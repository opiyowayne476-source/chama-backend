// routes/payments.js - Complete with payment initiation
'use strict';
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const { requireAuth } = require('../middleware/auth');
const { stkPush, queryPaymentStatus, getPendingPayment } = require('../services/daraja');
const {
  getMemberByPhone, updateMemberTotal, updateCampaignCollected,
  recordContribution, getContributionsForCampaign, getAllCampaigns,
  writeAuditLog,
} = require('../services/sheets');
const { normalisePhone, maskPhone } = require('../utils/validation');
const { logger } = require('../utils/logger');

router.use(requireAuth);

// GET /api/payments?campaignId=xxx
router.get('/', async (req, res) => {
  try {
    const { campaignId } = req.query;
    if (!campaignId) return res.status(400).json({ error: 'campaignId is required.' });
    const contributions = await getContributionsForCampaign(campaignId);
    const safe = contributions.map(c => ({ ...c, memberPhone: maskPhone(c.memberPhone) }));
    res.json({ contributions: safe });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch payments.' });
  }
});

// GET /api/payments/unmatched
router.get('/unmatched', async (req, res) => {
  try {
    const { readSheet } = require('../services/sheets');
    const rows = await readSheet('UnmatchedPayments', 'A2:F');
    const unmatched = rows
      .filter(r => r[5] === 'Pending')
      .map(r => ({
        id: r[0], txId: r[1],
        phone: maskPhone(r[2]), amount: parseInt(r[3]) || 0,
        date: r[4],
      }));
    res.json({ unmatched });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch unmatched payments.' });
  }
});

// POST /api/payments/initiate - Initiate STK Push payment
router.post('/initiate',
  body('campaignId').trim().notEmpty(),
  body('phone').trim().notEmpty(),
  body('amount').isInt({ min: 1, max: 150000 }),
  body('accountRef').optional().trim().isLength({ max: 12 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation failed.', details: errors.array() });
    }

    const { campaignId, phone, amount, accountRef = 'Chama' } = req.body;

    try {
      // Validate campaign exists
      const campaigns = await getAllCampaigns();
      const campaign = campaigns.find(c => c.id === campaignId && c.status === 'Active');
      if (!campaign) {
        return res.status(404).json({ error: 'Active campaign not found.' });
      }

      // Validate phone
      const normPhone = normalisePhone(phone);
      if (!normPhone) {
        return res.status(400).json({ error: 'Invalid Kenyan phone number.' });
      }

      // Check if member exists (optional - can be anyone)
      const member = await getMemberByPhone(normPhone);

      // Initiate STK Push
      const result = await stkPush({
        phone: normPhone,
        amount,
        accountRef: accountRef || campaign.id,
        description: campaign.title.slice(0, 13),
        campaignId
      });

      // Log the initiation
      await writeAuditLog({
        adminId: req.admin.id,
        action: 'PAYMENT_INITIATED',
        details: { 
          campaignId, 
          phone: maskPhone(normPhone), 
          amount, 
          checkoutRequestID: result.CheckoutRequestID 
        },
        ip: req.ip,
      });

      logger.info(`Payment initiated: ${result.CheckoutRequestID} - ${normPhone} KES ${amount}`);

      res.json({
        message: 'STK Push sent successfully.',
        checkoutRequestID: result.CheckoutRequestID,
        merchantRequestID: result.MerchantRequestID,
        responseCode: result.ResponseCode,
        responseDescription: result.ResponseDescription
      });

    } catch (err) {
      logger.error(`Payment initiation error: ${err.message}`);
      res.status(500).json({ error: 'Failed to initiate payment. Please try again.' });
    }
  }
);

// GET /api/payments/status/:checkoutRequestID - Check payment status
router.get('/status/:checkoutRequestID', async (req, res) => {
  const { checkoutRequestID } = req.params;
  
  try {
    // Check local cache first
    const pending = await getPendingPayment(checkoutRequestID);
    if (pending && pending.status !== 'Pending') {
      return res.json({
        status: pending.status,
        amount: pending.amount,
        resultCode: pending.resultCode,
        resultDesc: pending.resultDesc
      });
    }

    // Query Daraja
    const result = await queryPaymentStatus(checkoutRequestID);
    
    // Map result
    const status = result.ResultCode === '0' ? 'Completed' : 'Failed';
    
    res.json({
      status,
      amount: result.Amount || pending?.amount,
      resultCode: result.ResultCode,
      resultDesc: result.ResultDesc,
      checkoutRequestID
    });

  } catch (err) {
    logger.error(`Status check error: ${err.message}`);
    res.status(500).json({ error: 'Could not check payment status.' });
  }
});

// POST /api/payments/reconcile - Assign unmatched payment to member
router.post('/reconcile',
  body('txId').trim().notEmpty(),
  body('memberPhone').trim().notEmpty(),
  body('campaignId').trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed.' });

    const { txId, memberPhone, campaignId } = req.body;
    const normPhone = normalisePhone(memberPhone);
    if (!normPhone) return res.status(400).json({ error: 'Invalid phone number.' });

    try {
      const member = await getMemberByPhone(normPhone);
      if (!member) return res.status(404).json({ error: 'Member not found.' });

      const campaigns = await getAllCampaigns();
      const campaign = campaigns.find(c => c.id === campaignId);
      if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

      const { readSheet, updateCell } = require('../services/sheets');
      const rows = await readSheet('UnmatchedPayments', 'A2:F');
      const rowIndex = rows.findIndex(r => r[1] === txId && r[5] === 'Pending');
      if (rowIndex === -1) return res.status(404).json({ error: 'Unmatched payment not found.' });

      const amount = parseInt(rows[rowIndex][3]);
      const date = rows[rowIndex][4];

      await updateCell('UnmatchedPayments', `F${rowIndex + 2}`, 'Reconciled');

      await recordContribution({
        id: uuidv4(), memberPhone: member.phone, memberName: member.name,
        amount, campaignId, date, source: 'M-Pesa (reconciled)', txId,
      });
      await updateMemberTotal(member.phone, amount);
      await updateCampaignCollected(campaignId, amount);

      await writeAuditLog({
        adminId: req.admin.id, action: 'RECONCILE_PAYMENT',
        details: { txId, memberPhone: normPhone, campaignId, amount }, ip: req.ip,
      });

      logger.info(`Payment reconciled: ${txId} → ${member.name} KES ${amount}`);
      res.json({ message: 'Payment reconciled successfully.', amount });

    } catch (err) {
      logger.error(`Reconcile error: ${err.message}`);
      res.status(500).json({ error: 'Could not reconcile payment.' });
    }
  }
);

module.exports = router;