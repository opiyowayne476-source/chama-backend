'use strict';
const express = require('express');
const router  = express.Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const { requireAuth } = require('../middleware/auth');
const { getAllCampaigns, getActiveCampaigns, addCampaign, writeAuditLog } = require('../services/sheets');
const { sanitiseText, isValidAmount } = require('../utils/validation');
const { logger } = require('../utils/logger');

router.use(requireAuth);

// GET /api/campaigns
router.get('/', async (req, res) => {
  try {
    const campaigns = await getAllCampaigns();
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch campaigns.' });
  }
});

// GET /api/campaigns/active
router.get('/active', async (req, res) => {
  try {
    res.json({ campaigns: await getActiveCampaigns() });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch active campaigns.' });
  }
});

// POST /api/campaigns
router.post('/',
  body('title').trim().notEmpty().isLength({ max: 100 }),
  body('beneficiary').trim().notEmpty().isLength({ max: 100 }),
  body('goal').isInt({ min: 100, max: 10_000_000 }),
  body('startDate').isISO8601(),
  body('endDate').isISO8601(),
  body('tills').isArray({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed.', details: errors.array() });

    const { title, beneficiary, goal, startDate, endDate, tills } = req.body;

    if (new Date(endDate) <= new Date(startDate)) {
      return res.status(400).json({ error: 'End date must be after start date.' });
    }

    const safeTills = tills
      .map(t => sanitiseText(String(t), 20))
      .filter(t => /^[\d+\s-]+$/.test(t));

    if (safeTills.length === 0) {
      return res.status(400).json({ error: 'At least one valid till/paybill number required.' });
    }

    try {
      const id = uuidv4().slice(0, 8).toUpperCase();
      const campaign = {
        id, title: sanitiseText(title), beneficiary: sanitiseText(beneficiary),
        goal: parseInt(goal), startDate, endDate, tills: safeTills,
      };
      await addCampaign(campaign);
      await writeAuditLog({
        adminId: req.admin.id, action: 'CREATE_CAMPAIGN',
        details: { id, title: campaign.title, goal: campaign.goal }, ip: req.ip,
      });
      logger.info(`Campaign created by ${req.admin.email}: ${campaign.title}`);
      res.status(201).json(campaign);
    } catch (err) {
      logger.error(`POST /campaigns error: ${err.message}`);
      res.status(500).json({ error: 'Could not create campaign.' });
    }
  }
);

module.exports = router;
