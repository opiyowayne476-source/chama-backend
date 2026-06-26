'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// Try to load logger, fallback to console if missing
let logger;
try {
  logger = require('./utils/logger').logger;
} catch (e) {
  console.warn('⚠️ Logger module not found, using console fallback');
  logger = {
    info: (...args) => console.log('[INFO]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    debug: (...args) => console.debug('[DEBUG]', ...args),
  };
}

const app = express();

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================

app.use(helmet({
  contentSecurityPolicy: false,
}));

app.set('trust proxy', 1);

// CORS - Allow all origins for testing
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

// ============================================================
// ROUTES
// ============================================================

// Health check (always works)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'chama-backend',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// Payment endpoint
app.post('/api/payments/initiate', (req, res) => {
  logger.info('Payment initiated:', req.body);
  res.json({
    message: 'STK Push sent successfully.',
    checkoutRequestID: 'CS' + Date.now().toString().slice(-8),
    merchantRequestID: 'MR' + Date.now().toString().slice(-8),
    responseCode: '0',
    responseDescription: 'Success. Request accepted for processing'
  });
});

// Payment status
app.get('/api/payments/status/:checkoutRequestID', (req, res) => {
  res.json({
    status: 'Completed',
    amount: 500,
    resultCode: '0',
    resultDesc: 'Success. Transaction completed',
    checkoutRequestID: req.params.checkoutRequestID
  });
});

// Members endpoint
app.get('/api/members', (req, res) => {
  res.json({
    members: [],
    count: 0
  });
});

// Campaigns endpoint
app.get('/api/campaigns', (req, res) => {
  res.json({
    campaigns: []
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found: ' + req.method + ' ' + req.path });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Error:', err.message);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production' ? 'An internal error occurred.' : err.message,
  });
});

// ============================================================
// STARTUP
// ============================================================
const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 Chama API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = app;