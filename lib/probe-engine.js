'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const profileMetadata = require('../profile-metadata');
const usernameRules = require('../username-rules');
const sourceRequestAdapter = require('../source-request-adapter');
const { TIMEOUT_MS, MAX_BODY } = require('./config');
const { delay } = require('./http-fetch');
const {
  AUTH_REDIRECT_PATTERNS, makeClassifiedResult, classify, redirectRetainsProfileIdentity,
  redirectIdentityMarkerMatches,
} = require('./classifier');

/* ── Profile details (found results only) ────────────────────────────── */
function withProfile(result, site, username, body, contentType, fetchedUrl) {
  if (!result || result.status !== 'found' || !body) return result;
  const profile = profileMetadata.extractProfile(site, username, body, contentType, fetchedUrl);
  return profile ? { ...result, profile } : result;
}

const FOLLOW_UP_TIMEOUT_MS = 5000;
const FOLLOW_UP_MAX_HOPS = 3;

/* One GET for profile details a source's scan page cannot supply (its
 * profile page, or a public data feed). Runs only after a found verdict, never
 * changes that verdict, and gives up quietly on any error, block or timeout. */
function fetchFollowUpPage(site, plan, signal) {
  const crawlerUA = null;
  const cookieJars = new Map();
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const controller = new AbortController();
    const abort = () => { controller.abort(); done(null); };
    const timer = setTimeout(abort, FOLLOW_UP_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    const get = (url, hops) => {
      let parsed;
      try { parsed = new URL(url); } catch (_) { return done(null); }
      if (parsed.protocol !== 'https:') return done(null);
      scheduleHostRequest(parsed.hostname, () => {
        if (settled) return;
        const req = https.request(makeReqOptions(parsed, crawlerUA, cookieJars, controller.signal), res => {
          updateCookieJar(cookieJarFor(cookieJars, parsed.hostname), res.headers['set-cookie']);
          const sc = res.statusCode;
          if (sc >= 300 && sc < 400 && res.headers.location && hops < FOLLOW_UP_MAX_HOPS) {
            res.resume();
            let next;
            try { next = new URL(res.headers.location, url).href; } catch (_) { return done(null); }
            return get(next, hops + 1);
          }
          if (sc < 200 || sc >= 300) { res.resume(); return done(null); }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => {
            body += chunk;
            if (body.length >= plan.maxBytes || (plan.headOnly && /<\/head\s*>/i.test(body.slice(-(chunk.length + 8))))) res.destroy();
          });
          res.on('close', () => done({ body, contentType: res.headers['content-type'] || '', url }));
          res.on('error', () => done(null));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', () => done(null));
        req.end();
      });
    };
    get(plan.url, 0);
  });
}

async function withFollowUpProfile(result, site, username, signal) {
  if (!result || result.status !== 'found' || result.resolvedBy === 'browser') return result;
  const plan = profileMetadata.followUpPlan(site, username, result.profile);
  if (!plan) return result;
  const page = await fetchFollowUpPage(site, plan, signal).catch(() => null);
  if (!page) return result;
  const profile = profileMetadata.mergeFollowUp(site, username, result.profile || null, page.body, page.contentType, page.url);
  return profile ? { ...result, profile } : result;
}

/* ── Single-site probe (follows redirects up to MAX_REDIRECT_HOPS) ─────── */
const MAX_REDIRECT_HOPS = 3;
const MAX_TRANSIENT_RETRIES = 1;
const HOST_REQUEST_INTERVAL_MS = 250;
const hostNextRequestAt = new Map();

function scheduleHostRequest(hostname, task) {
  const now = Date.now();
  const runAt = Math.max(now, hostNextRequestAt.get(hostname) || 0);
  hostNextRequestAt.set(hostname, runAt + HOST_REQUEST_INTERVAL_MS);
  if (runAt === now) task();
  else setTimeout(task, runAt - now);
}

