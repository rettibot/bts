const fetch = require('node-fetch');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { amount, backupId } = JSON.parse(event.body);
    
    // Use SITE_URL env var for redirects (fallback to production domain)
    const siteUrl = process.env.SITE_URL || 'https://bts.ratchoppermusic.com';
    
    // 1. Prepare Flouci Payload
    const payload = {
        "app_token": process.env.FLOUCI_APP_TOKEN, 
        "app_secret": process.env.FLOUCI_APP_SECRET,
        "amount": amount * 1000, // Flouci uses Millimes (1 TND = 1000)
        "accept_card": "true",
        "session_timeout_secs": 1200,
        "success_link": `${siteUrl}/?success=true&region=tn`,
        "fail_link": `${siteUrl}/?error=true&region=tn`,
        "developer_tracking_id": backupId 
    };

    // 2. Call Flouci API
    const response = await fetch('https://developers.flouci.com/api/generate_payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.result && data.result.link) {
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                link: data.result.link,
                payment_id: data.result.payment_id  // Return payment_id to frontend
            })
        };
    } else {
        throw new Error(data.message || "Flouci Error");
    }

  } catch (error) {
    console.error("Flouci Error:", error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
