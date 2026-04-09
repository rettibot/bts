const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const Airtable = require('airtable');
const { Resend } = require('resend');

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
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const { payment_id } = JSON.parse(event.body);

    if (!payment_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing payment_id' }) };
    }

    // 1. Verify payment with Flouci API
    const verifyResponse = await fetch(
      `https://developers.flouci.com/api/verify_payment/${payment_id}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'apppublic': process.env.FLOUCI_APP_TOKEN,
          'appsecret': process.env.FLOUCI_APP_SECRET
        }
      }
    );

    const verifyData = await verifyResponse.json();
    console.log('Flouci verify response:', JSON.stringify(verifyData));

    // Check payment status
    const paymentStatus = verifyData.result && verifyData.result.status;
    if (paymentStatus !== 'SUCCESS') {
      return {
        statusCode: 402,
        headers,
        body: JSON.stringify({ 
          error: 'Payment not verified. Status: ' + (paymentStatus || 'unknown'),
          status: paymentStatus
        })
      };
    }

    // 2. Extract tracking info
    const trackingId = verifyData.result.developer_tracking_id || '';
    const amountMillimes = verifyData.result.amount || 0;
    const amountTND = amountMillimes / 1000;

    // 3. Check if purchase already recorded (prevent double-spend)
    const existingRecords = await base(AIRTABLE_TABLE_NAME)
      .select({ filterByFormula: `PaymentID = '${payment_id}'` })
      .firstPage();

    if (existingRecords.length > 0) {
      // Already processed — just return a fresh token
      const record = existingRecords[0];
      const token = jwt.sign(
        { paymentId: payment_id, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 },
        process.env.JWT_SECRET
      );
      return { statusCode: 200, headers, body: JSON.stringify({ token }) };
    }

    // 4. Find the reservation record by Backup_ID (the tracking ID)
    let customerEmail = '';
    if (trackingId && trackingId !== 'PUBLIC_BUYER') {
      try {
        const reservationRecords = await base(AIRTABLE_TABLE_NAME)
          .select({ filterByFormula: `Backup_ID = '${trackingId}'` })
          .firstPage();

        if (reservationRecords.length > 0) {
          const resRecord = reservationRecords[0];
          customerEmail = resRecord.fields.Email || '';

          // Update reservation record with payment info
          await base(AIRTABLE_TABLE_NAME).update(resRecord.id, {
            PaymentID: payment_id,
            Status: 'PAID',
            DownloadCount: 2,
            PaymentMethod: 'flouci',
            AmountPaid: String(amountTND) + ' TND'
          });
          console.log('Updated reservation record for:', trackingId);
        }
      } catch (e) {
        console.warn('Could not find/update reservation:', e.message);
      }
    }

    // 5. If no reservation found, create a new purchase record
    if (!existingRecords.length) {
      const checkAgain = await base(AIRTABLE_TABLE_NAME)
        .select({ filterByFormula: `PaymentID = '${payment_id}'` })
        .firstPage();

      if (checkAgain.length === 0) {
        await base(AIRTABLE_TABLE_NAME).create({
          PaymentID: payment_id,
          DownloadCount: 2,
          BackupUsed: false,
          Status: 'PAID',
          PaymentMethod: 'flouci',
          AmountPaid: String(amountTND) + ' TND',
          Email: customerEmail
        });
        console.log('Created new purchase record for Flouci payment:', payment_id);
      }
    }

    // 6. Generate JWT (7 days)
    const token = jwt.sign(
      { paymentId: payment_id, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60 },
      process.env.JWT_SECRET
    );

    // 7. Send confirmation email if we have an address
    if (customerEmail) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const siteUrl = process.env.SITE_URL || 'https://bts.ratchoppermusic.com';
        const backupLink = `${siteUrl}/?backup=${payment_id}`;

        const emailHTML = `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #0a0a0a; color: #ffffff; padding: 40px 20px; text-align: center;">
            <div style="max-width: 600px; margin: 0 auto; border: 1px solid #333; border-radius: 16px; padding: 40px; background-color: #0f0c0a;">
                <h1 style="color: #d4af37; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; font-size: 24px;">Purchase Confirmed</h1>
                <p style="color: #888; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; margin-top: 0;">RATCHOPPER • B.T.S</p>
                
                <div style="border-top: 1px solid #333; border-bottom: 1px solid #333; padding: 30px 0; margin: 30px 0;">
                    <p style="color: #cccccc; font-size: 16px; line-height: 1.6; margin-bottom: 25px;">Your copy is unlocked. Thank you for supporting the project.</p>
                    
                    <a href="${siteUrl}" style="display: inline-block; padding: 16px 32px; background-color: #d4af37; color: #000000; text-decoration: none; font-weight: bold; border-radius: 8px; font-size: 16px; margin-bottom: 20px;">ACCESS CONTENT</a>
                    
                    <div style="margin-top: 30px; text-align: center;">
                        <p style="color: #666; font-size: 12px; margin-bottom: 8px;">EMERGENCY BACKUP LINK:</p>
                        <a href="${backupLink}" style="color: #d4af37; font-size: 12px; text-decoration: none; border-bottom: 1px dotted #d4af37;">${backupLink}</a>
                        <p style="color: #555; font-size: 11px; margin-top: 8px;">Only use if you lose access. Link works once.</p>
                    </div>
                </div>
                
                <p style="color: #555; font-size: 11px;">Paid via Flouci • ${amountTND} TND</p>
                <p style="color: #333; font-size: 10px;">ID: ${payment_id}</p>
            </div>
        </div>`;

        await resend.emails.send({
          from: 'RATCHOPPER <noreply@bts.ratchoppermusic.com>',
          to: customerEmail,
          subject: 'Your Copy: B.T.S - RATCHOPPER',
          html: emailHTML
        });
        console.log('Confirmation email sent to:', customerEmail);
      } catch (emailError) {
        console.warn('Email failed (non-critical):', emailError.message);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ token })
    };

  } catch (error) {
    console.error('Flouci verification error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