// A source asking for a longer pause gets one: no early retry inside this
// scan (the source cooldown then avoids hammering it across scans).
function requestedRetryDelayMs(headers) {
  const retryAfter = headers['retry-after'];
  if (!retryAfter) return 0;
  const seconds = Number(retryAfter);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}

function retryDelayMs(headers, attempt) {
  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Date.parse(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : retryAt - Date.now();
    if (Number.isFinite(delay) && delay >= 0) return Math.min(delay, 5000);
  }
  return 750 * (attempt + 1);
}

function updateCookieJar(cookieJar, setCookieHeaders) {
  for (const header of setCookieHeaders || []) {
    const pair = String(header).split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator > 0) cookieJar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
}

function cookieJarFor(cookieJars, hostname) {
  if (!cookieJars.has(hostname)) cookieJars.set(hostname, new Map());
  return cookieJars.get(hostname);
}

function makeReqOptions(parsed, overrideUA, cookieJars, signal, requestConfig = { method: 'GET', headers: {} }) {
  const reqConfig = requestConfig || { method: 'GET', headers: {} };
  const ua = overrideUA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const cookies = [...cookieJarFor(cookieJars, parsed.hostname)].map(([name, value]) => `${name}=${value}`).join('; ');
  const headers = {
    'User-Agent'               : ua,
    'Accept'                   : 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language'          : 'en-US,en;q=0.9',
    'Referer'                  : `${parsed.protocol}//${parsed.host}/`,
    'Cache-Control'            : 'max-age=0',
    'Connection'               : 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest'           : 'document',
    'Sec-Fetch-Mode'           : 'navigate',
    'Sec-Fetch-Site'           : 'same-origin',
    'Sec-Fetch-User'           : '?1',
    'sec-ch-ua'                : '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="8"',
    'sec-ch-ua-mobile'         : '?0',
    'sec-ch-ua-platform'       : '"Windows"',
    ...(cookies ? { 'Cookie': cookies } : {}),
  };
  for (const [name, value] of Object.entries(reqConfig.headers || {})) {
    for (const existingName of Object.keys(headers)) {
      if (existingName.toLowerCase() === name) delete headers[existingName];
    }
    headers[name] = value;
  }
  // A non-browser User-Agent must not carry browser-only client hints:
  // that combination is incoherent and itself a bot signal.
  const finalUA = Object.entries(headers).find(([name]) => name.toLowerCase() === 'user-agent')?.[1] || '';
  if (!/^Mozilla\//.test(finalUA)) {
    for (const name of Object.keys(headers)) {
      if (/^(sec-ch-ua|sec-fetch-|upgrade-insecure-requests$)/i.test(name)) delete headers[name];
    }
  }
  // Credentials attach only to their reviewed HTTPS host, so a redirect to
  // any other host can never receive them.
  const credential = reqConfig.credential;
  if (credential && credential.header && parsed.protocol === 'https:' && parsed.hostname === credential.host) {
    headers[credential.header] = credential.scheme ? `${credential.scheme} ${credential.value}` : credential.value;
  }
  return {
    hostname: parsed.hostname,
    port    : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path    : parsed.pathname + parsed.search,
    method  : reqConfig.method || 'GET',
    headers,
    timeout: TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  };
}

