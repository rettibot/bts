const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const FLOUCI_API_BASE = 'https://developers.flouci.com/api/v2';

function ensureEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function buildFlouciHeaders() {
  const { token, secret } = getFlouciCredentials();

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}:${secret}`
  };
}

function getFlouciMode() {
  return (process.env.FLOUCI_MODE || 'LIVE').trim().toUpperCase() === 'TEST' ? 'TEST' : 'LIVE';
}

function getFlouciCredentials() {
  const mode = getFlouciMode();
  const token = mode === 'TEST'
    ? (process.env.FLOUCI_TEST_APP_TOKEN || process.env.FLOUCI_APP_TOKEN)
    : (process.env.FLOUCI_LIVE_APP_TOKEN || process.env.FLOUCI_APP_TOKEN);
  const secret = mode === 'TEST'
    ? (process.env.FLOUCI_TEST_APP_SECRET || process.env.FLOUCI_APP_SECRET)
    : (process.env.FLOUCI_LIVE_APP_SECRET || process.env.FLOUCI_APP_SECRET);

  if (!token || !secret) {
    throw new Error(`Missing Flouci ${mode.toLowerCase()} credentials`);
  }

  return { mode, token, secret };
}

function buildSupabaseClient() {
  return createClient(ensureEnv('SUPABASE_URL'), ensureEnv('SUPABASE_SERVICE_ROLE_KEY'));
}

function resolveBaseUrl(event) {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin;
  const referer = headers.referer || headers.Referer;
  const host = headers.host || headers.Host;

  if (origin) {
    return origin.replace(/\/$/, '');
  }

  if (referer) {
    try {
      return new URL(referer).origin;
    } catch (error) {
      // Ignore invalid referers and fall back.
    }
  }

  if (host) {
    const protocol = host.includes('localhost') ? 'http' : 'https';
    return `${protocol}://${host}`;
  }

  return process.env.SITE_URL || 'https://bts.ratchoppermusic.com';
}

function normalizeTunisiaAmount(rawAmount) {
  const amount = Math.round(Number(rawAmount) || 1);
  return Math.max(1, Math.min(150, amount));
}

function resolveWebhookUrl(baseUrl) {
  if (process.env.FLOUCI_WEBHOOK_URL) {
    return process.env.FLOUCI_WEBHOOK_URL.trim();
  }

  const safeBaseUrl = (baseUrl || '').replace(/\/$/, '');

  if (/https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(safeBaseUrl)) {
    return '';
  }

  return `${safeBaseUrl}/.netlify/functions/flouci-webhook`;
}

