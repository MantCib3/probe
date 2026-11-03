'use strict';

const https = require('https');
const { IS_PRODUCTION } = require('./config');

/* ── Rate limiting & Turnstile ───────────────────────────────────────── */
const RATE_LIMIT_MAX    = 10;                  // free scans per window per IP
const RATE_LIMIT_WINDOW = 60 * 60 * 1000;     // 1 hour in ms
const AUX_RATE_LIMIT_MAX = 200;
const AUX_RATE_LIMIT_WINDOW = 60 * 60 * 1000;
const AUX_RATE_LIMITED_PATHS = new Set([
  '/api/quick-check', '/api/email-check', '/api/phone-check',
  '/api/domain-check', '/api/dork-search', '/api/link-preview',
  '/api/name-check',
]);
// .trim() matters: a stray trailing newline/space from copy-pasting into
// Render's Environment tab produces a secret that LOOKS right but makes
// every siteverify call fail with 'invalid-input-secret' silently.
const TURNSTILE_SECRET  = (process.env.TURNSTILE_SECRET || '').trim(); // set in Render env vars
// The `action` each surface's widget render() call uses (script.js) —
// cross-checked against siteverify's response below so a token minted for
// one form can't be replayed against another (e.g. a scan token reused to
// spam the contact form).
const TURNSTILE_ACTIONS = { scan: 'scan', contact: 'contact', report: 'report' };
// Optional comma-separated allowlist of hostnames siteverify is allowed to
// report back (e.g. "usernameprobe.com,www.usernameprobe.com"). Skipped
// when unset so this doesn't become a third way for scans to fail while
// the domain is still being set up — set it once the domain is live.
const TURNSTILE_HOSTNAMES = (process.env.TURNSTILE_HOSTNAMES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (IS_PRODUCTION && !TURNSTILE_SECRET) {
  console.error('\n  [SECURITY] TURNSTILE_SECRET is not set in a production environment.');
  console.error('  All scan requests will be rejected (fail-closed) until it is configured.\n');
}

// Bound in-memory rate-limit maps so a spoofed-IP flood can't grow them
// without limit. When a map exceeds MAX_TRACKED_IPS, the oldest entry
// (Map preserves insertion order) is evicted first.
const MAX_TRACKED_IPS = 20000;
function boundedSet(map, key, value) {
  if (map.size >= MAX_TRACKED_IPS && !map.has(key)) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
  map.set(key, value);
}

const _scanRates = new Map(); // ip → { count: number, resetAt: timestamp }
const _auxRates = new Map(); // ip → { count: number, resetAt: timestamp }

// Reserve synchronously so parallel requests from one IP cannot all pass the
// check while Turnstile verification is still pending.
function reserveScanSlot(ip) {
  const now = Date.now();
  let entry = _scanRates.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    boundedSet(_scanRates, ip, entry);
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

function refundScanSlot(ip) {
  const entry = _scanRates.get(ip);
  if (entry && entry.count > 0) entry.count--;
}

/* ── Global scan capacity ──────────────────────────────────────────────
 * Each scan fans out to every automatic source. Without a global ceiling,
 * concurrent users multiply outbound load and the shared per-host spacing
 * pushes requests past the probe deadline. Excess scans wait in a bounded
 * FIFO queue and see their position. */
const MAX_ACTIVE_SCANS = Math.max(1, Number(process.env.MAX_ACTIVE_SCANS) || 4);
const MAX_QUEUED_SCANS = 20;
let activeScanCount = 0;
const scanWaiters = [];

function acquireScanCapacity(onQueued) {
  if (activeScanCount < MAX_ACTIVE_SCANS) {
    activeScanCount++;
    return { ready: Promise.resolve(true), cancel() {} };
  }
  if (scanWaiters.length >= MAX_QUEUED_SCANS) return null;
  let waiter;
  const ready = new Promise(resolve => { waiter = { resolve }; });
  scanWaiters.push(waiter);
  onQueued(scanWaiters.length);
  return {
    ready,
    cancel() {
      const index = scanWaiters.indexOf(waiter);
      if (index !== -1) { scanWaiters.splice(index, 1); waiter.resolve(false); }
    },
  };
}

function releaseScanCapacity() {
  const next = scanWaiters.shift();
  if (next) next.resolve(true);
  else activeScanCount = Math.max(0, activeScanCount - 1);
}

/* ── Source cooldown for public scans ───────────────────────────────────
 * A source that keeps blocking this server is not re-requested on every
 * scan: that wastes requests and degrades the shared IP's reputation. After
 * consecutive blocks it is skipped for a cooldown and reported as blocked
 * with an explicit reason; the first scan after the cooldown re-probes it.
 * Lab and staging probes bypass this so measurements stay real. */
const SOURCE_COOLDOWN_THRESHOLD = 3;
const SOURCE_COOLDOWN_MS = 10 * 60 * 1000;
const sourceHealth = new Map();

function sourceCooldownResult(site, username) {
  const health = sourceHealth.get(site.name);
  if (!health || health.until <= Date.now()) return null;
  return {
    name: site.name,
    category: site.category,
    url: site.url.replace(/\{\}/g, encodeURIComponent(username)),
    status: 'blocked',
    statusCode: 0,
    confidence: 0.9,
    reasonCodes: ['source_cooldown'],
    detectionMethod: 'http',
    bodyHash: null,
  };
}

function recordSourceHealth(site, result) {
  if (!result) return;
  if (result.status === 'found' || result.status === 'not_found') {
    sourceHealth.delete(site.name);
  } else if (result.status === 'blocked') {
    const health = sourceHealth.get(site.name) || { blocks: 0, until: 0 };
    health.blocks++;
    if (health.blocks >= SOURCE_COOLDOWN_THRESHOLD) health.until = Date.now() + SOURCE_COOLDOWN_MS;
    sourceHealth.set(site.name, health);
  }
}

function consumeAuxRateLimit(ip) {
  const now = Date.now();
  let entry = _auxRates.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + AUX_RATE_LIMIT_WINDOW };
    boundedSet(_auxRates, ip, entry);
  }
  entry.count++;
  return entry.count <= AUX_RATE_LIMIT_MAX;
}

