/**
 * foodItems.js
 *
 * Categories are now dynamic (stored in the `categories` DB table).
 * Category names are validated against the DB on every write.
 * A short-lived in-memory cache avoids a DB round-trip on every request.
 *
 * New filter: ?is_veg=true|false on GET /api/food-items
 */

const express = require('express');
const { z }   = require('zod');
const { supabase, supabaseAdmin } = require('../config/supabase');
const { createError }    = require('../middleware/errorHandler');
const { requireAdminKey } = require('../middleware/adminMiddleware');

const router = express.Router();

// ── In-memory cache for public food items ────────────────────────────────────
let itemCache     = null;
let itemCacheTime = 0;
const ITEM_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const invalidateCache = () => { itemCache = null; itemCacheTime = 0; };

// ── Category name cache (1-min TTL) ──────────────────────────────────────────
let categoryNames     = null;
let categoryNamesTime = 0;
const CAT_NAME_TTL    = 60 * 1000; // 1 minute

async function getValidCategoryNames() {
  if (categoryNames && Date.now() - categoryNamesTime < CAT_NAME_TTL) {
    return categoryNames;
  }
  const { data, error } = await supabaseAdmin
    .from('categories')
    .select('name')
    .eq('active', true);
  if (error) throw new Error('Failed to load categories: ' + error.message);
  categoryNames     = data.map(c => c.name);
  categoryNamesTime = Date.now();
  return categoryNames;
}

const invalidateCategoryCache = () => { categoryNames = null; categoryNamesTime = 0; };

// ── Validation Schemas ────────────────────────────────────────────────────────
// category validated dynamically against DB — not a hardcoded Zod enum
const FoodItemSchema = z.object({
  name:             z.string().min(1).max(255),
  description:      z.string().optional().nullable(),
  category:         z.string().min(1).max(100),
  price:            z.number().positive(),
  imageUrl:         z.string().url().optional().or(z.literal('')).nullable(),
  available:        z.boolean().optional().default(true),
  is_available:     z.boolean().optional().default(true),
  is_veg:           z.boolean().optional().default(false),
  discount_percent: z.number().min(0).max(100).optional().default(0),
  offer_label:      z.string().max(100).optional().nullable(),
});

const PriceUpdateSchema = z.object({
  price: z.number().positive(),
});

const OfferUpdateSchema = z.object({
  discount_percent: z.number().min(0).max(100),
  offer_label:      z.string().max(100).optional().nullable(),
});

const BulkPriceSchema = z.object({
  category:    z.string().min(1).max(100),
  change_type: z.enum(['percent_increase', 'percent_decrease', 'set_percent_discount']),
  value:       z.number().positive().max(100),
});

// ── Helper: validate category name against DB ─────────────────────────────────
async function assertCategoryExists(categoryName) {
  const valid = await getValidCategoryNames();
  if (!valid.includes(categoryName)) {
    throw createError(
      400,
      'INVALID_CATEGORY',
      'Category "' + categoryName + '" does not exist. Valid: ' + valid.join(', ')
    );
  }
}

// ── GET /api/food-items  (public) ─────────────────────────────────────────────
// Query params: category (optional), is_veg=true|false (optional)
router.get('/', async (req, res, next) => {
  try {
    const { category, is_veg } = req.query;
    const useCache = !category && is_veg === undefined;

    if (useCache && itemCache && Date.now() - itemCacheTime < ITEM_CACHE_TTL) {
      return res.json({ data: itemCache, cached: true });
    }

    let query = supabase
      .from('food_items')
      .select('*')
      .eq('available', true)
      .order('"createdAt"', { ascending: true });

    if (category) query = query.eq('category', category);
    if (is_veg !== undefined) query = query.eq('is_veg', is_veg === 'true');

    const { data, error } = await query;
    if (error) throw createError(500, 'DB_ERROR', error.message);

    if (useCache) { itemCache = data; itemCacheTime = Date.now(); }

    res.json({ data });
  } catch (err) { next(err); }
});

// ── GET /api/food-items/admin  (admin — ALL items) ───────────────────────────
// NOTE: must be BEFORE /:id to avoid 'admin' matching as an id param
router.get('/admin', requireAdminKey, async (req, res, next) => {
  try {
    const { category, search, is_veg } = req.query;

    let query = supabaseAdmin
      .from('food_items')
      .select('*')
      .order('"createdAt"', { ascending: false });

    if (category)          query = query.eq('category', category);
    if (search)            query = query.ilike('name', '%' + search + '%');
    if (is_veg !== undefined) query = query.eq('is_veg', is_veg === 'true');

    const { data, error } = await query;
    if (error) throw createError(500, 'DB_ERROR', error.message);

    res.json({ data });
  } catch (err) { next(err); }
});

// ── GET /api/food-items/:id  (public) ────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('food_items')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) throw createError(404, 'NOT_FOUND', 'Food item not found');
    res.json({ data });
  } catch (err) { next(err); }
});

