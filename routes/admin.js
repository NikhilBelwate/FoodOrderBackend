/**
 * admin.js — Admin-only API routes
 *
 * All routes protected by requireAdminKey middleware.
 * Mounted at: /api/admin
 *
 * Routes:
 *   GET  /api/admin/stats              — dashboard summary stats
 *   GET  /api/admin/orders             — all orders with filters & pagination
 *   PUT  /api/admin/orders/:id/status  — update any order's status
 *
 * ── Actual DB column names (from 01_schema.sql) ──────────────────────────────
 * orders:      id (UUID PK), "orderId" (human-readable), "customerName",
 *              "customerEmail", "customerPhone", "deliveryAddress",
 *              "specialInstructions", status, "totalPrice", "createdAt",
 *              "updatedAt", user_id
 * order_items: id, "orderId" (FK→orders.id), "foodItemId" (FK→food_items.id),
 *              quantity, price, "createdAt"
 * food_items:  id, name, description, category, price, "imageUrl", available,
 *              "createdAt", "updatedAt", discount_percent, offer_label, is_available
 *
 * Status values (Title Case as defined in DB CHECK constraint):
 *   'Pending' | 'Confirmed' | 'Preparing' | 'Ready' | 'Delivered' | 'Cancelled'
 */

const express = require('express');
const { z }   = require('zod');
const { supabaseAdmin } = require('../config/supabase');
const { createError }    = require('../middleware/errorHandler');
const { requireAdminKey } = require('../middleware/adminMiddleware');
const { sendDeliveryNotification } = require('../services/emailService');

const router = express.Router();

// Apply admin key check to every route in this file
router.use(requireAdminKey);

// Valid status values — must match DB CHECK constraint (Title Case)
const VALID_STATUSES = ['Pending', 'Confirmed', 'Preparing', 'Ready', 'Delivered', 'Cancelled'];

