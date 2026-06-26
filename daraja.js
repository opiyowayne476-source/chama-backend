// services/daraja.js - Complete working implementation
'use strict';
const axios = require('axios');
const crypto = require('crypto');
const { logger } = require('../utils/logger');

const BASE_URL = process.env.DARAJA_ENVIRONMENT === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

let _token = null;
let _tokenExpiry = 0;

// ----------------------------------------------------------------
// OAuth Token (cached, auto-refreshed)
// ----------------------------------------------------------------

async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const credentials = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
  ).toString('base64');

  try {
    const res = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${credentials}` },
      timeout: 10000,
    });

    _token = res.data.access_token;
    _tokenExpiry = Date.now() + (parseInt(res.data.expires_in) - 60) * 1000;
    logger.info('Daraja access token refreshed');
    return _token;
  } catch (err) {
    logger.error(`Daraja token error: ${err.message}`);
    throw new Error('Failed to get Daraja access token');
  }
}

// ----------------------------------------------------------------
// STK Push (Lipa Na M-Pesa Online)
// ----------------------------------------------------------------

async function stkPush({ phone, amount, accountRef, description, campaignId }) {
  const token = await getAccessToken();
  const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  const password = Buffer.from(
    `${process.env.DARAJA_SHORT_CODE}${process.env.DARAJA_PASSKEY}${timestamp}`
  ).toString('base64');

  // Clean phone: remove + and ensure it starts with 254
  let cleanPhone = phone.replace('+', '');
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '254' + cleanPhone.slice(1);
  }
  if (!cleanPhone.startsWith('254')) {
    cleanPhone = '254' + cleanPhone;
  }

  const payload = {
    BusinessShortCode: process.env.DARAJA_SHORT_CODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amount),
    PartyA: cleanPhone,
    PartyB: process.env.DARAJA_SHORT_CODE,
    PhoneNumber: cleanPhone,
    CallBackURL: `${process.env.BASE_URL}/webhook/daraja/callback`,
    AccountReference: accountRef.slice(0, 12),
    TransactionDesc: description.slice(0, 13),
  };

  logger.info(`STK Push initiated: ${cleanPhone} KES ${amount} Ref: ${accountRef}`);

  try {
    const res = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      }
    );

    // Store pending payment in memory or DB for status tracking
    await storePendingPayment({
      checkoutRequestID: res.data.CheckoutRequestID,
      merchantRequestID: res.data.MerchantRequestID,
      phone: cleanPhone,
      amount: Math.round(amount),
      campaignId,
      accountRef,
      status: 'Pending',
      timestamp: new Date().toISOString()
    });

    logger.info(`STK Push response: ${res.data.ResponseCode} - ${res.data.ResponseDescription}`);
    return res.data;
  } catch (err) {
    logger.error(`STK Push error: ${err.message}`);
    throw err;
  }
}

// ----------------------------------------------------------------
// Payment Status Query
// ----------------------------------------------------------------

async function queryPaymentStatus(checkoutRequestID) {
  const token = await getAccessToken();
  const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  const password = Buffer.from(
    `${process.env.DARAJA_SHORT_CODE}${process.env.DARAJA_PASSKEY}${timestamp}`
  ).toString('base64');

  try {
    const res = await axios.post(
      `${BASE_URL}/mpesa/stkpushquery/v1/query`,
      {
        BusinessShortCode: process.env.DARAJA_SHORT_CODE,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestID,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      }
    );

    // Update pending payment status
    await updatePendingPayment(checkoutRequestID, {
      status: res.data.ResultCode === '0' ? 'Completed' : 'Failed',
      resultCode: res.data.ResultCode,
      resultDesc: res.data.ResultDesc,
      updatedAt: new Date().toISOString()
    });

    return res.data;
  } catch (err) {
    logger.error(`Payment status query error: ${err.message}`);
    throw err;
  }
}

// ----------------------------------------------------------------
// In-memory pending payments store (replace with Redis/DB in production)
// ----------------------------------------------------------------

const pendingPayments = new Map();

async function storePendingPayment(data) {
  pendingPayments.set(data.checkoutRequestID, {
    ...data,
    createdAt: new Date().toISOString()
  });
  logger.info(`Pending payment stored: ${data.checkoutRequestID}`);
}

async function updatePendingPayment(checkoutRequestID, updates) {
  const existing = pendingPayments.get(checkoutRequestID);
  if (existing) {
    pendingPayments.set(checkoutRequestID, { ...existing, ...updates });
  }
}

async function getPendingPayment(checkoutRequestID) {
  return pendingPayments.get(checkoutRequestID) || null;
}

// ----------------------------------------------------------------
// C2B Register URLs (run once during setup)
// ----------------------------------------------------------------

async function registerC2BUrls() {
  const token = await getAccessToken();
  try {
    await axios.post(
      `${BASE_URL}/mpesa/c2b/v1/registerurl`,
      {
        ShortCode: process.env.DARAJA_SHORT_CODE,
        ResponseType: 'Completed',
        ConfirmationURL: `${process.env.BASE_URL}/webhook/daraja/confirm`,
        ValidationURL: `${process.env.BASE_URL}/webhook/daraja/validate`,
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      }
    );
    logger.info('Daraja C2B URLs registered successfully');
  } catch (err) {
    logger.error(`C2B registration error: ${err.message}`);
  }
}

// ----------------------------------------------------------------
// HMAC-SHA256 Signature Validation
// ----------------------------------------------------------------

function validateDarajaSignature(req) {
  const signature = req.headers['x-safaricom-signature'];
  if (!signature) {
    logger.warn('Daraja callback missing signature header');
    return false;
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    logger.error('rawBody not available');
    return false;
  }

  const expected = crypto
    .createHmac('sha256', process.env.DARAJA_CONSUMER_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

module.exports = { 
  getAccessToken, 
  stkPush, 
  queryPaymentStatus,
  registerC2BUrls, 
  validateDarajaSignature,
  getPendingPayment,
  updatePendingPayment,
  storePendingPayment,
  pendingPayments // export for testing
};