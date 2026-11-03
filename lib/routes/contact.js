'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR, IS_PRODUCTION } = require('../config');
const {
  TURNSTILE_ACTIONS, checkSubmitRateLimit, consumeSubmitRateLimit, verifyTurnstile,
} = require('../scan-scheduler');
const { getClientIp, readBody } = require('../request');

/** Handle POST /api/contact and POST /api/report. */
async function handlePostEndpoint(pathname, req, res) {
  const ip = getClientIp(req);

  if (!checkSubmitRateLimit(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Too many submissions. Try again later.' }));
  }

  let body;
  try {
    const raw = await readBody(req, 8192);
    body = JSON.parse(raw);
    if (typeof body !== 'object' || body === null) throw new Error('not_object');
  } catch (error) {
    const tooLarge = error && error.code === 'BODY_TOO_LARGE';
    res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: tooLarge ? 'Request body is too large.' : 'Invalid request body.' }));
  }

  // Every form submission must carry a valid Turnstile token for its own
  // action — without this, siteverify is never called and the form is
  // wide open to automated bot submissions.
  const expectedAction = pathname === '/api/contact' ? TURNSTILE_ACTIONS.contact : TURNSTILE_ACTIONS.report;
  const cfToken = String(body.cfToken || '').trim();
  const tsOk = await verifyTurnstile(cfToken, ip, expectedAction);
  if (!tsOk) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Security check failed. Please refresh and try again.' }));
  }

  const REPORTS_DIR = path.join(ROOT_DIR, 'reports');
  try { fs.mkdirSync(REPORTS_DIR, { recursive: true }); } catch (_) {}

  if (pathname === '/api/contact') {
    const name    = String(body.name    || '').trim().slice(0, 100);
    const email   = String(body.email   || '').trim().slice(0, 200);
    const message = String(body.message || '').trim().slice(0, 2000);
    if (!name || !email || !message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Name, email and message are all required.' }));
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Please enter a valid email address.' }));
    }
    const entry = JSON.stringify({ type: 'contact', ts: new Date().toISOString(), name, email, message }) + '\n';
    fs.appendFile(path.join(REPORTS_DIR, 'contact.jsonl'), entry, 'utf8', () => {});
    try {
      await notifyByEmail('New contact form submission', `Name: ${name}\nEmail: ${email}\n\n${message}`, email);
    } catch (error) {
      console.error(`[email] contact notification failed: ${error.message}`);
      res.writeHead(error.code === 'EMAIL_NOT_CONFIGURED' ? 503 : 502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(emailDeliveryError(error, 'Message could not be delivered. Please try again later.')));
    }
    consumeSubmitRateLimit(ip);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, delivery: 'accepted' }));
  }

  if (pathname === '/api/report') {
    const site          = String(body.site          || '').trim().slice(0, 100);
    const username      = String(body.username      || '').trim().slice(0, 50);
    const correctStatus = String(body.correctStatus || '').trim().slice(0, 30);
    const notes         = String(body.notes         || '').trim().slice(0, 500);
    const VALID_STATUSES = new Set(['should_be_found', 'should_be_not_found', 'other']);
    if (!site || !VALID_STATUSES.has(correctStatus)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid report payload.' }));
    }
    const entry = JSON.stringify({ type: 'report', ts: new Date().toISOString(), site, username, correctStatus, notes }) + '\n';
    fs.appendFile(path.join(REPORTS_DIR, 'reports.jsonl'), entry, 'utf8', () => {});
    try {
      await notifyByEmail('New accuracy report', `Site: ${site}\nUsername: ${username}\nCorrect status: ${correctStatus}\n\n${notes}`);
    } catch (error) {
      console.error(`[email] report notification failed: ${error.message}`);
      res.writeHead(error.code === 'EMAIL_NOT_CONFIGURED' ? 503 : 502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(emailDeliveryError(error, 'Report could not be delivered. Please try again later.')));
    }
    consumeSubmitRateLimit(ip);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, delivery: 'accepted' }));
  }

  res.writeHead(404); res.end('Not found');
}

/** Email notification via Resend's REST API. */
function getEmailConfig() {
  const values = {
    apiKey: (process.env.RESEND_API_KEY || '').trim(),
    from: (process.env.RESEND_FROM || '').trim(),
    to: (process.env.RESEND_TO || '').trim(),
  };
  const missing = Object.entries(values).filter(([, value]) => !value).map(([name]) => name);
  return { ...values, configured: missing.length === 0, missing };
}

function emailDeliveryError(error, fallback) {
  const status = Number(error && error.httpStatus);
  if (error && error.code === 'EMAIL_NOT_CONFIGURED') {
    return { error: 'Email notifications are not configured. Please contact the site administrator.', deliveryError: 'configuration' };
  }
  if (status === 401) {
    return { error: 'Email service credentials were rejected. Please contact the site administrator.', deliveryError: 'authentication' };
  }
  if (status === 400 || status === 403 || status === 422) {
    return { error: 'Email sender configuration was rejected. Please contact the site administrator.', deliveryError: 'sender_configuration' };
  }
  if (status === 429) {
    return { error: 'Email service is temporarily rate limited. Please try again shortly.', deliveryError: 'rate_limited' };
  }
  return { error: fallback, deliveryError: 'upstream' };
}

const EMAIL_CONFIG_AT_STARTUP = getEmailConfig();
if (IS_PRODUCTION && !EMAIL_CONFIG_AT_STARTUP.configured) {
  console.error(`[email] notifications disabled; missing configuration: ${EMAIL_CONFIG_AT_STARTUP.missing.join(', ')}`);
}

function notifyByEmail(subject, text, replyTo = '') {
  const config = getEmailConfig();
  if (!config.configured) {
    const error = new Error('Resend environment variables are incomplete');
    error.code = 'EMAIL_NOT_CONFIGURED';
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      to: config.to,
      from: config.from,
      subject: `[PROBE] ${subject}`,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (resp) => {
      let responseBody = '';
      resp.setEncoding('utf8');
      resp.on('data', chunk => { if (responseBody.length < 16384) responseBody += chunk; });
      resp.on('end', () => {
        let result;
        try { result = JSON.parse(responseBody); } catch (_) { result = null; }
        if (resp.statusCode >= 200 && resp.statusCode < 300 && result && result.id) {
          return finish(resolve, result);
        }
        const detail = result && (result.message || result.name) || `HTTP ${resp.statusCode}`;
        const error = new Error(`Resend rejected the request: ${detail}`);
        error.code = 'EMAIL_SEND_FAILED';
        error.httpStatus = resp.statusCode;
        finish(reject, error);
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('Resend timed out')));
    req.on('error', error => {
      error.code = error.code || 'EMAIL_SEND_FAILED';
      finish(reject, error);
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { handlePostEndpoint };