function doRequest(site, username, origUrl, url, hops, finish, attempt = 0, cookieJars = new Map(), signal, requestState = null) {
  const deliver = finish;
  let completed = false;
  finish = result => {
    if (completed) return;
    completed = true;
    deliver(result);
  };
  if (signal?.aborted) {
    return finish({ name: site.name, category: site.category, url: origUrl, status: 'timeout', statusCode: 0 });
  }
  let parsed;
  try { parsed = new URL(url); }
  catch (_) { return finish({ name: site.name, category: site.category, url: origUrl, status: 'error', statusCode: 0 }); }

  const mod  = parsed.protocol === 'https:' ? https : http;
  const base = { name: site.name, category: site.category, url: origUrl };
  const finishResponse = (result, body, contentType) => {
    // Identity is judged against the URL PROBE actually requested (an API
    // endpoint when configured), not the profile link shown to users.
    const requestedUrl = (site.apiUrl || site.checkUrl || site.url).replace(/\{\}/g, encodeURIComponent(username));
    if (result.status === 'found' && hops > 0 && !redirectRetainsProfileIdentity(requestedUrl, url, username)) {
      if (redirectIdentityMarkerMatches(site, username, body, MAX_BODY)) {
        const reasonCodes = [...(result.reasonCodes || []), 'site_redirect_identity_marker'];
        const proven = { ...result, reasonCodes, ...(result.evidence ? { evidence: { ...result.evidence, reasons: reasonCodes } } : {}) };
        return finish(withProfile(proven, site, username, body, contentType, url));
      }
      return finish(makeClassifiedResult({
        ...base,
        statusCode: result.statusCode,
        detectionMethod: result.detectionMethod,
        bodyHash: result.bodyHash,
      }, 'unknown', ['redirect_profile_identity_lost'], 0.3));
    }
    finish(withProfile(result, site, username, body, contentType, url));
  };
  let requestConfig;
  try {
    requestConfig = requestState || sourceRequestAdapter.buildRequest(site, username);
    if (!requestState && site.resolvedCredential) {
      Object.defineProperty(requestConfig, 'credential', { value: site.resolvedCredential, enumerable: false });
    }
  } catch (error) {
    console.error(`[source-request] Invalid request configuration for "${site.name}": ${error.message}`);
    return finish({ ...base, status: 'error', statusCode: 0, reasonCodes: ['invalid_source_request'] });
  }
  const crawlerUA = null;
  let responseState = null;

  const startRequest = () => {
  if (signal?.aborted) return finish({ ...base, status: 'timeout', statusCode: 0 });
  const req = mod.request(makeReqOptions(parsed, crawlerUA, cookieJars, signal, requestConfig), (res) => {
    const sc      = res.statusCode;
    const headers = res.headers;
    responseState = { statusCode: sc, headers, body: '' };
    updateCookieJar(cookieJarFor(cookieJars, parsed.hostname), headers['set-cookie']);

    if (sc >= 301 && sc <= 308 && site.notFoundStatus !== undefined && sc === site.notFoundStatus) {
      res.resume();
      return finish({ ...base, status: 'not_found', statusCode: sc, reasonCodes: ['site_specific_not_found_status'] });
    }

    if ((sc === 429 || sc === 502 || sc === 503 || sc === 504) && attempt < MAX_TRANSIENT_RETRIES &&
        requestedRetryDelayMs(headers) <= 5000) {
      res.resume();
      return setTimeout(
        () => doRequest(site, username, origUrl, url, hops, finish, attempt + 1, cookieJars, signal, requestConfig),
        retryDelayMs(headers, attempt)
      );
    }

    // ── Handle redirects ───────────────────────────────────────────────
    if (sc >= 301 && sc <= 308) {
      res.resume(); // drain to free socket

      const locRaw = headers['location'];
      const redirect = sourceRequestAdapter.inspectRedirectLocation(locRaw, url);
      if (!redirect.valid) {
        return finish({ ...base, status: 'unknown', statusCode: sc, reasonCodes: [redirect.reason] });
      }
      const absLoc = redirect.url;
      const loc = absLoc.toLowerCase();

      // A challenge destination is explicit blocking evidence, not evidence that the profile exists.
      if (loc.includes('.within.website') || /\/cdn-cgi\/challenge(?:[/?#]|$)/.test(loc) ||
          loc.includes('/_/challenge') || loc.includes('verify-browser') || loc.includes('bot-check')) {
        return finish({ ...base, status: 'blocked', statusCode: sc, reasonCodes: ['redirect_bot_challenge'] });
      }

      if (AUTH_REDIRECT_PATTERNS.some(p => loc.includes(p))) {
        const authStatus = site.authRedirectMeansFound === true ? 'found'
          : site.authRedirectMeansNotFound === true ? 'not_found' : 'unknown';
        const reasonCode = authStatus === 'found' ? 'site_auth_redirect_found'
          : authStatus === 'not_found' ? 'site_auth_redirect_not_found' : 'redirect_auth_login';
        return finish({
          ...base,
          status: authStatus,
          statusCode: sc,
          reasonCodes: [reasonCode],
        });
      }
      // Reviewed exception: on this source only existing accounts redirect
      // (e.g. a publication moving to its custom domain); missing names 404.
      if (site.redirectMeansFound === true && hops === 0) {
        return finish({ ...base, status: 'found', statusCode: sc, reasonCodes: ['site_redirect_found'], confidence: 0.9 });
      }
      // Redirect to domain root (no sub-path) → user doesn't exist, unless
      // the username is encoded in the hostname and only the protocol changed.
      try {
        const absURL = new URL(locRaw, url);
        const profileIsHostBased = parsed.pathname === '/' && !parsed.search;
        if (absURL.pathname === '/' && !absURL.search && !profileIsHostBased) {
          return finish({ ...base, status: 'not_found', statusCode: sc, reasonCodes: ['redirect_to_site_root'] });
        }
        // Redirect to /404 or /not-found path → user doesn't exist
        if (/\/(404|not[-_]?found|account[-_]?deleted|deleted[-_]?account|user[-_]?not[-_]?found|no[-_]?user)(\/|$)/i.test(absURL.pathname)) {
          return finish({ ...base, status: 'not_found', statusCode: sc, reasonCodes: ['redirect_to_not_found_path'] });
        }
      } catch (_) {}

      // Follow redirect if within hop limit
      if (hops < MAX_REDIRECT_HOPS) {
        let nextRequest = requestConfig;
        if (((sc === 301 || sc === 302) && requestConfig.method === 'POST') ||
            (sc === 303 && requestConfig.method !== 'HEAD')) {
          const headers = { ...requestConfig.headers };
          delete headers['content-type'];
          nextRequest = { method: 'GET', headers, body: null };
        }
        return doRequest(site, username, origUrl, absLoc, hops + 1, finish, attempt, cookieJars, signal, nextRequest);
      }
      return finish({ ...base, status: 'unknown', statusCode: sc, reasonCodes: ['redirect_hop_limit'] });
    }

    // ── Non-redirect: read body and classify ──────────────────────────
    // Classification always uses the first MAX_BODY bytes. Sources whose
    // profile details sit further down (per metadata-hints.json) keep
    // streaming only once that prefix already classifies as found.
    const readPlan = profileMetadata.readPlan(site);
    let body = '';
    let classifyBody = null;
    let early = null;
    let stopped = false;
    res.setEncoding('utf8');
    res.on('data', chunk => {
      if (stopped) return;
      body += chunk;
      responseState.body = body;
      if (classifyBody === null && body.length >= MAX_BODY) {
        classifyBody = body;
        if (!readPlan) { stopped = true; return res.destroy(); }
        early = classify(site, username, origUrl, sc, headers, classifyBody, 'http', true);
        if (early.status !== 'found') { stopped = true; return res.destroy(); }
      }
      if (classifyBody !== null && readPlan && (
        body.length >= readPlan.maxBytes ||
        (readPlan.headOnly && /<\/head\s*>/i.test(body.slice(-(chunk.length + 8))))
      )) {
        stopped = true;
        res.destroy();
      }
    });
    res.on('close', () => {
      const bodyIncomplete = stopped || body.length >= MAX_BODY || !res.complete;
      const result = early || classify(site, username, origUrl, sc, headers, classifyBody ?? body, 'http', bodyIncomplete);
      finishResponse(result, body, headers['content-type']);
    });
    res.on('error', () => {
      const partial = classify(site, username, origUrl, sc, headers, body, 'http', true);
      finishResponse(partial, body, headers['content-type']);
    });
  });

  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', (err) => {
    if (err.message === 'timeout' || err.code === 'ABORT_ERR') {
      finish({ ...base, status: 'timeout', statusCode: 0 });
    } else if (responseState && responseState.statusCode) {
      const partial = classify(site, username, origUrl, responseState.statusCode,
        responseState.headers, responseState.body, 'http', true);
      finishResponse(partial, responseState.body, responseState.headers['content-type']);
    } else {
      finish({ ...base, status: 'error', statusCode: 0 });
    }
  });

  req.end(requestConfig.body === null ? undefined : requestConfig.body);
  };

  scheduleHostRequest(parsed.hostname, startRequest);
}

