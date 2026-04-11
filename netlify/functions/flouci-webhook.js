const {
  finalizeFlouciPayment,
  sendFlouciConfirmationEmail
} = require('./flouci-shared');

function extractPaymentId(payload) {
  return (
    payload.payment_id ||
    payload.paymentId ||
    payload.id ||
    (payload.data && (payload.data.payment_id || payload.data.paymentId)) ||
    (payload.result && (payload.result.payment_id || payload.result.paymentId)) ||
    null
  );
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json'
  };
  const query = event.queryStringParameters || {};

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const payload = event.httpMethod === 'POST'
      ? JSON.parse(event.body || '{}')
      : {};
    const paymentId = extractPaymentId(payload)
      || query.payment_id
      || query.paymentId
      || query.id
      || null;

    if (!paymentId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing payment_id' }) };
    }

    const outcome = await finalizeFlouciPayment(paymentId);

    if (!outcome.verified) {
      return {
        statusCode: 202,
        headers,
        body: JSON.stringify({
          acknowledged: true,
          status: outcome.verification.status || 'UNKNOWN'
        })
      };
    }

    if (!outcome.isExistingRecord) {
      try {
        await sendFlouciConfirmationEmail({
          customerEmail: outcome.customerEmail,
          purchaseRecord: outcome.purchaseRecord,
          paymentId,
          amountMillimes: outcome.verification.result.amount,
          accessToken: outcome.token
        });
      } catch (emailError) {
        console.warn('Flouci webhook email failed (non-critical):', emailError.message);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        acknowledged: true,
        status: outcome.verification.status
      })
    };
  } catch (error) {
    console.error('Flouci webhook error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
