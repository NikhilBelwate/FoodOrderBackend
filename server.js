require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const logger     = require('./config/logger');
const requestLogger  = require('./middleware/requestLogger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const foodItemsRouter = require('./routes/foodItems');
const ordersRouter    = require('./routes/orders');

const app  = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:3001',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'OK',
    service:   'FoodOrder Backend',
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV,
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/food-items', foodItemsRouter);
app.use('/api/orders',     ordersRouter);

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`🚀 FoodOrder Backend running on http://localhost:${PORT}`);
  logger.info(`   Environment : ${process.env.NODE_ENV || 'development'}`);
  logger.info(`   Supabase    : ${process.env.SUPABASE_URL ? 'Connected' : 'NOT CONFIGURED'}`);
});

module.exports = app;
