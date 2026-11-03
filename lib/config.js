'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const usernameRules = require('../username-rules');
const sourceRequestAdapter = require('../source-request-adapter');
const { runtimeCodeSha256 } = require('./runtime-fingerprint');

const ROOT_DIR = path.join(__dirname, '..');

// Disguised (stealth) browser automation is never loaded: PROBE identifies
// itself honestly. Code paths that check this value stay inert.
const chromiumStealth = null;

// Test seam: a fixture catalog for integration tests; ignored in production.
const SITES_PATH = process.env.PROBE_SITES_PATH && process.env.NODE_ENV !== 'production' && !process.env.RENDER
  ? path.resolve(process.env.PROBE_SITES_PATH)
  : path.join(ROOT_DIR, 'sites.json');
const SITES_SOURCE = fs.readFileSync(SITES_PATH, 'utf8');
const SITES      = JSON.parse(SITES_SOURCE).filter(s => !s.defunct);
usernameRules.validateCatalog(SITES);
sourceRequestAdapter.validateCatalog(SITES);
const NAME_SITES = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'name-sites.json'), 'utf8'));
const PORT       = process.env.PORT || process.argv[2] || 3737;
const CONCURRENCY = 20;
const TIMEOUT_MS  = 10000;
const MAX_BODY    = 32768;
const SITE_PROBE_TIMEOUT_MS = 45000;
const PROBE_DEADLINE_MS = 15000;

const ENABLE_USERNAME_BROWSER_FALLBACK = false;
const LAB_RUNTIME_FINGERPRINT = Object.freeze({
  // sha256 over the bytes of server.js and every lib/**/*.js file, concatenated
  // in sorted POSIX relative-path order (lib/runtime-fingerprint.js). The
  // accuracy lab computes the same value for its runtime parity check.
  classifierSha256: runtimeCodeSha256(ROOT_DIR),
  sourceRequestAdapterSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT_DIR, 'source-request-adapter.js'))).digest('hex'),
  catalogSha256: crypto.createHash('sha256').update(SITES_SOURCE).digest('hex'),
  usernameRulesSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT_DIR, 'username-rules.js'))).digest('hex'),
  nodeVersion: process.version,
  probeDeadlineMs: PROBE_DEADLINE_MS,
  browserFallbackAvailable: Boolean(chromiumStealth),
  browserFallbackEnabled: ENABLE_USERNAME_BROWSER_FALLBACK,
});

/* ── Environment / trust configuration ────────────────────────────────
 * IS_PRODUCTION — true when running on Render. Used to decide whether a
 *                 missing Turnstile secret should fail OPEN (dev) or fail
 *                 CLOSED (prod — safer default for a public deployment).
 * TRUST_PROXY   — set to '1' once you've confirmed exactly one trusted
 *                 reverse proxy sits in front of this process (Render's
 *                 own edge always does this). When true, the right-most
 *                 entry in X-Forwarded-For is trusted as the client IP —
 *                 that's the hop the trusted proxy itself appended;
 *                 anything to its left can be forged by the client.
 * CF_FRONTED    — set to '1' if Cloudflare is proxying in front of this
 *                 origin (orange-clouded DNS). Cloudflare overwrites
 *                 CF-Connecting-IP at its edge, so that header is safe to
 *                 trust for the real client IP in that case, and takes
 *                 priority over X-Forwarded-For when present. */
const IS_PRODUCTION = !!process.env.RENDER || process.env.NODE_ENV === 'production';
const TRUST_PROXY   = process.env.TRUST_PROXY === '1';
const CF_FRONTED     = process.env.CF_FRONTED === '1';

module.exports = { chromiumStealth, ROOT_DIR, SITES, NAME_SITES, PORT, CONCURRENCY, TIMEOUT_MS,
  MAX_BODY, PROBE_DEADLINE_MS, LAB_RUNTIME_FINGERPRINT, IS_PRODUCTION, TRUST_PROXY, CF_FRONTED };
