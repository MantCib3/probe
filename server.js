'use strict';

const http  = require('http');
const https = require('https');
const dns = require('dns').promises;
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// Stealth browser — lazy-loaded; absent gracefully if not installed
let chromiumStealth = null;
try {
  chromiumStealth = require('playwright-extra').chromium;
  chromiumStealth.use(require('puppeteer-extra-plugin-stealth')());
} catch (_) { /* run: npm install playwright-extra puppeteer-extra-plugin-stealth */ }

const SITES      = JSON.parse(fs.readFileSync(path.join(__dirname, 'sites.json'), 'utf8')).filter(s => !s.defunct);
const NAME_SITES = JSON.parse(fs.readFileSync(path.join(__dirname, 'name-sites.json'), 'utf8'));
const PORT       = process.env.PORT || process.argv[2] || 3737;
const CONCURRENCY = 20;
const TIMEOUT_MS  = 10000;
const MAX_BODY    = 32768;
const SITE_PROBE_TIMEOUT_MS = 45000;

const STEALTH_CONCURRENCY = 4;
const STEALTH_TIMEOUT_MS  = 16000;
const ENABLE_USERNAME_BROWSER_FALLBACK = false;
const ENABLE_UNDETECTABLE_STEALTH = false;

/* ── Rate limiting & Turnstile ───────────────────────────────────────── */
const RATE_LIMIT_MAX    = 10;                  // free scans per window per IP
const RATE_LIMIT_WINDOW = 60 * 60 * 1000;     // 1 hour in ms
const TURNSTILE_SECRET  = process.env.TURNSTILE_SECRET || ''; // set in Render env vars

const _scanRates = new Map(); // ip → { count: number, resetAt: timestamp }

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = _scanRates.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    _scanRates.set(ip, entry);
  }
  return entry.count < RATE_LIMIT_MAX;
}

function consumeRateLimit(ip) {
  const entry = _scanRates.get(ip);
  if (entry) entry.count++;
}

function getClientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || '0.0.0.0';
}

const _submitRates = new Map(); // ip → { count, resetAt }
const SUBMIT_LIMIT_MAX    = 5;
const SUBMIT_LIMIT_WINDOW = 60 * 60 * 1000;

function checkSubmitRateLimit(ip) {
  const now = Date.now();
  let entry = _submitRates.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + SUBMIT_LIMIT_WINDOW };
    _submitRates.set(ip, entry);
  }
  return entry.count < SUBMIT_LIMIT_MAX;
}
function consumeSubmitRateLimit(ip) {
  const entry = _submitRates.get(ip);
  if (entry) entry.count++;
}

/** Read up to maxLen bytes from req body, resolve as string. */
function readBody(req, maxLen = 8192) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > maxLen) { req.destroy(new Error('body_too_large')); }
    });
    req.on('end',   () => resolve(data));
    req.on('error', reject);
  });
}

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
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid request body.' }));
  }

  const REPORTS_DIR = path.join(__dirname, 'reports');
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
    try { fs.appendFileSync(path.join(REPORTS_DIR, 'contact.jsonl'), entry, 'utf8'); } catch (_) {}
    consumeSubmitRateLimit(ip);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
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
    try { fs.appendFileSync(path.join(REPORTS_DIR, 'reports.jsonl'), entry, 'utf8'); } catch (_) {}
    consumeSubmitRateLimit(ip);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404); res.end('Not found');
}


function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return Promise.resolve(true); // bypass when secret not set (dev mode)
  if (!token)            return Promise.resolve(false);
  return new Promise((resolve) => {
    const body = Buffer.from(
      `secret=${encodeURIComponent(TURNSTILE_SECRET)}&response=${encodeURIComponent(token)}&remoteip=${encodeURIComponent(ip)}`
    );
    const req = https.request({
      hostname: 'challenges.cloudflare.com',
      path    : '/turnstile/v0/siteverify',
      method  : 'POST',
      headers : { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length },
    }, (resp) => {
      let data = '';
      resp.on('data', c => { data += c; });
      resp.on('end',  () => {
        try { resolve(JSON.parse(data).success === true); }
        catch (_) { resolve(false); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

const QUICK_SITE_NAMES = [
  'github', 'instagram', 'tiktok', 'x', 'twitter', 'reddit', 'youtube', 'twitch'
];

let _browser     = null;
let _browserTask = null;
let _snapshotBusy = false;
let _bSlots      = 0;
const _bQueue    = [];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchText(url, timeoutMs = 20000, maxRedirects = 5, headers = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      fn(arg);
    };
    // Hard backstop in case socket-idle timeout doesn't fire (e.g. a slow
    // trickle of bytes keeps the connection "active" indefinitely).
    const hardDeadline = setTimeout(() => {
      req.destroy(new Error('request timeout'));
      finish(reject, new Error('request timeout'));
    }, timeoutMs + 3000);

    // Default UA mimics a desktop Chrome browser for sites that need one.
    // Pass headers = {} explicitly to send NO custom headers at all — some
    // bot-protection (e.g. Cloudflare in front of r.jina.ai) challenges a
    // spoofed-Chrome UA that's missing the rest of a real browser's header
    // fingerprint (sec-ch-ua, Accept-Language, etc.) more aggressively than
    // it challenges a plain/no UA request.
    const reqHeaders = headers || { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' };

    const req = transport.get(parsed, {
      headers: reqHeaders,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) {
          finish(reject, new Error('too many redirects'));
          return;
        }
        finish(resolve, fetchText(new URL(res.headers.location, parsed).toString(), timeoutMs, maxRedirects - 1, headers));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => finish(resolve, body));
      res.on('error', err => finish(reject, err));
    });
    req.on('error', err => finish(reject, err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timeout'));
    });
  });
}

// Like fetchText() but also exposes the final HTTP status code — used by
// /api/verify to classify found/not_found/blocked server-side (Node's http/
// https client is not subject to browser CORS, so this works for any site
// regardless of whether it sends Access-Control-Allow-Origin headers).
// NOTE: named fetchStatusV (not fetchStatus) to avoid colliding with the
// pre-existing single-arg fetchStatus(targetUrl) used by the legacy probe*
// functions further down this file — function declarations hoist and the
// later one wins, which silently broke /api/verify during initial testing.
function fetchStatusV(url, timeoutMs = 10000, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      fn(arg);
    };
    const hardDeadline = setTimeout(() => {
      req.destroy(new Error('request timeout'));
      finish(reject, new Error('request timeout'));
    }, timeoutMs + 3000);

    const req = transport.get(parsed, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        res.resume(); // discard body, follow redirect
        finish(resolve, fetchStatusV(new URL(res.headers.location, parsed).toString(), timeoutMs, maxRedirects - 1));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (body.length < 200000) body += chunk; });
      res.on('end', () => finish(resolve, { status: res.statusCode, body }));
      res.on('error', err => finish(reject, err));
    });
    req.on('error', err => finish(reject, err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timeout'));
    });
  });
}

// SSRF guard shared by proxy endpoints that accept an arbitrary target URL.
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return (
    h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
    /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) || h.endsWith('.local')
  );
}

// Auth/login redirect patterns — if a 3xx points here, account doesn't exist
const AUTH_REDIRECT_PATTERNS = [
  '/login', '/signin', '/sign-in', '/signup', '/sign-up', '/register',
  '/auth', 'accounts/login', 'account/login', 'users/sign_in',
  'login?', 'signin?', '?redirect=', '?returnurl=', '?next=',
  '?returnto=', '?redirecturi=', 'session/new',
];

// HTML title substrings that indicate a 200 page is actually a "not found" error
const NOT_FOUND_TITLE_PATTERNS = [
  'page not found', 'user not found', 'profile not found',
  'account not found', '404', 'nothing here', 'does not exist',
  "doesn't exist", 'no such user', 'not available',
];

// Title/body patterns that mean a bot-protection wall is blocking us
const BLOCKED_TITLE_PATTERNS = [
  'client challenge', 'just a moment', 'attention required',
  'ddos-guard', 'enable javascript and cookies', 'checking your browser',
  'one more step', 'please wait', 'security check',
];

// Body patterns that indicate JS-challenge / bot-protection pages (no title available)
const BLOCKED_BODY_PATTERNS = [
  'please enable js and disable any ad blocker',
  'please enable javascript and cookies to continue',
  'this process is automatic',
  'checking if the site connection is secure',
  'ray id',  // Cloudflare footer
];

// Body-text substrings that reliably indicate a missing profile (case-insensitive)
const NOT_FOUND_BODY_PATTERNS = [
  "this account doesn't exist",
  "this user doesn't exist",
  "this profile doesn't exist",
  "sorry, this account doesn't exist",
  "sorry, this page isn't available",
  "the specified profile could not be found",
  "no such user",
  "we couldn't find this user",
  "we can't find this account",
  "we couldn't find that user",
  "couldn't find that user",
  "user not found",
  "profile not found",
  "account not found",
  "member not found",
  "this username is not registered",
  "username is not available",
  "there is currently no user",
  "the user you requested",
  "page you requested does not exist",
  "the page you're looking for doesn't exist",
  "hmm, the page you were looking for",
  "oops! that page doesn't exist",
  "there's nothing here.",
  "that page doesn't exist",
  "we can't find this page",
  "this content isn't available",
  "this page isn't available",
  "no user with that username",
  "this page could not be found",
];

/* Phrases that indicate the account existed but is now gone (suspended/banned/deleted) */
const DELETED_BODY_PATTERNS = [
  "no longer exists",
  "account has been suspended",
  "account is suspended",
  "account was suspended",
  "this account has been suspended",
  "has been permanently suspended",
  "account has been deactivated",
  "account was deactivated",
  "this account has been deactivated",
  "account has been deleted",
  "account was deleted",
  "this account has been deleted",
  "account has been terminated",
  "account has been banned",
  "account was banned",
  "this account has been banned",
  "account has been closed",
  "account was closed",
  "user has been suspended",
  "user is suspended",
  "user has been deactivated",
  "user has been banned",
  "account has been withheld",
  "this account has been withheld",
];

/* ── Response classifier ─────────────────────────────────────────────── */
function hashBodySample(body) {
  return crypto.createHash('sha256').update(String(body || '').slice(0, 2048)).digest('hex');
}

function makeClassifiedResult(base, status, reasonCodes, confidence, extra = {}) {
  return {
    ...base,
    status,
    confidence,
    reasonCodes,
    evidence: {
      checkedAt: new Date().toISOString(),
      method: base.detectionMethod,
      statusCode: base.statusCode,
      bodyHash: base.bodyHash,
      reasons: reasonCodes,
    },
    ...extra,
  };
}

function normalizeResult(result) {
  if (typeof result.confidence === 'number' && Array.isArray(result.reasonCodes) && result.evidence) {
    return result;
  }

  const fallbackReason = result.status === 'timeout' ? 'request_timeout'
    : result.status === 'error' ? 'request_error'
    : result.status === 'unknown' ? 'inconclusive_result'
    : `status_${result.status}`;

  const confidenceByStatus = {
    found: 0.72,
    deleted: 0.8,
    not_found: 0.9,
    unknown: 0.3,
    timeout: 0.12,
    error: 0.1,
  };

  const reasonCodes = Array.isArray(result.reasonCodes) && result.reasonCodes.length
    ? result.reasonCodes
    : [fallbackReason];

  return {
    ...result,
    confidence: confidenceByStatus[result.status] ?? 0.5,
    reasonCodes,
    evidence: result.evidence || {
      checkedAt: new Date().toISOString(),
      method: result.resolvedBy === 'browser' ? 'browser' : 'http',
      statusCode: result.statusCode || 0,
      bodyHash: result.bodyHash || null,
      reasons: reasonCodes,
    },
  };
}

