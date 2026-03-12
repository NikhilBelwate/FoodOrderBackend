/**
 * adminMiddleware.js
 * Validates the X-Admin-Key header against the ADMIN_SECRET_KEY env var.
 * All admin-only routes use this middleware.
 *
 * Usage:
 *   const { requireAdminKey } = require('../middleware/adminMiddleware');
 *   router.post('/food-items', requireAdminKey, createHandler);
 */

const { createError } = require('./errorHandler');

/**
 * requireAdminKey — blocks requests without a valid X-Admin-Key header.
 * Rejects with 401 if header is missing, 403 if key is wrong.
 */
const requireAdminKey = (req, res, next) => {
  const adminKey = process.env.ADMIN_SECRET_KEY;

  if (!adminKey) {
    console.error('[requireAdminKey] ADMIN_SECRET_KEY is not set in environment!');
    return next(createError(500, 'CONFIG_ERROR', 'Admin functionality is not configured.'));
  }

  const providedKey = req.headers['x-admin-key'];

  if (!providedKey) {
    return next(createError(401, 'MISSING_ADMIN_KEY', 'Admin key is required.'));
  }

  if (providedKey !== adminKey) {
    return next(createError(403, 'INVALID_ADMIN_KEY', 'Invalid admin key.'));
  }

  next();
};

module.exports = { requireAdminKey };
