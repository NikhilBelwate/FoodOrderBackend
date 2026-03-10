const logger = require('../config/logger');

/**
 * Central error-handling middleware.
 * Converts any thrown error into a consistent JSON response.
 */
const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || err.status || 500;
  const errorCode  = err.code || 'INTERNAL_SERVER_ERROR';
  const message    = err.message || 'An unexpected error occurred';

  logger.error({ err, path: req.path, method: req.method }, 'Request error');

  res.status(statusCode).json({
    error:      errorCode,
    message,
    statusCode,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

/**
 * Helper to create structured API errors.
 */
const createError = (statusCode, code, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
};

/**
 * 404 handler — mount before errorHandler in app.
 */
const notFoundHandler = (req, res, next) => {
  next(createError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

module.exports = { errorHandler, notFoundHandler, createError };
