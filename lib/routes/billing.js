'use strict';

const crypto = require('node:crypto');
const { loadConfig } = require('../billing/config');
const { createPool } = require('../billing/db');
const { Store, problem } = require('../billing/store');
const { createStripe, startSetup, startRecovery, processWebhook, UUID } = require('../billing/stripe');
const { targetFor } = require('../billing/zyte');
const { SITES } = require('../config');
const { getClientIp } = require('../request');
const { consumeAuxRateLimit, verifyTurnstile, TURNSTILE_ACTIONS } = require('../scan-scheduler');
const { acceptanceAllowed, assertAcceptanceEvent } = require('../billing/acceptance');

const COOKIE = '__Host-probe_paid';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function csrfFor(token) { return hash(`probe-paid-csrf-v1:${token}`); }
function recoveryHash(code) { return hash(`probe-paid-recovery-v1:${code}`); }
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`);
}
function cookieToken(req) {
  const matches = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
function checkOrigin(req, config, required = true) {
  const origin = req.headers.origin;
  if ((required && origin !== config.origin) || (origin && origin !== config.origin) ||
      (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
    throw problem('same_origin_required', 403);
  }
}
function checkCsrf(req, guest) {
  const supplied = req.headers['x-probe-csrf'];
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) ||
      !crypto.timingSafeEqual(Buffer.from(hash(supplied)), Buffer.from(guest.csrf_hash))) {
    throw problem('csrf_required', 403);
  }
}
function readRaw(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => done(problem('body_timeout', 408)), 10000);
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) return done(problem('body_too_large', 413));
      parts.push(Buffer.from(chunk));
    });
    req.on('end', () => done(null, Buffer.concat(parts)));
    req.on('aborted', () => done(problem('body_aborted', 400)));
    req.on('error', () => done(problem('body_read_failed', 400)));
  });
}
function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}
function publicConfig(config) {
  const { enabled, reason, consentVersion, consentText, termsHash, rates, creditMicros, thresholdMicros, minimumCents } = config;
  return { enabled, sandbox: true, reason, consentVersion, consentText, termsHash, rates,
    creditMicros, thresholdMicros, minimumCents, currency: 'usd', billability: 'authoritative-reconciliation' };
}
function createBillingHandler(options = {}) {
  const env = options.env || process.env;
  const sites = options.sites || SITES;
  const config = options.config || loadConfig(env, sites);
  const verifyToken = options.verifyToken || verifyTurnstile;
  let store = options.store;
  let stripe = options.stripe;
  let acceptancePool;
  // Neither pool nor SDK makes any startup network requests. Lazy creation also preserves secretless/free startup.
  function dependencies() {
    if (!store) store = new Store(createPool(env));
    if (!stripe) stripe = createStripe(env);
    return { store, stripe };
  }
  return async (pathname, req, res) => {
    try {
      if (!config.staging) return send(res, 404, { error: 'not_found' });
      if (pathname === '/api/paid/config' && req.method === 'GET') return send(res, 200, publicConfig(config));
      const acceptanceWebhook = pathname === '/api/paid/webhook' && !config.enabled && acceptanceAllowed(env);
      if (!config.enabled && !acceptanceWebhook) return send(res, 503, { error: 'paid_disabled', reason: config.reason });
      if (pathname === '/api/paid/webhook') {
        if (req.method !== 'POST') return send(res, 405, { error: 'post_required' });
        if (typeof req.headers['stripe-signature'] !== 'string') throw problem('signature_required', 400);
        const raw = await readRaw(req, 256 * 1024);
        const { store: activeStore, stripe: activeStripe } = dependencies();
        let event;
        try { event = activeStripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET); }
        catch (_) { throw problem('invalid_signature', 400); }
        if (acceptanceWebhook) {
          if (!acceptancePool) acceptancePool = options.acceptancePool || createPool(env);
          await assertAcceptanceEvent(acceptancePool, event);
        }
        await processWebhook(activeStore, activeStripe, event);
        return send(res, 200, { received: true });
      }
      const known = new Set(['/api/paid/session','/api/paid/status','/api/paid/setup','/api/paid/revoke',
        '/api/paid/cap','/api/paid/jobs','/api/paid/replacement','/api/paid/recovery','/api/paid/resume',
        '/api/paid/recovery-code','/api/paid/restore-session']);
      if (!known.has(pathname)) return send(res, 404, { error: 'not_found' });
      const get = pathname === '/api/paid/status';
      if (req.method !== (get ? 'GET' : 'POST')) return send(res, 405, { error: get ? 'get_required' : 'post_required' });
      checkOrigin(req, config, !get);
      if (!consumeAuxRateLimit(getClientIp(req))) throw problem('rate_limit', 429);
      const { store: activeStore, stripe: activeStripe } = dependencies();
      const token = cookieToken(req);
      let guest = token ? await activeStore.authenticate(hash(token)) : null;
      if (guest && guest.currency !== 'usd') throw problem('legacy_currency_frozen', 409);
      if (pathname === '/api/paid/restore-session') {
        if (guest) throw problem('existing_session_present', 409);
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw problem('json_required', 415);
        let body;
        try { body = JSON.parse((await readRaw(req)).toString('utf8')); }
        catch (error) { if (error.publicCode) throw error; throw problem('invalid_json', 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.restore !== true ||
            typeof body.recoveryCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.recoveryCode) ||
            Object.keys(body).length !== 3) throw problem('invalid_recovery_request', 400);
        if (typeof body.cfToken !== 'string' || body.cfToken.length > 2048 ||
            !await verifyToken(body.cfToken, getClientIp(req), TURNSTILE_ACTIONS.paid)) {
          throw problem('security_check_failed', 403);
        }
        const fresh = crypto.randomBytes(32).toString('base64url');
        await activeStore.restoreSession(recoveryHash(body.recoveryCode), hash(fresh), hash(csrfFor(fresh)));
        setSessionCookie(res, fresh);
        return send(res, 200, { csrf: csrfFor(fresh), restored: true, authorized: false });
      }
      if (pathname === '/api/paid/session') {
        if (guest) return send(res, 200, { csrf: csrfFor(token) });
        // Never silently replace a supplied but expired/forged money-bearing session.
        if (req.headers.cookie?.includes(`${COOKIE}=`)) throw problem('session_invalid', 401);
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw problem('json_required', 415);
        let body;
        try { body = JSON.parse((await readRaw(req)).toString('utf8')); }
        catch (error) { if (error.publicCode) throw error; throw problem('invalid_json', 400); }
        if (!body || typeof body.cfToken !== 'string' || body.cfToken.length > 2048 ||
            !await verifyToken(body.cfToken, getClientIp(req), TURNSTILE_ACTIONS.paid)) throw problem('security_check_failed', 403);
        const fresh = crypto.randomBytes(32).toString('base64url');
        const recoveryCode = crypto.randomBytes(32).toString('base64url');
        await activeStore.createGuest(hash(fresh), hash(csrfFor(fresh)), recoveryHash(recoveryCode));
        setSessionCookie(res, fresh);
        return send(res, 201, { csrf: csrfFor(fresh), recoveryCode });
      }
      if (!guest) throw problem('session_required', 401);
      if (get) {
        const status = await activeStore.status(guest.id);
        return send(res, 200, { ...status, csrf: csrfFor(token), config: publicConfig(config) });
      }
      checkCsrf(req, guest);
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw problem('json_required', 415);
      let body;
      try { body = JSON.parse((await readRaw(req)).toString('utf8')); }
      catch (error) { if (error.publicCode) throw error; throw problem('invalid_json', 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem('invalid_json', 400);
      if (pathname === '/api/paid/recovery-code') {
        if (body.replaceRecoveryCode !== true || Object.keys(body).length !== 1) {
          throw problem('explicit_recovery_code_replacement_required', 400);
        }
        const recoveryCode = crypto.randomBytes(32).toString('base64url');
        await activeStore.setRecoveryCode(guest.id, hash(token), recoveryHash(recoveryCode));
        return send(res, 200, { recoveryCode });
      }
      if (['/api/paid/setup','/api/paid/replacement','/api/paid/recovery','/api/paid/resume'].includes(pathname)) {
        if (body.consent !== true || body.consentVersion !== config.consentVersion ||
            body.termsHash !== config.termsHash) throw problem('explicit_current_consent_required', 403);
        if (pathname === '/api/paid/resume') {
          await activeStore.resume(guest.id, config);
          return send(res, 200, { state: 'active' });
        }
        if (pathname === '/api/paid/recovery' && body.settleDebt !== true) throw problem('explicit_debt_settlement_required', 403);
        const url = pathname === '/api/paid/recovery'
          ? await startRecovery(activeStore, activeStripe, guest.id, config)
          : await startSetup(activeStore, activeStripe, guest.id, config, pathname === '/api/paid/replacement');
        return send(res, 200, { url, authorized: false });
      }
      if (pathname === '/api/paid/revoke') {
        await activeStore.revoke(guest.id);
        return send(res, 200, { state: 'revoked', newSpending: false });
      }
      if (pathname === '/api/paid/cap') {
        await activeStore.cap(guest.id, body.capMicros);
        return send(res, 200, { capMicros: body.capMicros });
      }
      if (pathname === '/api/paid/jobs') {
        const rate = config.rates.find(r => r.source === body.source);
        const site = sites.find(s => s.name === body.source && !s.defunct && !s.undetectable);
        if (!rate || !site || !UUID.test(body.requestKey || '')) throw problem('invalid_paid_job', 400);
        const target = targetFor(site, body.username, rate);
        const id = await activeStore.enqueue(guest.id, body.requestKey, site, body.username, target, rate, config);
        return send(res, 202, { id, reservationMicros: rate.maximumMicros, billable: 'awaiting_authoritative_usage' });
      }
    } catch (error) {
      if (!error.publicCode) console.error('[billing] handler failed; provider/database details withheld.');
      if (!res.writableEnded && !res.destroyed) send(res, error.status || 503, { error: error.publicCode || 'billing_unavailable' });
    }
  };
}
module.exports = { createBillingHandler, cookieToken, csrfFor, recoveryHash, hash, checkOrigin, checkCsrf, readRaw, COOKIE };
