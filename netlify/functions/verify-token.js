const jwt = require('jsonwebtoken');
const Airtable = require('airtable');

const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
if (!AIRTABLE_TABLE_NAME) {
  throw new Error('Missing AIRTABLE_TABLE_NAME environment variable');
}

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { token } = JSON.parse(event.body || '{}');

    if (!token) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          valid: false,
          expired: true,
          downloadTokens: 0,
          backupAvailable: false,
          error: 'No token provided',
        }),
      };
    }

    let decoded;
    try {
      // Verify JWT signature and expiry
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      console.error('JWT verification failed:', err.message);

      // Token invalid or expired
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          valid: false,
          expired: true,
          downloadTokens: 0,
          backupAvailable: false,
          error: err.message,
        }),
      };
    }

    // Ensure we have matching purchase record for download/backup info
    let record;
    try {
      const records = await base(AIRTABLE_TABLE_NAME)
        .select({ filterByFormula: `PaymentID = '${decoded.paymentId}'` })
        .firstPage();

      if (!records.length) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            valid: false,
            expired: false,
            downloadTokens: 0,
            backupAvailable: false,
            error: 'Purchase record not found',
          }),
        };
      }
      record = records[0];
    } catch (err) {
      console.error('Airtable lookup failed:', err.message);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          valid: false,
          expired: false,
          downloadTokens: 0,
          backupAvailable: false,
          error: 'Unable to verify purchase. Please try again.',
        }),
      };
    }

    let remainingDownloads = Number(record.fields.DownloadCount) || 0;
    if (!Number.isFinite(remainingDownloads)) {
      remainingDownloads = 0;
    }
    const backupUsed = !!record.fields.BackupUsed;

    // If we’re here, token signature is valid. Use exp from token.
    const now = Math.floor(Date.now() / 1000);
    const isExpired = typeof decoded.exp === 'number' && decoded.exp < now;

    // Your secure player URL (set in Netlify env)
    const streamUrl = process.env.UNTITLED_STREAM_URL;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: true,
        expired: isExpired,
        downloadTokens: Math.max(0, remainingDownloads),
        backupAvailable: !backupUsed,
        streamUrl,
      }),
    };
  } catch (error) {
    console.error('verify-token unexpected error:', error);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: false,
        expired: true,
        downloadTokens: 0,
        backupAvailable: false,
        error: error.message,
      }),
    };
  }
};
