'use strict';

/**
 * Normalise any Kenyan phone number to E.164 format (+2547XXXXXXXX).
 * Accepts: 07XXXXXXXX, 7XXXXXXXX, +2547XXXXXXXX, 2547XXXXXXXX
 * Returns null if the number cannot be normalised.
 */
function normalisePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, ''); // strip non-digits

  if (/^2547\d{8}$/.test(digits)) return `+${digits}`;
  if (/^07\d{8}$/.test(digits))   return `+254${digits.slice(1)}`;
  if (/^7\d{8}$/.test(digits))    return `+254${digits}`;
  if (/^2541\d{8}$/.test(digits)) return `+${digits}`; // landline — allow
  return null;
}

/**
 * Mask a phone number for display: +2547••••789
 */
function maskPhone(phone) {
  if (!phone || phone.length < 6) return '••••••••••';
  const e164 = normalisePhone(phone) || phone;
  return e164.slice(0, 6) + '••••' + e164.slice(-3);
}

/**
 * Validate that a string is a safe name (letters, spaces, hyphens, apostrophes).
 */
function isValidName(name) {
  return typeof name === 'string' &&
    name.trim().length >= 2 &&
    name.trim().length <= 100 &&
    /^[A-Za-z\s'\-\.]+$/.test(name.trim());
}

/**
 * Sanitise a free-text string: strip HTML/script tags, trim whitespace.
 */
function sanitiseText(input, maxLength = 500) {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/<[^>]*>/g, '')          // strip HTML tags
    .replace(/[<>"'`;]/g, '')         // strip injection chars
    .trim()
    .slice(0, maxLength);
}

/**
 * Validate a positive integer amount in KES.
 */
function isValidAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 10_000_000 && Number.isInteger(n);
}

module.exports = { normalisePhone, maskPhone, isValidName, sanitiseText, isValidAmount };
