const { createClient } = require('@supabase/supabase-js');
const { createError } = require('./errorHandler');

// Lightweight Supabase client just for JWT verification
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * requireAuth — verifies the Supabase JWT from Authorization header.
 * Attaches req.user = { id, email, ... } on success.
 */
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw createError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header');
    }

    const token = authHeader.split(' ')[1];

    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);

    if (error || !user) {
      throw createError(401, 'UNAUTHORIZED', 'Invalid or expired token. Please log in again.');
    }

    req.user = user;   // { id, email, user_metadata, ... }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * optionalAuth — same as requireAuth but does NOT fail if token is absent.
 * Useful for routes that work with or without a logged-in user.
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }

    const token = authHeader.split(' ')[1];
    const { data: { user } } = await supabaseAuth.auth.getUser(token);
    req.user = user || null;
    next();
  } catch (_) {
    req.user = null;
    next();
  }
};

module.exports = { requireAuth, optionalAuth };