function classify(site, username, url, sc, headers, body, detectionMethod = 'http') {
  const base = {
    name: site.name,
    category: site.category,
    url,
    statusCode: sc,
    detectionMethod,
    bodyHash: hashBodySample(body),
  };

  if (sc >= 301 && sc <= 308) {
    const loc = (headers['location'] || '').toLowerCase();
    if (loc) {
      if (AUTH_REDIRECT_PATTERNS.some(p => loc.includes(p))) {
        return makeClassifiedResult(base, 'not_found', ['redirect_auth_login'], 0.95);
      }
      if (loc.includes('.within.website') || loc.includes('/_/') ||
          loc.includes('/cdn-cgi/') || loc.includes('challenge') ||
          body.toLowerCase().includes('authorization required')) {
        return makeClassifiedResult(base, 'blocked', ['redirect_bot_challenge'], 0.9);
      }
    }
    return makeClassifiedResult(base, 'found', ['redirect_reachable'], 0.7);
  }

  if (sc === 404 || sc === 410) {
    return makeClassifiedResult(base, 'not_found', [sc === 404 ? 'http_404' : 'http_410'], 0.98);
  }

  if (sc === 403 || sc === 401 || sc === 429 || sc === 999) {
    return makeClassifiedResult(base, 'blocked', [`blocked_http_${sc}`], 0.9);
  }

  if (site.notFoundStatus !== undefined && sc === site.notFoundStatus) {
    return makeClassifiedResult(base, 'not_found', ['site_specific_not_found_status'], 0.94);
  }

  if (sc === 200) {
    const lbody = body.toLowerCase();

    if (site.positiveMsg) {
      const found = body.includes(site.positiveMsg);
      return makeClassifiedResult(base, found ? 'found' : 'not_found', ['site_positive_message'], found ? 0.9 : 0.9);
    }

    if (site.errorMsg && body.includes(site.errorMsg)) {
      return makeClassifiedResult(base, 'not_found', ['site_error_message'], 0.92);
    }

    const tm = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = tm ? tm[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&').toLowerCase().trim() : '';

    if (BLOCKED_TITLE_PATTERNS.some(p => title.includes(p))) {
      return makeClassifiedResult(base, 'blocked', ['title_blocked_pattern'], 0.9);
    }

    if (NOT_FOUND_TITLE_PATTERNS.some(p => title.includes(p))) {
      return makeClassifiedResult(base, 'not_found', ['title_not_found_pattern'], 0.9);
    }

    if (BLOCKED_BODY_PATTERNS.some(p => lbody.includes(p))) {
      return makeClassifiedResult(base, 'blocked', ['body_blocked_pattern'], 0.9);
    }

    if (DELETED_BODY_PATTERNS.some(p => lbody.includes(p))) {
      return makeClassifiedResult(base, 'deleted', ['body_deleted_pattern'], 0.86);
    }

    if (NOT_FOUND_BODY_PATTERNS.some(p => lbody.includes(p))) {
      return makeClassifiedResult(base, 'not_found', ['body_not_found_pattern'], 0.87);
    }

    if (site.usernameInBody) {
      const found = lbody.includes(username.toLowerCase());
      const displayName = found ? extractDisplayName(title, username) : null;
      return makeClassifiedResult(
        base,
        found ? 'found' : 'not_found',
        [found ? 'username_present_in_body' : 'username_missing_in_body'],
        found ? 0.9 : 0.85,
        displayName ? { displayName } : {}
      );
    }

    if (!site.skipBodyCheck) {
      const found = lbody.includes(username.toLowerCase());
      const displayName = found ? extractDisplayName(title, username) : null;
      return makeClassifiedResult(
        base,
        found ? 'found' : 'unknown',
        [found ? 'body_guard_username_match' : 'body_guard_no_username_match'],
        found ? 0.74 : 0.35,
        displayName ? { displayName } : {}
      );
    }

    const displayName = extractDisplayName(title, username);
    return makeClassifiedResult(base, 'found', ['skip_body_check_enabled'], 0.68, displayName ? { displayName } : {});
  }

  return makeClassifiedResult(base, 'unknown', [`unhandled_status_${sc}`], 0.3);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico' : 'image/x-icon',
  '.svg' : 'image/svg+xml',
};

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

function makeIntelResult({ category, name, status, url, summary, detail, reasonCodes = [], extra = {} }) {
  return normalizeResult({
    name,
    category,
    status,
    url,
    summary,
    detail,
    mode: category,
    reasonCodes,
    evidence: {
      checkedAt: new Date().toISOString(),
      method: extra.method || (status === 'link' ? 'link' : `${category}_probe`),
      statusCode: extra.statusCode || 0,
      bodyHash: extra.bodyHash || null,
      reasons: reasonCodes,
    },
    ...extra,
  });
}

function makeEmailResult({ name, status, url, summary, detail, reasonCodes = [], extra = {} }) {
  return makeIntelResult({
    category: 'email',
    name,
    status,
    url,
    summary,
    detail,
    reasonCodes,
    extra,
  });
}

function fetchStatus(targetUrl) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (_) { return resolve({ statusCode: 0, body: '' }); }

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length >= MAX_BODY) res.destroy();
      });
      res.on('close', () => resolve({ statusCode: res.statusCode || 0, body }));
      res.on('error', () => resolve({ statusCode: 0, body: '' }));
    });

    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', () => resolve({ statusCode: 0, body: '' }));
    req.end();
  });
}

async function probeGravatar(email) {
  const emailHash = hashEmail(email);
  const avatarUrl = `https://www.gravatar.com/avatar/${emailHash}?d=404&s=256`;
  const profileUrl = `https://gravatar.com/${emailHash}`;
  const resp = await fetchStatus(avatarUrl);

  if (resp.statusCode === 200) {
    return makeEmailResult({
      name: 'Gravatar',
      status: 'found',
      url: profileUrl,
      summary: 'Public Gravatar avatar or profile data appears to exist for this email.',
      detail: 'Useful for avatars, bios, linked accounts, and profile metadata when the owner has enabled it.',
      reasonCodes: ['gravatar_profile_found'],
      extra: { statusCode: 200, bodyHash: hashBodySample(resp.body), method: 'gravatar' },
    });
  }

  if (resp.statusCode === 404) {
    return makeEmailResult({
      name: 'Gravatar',
      status: 'not_found',
      url: profileUrl,
      summary: 'No public Gravatar avatar was found for this email hash.',
      detail: 'This does not rule out the email being valid; it only means no public Gravatar profile was exposed here.',
      reasonCodes: ['gravatar_profile_not_found'],
      extra: { statusCode: 404, bodyHash: hashBodySample(resp.body), method: 'gravatar' },
    });
  }

  return makeEmailResult({
    name: 'Gravatar',
    status: 'unknown',
    url: profileUrl,
    summary: 'Gravatar lookup was inconclusive.',
    detail: 'The upstream service did not return a clear found/not found response.',
    reasonCodes: ['gravatar_inconclusive'],
    extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'gravatar' },
  });
}

async function analyzeEmailDomain(email) {
  const domain = normalizeEmail(email).split('@')[1] || '';
  let mx = [];
  let txt = [];
  let dmarc = [];

  try { mx = await dns.resolveMx(domain); } catch (_) {}
  try { txt = await dns.resolveTxt(domain); } catch (_) {}
  try { dmarc = await dns.resolveTxt(`_dmarc.${domain}`); } catch (_) {}

  const flatTxt = txt.flat().join(' ');
  const flatDmarc = dmarc.flat().join(' ');
  const hasMx = mx.length > 0;
  const hasSpf = /v=spf1/i.test(flatTxt);
  const hasDmarc = /v=dmarc1/i.test(flatDmarc);
  const mxPreview = hasMx ? mx.slice(0, 3).map(entry => entry.exchange).join(', ') : 'none detected';

  return makeEmailResult({
    name: 'Email Domain',
    status: hasMx ? 'found' : 'unknown',
    url: `https://${domain}`,
    summary: `MX ${hasMx ? 'present' : 'missing'} | SPF ${hasSpf ? 'present' : 'missing'} | DMARC ${hasDmarc ? 'present' : 'missing'}`,
    detail: `Mail exchangers: ${mxPreview}`,
    reasonCodes: [hasMx ? 'domain_mx_present' : 'domain_mx_missing'],
    extra: { method: 'dns' },
  });
}

async function probeHibpPublicPage(email) {
  const target = `https://haveibeenpwned.com/account/${encodeURIComponent(normalizeEmail(email))}`;
  const resp = await fetchStatus(target);
  const body = (resp.body || '').toLowerCase();

  if (body.includes('good news') && body.includes('no pwnage found')) {
    return makeEmailResult({
      name: 'Have I Been Pwned',
      status: 'not_found',
      url: target,
      summary: 'Public breach page indicates no known pwnage for this email.',
      detail: 'Treat as an indicator only. Breach status can change over time.',
      reasonCodes: ['hibp_page_no_pwnage'],
      extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'hibp_page' },
    });
  }

  if (body.includes('oh no') && body.includes('pwned')) {
    return makeEmailResult({
      name: 'Have I Been Pwned',
      status: 'found',
      url: target,
      summary: 'Public breach page indicates this email appears in known breaches.',
      detail: 'Open the source for breach names and exposure details.',
      reasonCodes: ['hibp_page_pwned'],
      extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'hibp_page' },
    });
  }

  return makeEmailResult({
    name: 'Have I Been Pwned',
    status: 'unknown',
    url: target,
    summary: 'Breach page could not be classified automatically.',
    detail: 'Open the page directly to validate current status.',
    reasonCodes: ['hibp_page_inconclusive'],
    extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'hibp_page' },
  });
}

async function probeWebSearch(name, target, markerRegex, foundReason, notFoundReason) {
  const resp = await fetchStatus(target);
  const body = String(resp.body || '');
  const matchCount = (body.match(markerRegex) || []).length;

  if (matchCount > 0) {
    return makeEmailResult({
      name,
      status: 'found',
      url: target,
      summary: `Indexed references found (${matchCount} signal${matchCount === 1 ? '' : 's'}).`,
      detail: 'Open source results to inspect context and attribution.',
      reasonCodes: [foundReason],
      extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'web_search', signalCount: matchCount },
    });
  }

  if (resp.statusCode === 200) {
    return makeEmailResult({
      name,
      status: 'not_found',
      url: target,
      summary: 'No strong indexed references were detected automatically.',
      detail: 'Manual review may still reveal edge-case hits.',
      reasonCodes: [notFoundReason],
      extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'web_search', signalCount: 0 },
    });
  }

  return makeEmailResult({
    name,
    status: 'unknown',
    url: target,
    summary: 'Search source response was inconclusive.',
    detail: 'Source may block automation or require interactive checks.',
    reasonCodes: ['email_source_inconclusive'],
    extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'web_search', signalCount: 0 },
  });
}

async function fetchRenderedPageText(targetUrl) {
  if (!chromiumStealth) return { ok: false, text: '', title: '', statusCode: 0 };

  await acquireBSlot();
  let context;
  try {
    const b = await ensureBrowser();
    context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    let title = '';
    let text = '';
    let statusCode = 0;
    let blocked = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      await delay(350 + Math.floor(Math.random() * 650));
      const resp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: STEALTH_TIMEOUT_MS }).catch(() => null);
      statusCode = resp ? (resp.status() || statusCode) : statusCode;
      await page.waitForLoadState('networkidle', { timeout: 7000 }).catch(() => {});
      title = await page.title().catch(() => '');
      text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');

      const tl = String(title || '').toLowerCase();
      const bl = String(text || '').toLowerCase();
      blocked = BLOCKED_TITLE_PATTERNS.some(p => tl.includes(p)) || BLOCKED_BODY_PATTERNS.some(p => bl.includes(p));
      if (!blocked) break;
      if (attempt === 0) await page.waitForTimeout(2500);
    }
    await context.close();

    return {
      ok: !!(text || title),
      text: `${title}\n${text}`,
      title,
      statusCode: statusCode || 200,
      blocked,
    };
  } catch (_) {
    if (context) try { await context.close(); } catch (_) {}
    return { ok: false, text: '', title: '', statusCode: 0 };
  } finally {
    releaseBSlot();
  }
}

