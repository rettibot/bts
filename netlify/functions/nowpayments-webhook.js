const crypto = require('crypto');

exports.handler = async function(event, context) {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
    
    if (!ipnSecret) {
      console.error('NOWPayments IPN secret not configured');
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'IPN secret not configured' })
      };
    }

    // Get the signature from headers
    const receivedSignature = event.headers['x-nowpayments-sig'];
    
    if (!receivedSignature) {
      console.error('No signature provided in IPN callback');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No signature provided' })
      };
    }

    // Verify the signature
    const payload = event.body;
    const calculatedSignature = crypto
      .createHmac('sha512', ipnSecret)
      .update(payload)
      .digest('hex');

    if (calculatedSignature !== receivedSignature) {
      console.error('Invalid IPN signature');
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Invalid signature' })
      };
    }

    // Parse the IPN data
    const ipnData = JSON.parse(payload);
    
    console.log('NOWPayments IPN received:', {
      payment_id: ipnData.payment_id,
      payment_status: ipnData.payment_status,
      order_id: ipnData.order_id,
      price_amount: ipnData.price_amount,
      price_currency: ipnData.price_currency
    });

    // Handle different payment statuses
    switch (ipnData.payment_status) {
      case 'finished':
        // Payment completed successfully
        console.log(`Payment ${ipnData.payment_id} completed successfully`);
        // Here you could:
        // - Send confirmation email
        // - Update database
        // - Trigger any post-payment actions
        break;
        
      case 'partially_paid':
        console.log(`Payment ${ipnData.payment_id} partially paid`);
        break;
        
      case 'confirming':
        console.log(`Payment ${ipnData.payment_id} is confirming`);
        break;
        
      case 'sending':
        console.log(`Payment ${ipnData.payment_id} is being sent`);
        break;
        
      case 'failed':
        console.log(`Payment ${ipnData.payment_id} failed`);
        break;
        
      case 'refunded':
        console.log(`Payment ${ipnData.payment_id} was refunded`);
        break;
        
      case 'expired':
        console.log(`Payment ${ipnData.payment_id} expired`);
        break;
        
      default:
        console.log(`Payment ${ipnData.payment_id} status: ${ipnData.payment_status}`);
    }

    // Always return 200 OK to acknowledge receipt of the IPN
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'IPN received successfully' })
    };

  } catch (error) {
    console.error('Error processing NOWPayments IPN:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};