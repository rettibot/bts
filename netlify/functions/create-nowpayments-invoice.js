const fetch = require('node-fetch');

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
    if (!email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email is required for crypto payments' }) };
    }
    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    const siteUrl = process.env.SITE_URL || `https://${event.headers.host}`;

    const initialInvoiceData = {
      price_amount: amount,
      price_currency: 'eur',
      ipn_callback_url: `${siteUrl}/.netlify/functions/nowpayments-webhook`,
      order_id: `BTS-EP-${Date.now()}`,
      order_description: 'RATCHOPPER - BTS EP (Digital Download)',
      cancel_url: `${siteUrl}/?canceled=true`,
      customer_email: email
    };

    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(initialInvoiceData)
    });

    const invoice = await response.json();
    if (!response.ok || !invoice.id) {
      throw new Error('Failed to create invoice');
    }

    let invoiceUrl = invoice.invoice_url;
    if (!invoiceUrl) {
      try {
        const fallbackUrl = new URL('https://nowpayments.io/invoice/');
        fallbackUrl.searchParams.set('iid', invoice.id);
        invoiceUrl = fallbackUrl.toString();
      } catch (urlError) {
        console.warn('Falling back to legacy invoice URL format:', urlError.message);
        invoiceUrl = `https://nowpayments.io/invoice/${invoice.id}`;
      }
    }

    const successUrl = `${siteUrl}/?success=true&payment_id=${invoice.id}`;
    const finalInvoiceUrl = `${invoiceUrl}${invoiceUrl.includes('?') ? '&' : '?'}success_url=${encodeURIComponent(successUrl)}`;

    return { statusCode: 200, headers, body: JSON.stringify({ invoice_url: finalInvoiceUrl }) };
  } catch (error) {
    console.error('NOWPayments error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Payment system error' }) };
  }
};