async function probeWebSearchWithBrowserFallback(name, target, markerRegex, foundReason, notFoundReason) {
  const first = await probeWebSearch(name, target, markerRegex, foundReason, notFoundReason);
  if (first.status !== 'unknown') return first;
  if (!chromiumStealth) return first;

  const rendered = await fetchRenderedPageText(target);
  if (!rendered.ok) {
    return makeEmailResult({
      name,
      status: 'unknown',
      url: target,
      summary: first.summary,
      detail: `${first.detail} Browser-render fallback could not load source content.`,
      reasonCodes: Array.from(new Set([...(first.reasonCodes || []), 'browser_fallback'])),
      extra: { statusCode: 0, bodyHash: null, method: 'web_search_browser' },
    });
  }

  const matchCount = (String(rendered.text || '').match(markerRegex) || []).length;

  if (matchCount > 0) {
    return makeEmailResult({
      name,
      status: 'found',
      url: target,
      summary: `Browser-rendered source loaded and produced indexed results (${matchCount}).`,
      detail: 'Source required browser rendering for reliable parsing.',
      reasonCodes: ['browser_fallback', foundReason],
      extra: {
        statusCode: rendered.statusCode || 200,
        bodyHash: hashBodySample(rendered.text),
        method: 'web_search_browser',
        signalCount: matchCount,
      },
    });
  }

  return makeEmailResult({
    name,
    status: 'not_found',
    url: target,
    summary: rendered.blocked
      ? 'Source was reachable but challenge-protected; strong indexed references were not confirmed automatically.'
      : 'Browser-rendered source loaded but no strong indexed references were detected.',
    detail: rendered.blocked
      ? 'This source appears challenge-protected. Manual review is recommended for final confirmation.'
      : 'Manual review may still find edge-case references.',
    reasonCodes: rendered.blocked ? ['browser_fallback', 'cloudflare_or_challenge_detected', notFoundReason] : ['browser_fallback', notFoundReason],
    extra: {
      statusCode: rendered.statusCode || 200,
      bodyHash: hashBodySample(rendered.text),
      method: 'web_search_browser',
      signalCount: 0,
    },
  });
}

async function probeDuckDuckGoEmail(email) {
  const target = `https://duckduckgo.com/html/?q=${encodeURIComponent(`"${normalizeEmail(email)}"`)}`;
  return probeWebSearchWithBrowserFallback('DuckDuckGo', target, /result__a|result-link/gi, 'duckduckgo_email_hits', 'duckduckgo_email_no_hits');
}

async function probeBingEmail(email) {
  const target = `https://www.bing.com/search?q=${encodeURIComponent(`"${normalizeEmail(email)}"`)}`;
  return probeWebSearchWithBrowserFallback('Bing', target, /<li class="b_algo"|b_title/gi, 'bing_email_hits', 'bing_email_no_hits');
}

async function probeGitHubEmail(email) {
  const target = `https://github.com/search?q=${encodeURIComponent(`"${normalizeEmail(email)}"`)}&type=code`;
  return probeWebSearchWithBrowserFallback('GitHub Search', target, /code-list-item|search-title|repo-list-item/gi, 'github_email_hits', 'github_email_no_hits');
}

function buildEmailPivots(email) {
  const encoded = encodeURIComponent(normalizeEmail(email));

  return [
    makeEmailResult({
      name: 'IntelX Search Pivot',
      status: 'link',
      url: `https://intelx.io/?s=${encoded}`,
      summary: 'Open deep-index search for leaked and indexed references.',
      detail: 'Useful for deeper manual validation when automated checks are inconclusive.',
      reasonCodes: ['manual_intel_pivot'],
      extra: { method: 'link' },
    }),
  ];
}

function guessPhoneRegion(phone) {
  const p = normalizePhone(phone);
  if (p.startsWith('+1')) return 'North America (+1)';
  if (p.startsWith('+44')) return 'United Kingdom (+44)';
  if (p.startsWith('+61')) return 'Australia (+61)';
  if (p.startsWith('+91')) return 'India (+91)';
  if (p.startsWith('+81')) return 'Japan (+81)';
  if (p.startsWith('+49')) return 'Germany (+49)';
  if (p.startsWith('+33')) return 'France (+33)';
  if (p.startsWith('+34')) return 'Spain (+34)';
  return p.startsWith('+') ? 'International format detected' : 'Local format detected';
}

function analyzePhoneNumber(phone) {
  const normalized = normalizePhone(phone);
  const valid = isValidPhone(normalized);
  return makeIntelResult({
    category: 'phone',
    name: 'Phone Structure',
    status: valid ? 'found' : 'unknown',
    url: `https://www.google.com/search?q=${encodeURIComponent(`"${normalized}"`)}`,
    summary: valid
      ? `Format valid (${normalized.length - (normalized.startsWith('+') ? 1 : 0)} digits).`
      : 'Phone format could not be validated confidently.',
    detail: valid
      ? `Region hint: ${guessPhoneRegion(normalized)}`
      : 'Try international format with country code, e.g. +1 555 123 4567.',
    reasonCodes: [valid ? 'phone_format_valid' : 'phone_format_unknown'],
    extra: { method: 'phone_format' },
  });
}

async function probeDuckDuckGoPhone(phone) {
  const normalized = normalizePhone(phone);
  const target = `https://duckduckgo.com/html/?q=${encodeURIComponent(`"${normalized}"`)}`;
  const result = await probeWebSearchWithBrowserFallback('DuckDuckGo Phone', target, /result__a|result-link/gi, 'phone_search_hits', 'phone_search_no_hits');
  return { ...result, category: 'phone', mode: 'phone' };
}

async function probeBingPhone(phone) {
  const normalized = normalizePhone(phone);
  const target = `https://www.bing.com/search?q=${encodeURIComponent(`"${normalized}"`)}`;
  const result = await probeWebSearchWithBrowserFallback('Bing Phone', target, /<li class="b_algo"|b_title/gi, 'phone_search_hits', 'phone_search_no_hits');
  return { ...result, category: 'phone', mode: 'phone' };
}

