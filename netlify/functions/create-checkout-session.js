const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const amount = Math.max(5, Math.min(50, Math.round(Number(body.amount) || 5)));
    const email = (body.email || '').trim().toLowerCase();

    const siteUrl = process.env.SITE_URL || `https://${event.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      allow_promotion_codes: true,
      payment_method_types: ['card', 'link'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'BTS EP by RATCHOPPER',
            description: 'Exclusive digital EP - Limited to 1000 copies',
            images: ['https://raw.githubusercontent.com/rettibot/bts-ep-release/main/Official%20Artwork%20Compressed.png'],
          },
          unit_amount: amount * 100,
        },
        quantity: 1,
      }],
      success_url: `${siteUrl}/?success=true&payment_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/?canceled=true`,
      customer_email: email || undefined,
      metadata: {
        purchaseEmail: email || ''
      }
    });

    return { statusCode: 200, headers, body: JSON.stringify({ url: session.url }) };
  } catch (error) {
    console.error('Stripe error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
