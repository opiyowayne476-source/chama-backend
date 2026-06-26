'use strict';
const express = require('express');
const router  = express.Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const { requireAuth } = require('../middleware/auth');
const {
  getAllCampaigns, getMemberByPhone, updateMemberTotal,
  updateCampaignCollected, recordContribution, writeAuditLog, appendRow,
} = require('../services/sheets');
const { isValidAmount, sanitiseText, normalisePhone } = require('../utils/validation');
const { logger } = require('../utils/logger');

router.use(requireAuth);

// ----------------------------------------------------------------
// POST /api/admin-contrib  — Submit a manual contribution for approval
// ----------------------------------------------------------------
router.post('/',
  body('campaignId').trim().notEmpty(),
  body('amount').isInt({ min: 1, max: 10_000_000 }),
  body('date').isISO8601(),
  body('method').trim().notEmpty().isLength({ max: 50 }),
  body('reference').optional().trim().isLength({ max: 100 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed.', details: errors.array() });

    const { campaignId, amount, date, method, reference = '' } = req.body;

    try {
      const campaigns = await getAllCampaigns();
      const campaign  = campaigns.find(c => c.id === campaignId && c.status === 'Active');
      if (!campaign) return res.status(404).json({ error: 'Active campaign not found.' });

      const pendingId = uuidv4();
      // Store in a pending approvals sheet — requires second admin to approve
      await appendRow('PendingApprovals', [
        pendingId,
        req.admin.id,
        req.admin.email,
        campaignId,
        campaign.title,
        parseInt(amount),
        date,
        sanitiseText(method),
        sanitiseText(reference),
        'Pending',
        new Date().toISOString(),
        '', // approvedBy (filled when approved)
      ]);

      await writeAuditLog({
        adminId: req.admin.id,
        action:  'ADMIN_CONTRIB_SUBMITTED',
        details: { pendingId, campaignId, amount },
        ip:      req.ip,
      });

      logger.info(`Admin contrib submitted by ${req.admin.email}: KES ${amount} → ${campaign.title}`);
      res.status(202).json({
        message:   'Contribution submitted and awaiting approval from a second admin.',
        pendingId,
      });
    } catch (err) {
      logger.error(`POST /admin-contrib error: ${err.message}`);
      res.status(500).json({ error: 'Could not submit contribution.' });
    }
  }
);

// ----------------------------------------------------------------
// POST /api/admin-contrib/approve/:pendingId — Second admin approves
// ----------------------------------------------------------------
router.post('/approve/:pendingId', async (req, res) => {
  const { pendingId } = req.params;
  if (!pendingId || !/^[0-9a-f-]{36}$/i.test(pendingId)) {
    return res.status(400).json({ error: 'Invalid pending ID.' });
  }

  try {
    const { readSheet, updateCell } = require('../services/sheets');
    const rows = await readSheet('PendingApprovals', 'A2:L');
    const rowIndex = rows.findIndex(r => r[0] === pendingId);
    if (rowIndex === -1) return res.status(404).json({ error: 'Pending approval not found.' });

    const row = rows[rowIndex];
    if (row[9] !== 'Pending') return res.status(409).json({ error: 'Already processed.' });

    // Prevent self-approval
    if (row[1] === req.admin.id) {
      return res.status(403).json({ error: 'You cannot approve your own contribution.' });
    }

    const submitterId = row[1];
    const campaignId  = row[3];
    const amount      = parseInt(row[5]);
    const date        = row[6];
    const method      = row[7];

    // Mark as approved
    await updateCell('PendingApprovals', `J${rowIndex + 2}`, 'Approved');
    await updateCell('PendingApprovals', `L${rowIndex + 2}`, req.admin.id);

    // Get submitter's phone from Admins sheet and match to Member
    // For simplicity, record under admin email as identifier
    await recordContribution({
      id: uuidv4(), memberPhone: row[2], memberName: row[2].split('@')[0],
      amount, campaignId, date, source: `Manual (${method})`, txId: pendingId, adminId: req.admin.id,
    });
    await updateCampaignCollected(campaignId, amount);

    await writeAuditLog({
      adminId: req.admin.id, action: 'ADMIN_CONTRIB_APPROVED',
      details: { pendingId, amount, approvedBy: req.admin.email }, ip: req.ip,
    });

    logger.info(`Admin contrib ${pendingId} approved by ${req.admin.email}`);
    res.json({ message: 'Contribution approved and recorded successfully.' });

  } catch (err) {
    logger.error(`Approve contrib error: ${err.message}`);
    res.status(500).json({ error: 'Could not approve contribution.' });
  }
});

// ----------------------------------------------------------------
// GET /api/admin-contrib/pending — List pending approvals
// ----------------------------------------------------------------
router.get('/pending', async (req, res) => {
  try {
    const { readSheet } = require('../services/sheets');
    const rows = await readSheet('PendingApprovals', 'A2:L');
    const pending = rows
      .filter(r => r[9] === 'Pending')
      .map(r => ({
        pendingId:  r[0],
        submittedBy: r[2],
        campaignId: r[3],
        campaign:   r[4],
        amount:     parseInt(r[5]) || 0,
        date:       r[6],
        method:     r[7],
        submittedAt: r[10],
      }));
    res.json({ pending });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch pending approvals.' });
  }
});

module.exports = router;
