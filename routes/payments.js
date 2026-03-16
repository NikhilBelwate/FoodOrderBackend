/**
 * payments.js — Stripe Payment API routes
 * Mounted at: /api/payments
 *
 * Public:
 *   POST /api/payments/webhook              — Stripe webhook
 *
 * Authenticated (Supabase JWT):
 *   GET  /api/payments/order/:orderId       — Payment record for caller's order
 *   PUT  /api/payments/:id/stripe-confirm   — Confirm after frontend payment succeeds
 *
 * Admin (X-Admin-Key):
 *   GET  /api/payments/admin/list           — All payments with filters
 *   PUT  /api/payments/admin/:id/verify     — Manually confirm a payment
 *   PUT  /api/payments/admin/:id/refund     — Mark payment refunded
 */
'use strict';

const express             = require('express');
const { supabaseAdmin }   = require('../config/supabase');
const { createError }     = require('../middleware/errorHandler');
const { requireAuth }     = require('../middleware/authMiddleware');
const { requireAdminKey } = require('../middleware/adminMiddleware');
const {
  retrievePaymentIntent,
  constructWebhookEvent,
} = require('../services/stripeService');

const router = express.Router();

// ── GET /api/payments/order/:orderId  [AUTH] ──────────────────────────────────
router.get('/order/:orderId', requireAuth, async (req, res, next) => {
  try {
    const { data: order, error: orderErr } = await supabaseAdmin
      .from('orders').select('id, user_id').eq('id', req.params.orderId).single();
    if (orderErr || !order) throw createError(404, 'NOT_FOUND', 'Order not found');
    if (order.user_id !== req.user.id) throw createError(403, 'FORBIDDEN', 'Access denied');

    const { data: payment, error } = await supabaseAdmin
      .from('payments')
      .select('id, payment_method, payment_status, amount, currency, stripe_payment_intent_id, paid_at, created_at')
      .eq('order_id', req.params.orderId).maybeSingle();
    if (error) throw createError(500, 'DB_ERROR', error.message);

    res.json({ data: payment || null });
  } catch (err) { next(err); }
});

// ── PUT /api/payments/:id/stripe-confirm  [AUTH] ──────────────────────────────
// Frontend calls this after stripe.confirmCardPayment returns 'succeeded'.
// We re-verify with Stripe API before updating DB.
router.put('/:id/stripe-confirm', requireAuth, async (req, res, next) => {
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) throw createError(400, 'MISSING_FIELD', 'paymentIntentId is required');

    const { data: payment, error: fetchErr } = await supabaseAdmin
      .from('payments')
      .select('id, payment_status, payment_method, order_id, stripe_payment_intent_id, orders(user_id)')
      .eq('id', req.params.id).single();
    if (fetchErr || !payment) throw createError(404, 'NOT_FOUND', 'Payment not found');
    if (payment.orders?.user_id !== req.user.id) throw createError(403, 'FORBIDDEN', 'Access denied');
    if (payment.payment_method !== 'stripe') throw createError(400, 'INVALID_OP', 'Only for Stripe payments');
    if (payment.payment_status === 'confirmed') {
      return res.json({ data: payment, message: 'Payment already confirmed' });
    }

    // Verify with Stripe
    let pi;
    try { pi = await retrievePaymentIntent(paymentIntentId); }
    catch (e) { throw createError(502, 'STRIPE_ERROR', `Could not verify payment: ${e.message}`); }

    if (pi.status !== 'succeeded') {
      throw createError(400, 'PAYMENT_NOT_SUCCEEDED',
        `Payment status is "${pi.status}" — card may have been declined`);
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('payments')
      .update({
        payment_status:           'confirmed',
        stripe_payment_intent_id: paymentIntentId,
        stripe_charge_id:         pi.latest_charge || null,
        paid_at:                  new Date().toISOString(),
      })
      .eq('id', req.params.id).select().single();
    if (updErr) throw createError(500, 'DB_ERROR', updErr.message);

    res.json({ data: updated, message: 'Payment confirmed!' });
  } catch (err) { next(err); }
});

