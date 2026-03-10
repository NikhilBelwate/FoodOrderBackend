const logger = require('../config/logger');

const requestLogger = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(
      {
        method:   req.method,
        path:     req.path,
        status:   res.statusCode,
        duration: `${duration}ms`,
        ip:       req.ip,
      },
      `${req.method} ${req.path} ${res.statusCode} ${duration}ms`
    );
  });
  next();
};

module.exports = requestLogger;
