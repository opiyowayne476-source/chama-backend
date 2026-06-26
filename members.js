'use strict';
const express = require('express');
const router  = express.Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const { requireAuth } = require('../middleware/auth');
const { getAllMembers, addMember, writeAuditLog } = require('../services/sheets');
const { normalisePhone, maskPhone, isValidName } = require('../utils/validation');
const { logger } = require('../utils/logger');

// All member routes require authentication
router.use(requireAuth);

// ----------------------------------------------------------------
// GET /api/members — list all members (phones masked)
// ----------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const members = await getAllMembers();
    // Mask phone numbers in the API response — full numbers stay in Sheets
    const safe = members.map(m => ({ ...m, phone: maskPhone(m.phone) }));
    res.json({ members: safe, count: safe.length });
  } catch (err) {
    logger.error(`GET /members error: ${err.message}`);
    res.status(500).json({ error: 'Could not fetch members.' });
  }
});

// ----------------------------------------------------------------
// POST /api/members — add a new member
// ----------------------------------------------------------------
router.post('/',
  body('name').trim().notEmpty(),
  body('phone').trim().notEmpty(),
  body('role').optional().isIn(['Member', 'Admin']),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed.', details: errors.array() });

    const { name, phone, role = 'Member' } = req.body;

    if (!isValidName(name)) {
      return res.status(400).json({ error: 'Invalid name format.' });
    }

    const normPhone = normalisePhone(phone);
    if (!normPhone) {
      return res.status(400).json({ error: 'Invalid Kenyan phone number.' });
    }

    try {
      // Check for duplicate
      const all = await getAllMembers();
      if (all.find(m => m.phone === normPhone)) {
        return res.status(409).json({ error: 'A member with this phone number already exists.' });
      }

      const id = uuidv4();
      await addMember({ id, name: name.trim(), phone: normPhone, role });
      await writeAuditLog({
        adminId: req.admin.id,
        action:  'ADD_MEMBER',
        details: { memberId: id, name: name.trim(), role },
        ip:      req.ip,
      });

      logger.info(`Member added by ${req.admin.email}: ${name.trim()}`);
      res.status(201).json({ id, name: name.trim(), phone: maskPhone(normPhone), role });

    } catch (err) {
      logger.error(`POST /members error: ${err.message}`);
      res.status(500).json({ error: 'Could not add member.' });
    }
  }
);

module.exports = router;