function buildPhonePivots(phone) {
  const normalized = normalizePhone(phone);
  const encoded = encodeURIComponent(normalized);
  const digitsOnly = normalized.replace(/^\+/, '');
  return [
    makeIntelResult({
      category: 'phone',
      name: 'Google Reverse Pivot',
      status: 'link',
      url: `https://www.google.com/search?q=${encodeURIComponent(`"${normalized}"`)}`,
      summary: 'Open web search pivot for reverse-phone traces.',
      detail: 'Useful for listings, forum posts, and cached directories.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
    makeIntelResult({
      category: 'phone',
      name: 'IntelX Phone Pivot',
      status: 'link',
      url: `https://intelx.io/?s=${encoded}`,
      summary: 'Open deep-index phone pivot for leaked/indexed mentions.',
      detail: 'Useful when direct indexing checks are inconclusive.',
      reasonCodes: ['manual_intel_pivot'],
      extra: { method: 'link' },
    }),
    makeIntelResult({
      category: 'phone',
      name: 'That\'sThem Pivot',
      status: 'link',
      url: `https://thatsthem.com/phone/${encodeURIComponent(digitsOnly)}`,
      summary: 'Open reverse-phone directory pivot.',
      detail: 'Best-effort public directory source; verify manually.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
  ];
}

async function probeDomainDns(domain) {
  const d = normalizeDomain(domain);
  let a = [];
  let aaaa = [];
  let mx = [];
  let ns = [];

  try { a = await dns.resolve4(d); } catch (_) {}
  try { aaaa = await dns.resolve6(d); } catch (_) {}
  try { mx = await dns.resolveMx(d); } catch (_) {}
  try { ns = await dns.resolveNs(d); } catch (_) {}

  const hasSignals = a.length > 0 || aaaa.length > 0 || mx.length > 0 || ns.length > 0;
  const summary = `A ${a.length} | AAAA ${aaaa.length} | MX ${mx.length} | NS ${ns.length}`;

  return makeIntelResult({
    category: 'domain',
    name: 'DNS Signals',
    status: hasSignals ? 'found' : 'unknown',
    url: `https://${d}`,
    summary,
    detail: hasSignals
      ? `NS sample: ${(ns.slice(0, 2).join(', ') || 'n/a')}`
      : 'No strong DNS signals detected via resolver checks.',
    reasonCodes: [hasSignals ? 'domain_dns_present' : 'domain_dns_missing'],
    extra: { method: 'dns' },
  });
}

async function probeDomainReachability(domain) {
  const d = normalizeDomain(domain);
  const httpsResp = await fetchStatus(`https://${d}`);
  const httpResp = await fetchStatus(`http://${d}`);

  if (httpsResp.statusCode >= 200 && httpsResp.statusCode < 500) {
    return makeIntelResult({
      category: 'domain',
      name: 'Web Reachability',
      status: 'found',
      url: `https://${d}`,
      summary: `HTTPS responded with status ${httpsResp.statusCode}.`,
      detail: 'Domain is reachable over HTTPS.',
      reasonCodes: ['domain_https_reachable'],
      extra: { statusCode: httpsResp.statusCode, bodyHash: hashBodySample(httpsResp.body), method: 'http' },
    });
  }

  if (httpResp.statusCode >= 200 && httpResp.statusCode < 500) {
    return makeIntelResult({
      category: 'domain',
      name: 'Web Reachability',
      status: 'unknown',
      url: `http://${d}`,
      summary: `HTTP responded with status ${httpResp.statusCode}; HTTPS did not respond clearly.`,
      detail: 'Domain appears reachable but TLS endpoint may be restricted or unavailable.',
      reasonCodes: ['domain_http_only'],
      extra: { statusCode: httpResp.statusCode, bodyHash: hashBodySample(httpResp.body), method: 'http' },
    });
  }

  return makeIntelResult({
    category: 'domain',
    name: 'Web Reachability',
    status: 'unknown',
    url: `https://${d}`,
    summary: 'Domain web endpoint did not respond clearly.',
    detail: 'Could be offline, parked, blocked, or challenge-protected.',
    reasonCodes: ['domain_unreachable'],
    extra: { statusCode: httpsResp.statusCode || httpResp.statusCode || 0, method: 'http' },
  });
}

async function probeDomainCrtSh(domain) {
  const d = normalizeDomain(domain);
  const target = `https://crt.sh/?q=${encodeURIComponent(d)}&output=json`;
  const resp = await fetchStatus(target);
  const body = String(resp.body || '');
  const count = (body.match(/"name_value"/g) || []).length;
  const found = resp.statusCode === 200 && count > 0;

  return makeIntelResult({
    category: 'domain',
    name: 'Certificate Transparency',
    status: found ? 'found' : (resp.statusCode === 200 ? 'not_found' : 'unknown'),
    url: `https://crt.sh/?q=${encodeURIComponent(d)}`,
    summary: found
      ? `Certificate records detected (${count} entries).`
      : resp.statusCode === 200
        ? 'No certificate records detected in this query response.'
        : 'Certificate lookup response was inconclusive.',
    detail: 'Use certificate history to pivot on subdomains and infrastructure.',
    reasonCodes: [found ? 'crtsh_hits' : 'crtsh_no_hits'],
    extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'crtsh' },
  });
}

function buildDomainPivots(domain) {
  const d = normalizeDomain(domain);
  return [
    makeIntelResult({
      category: 'domain',
      name: 'Whois Lookup Pivot',
      status: 'link',
      url: `https://who.is/whois/${encodeURIComponent(d)}`,
      summary: 'Open WHOIS pivot for registration history and registrar data.',
      detail: 'Useful for ownership and registration timeline checks.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
    makeIntelResult({
      category: 'domain',
      name: 'DNSdumpster Pivot',
      status: 'link',
      url: `https://dnsdumpster.com/static/map/${encodeURIComponent(d)}.png`,
      summary: 'Open DNS infrastructure pivot.',
      detail: 'Best-effort infrastructure map artifact; may not exist for every domain.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
    makeIntelResult({
      category: 'domain',
      name: 'VirusTotal GUI Pivot',
      status: 'link',
      url: `https://www.virustotal.com/gui/domain/${encodeURIComponent(d)}`,
      summary: 'Open reputation and passive DNS pivot.',
      detail: 'Useful for reputation context and linked artifacts.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
  ];
}

/* ── Display name extractor (optional field on 'found' results) ────────── */
function extractDisplayName(title, username) {
  if (!title) return null;
  const uLow = username.toLowerCase();
  const t = title.trim();

  // "Full Name (@handle)" or "Full Name (@handle) on Platform"
  let m = t.match(/^(.+?)\s*\(@?[a-zA-Z0-9._\-]+\)/);
  if (m) {
    const name = m[1].trim();
    if (name.toLowerCase() !== uLow && name.length > 1 && name.length < 60) return name;
  }

  // "handle (Full Name) · Platform" — GitHub style
  m = t.match(/^@?[a-zA-Z0-9._\-]+ \((.+?)\)/);
  if (m) {
    const name = m[1].trim();
    if (name.toLowerCase() !== uLow && name.length > 1 && name.length < 60) return name;
  }

  // "Full Name | Platform" or "Full Name · Platform" or "Full Name — Platform" or "Full Name - Platform"
  m = t.match(/^(.+?)\s*[|·\u2013\u2014]\s*.+$/);
  if (m) {
    const name = m[1].trim();
    if (name.toLowerCase() !== uLow && name.length > 1 && name.length < 60
        && name.includes(' ')) return name;
  }

  return null;
}

/* ── Name-site URL builder ───────────────────────────────────────────────── */
function toSlug(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function toTitleSlug(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('-');
}

const US_STATE_CODES = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
  'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV',
  'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY',
  'north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK',
  'oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT',
  'vermont':'VT','virginia':'VA','washington':'WA','west virginia':'WV',
  'wisconsin':'WI','wyoming':'WY','district of columbia':'DC',
};

const STATE_CODE_TO_NAME = Object.fromEntries(
  Object.entries(US_STATE_CODES).map(([name, code]) => [code, name])
);

function toStateCode(s) {
  if (!s) return '';
  const t = s.trim();
  if (t.length <= 3) return t.toUpperCase();
  return US_STATE_CODES[t.toLowerCase()] || t.slice(0, 2).toUpperCase();
}

function toStateName(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (!t) return '';
  const code = toStateCode(t);
  const raw = STATE_CODE_TO_NAME[code] || t.toLowerCase();
  return raw.split(' ').map(part => part ? (part[0].toUpperCase() + part.slice(1)) : '').join(' ');
}

function toPlusParam(s) {
  return encodeURIComponent(String(s || '').trim()).replace(/%20/g, '+');
}

function buildNameUrl(site, firstName, lastName, filters = {}) {
  const city     = (filters.city  || '').trim();
  const stateRaw = (filters.state || '').trim();
  const state    = toStateCode(stateRaw);
  const stateFull = toStateName(stateRaw);
  const ageMin   = String(filters.ageMin || '');
  const ageMax   = String(filters.ageMax || '');

  const fLow  = firstName.toLowerCase();
  const lLow  = lastName.toLowerCase();

  const encFirst  = encodeURIComponent(firstName);
  const encLast   = encodeURIComponent(lastName);
  const encFull   = encodeURIComponent(`${firstName} ${lastName}`);
  const encHyphen = encodeURIComponent(`${fLow}-${lLow}`);
  const encUnder  = encodeURIComponent(`${fLow}_${lLow}`);
  const encPlus   = encodeURIComponent(`${firstName}+${lastName}`);

  const citySlug       = toSlug(city);
  const cityTitleSlug  = toTitleSlug(city);
  const cityPlus       = toPlusParam(city);
  const stateSlug      = toSlug(stateRaw);
  const stateCodeLower = state.toLowerCase();
  const locationPath = city && state ? `${citySlug}-${stateCodeLower}`
                     : city          ? citySlug
                     : stateCodeLower;
  const locationQs = city && state ? encodeURIComponent(`${city}, ${state}`)
                   : city          ? encodeURIComponent(city)
                   : encodeURIComponent(state);
  const locationQsDouble = encodeURIComponent(locationQs);
  const fullNameDouble = encodeURIComponent(encFull);

  const hasCity  = !!city;
  const hasState = !!state;
  const hasAge   = !!(ageMin || ageMax);
  let template = site.url;
  if (site.urlFiltered) {
    const fr = site.filterRequires || 'any';
    const useFiltered =
      (fr === 'city_and_state' && hasCity && hasState) ||
      ((fr === 'state' || fr === 'any') && (hasCity || hasState || hasAge));
    if (useFiltered) template = site.urlFiltered;
  }

  return template
    .replace('{first}',               encFirst)
    .replace('{last}',                encLast)
    .replace('{first_lower}',         encodeURIComponent(fLow))
    .replace('{last_lower}',          encodeURIComponent(lLow))
    .replace('{fullname}',            encFull)
    .replace('{fullname_hyphen}',     encHyphen)
    .replace('{fullname_hyphen_lower}', `${fLow}-${lLow}`)
    .replace('{fullname_underscore}', encUnder)
    .replace('{fullname_underscore_lower}', `${fLow}_${lLow}`)
    .replace('{fullname_plus}',       encodeURIComponent(`${fLow} ${lLow}`))
    .replace('{fullname_plus_lower}', `${encodeURIComponent(fLow)}+${encodeURIComponent(lLow)}`)
    .replace('{city}',                encodeURIComponent(city))
    .replace('{city_slug}',           citySlug)
    .replace('{city_title_slug}',     cityTitleSlug)
    .replace('{city_plus}',           cityPlus)
    .replace('{state_code}',          state)
    .replace('{state_code_lower}',    stateCodeLower)
    .replace('{state_full}',          encodeURIComponent(stateFull))
    .replace('{state_slug}',          stateSlug)
    .replace('{city_state_slug}',     locationPath)
    .replace('{location_path}',       locationPath)
    .replace('{location_qs}',         locationQs)
    .replace('{location_qs_double}',  locationQsDouble)
    .replace('{fullname_double}',     fullNameDouble)
    .replace('{age_min}',             ageMin)
    .replace('{age_max}',             ageMax);
}

/* ── Name-site stealth probe ───────────────────────────────────────────────────────── */
async function probeNameSearch(site, firstName, lastName, filters = {}) {
  const profileUrl = buildNameUrl(site, firstName, lastName, filters);

  const base = { name: site.name, category: 'people-finder', url: profileUrl, mode: 'name' };

  if (!chromiumStealth) return { ...base, status: 'unknown', statusCode: 0 };

  await acquireBSlot();
  let context;
  try {
    const b = await ensureBrowser();
    context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale   : 'en-US',
      viewport : { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    let title = '';
    let text  = '';
    let statusCode = 0;
    let challengeSeen = false;

    for (let attempt = 0; attempt < 1; attempt++) {
      try {
        await delay(350 + Math.floor(Math.random() * 650));
        const resp = await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: STEALTH_TIMEOUT_MS }).catch(() => null);
        statusCode = resp ? (resp.status() || statusCode) : statusCode;
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      } catch (_) {}

      title = await page.title().catch(() => '');
      text  = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 5000) : '').catch(() => '');
      const tl = String(title || '').toLowerCase();
      const bl = String(text || '').toLowerCase();
      challengeSeen = BLOCKED_TITLE_PATTERNS.some(p => tl.includes(p)) || BLOCKED_BODY_PATTERNS.some(p => bl.includes(p));
      if (!challengeSeen) break;
    }
    await context.close();

    const tLow = title.toLowerCase();
    const bLow = text.toLowerCase();
    const combined = tLow + ' ' + bLow;

    // Bot-wall detection
    if (challengeSeen || BLOCKED_TITLE_PATTERNS.some(p => tLow.includes(p)) || BLOCKED_BODY_PATTERNS.some(p => bLow.includes(p))) {
      // Compliant fallback: retry with a plain HTTP fetch parser before declaring blocked.
      const httpFallback = await fetchStatus(profileUrl);
      const fbBody = String(httpFallback.body || '').toLowerCase();
      const fbBlocked = BLOCKED_BODY_PATTERNS.some(p => fbBody.includes(p));

      if (httpFallback.statusCode === 404 || httpFallback.statusCode === 410) {
        return { ...base, status: 'not_found', statusCode: httpFallback.statusCode, reasonCodes: ['http_fallback_not_found'] };
      }

      if (!fbBlocked && httpFallback.statusCode === 200) {
        if (site.noResultsMsg && fbBody.includes(site.noResultsMsg.toLowerCase())) {
          return { ...base, status: 'not_found', statusCode: 200, reasonCodes: ['http_fallback_no_results'] };
        }
        if (site.resultsPattern && fbBody.includes(site.resultsPattern.toLowerCase())) {
          return { ...base, status: 'found', statusCode: 200, reasonCodes: ['http_fallback_results_pattern'] };
        }
      }

      return { ...base, status: 'unknown', statusCode: statusCode || httpFallback.statusCode || 0, reasonCodes: ['cloudflare_or_challenge_detected'] };
    }

    if (statusCode === 404 || statusCode === 410) {
      return { ...base, status: 'not_found', statusCode };
    }

    if (site.noResultsMsg && combined.includes(site.noResultsMsg.toLowerCase())) {
      return { ...base, status: 'not_found', statusCode: statusCode || 200 };
    }

    // Try to count results
    let resultCount = null;
    const countMatch = combined.match(/(\d+)\s+(?:result|record|people|person|match)/i);
    if (countMatch) resultCount = parseInt(countMatch[1], 10);

    if (site.resultsPattern && combined.includes(site.resultsPattern.toLowerCase())) {
      return { ...base, status: 'found', statusCode: statusCode || 200, resultCount };
    }

    // Fallback: if page loaded without a "no results" message and has enough content, assume found
    if (bLow.length > 500) {
      return { ...base, status: 'found', statusCode: statusCode || 200, resultCount };
    }

    return { ...base, status: 'unknown', statusCode: statusCode || 0 };
  } catch (err) {
    if (context) try { await context.close(); } catch (_) {}
    return { ...base, status: 'unknown', statusCode: 0 };
  } finally {
    releaseBSlot();
  }
}

/* ── Safe URL for href (prevent javascript: etc.) ─────────────────────── */
function isSafeUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch (_) { return false; }
}

/* ── Single-site probe (follows redirects up to MAX_REDIRECT_HOPS) ─────── */
const MAX_REDIRECT_HOPS = 3;

function makeReqOptions(parsed, overrideUA) {
  const ua = overrideUA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  return {
    hostname: parsed.hostname,
    port    : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path    : parsed.pathname + parsed.search,
    method  : 'GET',
    headers : {
      'User-Agent'               : ua,
      'Accept'                   : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language'          : 'en-US,en;q=0.9',
      'Cache-Control'            : 'max-age=0',
      'Connection'               : 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest'           : 'document',
      'Sec-Fetch-Mode'           : 'navigate',
      'Sec-Fetch-Site'           : 'none',
      'Sec-Fetch-User'           : '?1',
      'sec-ch-ua'                : '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="8"',
      'sec-ch-ua-mobile'         : '?0',
      'sec-ch-ua-platform'       : '"Windows"',
    },
    timeout: TIMEOUT_MS,
  };
}

function doRequest(site, username, origUrl, url, hops, finish) {
  let parsed;
  try { parsed = new URL(url); }
  catch (_) { return finish({ name: site.name, category: site.category, url: origUrl, status: 'error', statusCode: 0 }); }

  const mod  = parsed.protocol === 'https:' ? https : http;
  const base = { name: site.name, category: site.category, url: origUrl };
  const crawlerUA = site.crawlerUA === 'googlebot'
    ? 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
    : site.crawlerUA === 'twitterbot'
    ? 'Twitterbot/1.0'
    : site.crawlerUA === 'facebookbot'
    ? 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
    : null;

  const req = mod.request(makeReqOptions(parsed, crawlerUA), (res) => {
    const sc      = res.statusCode;
    const headers = res.headers;

    // ── Handle redirects ───────────────────────────────────────────────
    if (sc >= 301 && sc <= 308) {
      res.resume(); // drain to free socket

      // WMN-derived sites carry a "missing profile" status code (m_code,
      // stored as site.notFoundStatus) that is OFTEN this exact redirect
      // code — the redirect itself IS the not-found signal. Check this
      // BEFORE any of the location-sniffing heuristics below, or we'd
      // follow the redirect away and lose the signal (this caused a real
      // false "found" on 247CTF, whose m_code is 302).
      if (site.notFoundStatus && sc === site.notFoundStatus) {
        return finish({ ...base, status: 'not_found', statusCode: sc });
      }

      const locRaw = headers['location'] || '';
      if (!locRaw) return finish({ ...base, status: 'found', statusCode: sc });
      const loc = locRaw.toLowerCase();

      let absLoc;
      try { absLoc = new URL(locRaw, url).href; }
      catch (_) { return finish({ ...base, status: 'found', statusCode: sc }); }

      // Auth/login redirect → not_found
      if (AUTH_REDIRECT_PATTERNS.some(p => loc.includes(p))) {
        return finish({ ...base, status: 'not_found', statusCode: sc });
      }
      // Bot-protection redirect → unknown (can't determine)
      if (loc.includes('.within.website') || loc.includes('/_/') ||
          loc.includes('/cdn-cgi/') || loc.includes('challenge') ||
          loc.includes('/captcha') || loc.includes('splashui') ||
          loc.includes('verify-browser') || loc.includes('bot-check')) {
        return finish({ ...base, status: 'unknown', statusCode: sc });
      }
      // Redirect to domain root (no sub-path) → user doesn't exist
      try {
        const absURL = new URL(locRaw, url);
        if (absURL.pathname === '/' && !absURL.search) {
          return finish({ ...base, status: 'not_found', statusCode: sc });
        }
        // Redirect to /404 or /not-found path → user doesn't exist
        if (/\/(404|not[-_]?found|account[-_]?deleted|deleted[-_]?account|user[-_]?not[-_]?found|no[-_]?user)(\/|$)/i.test(absURL.pathname)) {
          return finish({ ...base, status: 'not_found', statusCode: sc });
        }
      } catch (_) {}

      // Follow redirect if within hop limit
      if (hops < MAX_REDIRECT_HOPS) {
        return doRequest(site, username, origUrl, absLoc, hops + 1, finish);
      }
      // Gave up following — treat as found
      return finish({ ...base, status: 'found', statusCode: sc });
    }

    // ── Non-redirect: read body and classify ──────────────────────────
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      body += chunk;
      if (body.length >= MAX_BODY) res.destroy();
    });
    res.on('close', () => {
      finish(classify(site, username, origUrl, sc, headers, body));
    });
    res.on('error', () => finish({ ...base, status: 'error', statusCode: 0 }));
  });

  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', (err) => {
    if (err.message === 'timeout') {
      finish({ ...base, status: 'timeout', statusCode: 0 });
    } else {
      finish({ ...base, status: 'error', statusCode: 0 });
    }
  });

  req.end();
}

/* ── Stealth browser pool ─────────────────────────────────────────────── */
function acquireBSlot() {
  return new Promise(r => {
    if (_bSlots < STEALTH_CONCURRENCY) { _bSlots++; r(); }
    else _bQueue.push(r);
  });
}
function releaseBSlot() {
  if (_bQueue.length) { _bQueue.shift()(); }
  else _bSlots--;
}

async function ensureBrowser() {
  if (_browser)     return _browser;
  if (_browserTask) return _browserTask;
  _browserTask = chromiumStealth.launch({ headless: true }).then(b => {
    _browser     = b;
    _browserTask = null;
    b.on('disconnected', () => { _browser = null; });
    return b;
  });
  return _browserTask;
}

async function probeStealth(site, username) {
  const profileUrl = site.url.replace(/\{\}/g, encodeURIComponent(username));
  const base = { name: site.name, category: site.category, url: profileUrl };

  if (!chromiumStealth) {
    return { ...base, status: 'unknown', statusCode: 0 };
  }

  await acquireBSlot();
  let context;
  try {
    const b = await ensureBrowser();
    context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale   : 'en-US',
      viewport : { width: 1280, height: 800 },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const page = await context.newPage();
    let statusCode = 0;
    let title = '', text = '';
    try {
      const response = await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: STEALTH_TIMEOUT_MS }).catch(() => null);
      statusCode = response ? (response.status() || 0) : statusCode;
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    } catch (_) { /* partial content is acceptable */ }
    title = await page.title().catch(() => '');
    text  = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    await context.close();
    const syntheticBody = `<title>${title}</title>\n${text}`;
    return classify(site, username, profileUrl, statusCode || 200, {}, syntheticBody, 'browser');
  } catch (err) {
    if (context) try { await context.close(); } catch (_) {}
    return { ...base, status: 'unknown', statusCode: 0 };
  } finally {
    releaseBSlot();
  }
}

