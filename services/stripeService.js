/**
 * stripeService.js — Zero-dependency Stripe API client
 *
 * Uses Node.js built-in `https` module — no npm packages needed.
 * Stripe REST API uses application/x-www-form-urlencoded encoding.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY       — sk_test_... or sk_live_...
 *   STRIPE_PUBLISHABLE_KEY  — pk_test_... or pk_live_... (returned to frontend)
 *
 * Optional:
 *   STRIPE_WEBHOOK_SECRET   — whsec_... for verifying webhook signatures
 *   STRIPE_CURRENCY         — default currency (default: usd)
 */

'use strict';

const https  = require('https');
const crypto = require('crypto');

const STRIPE_HOST    = 'api.stripe.com';
const STRIPE_VERSION = '2023-10-16';

// ─── Form encoding (Stripe uses x-www-form-urlencoded, not JSON) ─────────────

function encodeFormData(data, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach(item => {
        parts.push(`${encodeURIComponent(fullKey)}[]=${encodeURIComponent(item)}`);
      });
    } else if (typeof value === 'object') {
      const nested = encodeFormData(value, fullKey);
      if (nested) parts.push(nested);
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join('&');
}

// ─── Core HTTP helper ─────────────────────────────────────────────────────────

function stripeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return reject(new Error('STRIPE_SECRET_KEY is not configured in .env'));
    }

    const postData = body ? encodeFormData(body) : '';

    const options = {
      hostname: STRIPE_HOST,
      path:     `/v1${path}`,
      method,
      headers: {
        Authorization:    `Bearer ${secretKey}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Stripe-Version': STRIPE_VERSION,
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch (e) {
          return reject(new Error(`Stripe response parse error: ${e.message}`));
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const msg = parsed?.error?.message || `HTTP ${res.statusCode}`;
          const code = parsed?.error?.code || 'stripe_error';
          const err  = new Error(`Stripe: ${msg}`);
          err.stripeCode   = code;
          err.stripeStatus = res.statusCode;
          reject(err);
        }
      });
    });

    req.on('error', (e) => reject(new Error(`Stripe network error: ${e.message}`)));
    if (postData) req.write(postData);
    req.end();
  });
}

// ─── Payment Intents ──────────────────────────────────────────────────────────

/**
 * Create a Stripe PaymentIntent.
 * @param {number}  amountCents  - Amount in smallest currency unit (cents)
 * @param {string}  currency     - 3-letter currency code, e.g. 'usd'
 * @param {object}  metadata     - Key-value pairs stored on the PaymentIntent
 * @returns {Promise<{id, client_secret, status, ...}>}
 */
async function createPaymentIntent(amountCents, currency, metadata = {}) {
  return stripeRequest('POST', '/payment_intents', {
    amount:               amountCents,
    currency:             currency.toLowerCase(),
    payment_method_types: ['card'],
    metadata,
  });
}

/**
 * Retrieve an existing PaymentIntent by ID.
 */
async function retrievePaymentIntent(paymentIntentId) {
  return stripeRequest('GET', `/payment_intents/${paymentIntentId}`);
}

// ─── Webhook signature verification ──────────────────────────────────────────

/**
 * Verify and parse an incoming Stripe webhook event.
 *
 * Stripe signs webhooks using HMAC-SHA256:
 *   Stripe-Signature: t=timestamp,v1=hex,v1=hex,...
 *   Signed payload: `${timestamp}.${rawBody}`
 *
 * @param {string} rawBody   - Raw request body string
 * @param {string} sigHeader - Value of the Stripe-Signature header
 * @returns {{ valid: boolean, event?: object, error?: string }}
 */
function constructWebhookEvent(rawBody, sigHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  // Skip verification if no secret configured (dev/sandbox only)
  if (!secret) {
    try {
      return { valid: true, event: JSON.parse(rawBody) };
    } catch (e) {
      return { valid: false, error: 'Invalid JSON body' };
    }
  }

  if (!sigHeader) {
    return { valid: false, error: 'Missing Stripe-Signature header' };
  }

  // Parse signature header: t=timestamp,v1=hex,...
  const parts = {};
  sigHeader.split(',').forEach(part => {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx);
      const v = part.slice(idx + 1);
      if (!parts[k]) parts[k] = [];
      parts[k].push(v);
    }
  });

  const timestamp  = parts.t?.[0];
  const signatures = parts.v1 || [];

  if (!timestamp || signatures.length === 0) {
    return { valid: false, error: 'Malformed Stripe-Signature header' };
  }

  // Protect against replay attacks (allow 5-minute tolerance)
  const ts = parseInt(timestamp, 10);
  if (Math.abs(Date.now() / 1000 - ts) > 300) {
    return { valid: false, error: 'Webhook timestamp too old (replay attack?)' };
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  const valid = signatures.some(sig => {
    try {
      return crypto.timingSafeEqual(
        Buffer.from(sig,      'hex'),
        Buffer.from(expected, 'hex'),
      );
    } catch { return false; }
  });

  if (!valid) {
    return { valid: false, error: 'Stripe signature verification failed' };
  }

  try {
    return { valid: true, event: JSON.parse(rawBody) };
  } catch (e) {
    return { valid: false, error: 'Invalid JSON body' };
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────

/**
 * Verify the secret key is valid by fetching the account.
 */
async function verifyStripeToken() {
  try {
    await stripeRequest('GET', '/payment_intents?limit=1');
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = {
  createPaymentIntent,
  retrievePaymentIntent,
  constructWebhookEvent,
  verifyStripeToken,
};
