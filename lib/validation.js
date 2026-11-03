'use strict';

const crypto = require('crypto');

/* ── Input validation ─────────────────────────────────────────────────── */
function isValidUsername(u) {
  return typeof u === 'string' && u.length >= 1 && u.length <= 50
    && /^[a-zA-Z0-9._\-]+$/.test(u);
}

function isValidName(n) {
  return typeof n === 'string' && n.trim().length >= 2 && n.trim().length <= 80
    && /^[a-zA-Z][a-zA-Z '\-.]+$/.test(n.trim());
}

function isValidEmail(email) {
  return typeof email === 'string' && email.length >= 3 && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function normalizePhone(phone) {
  const raw = String(phone || '').trim();
  const stripped = raw.replace(/[\s().-]/g, '');
  if (!stripped) return '';
  return stripped.startsWith('+')
    ? `+${stripped.slice(1).replace(/[^0-9]/g, '')}`
    : stripped.replace(/[^0-9]/g, '');
}

function isValidPhone(phone) {
  const normalized = normalizePhone(phone);
  return /^\+?[0-9]{7,15}$/.test(normalized);
}

function normalizeDomain(domain) {
  let d = String(domain || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  d = d.replace(/\.$/, '');
  return d;
}

function isValidDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d || d.length > 253) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashEmail(email) {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

module.exports = { isValidUsername, isValidName, isValidEmail, normalizePhone, isValidPhone,
  normalizeDomain, isValidDomain, normalizeEmail, hashEmail };