const _submitRates = new Map(); // ip → { count, resetAt }
const SUBMIT_LIMIT_MAX    = 5;
const SUBMIT_LIMIT_WINDOW = 60 * 60 * 1000;

function checkSubmitRateLimit(ip) {
  const now = Date.now();
  let entry = _submitRates.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + SUBMIT_LIMIT_WINDOW };
    boundedSet(_submitRates, ip, entry);
  }
  return entry.count < SUBMIT_LIMIT_MAX;
}
function consumeSubmitRateLimit(ip) {
  const entry = _submitRates.get(ip);
  if (entry) entry.count++;
}

// Periodic sweep — drops fully-expired entries so a long-lived process
// doesn't accumulate stale IPs between the size-based evictions above.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _scanRates)   if (now > entry.resetAt) _scanRates.delete(ip);
  for (const [ip, entry] of _auxRates)    if (now > entry.resetAt) _auxRates.delete(ip);
  for (const [ip, entry] of _submitRates) if (now > entry.resetAt) _submitRates.delete(ip);
}, 10 * 60 * 1000).unref();

/**
 * Calls Cloudflare's siteverify endpoint to validate a Turnstile response
 * token. `expectedAction` must match one of TURNSTILE_ACTIONS's values —
 * every caller (scan, contact, report) MUST pass its own action so a token
 * minted for one form can't be replayed against another.
 */
function verifyTurnstile(token, ip, expectedAction) {
  if (!TURNSTILE_SECRET) {
    // No secret configured: only bypass verification in non-production
    // (local dev). In production, fail CLOSED so requests are blocked rather
    // than silently unprotected until the secret is set.
    console.error(`[turnstile] TURNSTILE_SECRET is empty at request time (IS_PRODUCTION=${IS_PRODUCTION}) — ${IS_PRODUCTION ? 'failing closed' : 'bypassing in dev'}.`);
    return Promise.resolve(!IS_PRODUCTION);
  }
  if (!token) {
    console.error(`[turnstile] no token provided for action="${expectedAction}" (client never sent cf-token, or it was empty).`);
    return Promise.resolve(false);
  }
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
        try {
          const result = JSON.parse(data);
          if (result.success !== true) {
            // Cloudflare's own error-codes explain exactly why (e.g.
            // 'invalid-input-secret', 'timeout-or-duplicate') — log them
            // since a bare `false` here is otherwise a black box.
            console.error(`[turnstile] siteverify failed for action="${expectedAction}": ${JSON.stringify(result['error-codes'] || result.errorCodes || result)}`);
            return resolve(false);
          }
          // Reject tokens minted for a different action so one form's token
          // can't be replayed against another.
          if (result.action && result.action !== expectedAction) {
            console.error(`[turnstile] action mismatch: expected "${expectedAction}", got "${result.action}"`);
            return resolve(false);
          }
          // Only enforced once TURNSTILE_HOSTNAMES is configured, so this
          // doesn't add a fourth way for requests to fail during domain setup.
          if (TURNSTILE_HOSTNAMES.length && !TURNSTILE_HOSTNAMES.includes(result.hostname)) {
            console.error(`[turnstile] hostname "${result.hostname}" not in TURNSTILE_HOSTNAMES allowlist`);
            return resolve(false);
          }
          resolve(true);
        } catch (_) {
          console.error(`[turnstile] siteverify response was not valid JSON: ${data.slice(0, 200)}`);
          resolve(false);
        }
      });
    });
    req.setTimeout(8000, () => { console.error('[turnstile] siteverify request timed out'); req.destroy(); resolve(false); });
    req.on('error', (err) => { console.error(`[turnstile] siteverify request error: ${err.message}`); resolve(false); });
    req.write(body);
    req.end();
  });
}

module.exports = { RATE_LIMIT_MAX, AUX_RATE_LIMITED_PATHS, TURNSTILE_ACTIONS, reserveScanSlot,
  refundScanSlot, MAX_ACTIVE_SCANS, MAX_QUEUED_SCANS, acquireScanCapacity, releaseScanCapacity,
  SOURCE_COOLDOWN_THRESHOLD, sourceCooldownResult, recordSourceHealth, consumeAuxRateLimit,
  checkSubmitRateLimit, consumeSubmitRateLimit, verifyTurnstile };