// WhatsMyName's public dataset doesn't ship a per-site username-format
// regex, so we can't replicate its exact per-platform validation. As a
// cheap, safe proxy that still meaningfully cuts false positives: most
// platforms reject usernames containing raw spaces (a strong signal the
// input is actually a full name/phrase, not a handle) — except a handful
// of categories (gaming platforms like Roblox/PSN/Xbox/Steam commonly use
// space-containing display names). Skipping the network request entirely
// for a clearly-incompatible format is both faster and reduces noise from
// odd site-specific behavior on malformed input.
const ALLOW_SPACE_CATEGORIES = new Set(['gaming']);
function isUsernameFormatPlausible(username, site) {
  if (/\s/.test(username) && !ALLOW_SPACE_CATEGORIES.has(site.category)) return false;
  return true;
}

function probe(site, username) {
  // Optional fast-path: skip stealth for undetectable sites.
  // Sites that require authentication — server-side check is never possible
  if (site.requiresAuth) {
    return Promise.resolve({
      name: site.name,
      category: site.category,
      url: site.url.replace(/\{\}/g, encodeURIComponent(username)),
      status: 'auth_required',
      statusCode: 0,
      reasonCodes: ['requires_authentication'],
      confidence: 1.0,
      detectionMethod: 'http',
      bodyHash: null,
    });
  }

  // Format is obviously incompatible with this platform — skip the network
  // request entirely rather than risk a misleading response.
  if (!isUsernameFormatPlausible(username, site)) {
    return Promise.resolve({
      name: site.name,
      category: site.category,
      url: site.url.replace(/\{\}/g, encodeURIComponent(username)),
      status: 'not_found',
      statusCode: 0,
      reasonCodes: ['username_format_incompatible'],
      confidence: 0.55,
      detectionMethod: 'format_check',
      bodyHash: null,
    });
  }

  // NOTE: cfProxy/cors sites used to be deferred entirely to client-side
  // tiers (browser-direct fetch / CF Worker edge proxy) since our own
  // server IP got blocked by some CF-protected hosts. That client-side
  // fallback has been removed as redundant now that every site resolves
  // through this same server-side path — cfProxy/cors sites just fall
  // through to the normal request below and surface as 'blocked' if the
  // target actually blocks our server's IP (visible to the user, same as
  // any other blocked site), instead of silently staying 'unknown'.

  if (site.undetectable && !ENABLE_UNDETECTABLE_STEALTH) {
    return Promise.resolve({
      name: site.name,
      category: site.category,
      url: site.url.replace(/\{\}/g, encodeURIComponent(username)),
      status: 'unknown',
      statusCode: 0,
      reasonCodes: ['inconclusive_result'],
      detectionMethod: 'http',
      bodyHash: null,
    });
  }

  if (site.undetectable) return probeStealth(site, username);

  return new Promise((resolve) => {
    // Sites with a calibrated internal API endpoint — hit that directly
    const targetTemplate = site.apiUrl || site.url;
    let url;
    try {
      url = targetTemplate.replace(/\{\}/g, encodeURIComponent(username));
    } catch (_) {
      return resolve({ name: site.name, category: site.category, url: site.url, status: 'error', statusCode: 0 });
    }

    // The URL shown to the user in results is always the profile URL, not the API URL
    const profileUrl = site.url.replace(/\{\}/g, encodeURIComponent(username));
    doRequest(site, username, profileUrl, url, 0, resolve);
  });
}

async function probeWithBrowserFallback(site, username) {
  const first = await probe(site, username);

  // Keep fast-path result when already conclusive.
  if (first.status !== 'unknown') return first;

  let result = first;
  if ((ENABLE_USERNAME_BROWSER_FALLBACK || site.allowBrowserFallback) && chromiumStealth && !site.noBrowserFallback) {
    const second = await probeStealth(site, username);
    const secondReasons = Array.isArray(second.reasonCodes) ? second.reasonCodes : [];
    result = {
      ...second,
      preBrowserStatus: first.status,
      resolvedBy: 'browser',
      reasonCodes: secondReasons.includes('browser_fallback') ? secondReasons : [...secondReasons, 'browser_fallback'],
    };
  }

  // Last resort: any site still 'unknown' after the direct request (and
  // browser fallback, if it ran) gets checked against the Wayback Machine's
  // CDX API — if the profile URL was ever archived with a 200 response, the
  // profile almost certainly existed at that point in time. This used to be
  // a separate client-side pass; folding it in here means the frontend gets
  // one single, already-final verdict per site instead of needing its own
  // follow-up network round.
  if (result.status === 'unknown') {
    const archived = await probeArchiveOrgFallback(result.url).catch(() => false);
    if (archived) {
      const reasons = Array.isArray(result.reasonCodes) ? result.reasonCodes : [];
      result = { ...result, status: 'found', confidence: 0.6, reasonCodes: [...reasons, 'archive_org_fallback_found'] };
    }
  }

  return result;
}

