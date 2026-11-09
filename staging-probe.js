'use strict';

const crypto = require('node:crypto');
const { HONEST_USER_AGENT } = require('./source-request-adapter');
const census = require('./tools/census-observe');

// Census requests may only reach domains already in the active catalog.
function catalogDomains(sites) {
  const domains = new Set();
  for (const site of sites) {
    if (site.defunct) continue;
    for (const key of ['url', 'urlMain', 'apiUrl', 'checkUrl']) {
      try { domains.add(census.registrableDomain(new URL(String(site[key]).replace(/\{\}/g, 'x')).hostname)); } catch (_) {}
    }
  }
  return domains;
}

function parseCensus(input, domains, isValidUsername) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { url, method = 'GET', body = null, contentType = null, username, variant = 'honest' } = input;
  if (typeof username !== 'string' || !isValidUsername(username)) return null;
  if (!['GET', 'HEAD', 'POST'].includes(method) || !['honest', 'browserlike'].includes(variant)) return null;
  if (body !== null && (method !== 'POST' || typeof body !== 'string' || body.length > 1500)) return null;
  if (contentType !== null && !['application/json', 'application/x-www-form-urlencoded'].includes(contentType)) return null;
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !domains.has(census.registrableDomain(parsed.hostname))) return null;
  return { url: parsed.href, method, body, contentType, username, variant };
}

// Header variants for A/B measurement; detection rules are never altered.
function applyVariant(site, variant) {
  if (variant === undefined || variant === 'catalog') return site;
  const adapter = site.requestAdapter || { method: 'GET' };
  const headers = { ...(adapter.headers || {}) };
  for (const name of Object.keys(headers)) if (name.toLowerCase() === 'user-agent') delete headers[name];
  const clone = { ...site };
  delete clone.crawlerUA;
  if (variant === 'honest') headers['User-Agent'] = HONEST_USER_AGENT;
  else if (variant !== 'browserlike') return null;
  clone.requestAdapter = { ...adapter, headers };
  return clone;
}

