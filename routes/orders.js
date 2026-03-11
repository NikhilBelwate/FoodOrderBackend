const express = require('express');
const { z }   = require('zod');
const { supabase, supabaseAdmin } = require('../config/supabase');
const { createError } = require('../middleware/errorHandler');
const { requireAuth }  = require('../middleware/authMiddleware');
const { generateOrderId } = require('../utils/orderIdGenerator');

const router = express.Router();

// ─── Validation Schemas ──────────────────────────────────────────────────────
const OrderItemSchema = z.object({
  foodItemId: z.string().uuid('Invalid food item ID'),
  quantity:   z.number().int().positive('Quantity must be a positive integer'),
});

const CreateOrderSchema = z.object({
  customerName:        z.string().min(2).max(255),
  customerEmail:       z.string().email('Invalid email address'),
  customerPhone:       z.string().min(7).max(20).regex(/^[\d\s\+\-\(\)]+$/, 'Invalid phone number'),
  deliveryAddress:     z.string().min(5).max(500),
  specialInstructions: z.string().max(1000).optional().default(''),
  items:               z.array(OrderItemSchema).min(1, 'Order must contain at least one item'),
});

const OrderStatusSchema = z.object({
  status: z.enum(['Pending', 'Confirmed', 'Preparing', 'Ready', 'Delivered', 'Cancelled']),
});

// ─── POST /api/orders  [AUTH REQUIRED] ───────────────────────────────────────
router.post('/', requireAuth, async (req, res, next) => {
  try {
    // 1. Validate body
    const parsed = CreateOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(
        400,
        'VALIDATION_ERROR',
        parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(' | ')
      );
    }

    const { customerName, customerEmail, customerPhone, deliveryAddress, specialInstructions, items } = parsed.data;

    // 2. Fetch + validate food items
    const foodItemIds = items.map(i => i.foodItemId);
    const { data: foodItems, error: fetchError } = await supabaseAdmin
      .from('food_items')
      .select('id, name, price, available')
      .in('id', foodItemIds);

    if (fetchError) throw createError(500, 'DB_ERROR', fetchError.message);

    const foodItemMap = {};
    foodItems.forEach(f => { foodItemMap[f.id] = f; });

    for (const item of items) {
      const food = foodItemMap[item.foodItemId];
      if (!food)           throw createError(404, 'ITEM_NOT_FOUND',    `Food item ${item.foodItemId} not found`);
      if (!food.available) throw createError(400, 'ITEM_UNAVAILABLE', `${food.name} is currently unavailable`);
    }

    // 3. Calculate total
    let totalPrice = 0;
    const enrichedItems = items.map(item => {
      const food  = foodItemMap[item.foodItemId];
      const price = parseFloat(food.price) * item.quantity;
      totalPrice += price;
      return { foodItemId: item.foodItemId, quantity: item.quantity, unitPrice: parseFloat(food.price) };
    });

    // 4. Create order — attach authenticated user_id
    const orderId = generateOrderId();
    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert([{
        orderId,
        customerName,
        customerEmail,
        customerPhone,
        deliveryAddress,
        specialInstructions,
        totalPrice:  totalPrice.toFixed(2),
        status:      'Pending',
        user_id:     req.user.id,            // ← link to auth user
      }])
      .select()
      .single();

    if (orderError) throw createError(500, 'DB_ERROR', `Failed to create order: ${orderError.message}`);

    // 5. Insert order items
    const orderItemsData = enrichedItems.map(item => ({
      orderId:    order.id,
      foodItemId: item.foodItemId,
      quantity:   item.quantity,
      price:      item.unitPrice,
    }));

    const { error: itemsError } = await supabaseAdmin
      .from('order_items')
      .insert(orderItemsData);

    if (itemsError) {
      await supabaseAdmin.from('orders').delete().eq('id', order.id);
      throw createError(500, 'DB_ERROR', `Failed to save order items: ${itemsError.message}`);
    }

    res.status(201).json({
      data: {
        orderId:    order.orderId,
        id:         order.id,
        status:     order.status,
        totalPrice: order.totalPrice,
        createdAt:  order.createdAt,
      },
      message: 'Order placed successfully',
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/orders  [AUTH REQUIRED — returns user's own orders] ─────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { status, sortBy = 'date', page = 1, limit = 20 } = req.query;

    const pageNum  = Math.max(1, parseInt(page));
    const pageSize = Math.min(100, Math.max(1, parseInt(limit)));
    const from     = (pageNum - 1) * pageSize;
    const to       = from + pageSize - 1;

    let query = supabaseAdmin
      .from('orders')
      .select('*, order_items(id, foodItemId, quantity, price, food_items(id, name, category, imageUrl))', { count: 'exact' })
      .eq('user_id', req.user.id)           // ← only this user's orders
      .range(from, to);

    if (status) {
      const validStatuses = ['Pending', 'Confirmed', 'Preparing', 'Ready', 'Delivered', 'Cancelled'];
      if (!validStatuses.includes(status)) {
        throw createError(400, 'INVALID_STATUS', `Status must be one of: ${validStatuses.join(', ')}`);
      }
      query = query.eq('status', status);
    }

    query = sortBy === 'status'
      ? query.order('status', { ascending: true })
      : query.order('"createdAt"', { ascending: false });

    const { data, error, count } = await query;
    if (error) throw createError(500, 'DB_ERROR', error.message);

    res.json({
      data,
      pagination: {
        page: pageNum, limit: pageSize,
        total: count,  totalPages: Math.ceil(count / pageSize),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/orders/:orderId  [AUTH REQUIRED] ───────────────────────────────
router.get('/:orderId', requireAuth, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select(`
        *,
        order_items (
          id, foodItemId, quantity, price,
          food_items ( id, name, description, category, imageUrl )
        )
      `)
      .eq('orderId', req.params.orderId)
      .eq('user_id', req.user.id)           // ← user can only see their own
      .single();

    if (error || !data) throw createError(404, 'NOT_FOUND', `Order ${req.params.orderId} not found`);

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/orders/:orderId/status  [AUTH REQUIRED — admin] ────────────────
router.put('/:orderId/status', requireAuth, async (req, res, next) => {
  try {
    const parsed = OrderStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(400, 'VALIDATION_ERROR', parsed.error.errors.map(e => e.message).join(', '));
    }

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('orders')
      .select('id, status')
      .eq('orderId', req.params.orderId)
      .single();

    if (fetchErr || !existing) throw createError(404, 'NOT_FOUND', `Order ${req.params.orderId} not found`);

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status: parsed.data.status })
      .eq('orderId', req.params.orderId)
      .select()
      .single();

    if (error) throw createError(500, 'DB_ERROR', error.message);

    res.json({ data, message: `Order status updated to ${parsed.data.status}` });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/orders/:orderId  [AUTH REQUIRED — cancel pending] ────────────
router.delete('/:orderId', requireAuth, async (req, res, next) => {
  try {
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('orders')
      .select('id, status, user_id')
      .eq('orderId', req.params.orderId)
      .single();

    if (fetchErr || !existing) throw createError(404, 'NOT_FOUND', `Order ${req.params.orderId} not found`);
    if (existing.user_id !== req.user.id) throw createError(403, 'FORBIDDEN', 'You cannot cancel this order');
    if (existing.status !== 'Pending')    throw createError(400, 'CANNOT_CANCEL', 'Only Pending orders can be cancelled');

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status: 'Cancelled' })
      .eq('orderId', req.params.orderId)
      .select()
      .single();

    if (error) throw createError(500, 'DB_ERROR', error.message);

    res.json({ data, message: 'Order cancelled successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