// ── POST /api/payments/webhook  [PUBLIC] ──────────────────────────────────────
router.post('/webhook', async (req, res) => {
  const sigHeader = req.headers['stripe-signature'] || '';
  const rawBody   = req.rawBody || JSON.stringify(req.body);

  const result = constructWebhookEvent(rawBody, sigHeader);
  if (!result.valid) {
    console.warn('[stripe-webhook] Signature invalid:', result.error);
    return res.status(400).json({ error: result.error });
  }

  const event = result.event;
  console.log(`[stripe-webhook] ${event.type}`);

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const { data: pay } = await supabaseAdmin
        .from('payments').select('id, payment_status')
        .eq('stripe_payment_intent_id', pi.id).maybeSingle();
      if (pay && pay.payment_status !== 'confirmed') {
        await supabaseAdmin.from('payments').update({
          payment_status: 'confirmed', stripe_charge_id: pi.latest_charge || null,
          stripe_raw_webhook: event, paid_at: new Date().toISOString(),
        }).eq('id', pay.id);
        console.log(`[stripe-webhook] confirmed payment ${pay.id}`);
      }
    }
    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      const { data: pay } = await supabaseAdmin
        .from('payments').select('id')
        .eq('stripe_payment_intent_id', pi.id).maybeSingle();
      if (pay) {
        await supabaseAdmin.from('payments').update({
          payment_status: 'failed', stripe_raw_webhook: event,
          notes: pi.last_payment_error?.message || 'Payment failed',
        }).eq('id', pay.id);
        console.log(`[stripe-webhook] failed payment ${pay.id}`);
      }
    }
  } catch (e) { console.error('[stripe-webhook] processing error:', e.message); }

  res.status(200).json({ received: true });
});

// ── Admin: GET /api/payments/admin/list  [ADMIN] ──────────────────────────────
router.get('/admin/list', requireAdminKey, async (req, res, next) => {
  try {
    const { status, method, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const pageSize = Math.min(100, parseInt(limit) || 20);
    const offset  = (pageNum - 1) * pageSize;

    let query = supabaseAdmin.from('payments').select(`
      id, payment_method, payment_status, amount, currency,
      stripe_payment_intent_id, stripe_charge_id, notes, paid_at, created_at, updated_at,
      orders("orderId", "customerName", "customerEmail", status, "totalPrice", "createdAt")
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

    if (status) query = query.eq('payment_status', status);
    if (method) query = query.eq('payment_method', method);

    const { data, error, count } = await query;
    if (error) throw createError(500, 'DB_ERROR', error.message);
    res.json({ data, pagination: { total: count||0, page: pageNum, limit: pageSize, pages: Math.ceil((count||0)/pageSize) } });
  } catch (err) { next(err); }
});

// ── Admin: PUT /api/payments/admin/:id/verify  [ADMIN] ───────────────────────
router.put('/admin/:id/verify', requireAdminKey, async (req, res, next) => {
  try {
    const { notes } = req.body;
    const { data: pay, error: fe } = await supabaseAdmin
      .from('payments').select('id, payment_status').eq('id', req.params.id).single();
    if (fe || !pay) throw createError(404, 'NOT_FOUND', 'Payment not found');
    if (pay.payment_status === 'confirmed') return res.json({ data: pay, message: 'Already confirmed' });

    const { data: updated, error: ue } = await supabaseAdmin.from('payments')
      .update({ payment_status: 'confirmed', paid_at: new Date().toISOString(), notes: notes || 'Manually verified by admin' })
      .eq('id', req.params.id).select().single();
    if (ue) throw createError(500, 'DB_ERROR', ue.message);
    res.json({ data: updated, message: 'Payment verified' });
  } catch (err) { next(err); }
});

// ── Admin: PUT /api/payments/admin/:id/refund  [ADMIN] ───────────────────────
router.put('/admin/:id/refund', requireAdminKey, async (req, res, next) => {
  try {
    const { notes } = req.body;
    const { data: updated, error } = await supabaseAdmin.from('payments')
      .update({ payment_status: 'refunded', notes: notes || 'Refunded by admin' })
      .eq('id', req.params.id).select().single();
    if (error) throw createError(500, 'DB_ERROR', error.message);
    if (!updated) throw createError(404, 'NOT_FOUND', 'Payment not found');
    res.json({ data: updated, message: 'Payment refunded' });
  } catch (err) { next(err); }
});

module.exports = router;