function createStagingHandler(options) {
  const { enabled, secret, sites, isValidUsername, readBody, probeWithDeadline, deadlineMs, runtimeFingerprint } = options;
  const hourlyLimit = Number.isInteger(options.hourlyLimit) && options.hourlyLimit > 0 ? Math.min(options.hourlyLimit, 600) : 120;
  if (enabled && (typeof secret !== 'string' || Buffer.byteLength(secret) < 32)) {
    throw new Error('PROBE_STAGING requires a STAGING_PROBE_KEY of at least 32 bytes.');
  }
  const digest = value => crypto.createHash('sha256').update(value).digest();
  const expected = digest(secret || '');
  const domains = catalogDomains(sites || []);
  const observe = options.observe || census.observe;
  let active = 0;
  let used = 0;
  let windowStarted = Date.now();
  let billingHealthActive = false;
  let billingHealthNext = 0;
  let billingAccountingActive = false;
  let billingAccountingNext = 0;

  return async function handleStaging(pathname, req, res) {
    const send = (status, payload, headers = {}) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(payload));
    };
    if (!enabled) return send(404, { ok: false, error: 'Not found.' });
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ') ||
        !crypto.timingSafeEqual(expected, digest(authorization.slice(7)))) {
      return send(401, { ok: false, error: 'Authentication required.' });
    }
    if (pathname === '/api/staging-health') {
      if (req.method !== 'GET') return send(405, { ok: false, error: 'GET required.' }, { Allow: 'GET' });
      return send(200, { ok: true, runtimeFingerprint, deployment: options.deployment, credentialsConfigured: options.credentialsConfigured || {} });
    }
    if (pathname === '/api/staging-billing-health') {
      if (req.method !== 'GET') return send(405, { ok: false, error: 'GET required.' }, { Allow: 'GET' });
      if (!options.billingHealth) return send(404, { ok: false, error: 'Not found.' });
      if (billingHealthActive || Date.now() < billingHealthNext) {
        return send(429, { ok: false, error: 'Database check rate limited.' }, { 'Retry-After': '30' });
      }
      billingHealthActive = true;
      billingHealthNext = Date.now() + 30000;
      try {
        return send(200, { ok: true, database: await options.billingHealth() });
      } catch (_) {
        console.error('[staging-billing-health] read-only database verification failed; details withheld.');
        return send(503, { ok: false, error: 'Database readiness check failed. Check staging database and CA settings.' });
      } finally {
        billingHealthActive = false;
      }
    }
    if (pathname === '/api/staging-billing-accounting') {
      if (req.method !== 'POST') return send(405, { ok: false, error: 'POST required.' }, { Allow: 'POST' });
      if (!options.billingAccounting) return send(404, { ok: false, error: 'Not found.' });
      if (billingAccountingActive || Date.now() < billingAccountingNext) {
        return send(429, { ok: false, error: 'Accounting check rate limited.' }, { 'Retry-After': '300' });
      }
      billingAccountingActive = true;
      try {
        let input;
        try {
          req.setTimeout(5000, () => req.destroy());
          input = JSON.parse(await readBody(req, 256));
        } catch (error) {
          const tooLarge = error.code === 'BODY_TOO_LARGE';
          return send(tooLarge ? 413 : 400, { ok: false, error: 'Invalid bounded accounting confirmation.' });
        } finally {
          req.setTimeout(0);
        }
        if (!input || input.confirmation !== 'uuid-owned-accounting-fixtures-v1' ||
            Object.keys(input).length !== 1) {
          return send(400, { ok: false, error: 'Explicit accounting fixture confirmation required.' });
        }
        billingAccountingNext = Date.now() + 300000;
        return send(200, { ok: true, accounting: await options.billingAccounting() });
      } catch (_) {
        console.error('[staging-billing-accounting] accounting verification or fixture cleanup failed; details withheld.');
        return send(503, { ok: false, error: 'Accounting verification failed. Check disabled gates, empty guest ledger, database and CA settings.' });
      } finally {
        billingAccountingActive = false;
      }
    }
    if (req.method !== 'POST') return send(405, { ok: false, error: 'POST required.' }, { Allow: 'POST' });
    if (Date.now() - windowStarted >= 3600000) {
      used = 0;
      windowStarted = Date.now();
    }
    if (active >= 2 || used >= hourlyLimit) {
      const retryAfter = used >= hourlyLimit ? Math.ceil((3600000 - (Date.now() - windowStarted)) / 1000) : 16;
      return send(429, { ok: false, error: 'Staging probe limit reached.' }, { 'Retry-After': String(retryAfter) });
    }
    active++;
    used++;
    let probe;
    const cancel = () => { if (!res.writableEnded && probe) probe.cancel(); };
    res.once('close', cancel);
    try {
      let body;
      try {
        req.setTimeout(5000, () => req.destroy());
        body = JSON.parse(await readBody(req, 2048));
      } catch (error) {
        const tooLarge = error.code === 'BODY_TOO_LARGE';
        return send(tooLarge ? 413 : 400, { ok: false, error: tooLarge ? 'Request body is too large.' : 'Invalid JSON body.' });
      } finally {
        req.setTimeout(0);
      }
      if (body && Object.hasOwn(body, 'census')) {
        const request = parseCensus(body.census, domains, isValidUsername);
        if (!request) return send(400, { ok: false, error: 'Invalid census request.' });
        const observation = await observe({ ...request, timeoutMs: Math.min(deadlineMs, 15000) });
        return send(200, { ok: true, runtimeFingerprint, census: { url: request.url, variant: request.variant, observation } });
      }
      const catalogSite = body && sites.find(candidate => candidate.name === body.site && !candidate.undetectable);
      const site = catalogSite && applyVariant(catalogSite, body.variant);
      if (!site || typeof body.username !== 'string' || !isValidUsername(body.username)) {
        return send(400, { ok: false, error: 'Invalid automatic source, variant or username.' });
      }
      if (res.destroyed) return;
      probe = probeWithDeadline(site, body.username, deadlineMs);
      const result = await probe.promise;
      send(200, { ok: true, runtimeFingerprint, variant: body.variant || 'catalog', result: options.normalizeResult(result) });
    } catch (error) {
      console.error(`[staging-probe] execution failed (${error.code || error.name || 'Error'})`);
      send(500, { ok: false, error: 'Staging probe execution failed.' });
    } finally {
      if (res.destroyed && probe) probe.cancel();
      res.removeListener('close', cancel);
      active--;
    }
  };
}

module.exports = { applyVariant, createStagingHandler };
