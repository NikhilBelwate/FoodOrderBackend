/**
 * categories.js — Category management routes
 *
 * Public:
 *   GET  /api/categories          — list all active categories (used by menu page)
 *
 * Admin (X-Admin-Key required):
 *   GET  /api/categories/all      — list ALL categories including inactive
 *   POST /api/categories          — create new category
 *   PUT  /api/categories/:id      — update category
 *   DELETE /api/categories/:id    — delete category (only if no food items use it)
 *
 * DB schema (from 07_categories_veg.sql):
 *   id, name (unique), description, is_veg_only, sort_order, active,
 *   "createdAt", "updatedAt"
 */

const express = require('express');
const { z }   = require('zod');
const { supabase, supabaseAdmin } = require('../config/supabase');
const { createError }    = require('../middleware/errorHandler');
const { requireAdminKey } = require('../middleware/adminMiddleware');

const router = express.Router();

// ─── In-memory cache for public categories list ──────────────────────────────
let catCache     = null;
let catCacheTime = 0;
const CAT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const invalidateCatCache = () => { catCache = null; catCacheTime = 0; };

// ─── Validation Schemas ──────────────────────────────────────────────────────
const CategorySchema = z.object({
  name:        z.string().min(1).max(100).trim(),
  description: z.string().max(500).optional().nullable(),
  is_veg_only: z.boolean().optional().default(false),
  sort_order:  z.number().int().min(0).optional().default(0),
  active:      z.boolean().optional().default(true),
});

// ─── GET /api/categories  (public — active only, ordered) ────────────────────
router.get('/', async (req, res, next) => {
  try {
    // Serve from cache
    if (catCache && Date.now() - catCacheTime < CAT_CACHE_TTL) {
      return res.json({ data: catCache, cached: true });
    }

    const { data, error } = await supabase
      .from('categories')
      .select('id, name, description, is_veg_only, sort_order')
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('name',       { ascending: true });

    if (error) throw createError(500, 'DB_ERROR', error.message);

    catCache     = data;
    catCacheTime = Date.now();

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/categories/all  (admin — including inactive) ───────────────────
router.get('/all', requireAdminKey, async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('categories')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name',       { ascending: true });

    if (error) throw createError(500, 'DB_ERROR', error.message);

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/categories  (admin — create) ──────────────────────────────────
router.post('/', requireAdminKey, async (req, res, next) => {
  try {
    const parsed = CategorySchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(400, 'VALIDATION_ERROR',
        parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(' | '));
    }

    const { data, error } = await supabaseAdmin
      .from('categories')
      .insert([parsed.data])
      .select()
      .single();

    if (error) {
      // Unique constraint violation
      if (error.code === '23505') {
        throw createError(409, 'DUPLICATE_CATEGORY', `Category "${parsed.data.name}" already exists.`);
      }
      throw createError(500, 'DB_ERROR', error.message);
    }

    invalidateCatCache();
    res.status(201).json({ data, message: `Category "${data.name}" created successfully.` });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/categories/:id  (admin — update) ───────────────────────────────
router.put('/:id', requireAdminKey, async (req, res, next) => {
  try {
    const parsed = CategorySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      throw createError(400, 'VALIDATION_ERROR',
        parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(' | '));
    }

    const { data, error } = await supabaseAdmin
      .from('categories')
      .update(parsed.data)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw createError(409, 'DUPLICATE_CATEGORY', `A category with that name already exists.`);
      }
      throw createError(500, 'DB_ERROR', error.message);
    }
    if (!data) throw createError(404, 'NOT_FOUND', 'Category not found');

    invalidateCatCache();
    res.json({ data, message: `Category "${data.name}" updated successfully.` });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/categories/:id  (admin — delete or deactivate) ──────────────
// If any food items still reference this category, deactivates instead of hard-deletes.
router.delete('/:id', requireAdminKey, async (req, res, next) => {
  try {
    // Find the category first
    const { data: cat, error: fetchErr } = await supabaseAdmin
      .from('categories')
      .select('id, name')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !cat) throw createError(404, 'NOT_FOUND', 'Category not found');

    // Check if any food items still use this category name
    const { count, error: countErr } = await supabaseAdmin
      .from('food_items')
      .select('*', { count: 'exact', head: true })
      .eq('category', cat.name);

    if (countErr) throw createError(500, 'DB_ERROR', countErr.message);

    if (count > 0) {
      // Can't hard-delete — deactivate instead so menu still works
      const { data, error: deactErr } = await supabaseAdmin
        .from('categories')
        .update({ active: false })
        .eq('id', req.params.id)
        .select()
        .single();

      if (deactErr) throw createError(500, 'DB_ERROR', deactErr.message);

      invalidateCatCache();
      return res.json({
        data,
        message: `Category "${cat.name}" has ${count} food item(s) and was deactivated instead of deleted. Reassign or delete those items first to fully remove this category.`,
        deactivated: true,
      });
    }

    // Safe to hard-delete
    const { error: delErr } = await supabaseAdmin
      .from('categories')
      .delete()
      .eq('id', req.params.id);

    if (delErr) throw createError(500, 'DB_ERROR', delErr.message);

    invalidateCatCache();
    res.json({ message: `Category "${cat.name}" deleted successfully.` });
  } catch (err) {
    next(err);
  }
});

// Export cache invalidator so foodItems.js can call it when needed
module.exports = router;
module.exports.invalidateCatCache = invalidateCatCache;