// ── POST /api/food-items  (admin — create) ────────────────────────────────────
router.post('/', requireAdminKey, async (req, res, next) => {
  try {
    const parsed = FoodItemSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(400, 'VALIDATION_ERROR',
        parsed.error.errors.map(e => e.path.join('.') + ': ' + e.message).join(' | '));
    }

    await assertCategoryExists(parsed.data.category);

    const { data, error } = await supabaseAdmin
      .from('food_items')
      .insert([parsed.data])
      .select()
      .single();

    if (error) throw createError(500, 'DB_ERROR', error.message);

    invalidateCache();
    res.status(201).json({ data, message: 'Food item created successfully' });
  } catch (err) { next(err); }
});

// ── PUT /api/food-items/:id  (admin — full update) ───────────────────────────
router.put('/:id', requireAdminKey, async (req, res, next) => {
  try {
    const parsed = FoodItemSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      throw createError(400, 'VALIDATION_ERROR',
        parsed.error.errors.map(e => e.path.join('.') + ': ' + e.message).join(' | '));
    }

    if (parsed.data.category) await assertCategoryExists(parsed.data.category);

    const { data, error } = await supabaseAdmin
      .from('food_items')
      .update(parsed.data)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) throw createError(404, 'NOT_FOUND', 'Food item not found');

    invalidateCache();
    res.json({ data, message: 'Food item updated successfully' });
  } catch (err) { next(err); }
});

// ── PATCH /api/food-items/:id/price  (admin) ──────────────────────────────────
router.patch('/:id/price', requireAdminKey, async (req, res, next) => {
  try {
    const parsed = PriceUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(400, 'VALIDATION_ERROR', parsed.error.errors.map(e => e.message).join(', '));
    }

    const { data, error } = await supabaseAdmin
      .from('food_items')
      .update({ price: parsed.data.price })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) throw createError(404, 'NOT_FOUND', 'Food item not found');

    invalidateCache();
    res.json({ data, message: 'Price updated successfully' });
  } catch (err) { next(err); }
});

// ── PATCH /api/food-items/:id/offer  (admin) ──────────────────────────────────
router.patch('/:id/offer', requireAdminKey, async (req, res, next) => {
  try {
    const parsed = OfferUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(400, 'VALIDATION_ERROR', parsed.error.errors.map(e => e.message).join(', '));
    }

    const { data, error } = await supabaseAdmin
      .from('food_items')
      .update({ discount_percent: parsed.data.discount_percent, offer_label: parsed.data.offer_label || null })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) throw createError(404, 'NOT_FOUND', 'Food item not found');

    invalidateCache();
    res.json({ data, message: 'Offer updated successfully' });
  } catch (err) { next(err); }
});

// ── PATCH /api/food-items/:id/toggle  (admin — toggle availability) ───────────
router.patch('/:id/toggle', requireAdminKey, async (req, res, next) => {
  try {
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('food_items')
      .select('id, available, is_available')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !existing) throw createError(404, 'NOT_FOUND', 'Food item not found');

    const newAvailable = !(existing.available ?? existing.is_available ?? true);

    const { data, error } = await supabaseAdmin
      .from('food_items')
      .update({ available: newAvailable, is_available: newAvailable })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw createError(500, 'DB_ERROR', error.message);

    invalidateCache();
    res.json({ data, message: 'Item ' + (newAvailable ? 'enabled' : 'disabled') + ' successfully' });
  } catch (err) { next(err); }
});

// ── POST /api/food-items/bulk-price  (admin — batch price update) ─────────────
router.post('/bulk-price', requireAdminKey, async (req, res, next) => {
  try {
    const parsed = BulkPriceSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(400, 'VALIDATION_ERROR', parsed.error.errors.map(e => e.message).join(', '));
    }

    const { category, change_type, value } = parsed.data;
    await assertCategoryExists(category);

    const { data: items, error: fetchErr } = await supabaseAdmin
      .from('food_items')
      .select('id, price')
      .eq('category', category);

    if (fetchErr) throw createError(500, 'DB_ERROR', fetchErr.message);
    if (!items || items.length === 0) {
      throw createError(404, 'NOT_FOUND', 'No items found in category "' + category + '"');
    }

    const updates = items.map(item => {
      let p = parseFloat(item.price);
      if (change_type === 'percent_increase') p = p * (1 + value / 100);
      else if (change_type === 'percent_decrease') p = p * (1 - value / 100);
      return { id: item.id, price: Math.max(0.01, parseFloat(p.toFixed(2))) };
    });

    const { error: updateErr } = await supabaseAdmin
      .from('food_items')
      .upsert(updates, { onConflict: 'id' });
    if (updateErr) throw createError(500, 'DB_ERROR', updateErr.message);

    if (change_type === 'set_percent_discount') {
      const { error: dErr } = await supabaseAdmin
        .from('food_items')
        .update({ discount_percent: value })
        .eq('category', category);
      if (dErr) throw createError(500, 'DB_ERROR', dErr.message);
    }

    invalidateCache();
    res.json({ message: 'Bulk update applied to ' + items.length + ' item(s) in "' + category + '"', affected: items.length });
  } catch (err) { next(err); }
});

// ── DELETE /api/food-items/:id  (admin) ───────────────────────────────────────
router.delete('/:id', requireAdminKey, async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('food_items')
      .delete()
      .eq('id', req.params.id);

    if (error) throw createError(500, 'DB_ERROR', error.message);

    invalidateCache();
    res.json({ message: 'Food item deleted successfully' });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.invalidateCategoryCache = invalidateCategoryCache;