function usernamePreflight(site, username) {
  const reason = usernameRules.incompatibleReason(site, username);
  if (!reason) return null;
  return makeClassifiedResult({
    name: site.name,
    category: site.category,
    url: site.url.replace(/\{\}/g, encodeURIComponent(username)),
    statusCode: 0,
    detectionMethod: 'format_check',
    bodyHash: null,
  }, 'skipped', ['username_format_incompatible'], 1, { formatReason: reason });
}

function planUsernameScan(sites, username) {
  const queue = [];
  const skipped = [];
  for (const site of sites) {
    const result = usernamePreflight(site, username);
    if (result) skipped.push(result);
    else queue.push(site);
  }
  return { total: sites.length, queue, skipped };
}

function probe(site, username, signal) {
  const skipped = usernamePreflight(site, username);
  if (skipped) return Promise.resolve(skipped);
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

  // NOTE: cfProxy/cors sites used to be deferred entirely to client-side
  // tiers (browser-direct fetch / CF Worker edge proxy) since our own
  // server IP got blocked by some CF-protected hosts. That client-side
  // fallback has been removed as redundant now that every site resolves
  // through this same server-side path — cfProxy/cors sites just fall
  // through to the normal request below and surface as 'blocked' if the
  // target actually blocks our server's IP (visible to the user, same as
  // any other blocked site), instead of silently staying 'unknown'.

  if (site.undetectable) {
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

  site = sourceRequestAdapter.withCredential(site, process.env);
  return new Promise((resolve) => {
    // Sites with a calibrated internal API endpoint — hit that directly
    const targetTemplate = site.apiUrl || site.checkUrl || site.url;
    let url;
    try {
      url = targetTemplate.replace(/\{\}/g, encodeURIComponent(username));
      const credential = site.resolvedCredential;
      if (credential && credential.query) {
        const target = new URL(url);
        if (target.protocol === 'https:' && target.hostname === credential.host) {
          target.searchParams.set(credential.query, credential.value);
          url = target.href;
        }
      }
    } catch (_) {
      return resolve({ name: site.name, category: site.category, url: site.url, status: 'error', statusCode: 0 });
    }

    // The URL shown to the user in results is always the profile URL, not the API URL
    const profileUrl = site.url.replace(/\{\}/g, encodeURIComponent(username));
    doRequest(site, username, profileUrl, url, 0, resolve, 0, new Map(), signal);
  });
}

function probeWithDeadline(site, username, deadlineMs = 15000) {
  const controller = new AbortController();
  let deadlineTimer;
  const timeoutResult = new Promise(resolve => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      resolve({
        name: site.name,
        category: site.category,
        url: site.url.replace(/\{\}/g, encodeURIComponent(username)),
        status: 'timeout',
        statusCode: 0,
        reasonCodes: ['probe_timeout'],
        detectionMethod: 'http',
        bodyHash: null,
      });
    }, deadlineMs);
  });
  const detection = Promise.race([
    probe(site, username, controller.signal),
    timeoutResult,
  ]).finally(() => clearTimeout(deadlineTimer));
  // The follow-up has its own short budget so it can never turn a finished
  // verdict into a timeout; cancel() still aborts it.
  const promise = detection.then(result => withFollowUpProfile(result, site, username, controller.signal));

  return {
    controller,
    promise,
    cancel() {
      clearTimeout(deadlineTimer);
      controller.abort();
    },
  };
}

module.exports = { withProfile, makeReqOptions, probe, requestedRetryDelayMs, usernamePreflight,
  planUsernameScan, probeWithDeadline };
