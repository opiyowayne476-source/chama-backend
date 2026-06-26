'use strict';
const axios = require('axios');
const { logger } = require('../utils/logger');

const WA_BASE = 'https://graph.facebook.com/v19.0';

// ----------------------------------------------------------------
// Send a text message to a WhatsApp number or group
// ----------------------------------------------------------------

async function sendTextMessage(to, text) {
  const res = await axios.post(
    `${WA_BASE}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to,
      type:              'text',
      text:              { preview_url: false, body: text },
    },
    {
      headers: {
        Authorization:  `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    }
  );
  return res.data;
}

// ----------------------------------------------------------------
// Broadcast daily report to all configured group/member numbers
// ----------------------------------------------------------------

async function broadcastDailyReport(reportText) {
  const targets = (process.env.WHATSAPP_GROUP_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (targets.length === 0) {
    logger.warn('No WhatsApp targets configured — set WHATSAPP_GROUP_IDS in .env');
    return;
  }

  const results = [];
  for (const to of targets) {
    try {
      const r = await sendTextMessage(to, reportText);
      results.push({ to, status: 'sent', messageId: r.messages?.[0]?.id });
      logger.info(`WhatsApp report sent to ${to}`);
    } catch (err) {
      logger.error(`WhatsApp send failed to ${to}: ${err.message}`);
      results.push({ to, status: 'failed', error: err.message });
      // Attempt SMS fallback via Africa's Talking
      await smsFallback(to, reportText).catch(e =>
        logger.error(`SMS fallback also failed to ${to}: ${e.message}`)
      );
    }
  }
  return results;
}

// ----------------------------------------------------------------
// SMS fallback via Africa's Talking
// ----------------------------------------------------------------

async function smsFallback(phone, message) {
  const res = await axios.post(
    'https://api.africastalking.com/version1/messaging',
    new URLSearchParams({
      username: process.env.AT_USERNAME,
      to:       phone,
      message:  message.slice(0, 160), // SMS single-message limit
      from:     process.env.AT_SENDER_ID || 'CHAMA',
    }).toString(),
    {
      headers: {
        apiKey:         process.env.AT_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10_000,
    }
  );
  logger.info(`SMS fallback sent to ${phone}`);
  return res.data;
}

// ----------------------------------------------------------------
// Verify WhatsApp webhook (GET challenge from Meta)
// ----------------------------------------------------------------

function verifyWhatsAppWebhook(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('WhatsApp webhook verified successfully');
    return res.status(200).send(challenge);
  }
  logger.warn('WhatsApp webhook verification failed');
  return res.status(403).json({ error: 'Verification failed.' });
}

module.exports = { sendTextMessage, broadcastDailyReport, smsFallback, verifyWhatsAppWebhook };
