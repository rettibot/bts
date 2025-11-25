const Airtable = require('airtable');
const { Resend } = require('resend');

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const resend = new Resend(process.env.RESEND_API_KEY);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const { email, region, stage } = JSON.parse(event.body);

    // 1. Generate Codes
    const reservationCode = 'TN-' + Math.random().toString(36).substr(2, 4).toUpperCase();
    const backupId = 'key_' + Math.random().toString(36).substr(2, 9); 

    // 2. Save to Airtable
    await base('Purchases').create([
      {
        fields: {
          "Email": email,
          "Status": "RESERVED",
          "Region": region,
          "Reservation_Code": reservationCode,
          "Backup_ID": backupId, 
          "DownloadCount": 0,
          "BackupUsed": false
        }
      }
    ]);

    // 3. Email Logic
    const DELAY_MINUTES = 1; // Change to 60 for 1 hour later
    const isQueue = stage === 'EARLY_ACCESS';
    
    let subject = 'Spot Secured: B.T.S - RATCHOPPER';
    let scheduledAt = null;
    let emailBodyHTML = '';

    // --- TEMPLATES ---
    
    // TEMPLATE A: SPOT SECURED (PHASE 1)
    if (!isQueue) {
        emailBodyHTML = `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #0a0a0a; color: #ffffff; padding: 40px 20px; text-align: center;">
            <div style="max-width: 600px; margin: 0 auto; border: 1px solid #333; border-radius: 16px; padding: 40px; background-color: #0f0c0a;">
                <h1 style="color: #d4af37; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; font-size: 24px;">Spot Secured</h1>
                <p style="color: #888; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; margin-top: 0;">RATCHOPPER • B.T.S</p>
                
                <div style="border-top: 1px solid #333; border-bottom: 1px solid #333; padding: 30px 0; margin: 30px 0;">
                    <p style="color: #cccccc; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">You have successfully secured your spot.</p>
                    <p style="color: #cccccc; font-size: 16px; line-height: 1.6;">When the Tunisian payment options open, you will be amongst the first to receive an early access link.</p>
                    
                    <div style="background: rgba(212, 175, 55, 0.1); border: 1px solid #d4af37; border-radius: 8px; padding: 15px; margin-top: 25px; display: inline-block;">
                        <span style="color: #d4af37; font-weight: bold; font-size: 18px; letter-spacing: 1px;">CODE: ${reservationCode}</span>
                    </div>
                </div>
                
                <p style="color: #555; font-size: 11px;">Keep this code for your records.</p>
            </div>
        </div>`;
    } 
    
    // TEMPLATE B: YOU ARE IN (PHASE 2)
    else {
        subject = 'Access Link: B.T.S - RATCHOPPER';
        // LOGIC UPDATE: We pass the code in the URL now so index.html can display it
        const activationLink = `https://bts.ratchoppermusic.com/?activate=${backupId}&code=${reservationCode}`;
        
        const delayTime = new Date(Date.now() + DELAY_MINUTES * 60 * 1000); 
        scheduledAt = delayTime.toISOString();

        emailBodyHTML = `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #0a0a0a; color: #ffffff; padding: 40px 20px; text-align: center;">
            <div style="max-width: 600px; margin: 0 auto; border: 1px solid #333; border-radius: 16px; padding: 40px; background-color: #0f0c0a;">
                <h1 style="color: #d4af37; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; font-size: 28px;">YOU ARE IN</h1>
                <p style="color: #888; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; margin-top: 0;">Your Access Window Is Open</p>
                
                <div style="border-top: 1px solid #333; border-bottom: 1px solid #333; padding: 30px 0; margin: 30px 0;">
                    <p style="color: #cccccc; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">Click the link below to unlock the Tunisian payment gateway.</p>
                    
                    <a href="${activationLink}" style="display: inline-block; padding: 16px 32px; background-color: #d4af37; color: #000000; text-decoration: none; font-weight: bold; border-radius: 8px; font-size: 16px; letter-spacing: 0.5px;">ENTER SHOP</a>
                    
                    <p style="color: #666; font-size: 12px; margin-top: 20px;">Reservation Code: ${reservationCode}</p>
                </div>
                
                <p style="color: #555; font-size: 11px;">Link valid for 24 hours.</p>
            </div>
        </div>`;
    }

    // 4. Send
    const senderEmail = 'RATCHOPPER <noreply@bts.ratchoppermusic.com>'; 

    try {
        await resend.emails.send({
          from: senderEmail, 
          to: email,
          subject: subject,
          html: emailBodyHTML,
          ...(scheduledAt && { scheduled_at: scheduledAt }) 
        });
    } catch (e) {
        // Fallback if scheduling fails
        await resend.emails.send({ from: senderEmail, to: email, subject: subject, html: emailBodyHTML });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ message: "Success", code: reservationCode }) };

  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};