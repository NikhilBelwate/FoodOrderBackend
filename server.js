require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const logger     = require('./config/logger');
const requestLogger  = require('./middleware/requestLogger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const foodItemsRouter = require('./routes/foodItems');
const ordersRouter    = require('./routes/orders');
const adminRouter     = require('./routes/admin');
const categoriesRouter = require('./routes/categories');
const { createGraphQLServer } = require('./graphql/yoga');

// When categories change, bust the category-name cache inside foodItems.js
categoriesRouter.on && categoriesRouter.on('category_changed', () => {
  foodItemsRouter.invalidateCategoryCache && foodItemsRouter.invalidateCategoryCache();
});

const app  = express();
const PORT = process.env.PORT || 5000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:3001',
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key'],
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
app.use('/api/admin',      adminRouter);
app.use('/api/categories', categoriesRouter);

// ─── GraphQL API ──────────────────────────────────────────────────────────────
const yoga = createGraphQLServer();
app.use('/graphql', yoga);

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`🚀 FoodOrder Backend running on http://localhost:${PORT}`);
    logger.info(`   Environment : ${process.env.NODE_ENV || 'development'}`);
    logger.info(`   Supabase    : ${process.env.SUPABASE_URL ? 'Connected' : 'NOT CONFIGURED'}`);
    logger.info(`   GraphQL     : http://localhost:${PORT}/graphql`);
    logger.info(`   Admin API   : http://localhost:${PORT}/api/admin  [X-Admin-Key required]`);
    logger.info(`   Categories  : http://localhost:${PORT}/api/categories`);
    logger.info(`   Admin Key   : ${process.env.ADMIN_SECRET_KEY ? 'Set ✓' : 'NOT SET — admin routes will return 500'}`);
  });
}

module.exports = app;