// ─── GET /api/admin/stats ──────────────────────────────────────────────────────
// Returns dashboard summary: orders breakdown, revenue, item counts
router.get('/stats', async (req, res, next) => {
  try {
    // Fetch all orders (only the columns we need for stats)
    const { data: orders, error: ordersErr } = await supabaseAdmin
      .from('orders')
      .select('status, "totalPrice", "createdAt"');

    if (ordersErr) throw createError(500, 'DB_ERROR', ordersErr.message);

    // Fetch food item counts
    const { count: totalItems, error: totalItemsErr } = await supabaseAdmin
      .from('food_items')
      .select('*', { count: 'exact', head: true });

    if (totalItemsErr) throw createError(500, 'DB_ERROR', totalItemsErr.message);

    const { count: availableItems, error: availErr } = await supabaseAdmin
      .from('food_items')
      .select('*', { count: 'exact', head: true })
      .eq('available', true);

    if (availErr) throw createError(500, 'DB_ERROR', availErr.message);

    // Aggregate stats in JS
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const stats = {
      totalOrders:    orders.length,
      pendingOrders:  0,
      confirmedOrders: 0,
      preparingOrders: 0,
      readyOrders:    0,
      deliveredOrders: 0,
      cancelledOrders: 0,
      totalRevenue:   0,
      revenueLast30d: 0,
      totalItems:     totalItems  || 0,
      availableItems: availableItems || 0,
    };

    for (const o of orders) {
      // Count by status (Title Case values from DB)
      switch (o.status) {
        case 'Pending':   stats.pendingOrders++;   break;
        case 'Confirmed': stats.confirmedOrders++;  break;
        case 'Preparing': stats.preparingOrders++;  break;
        case 'Ready':     stats.readyOrders++;      break;
        case 'Delivered': stats.deliveredOrders++;  break;
        case 'Cancelled': stats.cancelledOrders++;  break;
      }

      // Sum revenue — exclude Cancelled orders
      if (o.status !== 'Cancelled') {
        const amount = parseFloat(o['totalPrice'] || 0);
        stats.totalRevenue += amount;
        if (new Date(o['createdAt']) >= thirtyDaysAgo) {
          stats.revenueLast30d += amount;
        }
      }
    }

    stats.totalRevenue   = parseFloat(stats.totalRevenue.toFixed(2));
    stats.revenueLast30d = parseFloat(stats.revenueLast30d.toFixed(2));

    res.json({ data: stats });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/admin/orders ─────────────────────────────────────────────────────
// Query params: status (Title Case), page (1-based), limit (default 20),
//               search (searches the human-readable "orderId" field)
router.get('/orders', async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;

    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const pageSize = Math.min(100, parseInt(limit, 10) || 20);
    const offset   = (pageNum - 1) * pageSize;

    // Build query — select all order columns + nested order_items with food details
    let query = supabaseAdmin
      .from('orders')
      .select(`
        id,
        "orderId",
        status,
        "totalPrice",
        "customerName",
        "customerEmail",
        "customerPhone",
        "deliveryAddress",
        "specialInstructions",
        user_id,
        "createdAt",
        "updatedAt",
        order_items (
          id,
          "foodItemId",
          quantity,
          price,
          food_items ( name, category )
        )
      `, { count: 'exact' })
      .order('"createdAt"', { ascending: false })
      .range(offset, offset + pageSize - 1);

    // Status filter — must use DB Title Case values
    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        throw createError(400, 'INVALID_STATUS',
          `Status must be one of: ${VALID_STATUSES.join(', ')}`);
      }
      query = query.eq('status', status);
    }

    // Search by the human-readable orderId field (e.g. ORD-20260310-143522-A7F2)
    if (search) {
      query = query.ilike('"orderId"', `%${search}%`);
    }

    const { data, error, count } = await query;
    if (error) throw createError(500, 'DB_ERROR', error.message);

    res.json({
      data,
      pagination: {
        total: count  || 0,
        page:  pageNum,
        limit: pageSize,
        pages: Math.ceil((count || 0) / pageSize),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/admin/orders/:id/status ─────────────────────────────────────────
// :id is the UUID primary key (orders.id)
// Body: { status: 'Pending' | 'Confirmed' | 'Preparing' | 'Ready' | 'Delivered' | 'Cancelled' }
const OrderStatusSchema = z.object({
  status: z.enum(['Pending', 'Confirmed', 'Preparing', 'Ready', 'Delivered', 'Cancelled']),
});

router.put('/orders/:id/status', async (req, res, next) => {
  try {
    const parsed = OrderStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(400, 'VALIDATION_ERROR',
        parsed.error.errors.map(e => e.message).join(', '));
    }

    const newStatus = parsed.data.status;

    // Verify the order exists (query by UUID PK)
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('orders')
      .select('id, status, "orderId"')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !existing) {
      throw createError(404, 'NOT_FOUND', `Order ${req.params.id} not found`);
    }

    // Update status — "updatedAt" is handled by the DB trigger automatically
    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status: newStatus })
      .eq('id', req.params.id)
      .select(`
        id,
        "orderId",
        status,
        "totalPrice",
        "customerName",
        "createdAt",
        "updatedAt"
      `);

    if (error) throw createError(500, 'DB_ERROR', error.message);

    const responsePayload = {
      data,
      message: `Order "${existing['orderId']}" status updated to "${newStatus}"`,
      emailSent: false,
    };

    // ── Send delivery notification email when order reaches "Delivered" ──────
    if (newStatus === 'Delivered') {
      try {
        // Fetch the full order (with nested items + food details) for the email
        const { data: fullOrder, error: orderFetchErr } = await supabaseAdmin
          .from('orders')
          .select(`
            id,
            "orderId",
            status,
            "totalPrice",
            "customerName",
            "customerEmail",
            "customerPhone",
            "deliveryAddress",
            "specialInstructions",
            "createdAt",
            order_items (
              id,
              quantity,
              price,
              food_items (
                name,
                category,
                discount_percent,
                offer_label
              )
            )
          `)
          .eq('id', req.params.id)
          .single();

        if (orderFetchErr) {
          // Log but don't fail the status update — email is best-effort
          console.error('[email] Failed to fetch full order for email:', orderFetchErr.message);
        } else {
          await sendDeliveryNotification(fullOrder);
          responsePayload.emailSent = true;
          responsePayload.message  += '. Delivery notification email sent to customer.';
          console.log(`[email] Delivery notification sent for order "${fullOrder['orderId']}" → ${fullOrder['customerEmail']}`);
        }
      } catch (emailErr) {
        // Email failure must NOT block the status update response
        console.error('[email] Failed to send delivery notification:', emailErr.message);
        responsePayload.emailError = emailErr.message;
      }
    }

    res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
