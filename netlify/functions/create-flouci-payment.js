const {
  generateFlouciPayment,
  normalizeTunisiaAmount,
  prepareFlouciTracking,
  resolveBaseUrl
} = require('./flouci-shared');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { amount, backupId, customerEmail } = JSON.parse(event.body || '{}');
    const baseUrl = resolveBaseUrl(event);
    const safeAmount = normalizeTunisiaAmount(amount);
    const tracking = await prepareFlouciTracking({
      requestedTrackingId: backupId,
      customerEmail
    });

    const payment = await generateFlouciPayment({
      amount: safeAmount,
      baseUrl,
      developerTrackingId: tracking.trackingId
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        link: payment.link,
        payment_id: payment.paymentId
      })
    };
  } catch (error) {
    console.error('Flouci create payment error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
