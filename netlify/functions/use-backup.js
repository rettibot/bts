const jwt = require('jsonwebtoken');
const Airtable = require('airtable');

const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
if (!AIRTABLE_TABLE_NAME) {
  throw new Error('Missing AIRTABLE_TABLE_NAME environment variable');
}

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

exports.handler = async (event) => {
  // 1. CORS Headers (Required for frontend access)
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { backupId } = JSON.parse(event.body);
    
    // SECURITY PATCH: Search by 'Backup_ID' (Secret), not 'PaymentID' (Public)
    // Ensure your Airtable column is exactly named "Backup_ID"
    const records = await base(AIRTABLE_TABLE_NAME)
      .select({ filterByFormula: `Backup_ID = '${backupId}'` })
      .firstPage();

    if (records.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invalid backup link' }) };
    }

    const record = records[0];

    // Check if already used
    if (record.fields.BackupUsed) {
      return { statusCode: 410, headers, body: JSON.stringify({ error: 'Backup link already utilized' }) };
    }

    // Logic: If they have 0 downloads left, give them 1 "Rescue" download.
    // If they still have 2 left, we don't add more, we just unlock access.
    let remainingDownloads = Number(record.fields.DownloadCount) || 0;
    const updates = { BackupUsed: true };
    
    if (remainingDownloads <= 0) {
      updates.DownloadCount = 1;
    }

    // Mark as used in DB
    await base(AIRTABLE_TABLE_NAME).update(record.id, updates);

    // SCARCITY LOGIC: 
    // 1. Set expiry to 24 Hours (86400 seconds)
    // 2. Add 'type: rescue' so frontend can show Red Archive UI
    const newToken = jwt.sign(
      { 
        paymentId: record.fields.PaymentID, // We still put PaymentID here so download.js works
        type: 'rescue',
        exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) 
      },
      process.env.JWT_SECRET
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ token: newToken })
    };
  } catch (error) {
    console.error('Backup error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
