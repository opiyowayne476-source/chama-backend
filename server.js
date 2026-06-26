'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { logger } = require('./utils/logger');
const { startScheduler } = require('./services/scheduler');

// --- Route imports ---
const authRoutes = require('./routes/auth');
const memberRoutes = require('./routes/members');
const campaignRoutes = require('./routes/campaigns');
const paymentRoutes = require('./routes/payments');
const reportRoutes = require('./routes/reports');
const adminContribRoutes = require('./routes/adminContrib');
const webhookRoutes = require('./routes/webhook'); // Daraja + WhatsApp
const healthRoutes = require('./routes/health');

const app = express();

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================

// Set secure HTTP headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

// Trust proxy (needed if behind Nginx/load balancer)
app.set('trust proxy', 1);

// CORS — restrict to your frontend domain in production
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',');
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS policy violation'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Parse JSON — size limit prevents payload DoS
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`Rate limit hit from ${req.ip}`);
    res.status(429).json({ error: 'Too many requests. Please slow down.' });
  },
});
app.use(globalLimiter);

// Stricter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

// ============================================================
// ROUTES
// ============================================================
app.use('/health', healthRoutes);

// Webhooks first (before JSON body parser because Daraja needs raw body for HMAC)
app.use('/webhook', webhookRoutes);

// Auth (with tight rate limit)
app.use('/api/auth', authLimiter, authRoutes);

// Protected API routes (JWT required — enforced inside each router)
app.use('/api/members', memberRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin-contrib', adminContribRoutes);

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // Never leak stack traces to the client
  logger.error({ message: err.message, stack: err.stack, path: req.path });
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production'
      ? 'An internal error occurred.'
      : err.message,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ============================================================
// STARTUP
// ============================================================
const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  logger.info(`Chama API running on port ${PORT} [${process.env.NODE_ENV}]`);
  startScheduler();
});

module.exports = app; // for tests