const express = require('express');
const { z }   = require('zod');
const { supabase, supabaseAdmin } = require('../config/supabase');
const { createError } = require('../middleware/errorHandler');

const router = express.Router();

// ─── In-memory cache for food items ─────────────────────────────────────────
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const invalidateCache = () => { cache = null; cacheTime = 0; };

// ─── Validation Schemas ──────────────────────────────────────────────────────
const FoodItemSchema = z.object({
  name:        z.string().min(1).max(255),
  description: z.string().optional(),
  category:    z.enum(['Sandwiches', 'Pizza', 'Cake','Desserts','Drinks','Main Course','Burgers']),
  price:       z.number().positive(),
  imageUrl:    z.string().url().optional().or(z.literal('')),
  available:   z.boolean().optional().default(true),
});

// ─── GET /api/food-items ─────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { category } = req.query;

    // Serve from cache when no category filter
    if (!category && cache && Date.now() - cacheTime < CACHE_TTL) {
      return res.json({ data: cache, cached: true });
    }

    let query = supabase
      .from('food_items')
      .select('*')
      .eq('available', true)
      .order('"createdAt"', { ascending: true });

    if (category) {
      const validCategories = ['Sandwiches', 'Pizza', 'Cake'];
      if (!validCategories.includes(category)) {
        throw createError(400, 'INVALID_CATEGORY', `Category must be one of: ${validCategories.join(', ')}`);
      }
      query = query.eq('category', category);
    }

    const { data, error } = await query;
    if (error) throw createError(500, 'DB_ERROR', error.message);

    if (!category) {
      cache     = data;
      cacheTime = Date.now();
    }

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/food-items/:id ─────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('food_items')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) throw createError(404, 'NOT_FOUND', 'Food item not found');

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/food-items (Admin) ─────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const parsed = FoodItemSchema.safeParse(req.body);
    if (!parsed.success) {
      throw createError(400, 'VALIDATION_ERROR', parsed.error.errors.map(e => e.message).join(', '));
    }

    const { data, error } = await supabaseAdmin
      .from('food_items')
      .insert([parsed.data])
      .select()
      .single();

    if (error) throw createError(500, 'DB_ERROR', error.message);

    invalidateCache();
    res.status(201).json({ data, message: 'Food item created successfully' });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/food-items/:id (Admin) ─────────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const parsed = FoodItemSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      throw createError(400, 'VALIDATION_ERROR', parsed.error.errors.map(e => e.message).join(', '));
    }

    const { data, error } = await supabaseAdmin
      .from('food_items')
      .update(parsed.data)
      .eq('id', req.params.id)
      .select();

    if (error || !data) throw createError(404, 'NOT_FOUND', 'Food item not found'+error.message);

    invalidateCache();
    res.json({ data, message: 'Food item updated successfully' });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/food-items/:id (Admin) ──────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabaseAdmin
      .from('food_items')
      .delete()
      .eq('id', req.params.id);

    if (error) throw createError(500, 'DB_ERROR', error.message);

    invalidateCache();
    res.json({ message: 'Food item deleted successfully' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
