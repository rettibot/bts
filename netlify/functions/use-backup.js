const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

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
    
    // SECURITY PATCH: Search by the secure uuid 'backup_id', not 'payment_id'
    const { data: record, error: fetchError } = await supabase
      .from('purchases')
      .select('*')
      .eq('backup_id', backupId)
      .single();

    if (fetchError || !record) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invalid backup link' }) };
    }

    // Check if already used
    if (record.backup_used) {
      return { statusCode: 410, headers, body: JSON.stringify({ error: 'Backup link already utilized' }) };
    }

    if (!record.payment_id || record.status !== 'PAID') {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: 'This backup link is not active until payment is confirmed.' })
      };
    }

    // Logic: If they have 0 downloads left, give them 1 "Rescue" download.
    // If they still have > 0 left, we don't add more, we just unlock access.
    let remainingDownloads = Number(record.download_count) || 0;
    const updates = { backup_used: true };
    
    if (remainingDownloads <= 0) {
      updates.download_count = 1;
    }

    // Mark as used in DB
    const { error: updateError } = await supabase
      .from('purchases')
      .update(updates)
      .eq('id', record.id);
      
    if (updateError) {
        throw new Error("Failed to process backup request.");
    }

    // SCARCITY LOGIC: 
    // 1. Set expiry to 24 Hours (86400 seconds)
    // 2. Add 'type: rescue' so frontend can show Red Archive UI
    const newToken = jwt.sign(
      { 
        paymentId: record.payment_id, // We still put paymentId here so download.js works
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
