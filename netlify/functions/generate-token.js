const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");
const Airtable = require("airtable");
const { Resend } = require("resend");

console.log("Airtable env check:", {
    baseId: process.env.AIRTABLE_BASE_ID,
    keyPrefix: (process.env.AIRTABLE_API_KEY || "").slice(0, 4), 
});

const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
if (!AIRTABLE_TABLE_NAME) {
    throw new Error("Missing AIRTABLE_TABLE_NAME environment variable");
}

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
    process.env.AIRTABLE_BASE_ID
);

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
        const {
            paymentId,
            paymentMethod,
            customerEmail: providedEmail,
        } = JSON.parse(event.body || "{}");
        if (!paymentId || !paymentMethod) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Missing payment details" }),
            };
        }

        const normalizedProvidedEmail = (providedEmail || "")
            .trim()
            .toLowerCase();
        let paymentVerified = false;
        let customerEmail = "";

        // --- Verify payment ---
        if (paymentMethod === "stripe") {
            const session = await stripe.checkout.sessions.retrieve(paymentId);
            paymentVerified = session.payment_status === "paid";
            customerEmail =
                session.customer_details?.email ||
                session.customer_email ||
                session.metadata?.purchaseEmail ||
                "";
            console.log("Stripe session status:", session.payment_status);
        } else if (paymentMethod === "nowpayments") {
            const response = await fetch(
                `https://api.nowpayments.io/v1/invoice/${paymentId}`,
                {
                    headers: { "x-api-key": process.env.NOWPAYMENTS_API_KEY },
                }
            );
            const invoice = await response.json();
            const status = (invoice.payment_status || "").toLowerCase();
            paymentVerified = status === "finished";
            customerEmail = invoice.email || "";
            console.log("NOWPayments status:", status);
        } else {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Unsupported payment method" }),
            };
        }

        if (!paymentVerified) {
            return {
                statusCode: 402,
                headers,
                body: JSON.stringify({
                    error: "Payment not verified yet. Please refresh once the processor confirms your payment.",
                }),
            };
        }

        if (!customerEmail) {
            customerEmail = normalizedProvidedEmail;
        }

        if (!customerEmail) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: "No email found in payment data",
                }),
            };
        }

        // --- Ensure purchase record exists in Airtable ---
        let purchaseRecord;
        let isExistingRecord = false;
        try {
            const existingRecords = await base(AIRTABLE_TABLE_NAME)
                .select({ filterByFormula: `PaymentID = '${paymentId}'` })
                .firstPage();

            if (existingRecords.length > 0) {
                purchaseRecord = existingRecords[0];
                isExistingRecord = true;
                if (!purchaseRecord.fields.Email && customerEmail) {
                    await base(AIRTABLE_TABLE_NAME).update(purchaseRecord.id, {
                        Email: customerEmail,
                    });
                    purchaseRecord.fields.Email = customerEmail;
                }
            } else {
                purchaseRecord = await base(AIRTABLE_TABLE_NAME).create({
                    PaymentID: paymentId,
                    DownloadCount: 2,
                    BackupUsed: false,
                    Email: customerEmail,
                });
            }
            console.log("Airtable: purchase recorded for", paymentId);
        } catch (airtableError) {
            console.error("Airtable persistence failed:", airtableError);
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({
                    error: "Unable to record purchase. Please try again.",
                }),
            };
        }

        // --- Generate JWT (7 days) ---
        const token = jwt.sign(
            {
                paymentId,
                exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
            },
            process.env.JWT_SECRET
        );

        // --- Try sending backup email (only for first-time record) ---
        // --- UPDATED: VISUAL DESIGN ONLY ---
        if (!isExistingRecord) {
            try {
                const resend = new Resend(process.env.RESEND_API_KEY);
                const accessLink = `https://bts.ratchoppermusic.com`;
                const backupLink = `https://bts.ratchoppermusic.com/?backup=${paymentId}`;

                // NEW DARK/GOLD EMAIL TEMPLATE
                const emailHTML = `
                <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #0a0a0a; color: #ffffff; padding: 40px 20px; text-align: center;">
                    <div style="max-width: 600px; margin: 0 auto; border: 1px solid #333; border-radius: 16px; padding: 40px; background-color: #0f0c0a;">
                        <h1 style="color: #d4af37; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; font-size: 24px;">Purchase Confirmed</h1>
                        <p style="color: #888; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; margin-top: 0;">RATCHOPPER • B.T.S</p>
                        
                        <div style="border-top: 1px solid #333; border-bottom: 1px solid #333; padding: 30px 0; margin: 30px 0;">
                            <p style="color: #cccccc; font-size: 16px; line-height: 1.6; margin-bottom: 25px;">Your copy is unlocked.</p>
                            
                            <a href="${accessLink}" style="display: inline-block; padding: 16px 32px; background-color: #d4af37; color: #000000; text-decoration: none; font-weight: bold; border-radius: 8px; font-size: 16px; margin-bottom: 20px;">ACCESS CONTENT</a>
                            
                            <div style="margin-top: 30px; text-align: center;">
                                <p style="color: #666; font-size: 12px; margin-bottom: 8px;">EMERGENCY BACKUP LINK:</p>
                                <a href="${backupLink}" style="color: #d4af37; font-size: 12px; text-decoration: none; border-bottom: 1px dotted #d4af37;">${backupLink}</a>
                                <p style="color: #555; font-size: 11px; margin-top: 8px;">Only use if you lose access. Link works once.</p>
                            </div>
                        </div>
                        
                        <p style="color: #333; font-size: 10px;">ID: ${paymentId}</p>
                    </div>
                </div>`;

                await resend.emails.send({
                    from: "RATCHOPPER <noreply@bts.ratchoppermusic.com>",
                    to: customerEmail,
                    subject: "Your Copy: B.T.S - RATCHOPPER",
                    html: emailHTML,
                });
                console.log("Resend: backup email queued for", customerEmail);
            } catch (emailError) {
                console.warn(
                    "Email failed (non-critical):",
                    emailError.message
                );
            }
        } else {
            console.log("Purchase already existed; skipping backup email.");
        }

        // --- Success response: token goes back to frontend ---
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ token }),
        };
    } catch (error) {
        console.error("Token generation error (fatal):", error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message }),
        };
    }
};
