'use strict';

const {
  SITES, CONCURRENCY, PROBE_DEADLINE_MS, LAB_RUNTIME_FINGERPRINT, IS_PRODUCTION,
} = require('../config');
const { normalizeResult } = require('../classifier');
const { isValidUsername } = require('../validation');
const { probe, planUsernameScan, probeWithDeadline } = require('../probe-engine');
const {
  RATE_LIMIT_MAX, TURNSTILE_ACTIONS, reserveScanSlot, refundScanSlot, acquireScanCapacity,
  releaseScanCapacity, sourceCooldownResult, recordSourceHealth, verifyTurnstile,
} = require('../scan-scheduler');
const { getClientIp } = require('../request');

const QUICK_SITE_NAMES = [
  'github', 'instagram', 'tiktok', 'x', 'twitter', 'reddit', 'youtube', 'twitch'
];

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
  if (status === 'skipped') return 'skipped';
  if (status === 'found' || status === 'deleted') return 'taken';
  if (status === 'not_found') return 'available';
  return 'unknown';
}

/* ── Local accuracy-lab probe ───────────────────────────────────────
 * Executes one source through the exact production probe function.
 * It is deliberately unavailable on Render/production and the server
 * binds to loopback in development, so this cannot become a public
 * arbitrary-probe or SSRF surface. */
function handleLabProbe(req, res, urlObj) {
  const remote = req.socket.remoteAddress || '';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (IS_PRODUCTION || !isLoopback) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const siteName = (urlObj.searchParams.get('site') || '').trim();
  const username = (urlObj.searchParams.get('username') || '').trim();
  const site = SITES.find(candidate => candidate.name === siteName);
  if (!site || !isValidUsername(username)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid site or username.' }));
  }
  const activeProbe = probeWithDeadline(site, username, PROBE_DEADLINE_MS);
  res.on('close', () => {
    if (!res.writableEnded) activeProbe.cancel();
  });
  activeProbe.promise
    .then(result => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, runtimeFingerprint: LAB_RUNTIME_FINGERPRINT, result: normalizeResult(result) }));
    })
    .catch(error => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    });
  return;
}

/* ── SSE endpoint ───────────────────────────────────────────────────── */
function handleScan(req, res, urlObj) {
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
  const activeProbes = new Set();
  req.on('close', () => {
    cancelled = true;
    for (const activeProbe of activeProbes) activeProbe.cancel();
    activeProbes.clear();
  });

  const send = (obj) => {
    if (!cancelled && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  };

  if (!reserveScanSlot(ip)) {
    send({ type: 'error', error: `Scan limit reached — ${RATE_LIMIT_MAX} free scans per hour. Try again later.`, code: 429 });
    return res.end();
  }

  let capacity = null;
  let holdsCapacity = false;
  const releaseCapacity = () => {
    if (holdsCapacity) { holdsCapacity = false; releaseScanCapacity(); }
  };
  req.on('close', () => {
    if (capacity) capacity.cancel();
    releaseCapacity();
  });

  verifyTurnstile(cfToken, ip, TURNSTILE_ACTIONS.scan).then(async tsOk => {
    if (cancelled) { refundScanSlot(ip); return; }
    if (!tsOk) {
      refundScanSlot(ip);
      send({ type: 'error', error: 'Security check failed. Please refresh and try again.', code: 403 });
      return res.end();
    }

    capacity = acquireScanCapacity(position => send({ type: 'queued', position }));
    if (!capacity) {
      refundScanSlot(ip);
      send({ type: 'error', error: 'PROBE is busy right now. Please try again in a minute.', code: 503 });
      return res.end();
    }
    const granted = await capacity.ready;
    if (!granted || cancelled) {
      if (granted) releaseScanCapacity();
      return;
    }
    holdsCapacity = true;

    const { total, queue, skipped } = planUsernameScan(SITES, username);
    let idx = 0, active = 0, done = 0;

    send({ type: 'start', total, username, skipped: skipped.length, scheduled: queue.length });
    for (const result of skipped) {
      done++;
      send({ type: 'result', ...result, done, total });
    }

    function tick() {
      while (!cancelled && active < CONCURRENCY && idx < queue.length) {
        const site = queue[idx++];
        const cooled = sourceCooldownResult(site, username);
        if (cooled) {
          done++;
          send({ type: 'result', ...normalizeResult(cooled), done, total });
          continue;
        }
        active++;
        const activeProbe = probeWithDeadline(site, username, PROBE_DEADLINE_MS);
        activeProbes.add(activeProbe);
        activeProbe.promise.then(result => {
          recordSourceHealth(site, result);
          activeProbes.delete(activeProbe);
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
          const checkUrl = (site.apiUrl || site.checkUrl || site.url).replace(/\{\}/g, encodeURIComponent(username));
          extra.checkUrl = checkUrl;
          if (!cancelled) send({ type: 'result', ...normalized, done, total, ...extra });
          tick();
        }).catch(() => {
          activeProbes.delete(activeProbe);
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
      if (idx >= queue.length && active === 0 && !res.writableEnded) {
        releaseCapacity();
        send({ type: 'done', done, total });
        res.end();
      }
    }

    tick();
  }).catch(() => {
    releaseCapacity();
    if (!cancelled) {
      send({ type: 'error', error: 'Server error. Please try again.' });
      res.end();
    }
  });

  return;
}

/* ── Quick check endpoint (instant, top platforms) ─────────────────── */
function handleQuickCheck(res, urlObj) {
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
        formatReason: r.formatReason || null,
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

module.exports = { handleLabProbe, handleScan, handleQuickCheck };