async function parseFlouciJson(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Flouci returned invalid JSON (${response.status})`);
  }
}

async function generateFlouciPayment({ amount, baseUrl, developerTrackingId }) {
  const safeBaseUrl = (baseUrl || process.env.SITE_URL || 'https://bts.ratchoppermusic.com').replace(/\/$/, '');
  const webhookUrl = resolveWebhookUrl(safeBaseUrl);
  const payload = {
    amount: normalizeTunisiaAmount(amount) * 1000,
    accept_card: true,
    session_timeout_secs: 1200,
    success_link: `${safeBaseUrl}/?success=true&region=tn`,
    fail_link: `${safeBaseUrl}/?error=true&region=tn`,
    developer_tracking_id: developerTrackingId || 'PUBLIC_BUYER'
  };

  if (webhookUrl) {
    payload.webhook = webhookUrl;
  }

  const response = await fetch(`${FLOUCI_API_BASE}/generate_payment`, {
    method: 'POST',
    headers: buildFlouciHeaders(),
    body: JSON.stringify(payload)
  });
  const data = await parseFlouciJson(response);
  const result = data.result || {};

  if (!response.ok || data.code !== 0 || result.success === false || !result.link || !result.payment_id) {
    const reason = result.message || data.message || data.name || 'Unable to create Flouci payment';
    const error = new Error(reason);
    error.details = { responseStatus: response.status, data };
    throw error;
  }

  return {
    paymentId: result.payment_id,
    link: result.link,
    raw: data
  };
}

async function verifyFlouciPayment(paymentId) {
  const response = await fetch(`${FLOUCI_API_BASE}/verify_payment/${paymentId}`, {
    headers: buildFlouciHeaders()
  });
  const data = await parseFlouciJson(response);
  const result = data.result || {};
  const status = (result.status || '').toUpperCase();
  const success = data.success !== false && data.code === 0;

  if (!response.ok || !success) {
    const reason = data.message || data.name || 'Unable to verify Flouci payment';
    const error = new Error(reason);
    error.details = { responseStatus: response.status, data };
    throw error;
  }

  return {
    raw: data,
    result,
    status,
    isVerified: status === 'SUCCESS',
    isPending: status === 'PENDING'
  };
}

function extractFailureMessage(verification) {
  const result = verification.result || {};
  const details = result.details || {};
  const fields = [
    details.reason,
    details.message,
    details.details,
    details.error_message,
    details.error,
    details.errorMessage,
    details.description,
    details.response_message,
    details.processor_response,
    details.gateway_response,
    details.decline_reason,
    details.decline_code,
    details.reason_code,
    details.response_code,
    details.return_code,
    result.reason,
    result.message
  ];
  const reason = fields.find((value) => typeof value === 'string' && value.trim());

  if (reason) {
    return reason.trim();
  }

  const detailEntry = Object.entries(details).find(([key, value]) => {
    return /reason|message|description|error|response|decline|code/i.test(key) && typeof value === 'string' && value.trim();
  });

  if (detailEntry) {
    return detailEntry[1].trim();
  }

  switch (verification.status) {
    case 'FAILURE':
      return 'The card payment was declined by the processor.';
    case 'EXPIRED':
      return 'The payment session expired before confirmation.';
    case 'PENDING':
      return 'The payment is still being processed by Flouci.';
    default:
      return `Flouci reported status ${verification.status || 'UNKNOWN'}.`;
  }
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function extractFlouciEmail(verification, preferredEmail) {
  const normalizedPreferredEmail = normalizeEmail(preferredEmail);

  if (normalizedPreferredEmail) {
    return normalizedPreferredEmail;
  }

  const details = verification.result && verification.result.details ? verification.result.details : {};
  const candidates = [
    details.email,
    details.customer_email,
    details.mail
  ];

  return candidates.map(normalizeEmail).find(Boolean) || '';
}

async function findPurchaseByPaymentId(supabase, paymentId) {
  const { data, error } = await supabase
    .from('purchases')
    .select('*')
    .eq('payment_id', paymentId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function findReservationByTrackingId(supabase, trackingId) {
  if (!trackingId || trackingId === 'PUBLIC_BUYER' || !isUuid(trackingId)) {
    return null;
  }

  const { data, error } = await supabase
    .from('purchases')
    .select('*')
    .eq('backup_id', trackingId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function prepareFlouciTracking({ requestedTrackingId, customerEmail }) {
  const normalizedEmail = normalizeEmail(customerEmail);

  if (!normalizedEmail) {
    throw new Error('A valid email is required for Tunisia purchases');
  }

  const supabase = buildSupabaseClient();
  const trackingId = isUuid(requestedTrackingId) ? requestedTrackingId.trim() : null;

  if (trackingId) {
    const reservationRecord = await findReservationByTrackingId(supabase, trackingId);

    if (!reservationRecord) {
      throw new Error('Invalid Tunisia reservation link');
    }

    if (reservationRecord.payment_id) {
      throw new Error('This Tunisia reservation has already been used');
    }

    if (reservationRecord.email === normalizedEmail && reservationRecord.region === 'tn') {
      return {
        trackingId,
        customerEmail: normalizedEmail,
        purchaseRecord: reservationRecord
      };
    }

    const { data, error } = await supabase
      .from('purchases')
      .update({
        email: normalizedEmail,
        region: 'tn'
      })
      .eq('id', reservationRecord.id)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return {
      trackingId,
      customerEmail: normalizedEmail,
      purchaseRecord: data
    };
  }

  const { data, error } = await supabase
    .from('purchases')
    .insert([{
      email: normalizedEmail,
      status: 'PENDING',
      region: 'tn',
      download_count: 0,
      backup_used: false
    }])
    .select()
    .single();

  if (error) {
    throw error;
  }

  return {
    trackingId: data.backup_id,
    customerEmail: normalizedEmail,
    purchaseRecord: data
  };
}

async function upsertFlouciPurchase({ supabase, paymentId, verification, preferredEmail }) {
  const trackingId = verification.result.developer_tracking_id || '';
  const customerEmail = extractFlouciEmail(verification, preferredEmail);
  const normalizedPreferredEmail = normalizeEmail(preferredEmail);
  let purchaseRecord = await findPurchaseByPaymentId(supabase, paymentId);
  let isExistingRecord = Boolean(purchaseRecord);

  if (!purchaseRecord) {
    const reservationRecord = await findReservationByTrackingId(supabase, trackingId);

    if (reservationRecord && !reservationRecord.payment_id) {
      const updates = {
        payment_id: paymentId,
        status: 'PAID',
        download_count: 2,
        region: 'tn'
      };

      if (customerEmail && !reservationRecord.email) {
        updates.email = customerEmail;
      }

      const { data, error } = await supabase
        .from('purchases')
        .update(updates)
        .eq('id', reservationRecord.id)
        .select()
        .single();

      if (error) {
        throw error;
      }

      purchaseRecord = data;
      isExistingRecord = false;
    }
  }

  if (!purchaseRecord) {
    const insertPayload = {
      payment_id: paymentId,
      email: customerEmail || null,
      download_count: 2,
      backup_used: false,
      status: 'PAID',
      region: 'tn'
    };

    const { data, error } = await supabase
      .from('purchases')
      .insert([insertPayload])
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        purchaseRecord = await findPurchaseByPaymentId(supabase, paymentId);
        isExistingRecord = true;
      } else {
        throw error;
      }
    } else {
      purchaseRecord = data;
      isExistingRecord = false;
    }
  }

  if (!purchaseRecord) {
    throw new Error(`Unable to persist purchase for payment ${paymentId}`);
  }

  const shouldUpdateEmail = customerEmail && (
    !purchaseRecord.email ||
    (normalizedPreferredEmail && normalizeEmail(purchaseRecord.email) !== customerEmail)
  );

  if (shouldUpdateEmail) {
    const { data, error } = await supabase
      .from('purchases')
      .update({ email: customerEmail })
      .eq('id', purchaseRecord.id)
      .select()
      .single();

    if (!error && data) {
      purchaseRecord = data;
    }
  }

  return {
    purchaseRecord,
    customerEmail: normalizeEmail(purchaseRecord.email) || customerEmail || '',
    isExistingRecord
  };
}

function createAccessToken(paymentId) {
  return jwt.sign(
    { paymentId, exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60) },
    ensureEnv('JWT_SECRET')
  );
}

async function sendFlouciConfirmationEmail({ customerEmail, purchaseRecord, paymentId, amountMillimes, accessToken }) {
  const normalizedEmail = normalizeEmail(customerEmail);

  if (!normalizedEmail || !purchaseRecord || !purchaseRecord.backup_id) {
    return false;
  }

  const resend = new Resend(ensureEnv('RESEND_API_KEY'));
  const siteUrl = process.env.SITE_URL || 'https://bts.ratchoppermusic.com';
  const safeAccessToken = accessToken || createAccessToken(paymentId);
  const accessLink = `${siteUrl}/?token=${encodeURIComponent(safeAccessToken)}`;
  const backupLink = `${siteUrl}/?backup=${purchaseRecord.backup_id}`;
  const amountTND = Number(amountMillimes || 0) / 1000;

  const emailHTML = `
    <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #0a0a0a; color: #ffffff; padding: 40px 20px; text-align: center;">
      <div style="max-width: 600px; margin: 0 auto; border: 1px solid #333; border-radius: 16px; padding: 40px; background-color: #0f0c0a;">
        <h1 style="color: #d4af37; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px; font-size: 24px;">Purchase Confirmed</h1>
        <p style="color: #888; font-size: 12px; letter-spacing: 1px; text-transform: uppercase; margin-top: 0;">RATCHOPPER \u2022 B.T.S</p>
        <div style="border-top: 1px solid #333; border-bottom: 1px solid #333; padding: 30px 0; margin: 30px 0;">
          <p style="color: #cccccc; font-size: 16px; line-height: 1.6; margin-bottom: 25px;">Your copy is unlocked. Thank you for supporting the project.</p>
          <a href="${accessLink}" style="display: inline-block; padding: 16px 32px; background-color: #d4af37; color: #000000; text-decoration: none; font-weight: bold; border-radius: 8px; font-size: 16px; margin-bottom: 20px;">ACCESS CONTENT</a>
          <div style="margin-top: 30px; text-align: center;">
            <p style="color: #666; font-size: 12px; margin-bottom: 8px;">EMERGENCY BACKUP LINK:</p>
            <a href="${backupLink}" style="color: #d4af37; font-size: 12px; text-decoration: none; border-bottom: 1px dotted #d4af37;">${backupLink}</a>
            <p style="color: #555; font-size: 11px; margin-top: 8px;">Only use if you lose access. Link works once.</p>
          </div>
        </div>
        <p style="color: #555; font-size: 11px;">Paid via Flouci \u2022 ${amountTND} TND</p>
        <p style="color: #333; font-size: 10px;">ID: ${paymentId}</p>
      </div>
    </div>`;

  await resend.emails.send({
    from: 'RATCHOPPER <noreply@bts.ratchoppermusic.com>',
    to: normalizedEmail,
    subject: 'Your Copy: B.T.S - RATCHOPPER',
    html: emailHTML
  });

  return true;
}

async function finalizeFlouciPayment(paymentId, { preferredEmail } = {}) {
  const verification = await verifyFlouciPayment(paymentId);

  if (!verification.isVerified) {
    return {
      verified: false,
      verification
    };
  }

  const supabase = buildSupabaseClient();
  const { purchaseRecord, customerEmail, isExistingRecord } = await upsertFlouciPurchase({
    supabase,
    paymentId,
    verification,
    preferredEmail
  });

  return {
    verified: true,
    verification,
    purchaseRecord,
    customerEmail,
    isExistingRecord,
    token: createAccessToken(paymentId)
  };
}

module.exports = {
  extractFailureMessage,
  finalizeFlouciPayment,
  generateFlouciPayment,
  getFlouciMode,
  normalizeTunisiaAmount,
  prepareFlouciTracking,
  resolveBaseUrl,
  resolveWebhookUrl,
  sendFlouciConfirmationEmail,
  verifyFlouciPayment
};
