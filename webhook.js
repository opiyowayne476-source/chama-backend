// routes/webhook.js - Enhanced callback handling
'use strict';
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

const { validateDarajaSignature, updatePendingPayment } = require('../services/daraja');
const { verifyWhatsAppWebhook } = require('../services/whatsapp');
const { darajaIpWhitelist } = require('../middleware/darajaIpWhitelist');
const {
  isTxAlreadyProcessed, markTxProcessed,
  getMemberByPhone, updateMemberTotal,
  getActiveCampaigns, updateCampaignCollected,
  recordContribution, appendRow, writeAuditLog,
} = require('../services/sheets');
const { normalisePhone, maskPhone } = require('../utils/validation');
const { logger } = require('../utils/logger');

// Raw body capture
function rawBodyCapture(req, res, buf) {
  req.rawBody = buf.toString('utf8');
}

const jsonWithRawBody = express.json({
  verify: rawBodyCapture,
  limit: '50kb',
});

// ----------------------------------------------------------------
// DARAJA — STK Push callback
// ----------------------------------------------------------------
router.post('/daraja/callback', darajaIpWhitelist, jsonWithRawBody, async (req, res) => {
  // Always respond quickly to Daraja
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    // Validate HMAC signature
    if (!validateDarajaSignature(req)) {
      logger.warn('Daraja callback: invalid HMAC signature — ignoring');
      return;
    }

    const body = req.body?.Body?.stkCallback;
    if (!body) {
      logger.warn('Daraja callback: missing stkCallback body');
      return;
    }

    // Get CheckoutRequestID for status update
    const checkoutRequestID = body.CheckoutRequestID;
    const merchantRequestID = body.MerchantRequestID;

    // Update pending payment status
    await updatePendingPayment(checkoutRequestID, {
      status: body.ResultCode === '0' ? 'Completed' : 'Failed',
      resultCode: body.ResultCode,
      resultDesc: body.ResultDesc,
      updatedAt: new Date().toISOString()
    });

    // Check for failed transaction
    if (body.ResultCode !== 0) {
      logger.info(`STK callback: failed transaction (code ${body.ResultCode}) - ${body.ResultDesc}`);
      return;
    }

    const meta = body.CallbackMetadata?.Item || [];
    const getValue = key => meta.find(i => i.Name === key)?.Value;

    const txId = getValue('MpesaReceiptNumber');
    const amount = parseInt(getValue('Amount'));
    const rawPhone = String(getValue('PhoneNumber'));
    const date = new Date().toISOString().slice(0, 10);

    if (!txId || !amount || !rawPhone) {
      logger.warn('Daraja callback: missing required fields');
      return;
    }

    // Idempotency check
    if (await isTxAlreadyProcessed(txId)) {
      logger.info(`Daraja callback: duplicate TxID ${txId} — skipped`);
      return;
    }
    await markTxProcessed(txId);

    // Normalise phone and match to member
    const phone = normalisePhone(rawPhone);
    const member = phone ? await getMemberByPhone(phone) : null;

    // Match to a campaign by till number or use first active
    const campaigns = await getActiveCampaigns();
    // Try to find campaign by AccountReference from the original request
    // For now, use first active campaign
    const campaign = campaigns.length > 0 ? campaigns[0] : null;

    if (!member) {
      await appendRow('UnmatchedPayments', [
        uuidv4(), txId, rawPhone, amount, date, 'Pending',
      ]);
      logger.warn(`Daraja: unmatched payment ${txId} from ${maskPhone(rawPhone)} — queued for reconciliation`);
      return;
    }

    if (!campaign) {
      logger.warn(`Daraja: matched member ${member.name} but no active campaign`);
      return;
    }

    // Record contribution and update totals
    await recordContribution({
      id: uuidv4(),
      memberPhone: member.phone,
      memberName: member.name,
      amount,
      campaignId: campaign.id,
      date,
      source: 'M-Pesa STK',
      txId,
    });
    await updateMemberTotal(member.phone, amount);
    await updateCampaignCollected(campaign.id, amount);

    logger.info(`✅ Contribution recorded: ${member.name} → KES ${amount} [${txId}]`);

  } catch (err) {
    logger.error(`Daraja callback processing error: ${err.message}`);
  }
});

// ... rest of the webhook routes ...

// ----------------------------------------------------------------
// WhatsApp webhook verification (GET) — Meta sends a challenge
// ----------------------------------------------------------------
router.get('/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && verifyWhatsAppWebhook(token)) {
    logger.info('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

module.exports = router;