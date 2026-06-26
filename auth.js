'use strict';
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const qrcode    = require('qrcode');
const { body, validationResult } = require('express-validator');

const { getAdminByEmail, addAdmin, writeAuditLog } = require('../services/sheets');
const { logger } = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// ----------------------------------------------------------------
// POST /api/auth/login  — Step 1: email + password
// ----------------------------------------------------------------
router.post('/login',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid credentials format.' });

    const { email, password } = req.body;
    try {
      const admin = await getAdminByEmail(email);

      // Use timing-safe comparison even for "not found" case
      const hashToCompare = admin?.passwordHash || '$2b$12$invalidhashtopreventtimingattack';
      const match = await bcrypt.compare(password, hashToCompare);

      if (!admin || !match || admin.status !== 'Active') {
        logger.warn(`Failed login attempt for ${email} from ${req.ip}`);
        // Generic error — don't reveal whether email exists
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      // Issue a short-lived pre-auth token (not full access)
      const preToken = jwt.sign(
        { id: admin.id, email: admin.email, step: 'pre-2fa' },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: '5m' }
      );

      logger.info(`Admin ${email} passed password check — awaiting 2FA`);
      res.json({ preToken, requires2FA: true });

    } catch (err) {
      logger.error(`Login error: ${err.message}`);
      res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  }
);

// ----------------------------------------------------------------
// POST /api/auth/verify-2fa  — Step 2: TOTP code
// ----------------------------------------------------------------
router.post('/verify-2fa',
  body('preToken').notEmpty(),
  body('totpCode').isLength({ min: 6, max: 6 }).isNumeric(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid 2FA code format.' });

    const { preToken, totpCode } = req.body;
    try {
      const payload = jwt.verify(preToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      if (payload.step !== 'pre-2fa') return res.status(401).json({ error: 'Invalid token stage.' });

      const admin = await getAdminByEmail(payload.email);
      if (!admin) return res.status(401).json({ error: 'Admin not found.' });

      const valid = speakeasy.totp.verify({
        secret:   admin.totpSecret,
        encoding: 'base32',
        token:    totpCode,
        window:   1, // allow ±30s clock drift
      });

      if (!valid) {
        logger.warn(`Invalid 2FA code for ${admin.email} from ${req.ip}`);
        return res.status(401).json({ error: 'Invalid or expired 2FA code.' });
      }

      const accessToken = jwt.sign(
        { id: admin.id, email: admin.email, role: admin.role },
        process.env.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
      );

      await writeAuditLog({
        adminId: admin.id,
        action:  'LOGIN',
        details: { email: admin.email },
        ip:      req.ip,
      });

      logger.info(`Admin ${admin.email} logged in successfully`);
      res.json({ accessToken, admin: { id: admin.id, email: admin.email, role: admin.role } });

    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Pre-auth token expired. Please log in again.' });
      }
      logger.error(`2FA verify error: ${err.message}`);
      res.status(500).json({ error: '2FA verification failed.' });
    }
  }
);

// ----------------------------------------------------------------
// POST /api/auth/setup-2fa  — Generate TOTP secret + QR code
// (called once when creating a new admin)
// ----------------------------------------------------------------
router.post('/setup-2fa',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 12 }),
  body('setupSecret').notEmpty(), // shared setup secret from .env
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid input.' });

    if (req.body.setupSecret !== process.env.ADMIN_SETUP_SECRET) {
      return res.status(403).json({ error: 'Invalid setup secret.' });
    }

    try {
      const existing = await getAdminByEmail(req.body.email);
      if (existing) return res.status(409).json({ error: 'Admin already exists.' });

      const secret = speakeasy.generateSecret({ name: `Chama (${req.body.email})`, length: 20 });
      const passwordHash = await bcrypt.hash(req.body.password, 12);
      const adminId = uuidv4();

      await addAdmin({
        id:           adminId,
        email:        req.body.email,
        passwordHash,
        role:         req.body.role || 'admin',
        totpSecret:   secret.base32,
      });

      const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);
      logger.info(`New admin created: ${req.body.email}`);
      res.json({
        message: 'Admin created. Scan the QR code with your authenticator app.',
        qrCode:  qrDataUrl,
        secret:  secret.base32, // show once — admin must store this
      });

    } catch (err) {
      logger.error(`Setup 2FA error: ${err.message}`);
      res.status(500).json({ error: 'Setup failed.' });
    }
  }
);

module.exports = router;