// Wayback Machine CDX lookup — open CORS-free API, no key needed. Returns
// true if the given URL was archived with a 200 response since 2022.
function probeArchiveOrgFallback(profileUrl) {
  return new Promise((resolve) => {
    let cdxUrl;
    try {
      const cdxTarget = profileUrl.replace(/^https?:\/\//, '');
      cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(cdxTarget)}&output=json&limit=2&filter=statuscode:200&from=20220101&fl=timestamp&matchType=prefix`;
    } catch (_) { return resolve(false); }

    const req = https.get(cdxUrl, { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(false); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (body.length < 20000) body += chunk; });
      res.on('end', () => {
        try {
          const rows = JSON.parse(body);
          resolve(Array.isArray(rows) && rows.length > 1); // row[0] is the header
        } catch (_) { resolve(false); }
      });
      res.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}


function getQuickSites() {
  const selected = [];
  const used = new Set();

  for (const key of QUICK_SITE_NAMES) {
    const hit = SITES.find(s => !used.has(s.name) && s.name.toLowerCase() === key);
    if (hit) {
      selected.push(hit);
      used.add(hit.name);
    }
  }

  if (selected.length < 8) {
    for (const s of SITES) {
      if (used.has(s.name)) continue;
      selected.push(s);
      used.add(s.name);
      if (selected.length >= 8) break;
    }
  }

  return selected;
}

function toQuickStatus(status) {
  if (status === 'found' || status === 'deleted') return 'taken';
  if (status === 'not_found') return 'available';
  return 'unknown';
}

/* ── HTTP-only snapshot fallback (no browser — parses raw HTML) ─────── */
function httpSnapshotFallback(rawUrl, res) {
  const https = require('https');
  const http2 = require('http');
  const mod = rawUrl.startsWith('https') ? https : http2;
  const req = mod.get(rawUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 8000,
  }, (r) => {
    let body = '';
    r.on('data', d => { if (body.length < 80000) body += d; });
    r.on('end', () => {
      function gmRx(name) {
        const rx = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
        const rx2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, 'i');
        const m = rx.exec(body) || rx2.exec(body);
        return m ? m[1].trim() : '';
      }
      const titleM = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(body);
      const metadata = {
        title:         titleM ? titleM[1].trim() : '',
        url:           rawUrl,
        description:   gmRx('description') || gmRx('og:description'),
        ogTitle:       gmRx('og:title'),
        ogSiteName:    gmRx('og:site_name'),
        author:        gmRx('author') || gmRx('article:author'),
        keywords:      gmRx('keywords'),
        publishedTime: gmRx('article:published_time'),
        twitterCard:   gmRx('twitter:card'),
        capturedAt:    new Date().toISOString(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, metadata, screenshot: '', mimeType: 'image/jpeg', httpOnly: true }));
    });
  });
  req.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Still return ok:true with empty metadata so UI doesn't show an error
      res.end(JSON.stringify({ ok: true, metadata: { title: '', url: rawUrl, description: '', capturedAt: new Date().toISOString() }, screenshot: '', mimeType: 'image/jpeg', httpOnly: true, fetchError: err.message }));
    }
  });
  req.setTimeout(8000, () => req.destroy());
}

/* ── Link preview helpers (dork result thumbnails) ───────────────────── */
function sendNoImage(res) {
  if (res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, image: null }));
}

function readAndExtractImage(r, baseUrl, res) {
  if (r.statusCode < 200 || r.statusCode >= 300) { r.resume(); return sendNoImage(res); }
  const ct = (r.headers['content-type'] || '').toLowerCase();
  if (ct && !ct.includes('html')) { r.resume(); return sendNoImage(res); }

  let body = '';
  let done = false;
  r.setEncoding('utf8');
  r.on('data', chunk => {
    if (done) return;
    body += chunk;
    // og:image/twitter:image meta tags live in <head>, no need to read
    // the whole document — bail out early once we've seen enough or hit
    // </head>, whichever comes first.
    if (body.length >= 220000 || /<\/head>/i.test(body)) {
      done = true;
      r.destroy();
      finish();
    }
  });
  r.on('end', () => { if (!done) { done = true; finish(); } });
  r.on('error', () => { if (!done) { done = true; sendNoImage(res); } });

  function finish() {
    try {
      const cheerio = require('cheerio');
      const $c = cheerio.load(body);
      const gm = name =>
        ($c(`meta[property="${name}"]`).attr('content') ||
         $c(`meta[name="${name}"]`).attr('content') || '').trim();
      let image = gm('og:image') || gm('og:image:url') || gm('twitter:image') || gm('twitter:image:src') || '';
      if (image) {
        try { image = new URL(image, baseUrl).href; } catch (_) { image = ''; }
      }
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, image: image || null }));
      }
    } catch (_) { sendNoImage(res); }
  }
}

/* ── Cheerio metadata + raw HTML fetch (for client-side capture) ────── */
async function fetchPageCheerio(rawUrl, res) {
  try {
    const https = require('https');
    const httpMod = require('http');
    const mod = rawUrl.startsWith('https') ? https : httpMod;
    const html = await new Promise((resolve, reject) => {
      const req = mod.get(rawUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 12000,
      }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', d => { if (body.length < 800000) body += d; });
        r.on('end', () => resolve(body));
        r.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(12000, () => req.destroy());
    });
    const cheerio = require('cheerio');
    const $c = cheerio.load(html);
    const gm = name =>
      ($c(`meta[name="${name}"]`).attr('content') ||
       $c(`meta[property="${name}"]`).attr('content') || '').trim();
    const metadata = {
      title:         ($c('title').text().trim() || gm('og:title')).slice(0, 200),
      url:           rawUrl,
      description:   gm('description') || gm('og:description'),
      ogTitle:       gm('og:title'),
      ogSiteName:    gm('og:site_name'),
      ogImage:       gm('og:image'),
      author:        gm('author') || gm('article:author'),
      keywords:      gm('keywords'),
      publishedTime: gm('article:published_time'),
      twitterCard:   gm('twitter:card'),
      canonical:     $c('link[rel="canonical"]').attr('href') || '',
      capturedAt:    new Date().toISOString(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, metadata, html }));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message.slice(0, 200) }));
    }
  }
}

/* ── OG image proxy (returns base64 JSON) ──────────────────────────── */
function proxyImage(rawUrl, res) {
  const https = require('https');
  const httpMod = require('http');
  const mod = rawUrl.startsWith('https') ? https : httpMod;
  const req = mod.get(rawUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    timeout: 8000,
  }, (r) => {
    const ct = (r.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
    if (!ct.startsWith('image/')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not an image' }));
      return;
    }
    const chunks = [];
    let total = 0;
    r.on('data', d => { total += d.length; if (total < 5000000) chunks.push(d); });
    r.on('end', () => {
      const b64 = Buffer.concat(chunks).toString('base64');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, b64, mimeType: ct }));
    });
    r.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'stream error' }));
      }
    });
  });
  req.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
  req.setTimeout(8000, () => req.destroy());
}

/* ── Static file helper ───────────────────────────────────────────────── */
function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const ct  = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

async function streamTaskResults(send, startPayload, taskFactories) {
  const total = taskFactories.length;
  let done = 0;
  send({ type: 'start', total, ...startPayload });

  await Promise.all(taskFactories.map(factory => Promise.resolve()
    .then(factory)
    .catch(() => null)
    .then(item => {
      done += 1;
      if (item) send({ type: 'result', ...item, done, total });
    })));

  send({ type: 'done', done: total, total });
}

/* ── HTTP server ──────────────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  let urlObj;
  try { urlObj = new URL(req.url, `http://localhost:${PORT}`); }
  catch (_) { res.writeHead(400); return res.end('Bad Request'); }

  const pathname = urlObj.pathname;

  // Route POST requests to dedicated handlers
  if (req.method === 'POST') {
    if (pathname === '/api/contact' || pathname === '/api/report') {
      handlePostEndpoint(pathname, req, res).catch(() => {
        if (!res.writableEnded) { res.writeHead(500); res.end('Internal Server Error'); }
      });
    } else {
      res.writeHead(405, { Allow: 'GET' });
      res.end('Method Not Allowed');
    }
    return;
  }

  // Only allow GET past this point
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET, POST' });
    return res.end('Method Not Allowed');
  }

  /* ── SSE endpoint ───────────────────────────────────────────────────── */
  if (pathname === '/api/check') {
    const username = (urlObj.searchParams.get('username') || '').trim();
    if (!isValidUsername(username)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid username. Use letters, numbers, dots, hyphens, underscores (1-50 chars).' }));
    }

    const ip      = getClientIp(req);
    const cfToken = (urlObj.searchParams.get('cf-token') || '').trim();

    res.writeHead(200, {
      'Content-Type' : 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection'   : 'keep-alive',
    });

    let cancelled = false;
    req.on('close', () => { cancelled = true; });

    const send = (obj) => {
      if (!cancelled && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };

    // Rate limit check (sync — before async Turnstile call)
    if (!checkRateLimit(ip)) {
      send({ type: 'error', error: `Scan limit reached — ${RATE_LIMIT_MAX} free scans per hour. Try again later.`, code: 429 });
      return res.end();
    }

    // Turnstile verification then scan
    verifyTurnstile(cfToken, ip).then(tsOk => {
      if (cancelled) return;
      if (!tsOk) {
        send({ type: 'error', error: 'Security check failed. Please refresh and try again.', code: 403 });
        return res.end();
      }

      consumeRateLimit(ip);

      const queue = [...SITES];
      const total = queue.length;
      let idx = 0, active = 0, done = 0;

      send({ type: 'start', total, username });

      function tick() {
        while (active < CONCURRENCY && idx < total) {
          const site = queue[idx++];
          active++;
          const PROBE_DEADLINE_MS = 15000;
          const probePromise  = probeWithBrowserFallback(site, username);
          const timeoutResult = new Promise(resolve =>
            setTimeout(() => resolve({
              name: site.name, category: site.category,
              url:  site.url.replace(/\{\}/g, encodeURIComponent(username)),
              status: 'timeout', statusCode: 0,
              reasonCodes: ['probe_timeout'], detectionMethod: 'http', bodyHash: null,
            }), PROBE_DEADLINE_MS)
          );
          Promise.race([probePromise, timeoutResult]).then(result => {
            active--;
            done++;
            const normalized = normalizeResult(result);
            // Include CORS flag + check info so client can self-verify unknowns
            const extra = {};
            if (site.cors)         extra.cors     = true;
            if (site.cfProxy)      extra.cfProxy  = true;
            if (site.requiresAuth) extra.auth     = true;
            if (site.checkMethod)  extra.checkMethod = site.checkMethod;
            if (site.errorMsg)     extra.errorMsg    = site.errorMsg;
            if (site.positiveMsg)  extra.positiveMsg = site.positiveMsg;
            const checkUrl = (site.apiUrl || site.url).replace(/\{\}/g, encodeURIComponent(username));
            extra.checkUrl = checkUrl;
            if (!cancelled) send({ type: 'result', ...normalized, done, total, ...extra });
            tick();
          }).catch(() => {
            active--;
            done++;
            const fallback = normalizeResult({
              name: site.name,
              category: site.category,
              url: site.url.replace(/\{\}/g, encodeURIComponent(username)),
              status: 'unknown',
              statusCode: 0,
              reasonCodes: ['probe_rejected'],
              detectionMethod: 'http',
              bodyHash: null,
            });
            if (!cancelled) send({ type: 'result', ...fallback, done, total });
            tick();
          });
        }
        if (idx >= total && active === 0 && !res.writableEnded) {
          send({ type: 'done', done, total });
          res.end();
        }
      }

      tick();
    }).catch(() => {
      if (!cancelled) {
        send({ type: 'error', error: 'Server error. Please try again.' });
        res.end();
      }
    });

    return;
  }


  /* ── Quick check endpoint (instant, top platforms) ─────────────────── */
  if (pathname === '/api/quick-check') {
    const username = (urlObj.searchParams.get('username') || '').trim();
    if (!isValidUsername(username)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid username.' }));
    }

    const quickSites = getQuickSites();
    Promise.all(quickSites.map(site => probe(site, username)))
      .then(items => {
        const results = items.map(r => ({
          name: r.name,
          category: r.category,
          status: toQuickStatus(r.status),
          sourceStatus: r.status,
          url: r.url,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ username, total: results.length, results }));
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Quick check failed.' }));
      });
    return;
  }

  /* ── Email investigation SSE endpoint ──────────────────────────────── */
  if (pathname === '/api/email-check') {
    const email = (urlObj.searchParams.get('q') || '').trim();
    if (!isValidEmail(email)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid email address.' }));
    }

    res.writeHead(200, {
      'Content-Type' : 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection'   : 'keep-alive',
    });

    let cancelled = false;
    req.on('close', () => { cancelled = true; });

    const send = (obj) => {
      if (!cancelled && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };

    (async () => {
      const pivots = buildEmailPivots(email);
      const tasks = [
        () => probeGravatar(email),
        () => analyzeEmailDomain(email),
        () => probeHibpPublicPage(email),
        () => probeDuckDuckGoEmail(email),
        () => probeBingEmail(email),
        () => probeGitHubEmail(email),
        ...pivots.map(item => () => item),
      ];

      await streamTaskResults(send, { email: normalizeEmail(email) }, tasks);
      res.end();
    })().catch(() => {
      if (!res.writableEnded) {
        send({ type: 'done', done: 0, total: 0 });
        res.end();
      }
    });
    return;
  }

  if (pathname === '/api/phone-check') {
    const phone = (urlObj.searchParams.get('q') || '').trim();
    if (!isValidPhone(phone)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid phone number. Use 7-15 digits with optional leading +.' }));
    }

    res.writeHead(200, {
      'Content-Type' : 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection'   : 'keep-alive',
    });

    let cancelled = false;
    req.on('close', () => { cancelled = true; });

    const send = (obj) => {
      if (!cancelled && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };

    (async () => {
      const normalized = normalizePhone(phone);
      const pivots = buildPhonePivots(normalized);
      const tasks = [
        () => analyzePhoneNumber(normalized),
        () => probeDuckDuckGoPhone(normalized),
        () => probeBingPhone(normalized),
        ...pivots.map(item => () => item),
      ];

      await streamTaskResults(send, { phone: normalized }, tasks);
      res.end();
    })().catch(() => {
      if (!res.writableEnded) {
        send({ type: 'done', done: 0, total: 0 });
        res.end();
      }
    });
    return;
  }

  if (pathname === '/api/domain-check') {
    const rawDomain = (urlObj.searchParams.get('q') || '').trim();
    if (!isValidDomain(rawDomain)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid domain. Use a hostname like example.com.' }));
    }

    const domain = normalizeDomain(rawDomain);

    res.writeHead(200, {
      'Content-Type' : 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection'   : 'keep-alive',
    });

    let cancelled = false;
    req.on('close', () => { cancelled = true; });

    const send = (obj) => {
      if (!cancelled && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };

    (async () => {
      const pivots = buildDomainPivots(domain);
      const tasks = [
        () => probeDomainDns(domain),
        () => probeDomainReachability(domain),
        () => probeDomainCrtSh(domain),
        ...pivots.map(item => () => item),
      ];

      await streamTaskResults(send, { domain }, tasks);
      res.end();
    })().catch(() => {
      if (!res.writableEnded) {
        send({ type: 'done', done: 0, total: 0 });
        res.end();
      }
    });
    return;
  }

  /* ── Dork proxy endpoint ──────────────────────────────────────────── */
  if (pathname === '/api/dork-search') {
    const target = (urlObj.searchParams.get('target') || '').trim();
    const engine = (urlObj.searchParams.get('engine') || 'google').toLowerCase();
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing target.' }));
    }

    const engineKey = ['google', 'bing', 'ddg', 'yandex'].includes(engine) ? engine : 'google';
    const q = encodeURIComponent('"' + target + '"');
    // Real Google search hits a consent/redirect interstitial when fetched
    // through the r.jina.ai reader proxy (no cookies/JS), so it never
    // yields usable content. Route it through DuckDuckGo's static HTML
    // endpoint instead, which the proxy CAN render — DDG covers the same
    // OSINT "dork" use case well enough as a drop-in for the Google tab.
    const searchUrl = {
      google: `https://r.jina.ai/https://duckduckgo.com/html/?q=${q}`,
      bing: `https://r.jina.ai/http://www.bing.com/search?q=${q}`,
      ddg: `https://r.jina.ai/https://duckduckgo.com/html/?q=${q}`,
      yandex: `https://r.jina.ai/http://yandex.com/search/?text=${q}`,
    }[engineKey];

    // DuckDuckGo's HTML results wrap every organic link in a redirector:
    //   https://duckduckgo.com/l/?uddg=<url-encoded target>&rut=...
    function extractDdgUrls(text) {
      const out = [];
      const re = /duckduckgo\.com\/l\/\?uddg=((?:[^&\s()]|\([^()]*\))+)/gi;
      let m;
      while ((m = re.exec(text))) {
        try { out.push(decodeURIComponent(m[1])); } catch (_) { /* skip malformed */ }
      }
      return out;
    }
    // Bing wraps results in a click-tracking redirector with a base64url-
    // encoded target in the "u" param, prefixed with "a1":
    //   https://www.bing.com/ck/a?...&u=a1<base64url>&...
    function extractBingUrls(text) {
      const out = [];
      const re = /[?&]u=a1([A-Za-z0-9_-]+)/g;
      let m;
      while ((m = re.exec(text))) {
        try {
          const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
          const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
          out.push(Buffer.from(b64 + pad, 'base64').toString('utf8'));
        } catch (_) { /* skip malformed */ }
      }
      return out;
    }
    // Yandex's reader-mode markdown contains plain, unwrapped result URLs
    // alongside its own nav/chrome links (login, translate, images, etc.)
    // — extract all URLs generically and filter those out below.
    function extractGenericUrls(text) {
      return (text.match(/https?:\/\/[^\s"'<>()]+/gi) || []).map(u => u.replace(/[),.]+$/, ''));
    }

    const NAV_HOST_PATTERNS = [
      'duckduckgo.com', 'bing.com', 'google.com', 'yandex.com', 'yandex.ru',
      'passport.yandex', 'translate.yandex', 'challenges.cloudflare.com',
      'r.jina.ai',
    ];
    function isNavLink(url) {
      try {
        const h = new URL(url).hostname.toLowerCase();
        return NAV_HOST_PATTERNS.some(p => h.includes(p));
      } catch (_) { return true; }
    }

    function extractByEngine(text, key) {
      let urls;
      if (key === 'bing') urls = extractBingUrls(text);
      else if (key === 'ddg' || key === 'google') urls = extractDdgUrls(text);
      else urls = extractGenericUrls(text);
      const seen = new Set();
      const out = [];
      for (const u of urls) {
        if (!u || !/^https?:\/\//i.test(u) || isNavLink(u) || seen.has(u)) continue;
        seen.add(u);
        out.push(u);
      }
      return out;
    }

    // r.jina.ai's reader-mode markdown renders organic results for DDG,
    // Bing, and Yandex the same way: a "## [title](url)" header line
    // followed by a paragraph of snippet text before the next result.
    // Parsing that structure gets us a real SERP (title + URL + snippet)
    // instead of a bare list of links.
    function stripMarkdown(s) {
      return String(s || '')
        // Same balanced-paren issue as headerRe/unwrapUrl above: link/image
        // hrefs inside the snippet body (e.g. a secondary breadcrumb link
        // pointing at the same redirector) can contain literal parens
        // (Wikipedia disambiguation URLs), so a naive "stop at first )"
        // class truncates the href and leaks the remainder as raw text.
        .replace(/!\[[^\]]*\]\(((?:[^()\s]|\([^()]*\))+)\)/g, '')       // images
        .replace(/\[([^\]]*)\]\(((?:[^()\s]|\([^()]*\))+)\)/g, '$1')     // links → link text
        .replace(/\*\*/g, '')                        // bold
        .replace(/\s+/g, ' ')
        .trim();
    }
    function unwrapUrl(rawUrl, key) {
      if (key === 'bing') {
        const bm = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(rawUrl);
        if (bm) {
          try {
            const b64 = bm[1].replace(/-/g, '+').replace(/_/g, '/');
            const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
            return Buffer.from(b64 + pad, 'base64').toString('utf8');
          } catch (_) { /* fall through */ }
        }
        return rawUrl;
      }
      const dm = /duckduckgo\.com\/l\/\?uddg=((?:[^&\s()]|\([^()]*\))+)/.exec(rawUrl);
      if (dm) { try { return decodeURIComponent(dm[1]); } catch (_) { /* fall through */ } }
      return rawUrl;
    }
    function extractSerpEntries(text, key) {
      // Some destination URLs (e.g. Wikipedia disambiguation pages like
      // "Cerberus_(mythology)") contain literal, non-percent-encoded
      // parentheses. A naive "stop at the first )" regex truncates those
      // URLs and leaks the remainder into the snippet, so allow one level
      // of balanced (...) nesting inside the URL capture group.
      const headerRe = /##\s*\[([^\]]+)\]\(((?:[^()\s]|\([^()]*\))+)\)/g;
      const headers = [];
      let m;
      while ((m = headerRe.exec(text))) {
        headers.push({ rawTitle: m[1], rawUrl: m[2], start: m.index, end: m.index + m[0].length });
      }
      const entries = [];
      for (let i = 0; i < headers.length; i++) {
        const cur = headers[i];
        const url = unwrapUrl(cur.rawUrl, key);
        if (!url || !/^https?:\/\//i.test(url) || isNavLink(url)) continue;
        const chunkEnd = headers[i + 1] ? headers[i + 1].start : Math.min(text.length, cur.end + 700);
        const snippet = stripMarkdown(text.slice(cur.end, chunkEnd)).slice(0, 280);
        entries.push({ title: stripMarkdown(cur.rawTitle).slice(0, 160) || url, url, snippet, engine: key });
      }
      // De-dupe by resolved URL, keep first occurrence
      const seen = new Set();
      return entries.filter(e => (seen.has(e.url) ? false : (seen.add(e.url), true)));
    }

    fetchText(searchUrl, 12000, 4, {})
      .then(text => {
        let results = extractSerpEntries(text, engineKey).slice(0, 8);
        // Defensive fallback: if the markdown structure didn't match (site
        // layout changed upstream), fall back to a bare URL list rather
        // than returning nothing.
        if (!results.length) {
          results = extractByEngine(text, engineKey).slice(0, 8).map(url => ({
            title: url, url, snippet: '', engine: engineKey,
          }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, target, engine: engineKey, results }));
      })
      .catch(err => {
        console.error('[dork-search] failed:', err && err.message);
        if (res.writableEnded) return;
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Dork lookup failed.' }));
      });
    return;
  }

  /* ── Link preview endpoint (dork result thumbnails) ──────────────────
   * Fetches a target page directly and pulls its og:image/twitter:image
   * meta tag so dork results can show a thumbnail, same as a normal
   * search engine results page. Lightweight: small byte cap, short
   * timeout, HEAD-of-document only — this is best-effort and many pages
   * simply won't have a usable image, which is fine (the client hides
   * the thumbnail slot when none is found). */
  if (pathname === '/api/link-preview') {
    const rawUrl = (urlObj.searchParams.get('url') || '').trim();
    let parsed;
    try { parsed = new URL(rawUrl); } catch (_) { parsed = null; }
    if (!parsed || !/^https?:$/.test(parsed.protocol) || isPrivateHost(parsed.hostname)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Invalid or unsupported URL.' }));
    }

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(parsed, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 6000,
    }, (r) => {
      // Follow a single redirect hop (common for tracking/share links)
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        try {
          const next = new URL(r.headers.location, parsed);
          const nextMod = next.protocol === 'https:' ? https : http;
          const req2 = nextMod.get(next, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
            timeout: 6000,
          }, (r2) => readAndExtractImage(r2, next, res));
          req2.on('error', () => sendNoImage(res));
          req2.setTimeout(6000, () => req2.destroy());
        } catch (_) { sendNoImage(res); }
        return;
      }
      readAndExtractImage(r, parsed, res);
    });
    req.on('error', () => sendNoImage(res));
    req.setTimeout(6000, () => req.destroy());
    return;
  }

  /* ── Server-side verify endpoint ─────────────────────────────────────
   * Tier-4 fallback for the client-side username scan: sites merged in
   * from the WhatsMyName catalog have no cors/cfProxy/auth flag, so the
   * browser has no way to check them directly (most block cross-origin
   * fetches). Node's http/https client isn't subject to browser CORS, so
   * we do the GET here and hand back a computed verdict. */
  if (pathname === '/api/verify') {
    const rawUrl        = (urlObj.searchParams.get('url') || '').trim();
    const checkMethod   = urlObj.searchParams.get('checkMethod') || 'status_code';
    const positiveMsg   = urlObj.searchParams.get('positiveMsg') || '';
    const errorMsg      = urlObj.searchParams.get('errorMsg') || '';
    const notFoundStatus = Number(urlObj.searchParams.get('notFoundStatus')) || 0;
    const expectedStatus = Number(urlObj.searchParams.get('expectedStatus')) || 0;

    let parsedV;
    try {
      parsedV = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsedV.protocol)) throw new Error('bad protocol');
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Invalid URL' }));
    }
    if (isPrivateHost(parsedV.hostname)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
    }

    // Sites merged from WhatsMyName carry BOTH an expected "found" status
    // code (e_code) and a "missing" status code (m_code) — WMN's own check
    // relies on the RAW response code (often a 3xx redirect for missing
    // profiles) rather than wherever that redirect eventually lands, so we
    // must not auto-follow redirects here or we lose that signal. Sites
    // without an expectedStatus (older/simpler entries) keep the old
    // follow-redirects + status-200-fallback behavior.
    const useWmnAlgorithm = expectedStatus > 0;
    const maxRedirects = useWmnAlgorithm ? 0 : 4;

    fetchStatusV(rawUrl, 10000, maxRedirects)
      .then(({ status, body }) => {
        let verdict = 'unknown';
        const lbody = body.toLowerCase();
        const isBlockedPage = BLOCKED_BODY_PATTERNS.some(p => lbody.includes(p)) || BLOCKED_TITLE_PATTERNS.some(p => lbody.includes(p));

        if (useWmnAlgorithm) {
          // WMN-style dual signal: status code decides found/not_found;
          // e_string (positiveMsg) / m_string (errorMsg), if present, must
          // also agree, otherwise the result is inconclusive. Explicit
          // codes are checked BEFORE the generic 403/401/429→blocked
          // shortcut below, since a handful of sites use one of those
          // codes as their normal "not found" signal (e.g. m_code: 401).
          if (notFoundStatus && status === notFoundStatus) {
            verdict = 'not_found';
          } else if (status === expectedStatus) {
            if (positiveMsg && !body.includes(positiveMsg)) verdict = 'unknown';
            else if (errorMsg && body.includes(errorMsg)) verdict = 'not_found';
            else verdict = 'found';
          } else if (status === 403 || status === 401 || status === 429) {
            verdict = 'blocked';
          } else if (isBlockedPage) {
            verdict = 'blocked';
          } else {
            verdict = 'unknown';
          }
        } else if (status === 403 || status === 401 || status === 429) {
          verdict = 'blocked';
        } else if (isBlockedPage) {
          verdict = 'blocked';
        } else if (status === 404 || status === 410) {
          verdict = 'not_found';
        } else if (notFoundStatus && status === notFoundStatus) {
          verdict = 'not_found';
        } else if (checkMethod === 'message' && positiveMsg && body.includes(positiveMsg)) {
          verdict = 'found';
        } else if (checkMethod === 'message' && errorMsg && body.includes(errorMsg)) {
          verdict = 'not_found';
        } else {
          verdict = status === 200 ? 'found' : 'unknown';
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, verdict, status }));
      })
      .catch(err => {
        if (res.writableEnded) return;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, verdict: 'unknown', error: err && err.message }));
      });
    return;
  }

  /* ── OG image proxy endpoint ───────────────────────────────────────── */
  if (pathname === '/api/og-image') {
    const rawUrl = (urlObj.searchParams.get('url') || '').trim();
    let parsedOG;
    try {
      parsedOG = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsedOG.protocol)) throw new Error('bad protocol');
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Invalid URL' }));
    }
    const hOG = parsedOG.hostname.toLowerCase();
    if (
      hOG === 'localhost' || hOG === '127.0.0.1' || hOG === '::1' ||
      /^10\./.test(hOG) || /^192\.168\./.test(hOG) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hOG) ||
      /^169\.254\./.test(hOG) || hOG.endsWith('.local')
    ) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
    }
    proxyImage(rawUrl, res);
    return;
  }

  /* ── Fetch page HTML + cheerio metadata (for client-side capture) ──── */
  if (pathname === '/api/fetch-page') {
    const rawUrl = (urlObj.searchParams.get('url') || '').trim();
    let parsedFP;
    try {
      parsedFP = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsedFP.protocol)) throw new Error('bad protocol');
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Invalid URL' }));
    }
    const hFP = parsedFP.hostname.toLowerCase();
    if (
      hFP === 'localhost' || hFP === '127.0.0.1' || hFP === '::1' ||
      /^10\./.test(hFP) || /^192\.168\./.test(hFP) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hFP) ||
      /^169\.254\./.test(hFP) || hFP.endsWith('.local')
    ) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
    }
    fetchPageCheerio(rawUrl, res);
    return;
  }

  /* ── Snapshot / metadata endpoint ──────────────────────────────────── */
  if (pathname === '/api/snapshot') {
    const rawUrl = (urlObj.searchParams.get('url') || '').trim();
    let targetUrl;
    try {
      targetUrl = new URL(rawUrl);
      if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new Error('bad protocol');
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Invalid URL' }));
    }
    // SSRF guard — block private/loopback ranges
    const h = targetUrl.hostname.toLowerCase();
    if (
      h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
      /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^169\.254\./.test(h) || h.endsWith('.local')
    ) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
    }
    if (!chromiumStealth) {
      // No browser available — fall back to HTTP-only metadata extraction
      httpSnapshotFallback(rawUrl, res);
      return;
    }
    if (_snapshotBusy) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Another snapshot in progress — please wait a moment' }));
    }
    _snapshotBusy = true;
    let context;
    (async () => {
      try {
        let b;
        try { b = await ensureBrowser(); } catch (_) {
          // Browser binary missing — degrade to HTTP-only
          _snapshotBusy = false;
          return httpSnapshotFallback(rawUrl, res);
        }
        context = await b.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          locale: 'en-US',
          viewport: { width: 1280, height: 900 },
          extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
        });
        const page = await context.newPage();
        try {
          await page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

          // Extract metadata — catch independently so screenshot still works if DOM eval fails
          let metadata = { title: '', url: rawUrl, description: '', capturedAt: new Date().toISOString() };
          try {
            metadata = await page.evaluate(() => {
              function gm(sel) { const e = document.querySelector(sel); return e ? (e.getAttribute('content') || '') : ''; }
              return {
                title:         document.title || '',
                url:           location.href,
                description:   gm('meta[name="description"]') || gm('meta[property="og:description"]') || '',
                ogTitle:       gm('meta[property="og:title"]') || '',
                ogSiteName:    gm('meta[property="og:site_name"]') || '',
                author:        gm('meta[name="author"]') || gm('meta[property="article:author"]') || '',
                keywords:      gm('meta[name="keywords"]') || '',
                publishedTime: gm('meta[property="article:published_time"]') || '',
                twitterCard:   gm('meta[name="twitter:card"]') || '',
                capturedAt:    new Date().toISOString(),
              };
            });
          } catch (_) { /* DOM eval blocked — keep blank metadata */ }

          // Screenshot — catch independently so metadata is still returned if screenshot fails
          let screenshot = '';
          let mimeType = 'image/jpeg';
          try {
            const buf = await page.screenshot({ type: 'jpeg', quality: 78, fullPage: false });
            screenshot = buf.toString('base64');
          } catch (_) { /* screenshot blocked — return metadata without image */ }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, metadata, screenshot, mimeType }));
        } finally {
          await page.close().catch(() => {});
        }
      } catch (err) {
        console.error('[snapshot]', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message.slice(0, 200) }));
        }
      } finally {
        if (context) await context.close().catch(() => {});
        _snapshotBusy = false;
      }
    })();
    return;
  }

  /* ── Serve sites.json for client ────────────────────────────────────── */
  if (pathname === '/sites.json') {
    return serveStatic(res, path.join(__dirname, 'sites.json'));
  }

  /* ── Serve name-sites.json for client ───────────────────────────────── */
  if (pathname === '/name-sites.json') {
    return serveStatic(res, path.join(__dirname, 'name-sites.json'));
  }

  /* ── Real-name SSE endpoint ─────────────────────────────────────────── */
  if (pathname === '/api/name-check') {
    const q = (urlObj.searchParams.get('q') || '').trim();
    const city = (urlObj.searchParams.get('city') || '').trim();
    const state = (urlObj.searchParams.get('state') || '').trim();
    const ageMinRaw = (urlObj.searchParams.get('ageMin') || '').trim();
    const ageMaxRaw = (urlObj.searchParams.get('ageMax') || '').trim();
    const ageMinNum = ageMinRaw === '' ? null : Number(ageMinRaw);
    const ageMaxNum = ageMaxRaw === '' ? null : Number(ageMaxRaw);
    const ageMin = Number.isFinite(ageMinNum) && ageMinNum >= 0 && ageMinNum <= 120 ? String(Math.floor(ageMinNum)) : '';
    const ageMax = Number.isFinite(ageMaxNum) && ageMaxNum >= 0 && ageMaxNum <= 120 ? String(Math.floor(ageMaxNum)) : '';
    const filters = {
      city: city.slice(0, 60),
      state: state.slice(0, 40),
      ageMin,
      ageMax,
    };
    if (!isValidName(q)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid name. Use letters, spaces, hyphens, apostrophes (2-80 chars).' }));
    }

    // Parse first / last names
    const parts     = q.split(/\s+/);
    const firstName = parts[0];
    const lastName  = parts.slice(1).join(' ') || '';

    res.writeHead(200, {
      'Content-Type' : 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection'   : 'keep-alive',
    });

    let cancelled = false;
    req.on('close', () => { cancelled = true; });

    const queue = [...NAME_SITES];
    const total = queue.length;
    let idx = 0, active = 0, done = 0;
    const NAME_CONCURRENCY = 2;

    const send = (obj) => {
      if (!cancelled && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };

    send({ type: 'start', total, name: q, firstName, lastName, filters });

    function normalizeNameResult(site, rawResult) {
      const resultCount = typeof rawResult.resultCount === 'number' ? rawResult.resultCount : null;
      const statusReason = rawResult.status === 'found'
        ? 'name_results_pattern_matched'
        : rawResult.status === 'not_found'
          ? 'name_no_results_message'
          : 'name_search_inconclusive';
      const reasonCodes = Array.isArray(rawResult.reasonCodes) && rawResult.reasonCodes.length
        ? rawResult.reasonCodes
        : [statusReason];
      const challengeDetected = reasonCodes.includes('cloudflare_or_challenge_detected');

      const summary = challengeDetected
        ? 'Source returned a challenge page, so automatic classification was limited.'
        : rawResult.status === 'found'
        ? `Potential people records detected${resultCount !== null ? ` (${resultCount})` : ''}.`
        : rawResult.status === 'not_found'
          ? 'No obvious people records detected.'
          : 'Result was inconclusive and may need manual verification.';
      const detail = challengeDetected
        ? `Source: ${site.name}. Challenge protection detected; open source manually to continue.`
        : `Source: ${site.name}`;

      return normalizeResult({
        ...rawResult,
        mode: 'name',
        summary,
        detail,
        reasonCodes,
        evidence: rawResult.evidence || {
          checkedAt: new Date().toISOString(),
          method: 'name_search',
          statusCode: rawResult.statusCode || 0,
          bodyHash: null,
          reasons: reasonCodes,
        },
      });
    }

    function tick() {
      while (active < NAME_CONCURRENCY && idx < total) {
        const site = queue[idx++];
        active++;
        probeNameSearch(site, firstName, lastName, filters)
          .then(raw => normalizeNameResult(site, raw))
          .catch(() => normalizeNameResult(site, {
            name: site.name,
            category: 'people-finder',
            url: buildNameUrl(site, firstName, lastName, filters),
            status: 'unknown',
            statusCode: 0,
          }))
          .then(result => {
            active--;
            done++;
            if (!cancelled) send({ type: 'result', ...result, done, total });
            tick();
          });
      }

      if (idx >= total && active === 0 && !res.writableEnded) {
        send({ type: 'done', done, total });
        res.end();
      }
    }

    tick();
    return;
  }

  /* ── Static files ───────────────────────────────────────────────────── */
  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = path.join(__dirname, 'index.html');
  } else {
    // Sanitize – prevent path traversal
    const normalized = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[\\/])+/, '');
    filePath = path.join(__dirname, normalized);
    if (!filePath.startsWith(__dirname + path.sep) && filePath !== __dirname) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
  }

  serveStatic(res, filePath);
});

