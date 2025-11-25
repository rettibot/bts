const jwt = require("jsonwebtoken");
const Airtable = require("airtable");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
    process.env.AIRTABLE_BASE_ID
);
const S3 = new S3Client({
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    region: process.env.B2_ENDPOINT.split(".")[1],
    credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
});

const fileMap = {
    MP3: "RATCHOPPER._B.T.S_MP3.zip",
    WAV: "RATCHOPPER._B.T.S_WAV.zip",
    FLAC: "RATCHOPPER._B.T.S_FLAC.zip",
};

const LOCK_FIELD = "DownloadLock";
const LOCK_RETRY_DELAY = 200; // ms
const LOCK_HOLD_TIME = 8000; // ms
const LOCK_TIMEOUT = 7000; // ms

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseLockValue(value = "") {
    if (!value || typeof value !== "string" || !value.includes(":")) {
        return { token: "", expiresAt: 0 };
    }
    const [token, rawExpiry] = value.split(":");
    return { token, expiresAt: Number(rawExpiry) || 0 };
}

async function acquireDownloadLock(recordId) {
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const deadline = Date.now() + LOCK_TIMEOUT;

    while (Date.now() < deadline) {
        const current = await base("Purchases").find(recordId);
        const { token: currentToken, expiresAt } = parseLockValue(
            current.fields[LOCK_FIELD]
        );
        const isExpired = !currentToken || Date.now() > expiresAt;

        if (isExpired) {
            const lockValue = `${token}:${Date.now() + LOCK_HOLD_TIME}`;
            try {
                await base("Purchases").update(recordId, {
                    [LOCK_FIELD]: lockValue,
                });
            } catch (err) {
                if (
                    err.message?.includes("UNKNOWN_FIELD_NAME") ||
                    err.message?.includes("Unknown field name")
                ) {
                    throw new Error(
                        `Airtable field "${LOCK_FIELD}" is missing. Please add a single line text field named exactly "${LOCK_FIELD}".`
                    );
                }
                throw err;
            }

            const confirm = await base("Purchases").find(recordId);
            if (confirm.fields[LOCK_FIELD] === lockValue) {
                return { lockValue, record: confirm };
            }
        }

        await delay(LOCK_RETRY_DELAY);
    }

    throw new Error("Unable to acquire download lock. Please try again.");
}

async function releaseDownloadLock(recordId, lockValue) {
    if (!lockValue) return;
    try {
        const current = await base("Purchases").find(recordId);
        if (current.fields[LOCK_FIELD] === lockValue) {
            await base("Purchases").update(recordId, { [LOCK_FIELD]: "" });
        }
    } catch (err) {
        console.warn("Failed to release download lock:", err.message);
    }
}

exports.handler = async (event) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Content-Type": "application/json",
    };

    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers, body: "" };
    }

    try {
        const { token, format } = JSON.parse(event.body);
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const formatKey = (format || "").toUpperCase();
        const fileKey = fileMap[formatKey];

        if (!fileKey) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: "Invalid format selected",
                }),
            };
        }

        const records = await base("Purchases")
            .select({ filterByFormula: `PaymentID = '${decoded.paymentId}'` })
            .firstPage();

        if (!records.length) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: "Purchase not found" }),
            };
        }

        const record = records[0];

        if (decoded.exp < Math.floor(Date.now() / 1000)) {
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({ error: "Access expired" }),
            };
        }

        let lock;
        try {
            lock = await acquireDownloadLock(record.id);
        } catch (lockError) {
            console.error("Download lock error:", lockError.message);
            return {
                statusCode: 503,
                headers,
                body: JSON.stringify({ error: lockError.message }),
            };
        }

        try {
            const lockedRecord = lock.record;
            let remainingDownloads =
                Number(lockedRecord.fields.DownloadCount) || 0;
            if (!Number.isFinite(remainingDownloads)) {
                remainingDownloads = 0;
            }

            if (remainingDownloads <= 0) {
                return {
                    statusCode: 429,
                    headers,
                    body: JSON.stringify({
                        error: "No downloads remaining",
                    }),
                };
            }

            let downloadUrl;
            try {
                const command = new GetObjectCommand({
                    Bucket: process.env.B2_BUCKET_NAME,
                    Key: fileKey,
                });
                downloadUrl = await getSignedUrl(S3, command, {
                    expiresIn: 60,
                });
            } catch (err) {
                console.error("Failed to generate download link:", err);
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({
                        error: "Unable to prepare download. Please try again.",
                    }),
                };
            }

            const updatedDownloads = Math.max(0, remainingDownloads - 1);

            await base("Purchases").update(record.id, {
                DownloadCount: updatedDownloads,
            });

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    downloadUrl,
                    remainingTokens: updatedDownloads,
                }),
            };
        } finally {
            await releaseDownloadLock(record.id, lock.lockValue);
        }
    } catch (error) {
        console.error("Download error:", error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message }),
        };
    }
};