const HOST = process.env.RENDER ? '0.0.0.0' : '127.0.0.1';
let didPortFallback = false;

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && !didPortFallback) {
    didPortFallback = true;
    console.log(`\n  Port ${PORT} is busy, retrying with an open port...`);
    server.listen(0, HOST);
    return;
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const activePort = addr && typeof addr === 'object' ? addr.port : PORT;

  console.log(`\n  ██████╗ ██████╗  ██████╗ ██████╗ ███████╗`);
  console.log(`  ██╔══██╗██╔══██╗██╔═══██╗██╔══██╗██╔════╝`);
  console.log(`  ██████╔╝██████╔╝██║   ██║██████╔╝█████╗  `);
  console.log(`  ██╔═══╝ ██╔══██╗██║   ██║██╔══██╗██╔══╝  `);
  console.log(`  ██║     ██║  ██║╚██████╔╝██████╔╝███████╗`);
  console.log(`  ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝`);
  console.log(`\n  Username Intelligence — ${SITES.length} platforms`);
  console.log(`  http://localhost:${activePort}`);
  if (chromiumStealth && (ENABLE_UNDETECTABLE_STEALTH || ENABLE_USERNAME_BROWSER_FALLBACK)) {
    ensureBrowser().catch(() => {});
    console.log(`  Stealth browser: warming up (${STEALTH_CONCURRENCY} concurrent tabs)\n`);
  } else {
    console.log(`  Stealth browser: disabled for username scans\n`);
  }
});
