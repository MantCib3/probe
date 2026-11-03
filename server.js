'use strict';

// Entry point (`node server.js`): builds the HTTP server and dispatches
// routes. Implementation lives in lib/ — config, net-guard, http-fetch,
// classifier, probe-engine, scan-scheduler, static and routes/*.
// LAB_RUNTIME_FINGERPRINT.classifierSha256 covers this file plus lib/**/*.js.

const http = require('http');
const path = require('path');
const { URL } = require('url');
const { SITES, PORT, LAB_RUNTIME_FINGERPRINT, IS_PRODUCTION } = require('./lib/config');
const { isPrivateHost } = require('./lib/net-guard');
const {
  hasIntegrityAbstention, makeClassifiedResult, normalizeResult, classify, classifyVerifyResponse,
  redirectRetainsProfileIdentity,
} = require('./lib/classifier');
const {
  withProfile, makeReqOptions, probe, requestedRetryDelayMs, usernamePreflight, planUsernameScan,
  probeWithDeadline,
} = require('./lib/probe-engine');
const {
  RATE_LIMIT_MAX, AUX_RATE_LIMITED_PATHS, reserveScanSlot, refundScanSlot, MAX_ACTIVE_SCANS,
  MAX_QUEUED_SCANS, acquireScanCapacity, releaseScanCapacity, SOURCE_COOLDOWN_THRESHOLD,
  sourceCooldownResult, recordSourceHealth, consumeAuxRateLimit,
} = require('./lib/scan-scheduler');
const { getClientIp } = require('./lib/request');
const {
  setSecurityHeaders, LEGACY_PAGE_REDIRECTS, serveStatic, handleHead, serveRequestPath,
} = require('./lib/static');
const { handlePostEndpoint } = require('./lib/routes/contact');
const { handleLabProbe, handleScan, handleQuickCheck } = require('./lib/routes/scan');
const { handleEmailCheck, handlePhoneCheck, handleDomainCheck } = require('./lib/routes/intel');
const {
  handleLinkPreview, handleVerify, handleOgImage, handleFetchPage, handleSnapshot,
} = require('./lib/routes/page-tools');
const { handleDorkSearch } = require('./lib/routes/dork-search');
const { handleNameCheck } = require('./lib/routes/name-check');
const { handleStaging } = require('./lib/routes/staging');

const server = http.createServer((req, res) => {
  setSecurityHeaders(res);
  let urlObj;
  try { urlObj = new URL(req.url, `http://localhost:${PORT}`); }
  catch (_) { res.writeHead(400); return res.end('Bad Request'); }

  const pathname = urlObj.pathname;

  res.on('finish', () => {
    if (res.statusCode < 400) return;
    const ray = String(req.headers['cf-ray'] || '').split('-', 1)[0].slice(0, 32);
    console.warn(`[http] ${req.method} ${pathname} ${res.statusCode}${ray ? ` cf-ray=${ray}` : ''}`);
  });

  if (pathname === '/api/staging-probe' || pathname === '/api/staging-health') {
    handleStaging(pathname, req, res).catch(error => {
      console.error(`[staging-probe] handler failed (${error.code || error.name || 'Error'})`);
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: 'Staging handler failed.' }));
      }
    });
    return;
  }

  const canonicalPath = LEGACY_PAGE_REDIRECTS.get(pathname);
  if (canonicalPath) {
    res.writeHead(301, { Location: `${canonicalPath}${urlObj.search}` });
    return res.end();
  }

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
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD, POST' });
    return res.end('Method Not Allowed');
  }

  if (req.method === 'HEAD') return handleHead(res, pathname);

  if (AUX_RATE_LIMITED_PATHS.has(pathname) && !consumeAuxRateLimit(getClientIp(req))) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '3600' });
    return res.end(JSON.stringify({ ok: false, error: 'Request limit reached. Try again later.' }));
  }

  if (IS_PRODUCTION && ['/api/verify', '/api/og-image', '/api/fetch-page', '/api/snapshot'].includes(pathname)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Not found.' }));
  }

  if (pathname === '/api/lab-probe') return handleLabProbe(req, res, urlObj);

  if (pathname === '/api/check') return handleScan(req, res, urlObj);

  if (pathname === '/api/quick-check') return handleQuickCheck(res, urlObj);

  if (pathname === '/api/email-check') return handleEmailCheck(req, res, urlObj);

  if (pathname === '/api/phone-check') return handlePhoneCheck(req, res, urlObj);

  if (pathname === '/api/domain-check') return handleDomainCheck(req, res, urlObj);

  if (pathname === '/api/dork-search') return handleDorkSearch(res, urlObj);

  if (pathname === '/api/link-preview') return handleLinkPreview(res, urlObj);

  if (pathname === '/api/verify') return handleVerify(res, urlObj);

  if (pathname === '/api/og-image') return handleOgImage(res, urlObj);

  if (pathname === '/api/fetch-page') return handleFetchPage(res, urlObj);

  if (pathname === '/api/snapshot') return handleSnapshot(res, urlObj);

  /* ── Serve sites.json for client ────────────────────────────────────── */
  if (pathname === '/sites.json') {
    return serveStatic(res, path.join(__dirname, 'sites.json'));
  }

  // Public deploy identity for pipeline verification; contains no secrets.
  if (pathname === '/version.json') {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({
      commit: process.env.RENDER_GIT_COMMIT || null,
      catalogSha256: LAB_RUNTIME_FINGERPRINT.catalogSha256,
      classifierSha256: LAB_RUNTIME_FINGERPRINT.classifierSha256,
      sourceRequestAdapterSha256: LAB_RUNTIME_FINGERPRINT.sourceRequestAdapterSha256,
      node: process.version,
      sources: { active: SITES.length, manual: SITES.filter(site => site.undetectable).length },
    }));
  }

  /* ── Serve name-sites.json for client ───────────────────────────────── */
  if (pathname === '/name-sites.json') {
    return serveStatic(res, path.join(__dirname, 'name-sites.json'));
  }

  if (pathname === '/api/name-check') return handleNameCheck(req, res, urlObj);

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }

  serveRequestPath(res, pathname);
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

if (require.main === module) {
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
    console.log(`  Stealth browser: disabled for username scans\n`);
  });
}

module.exports = { isPrivateHost, classify, classifyVerifyResponse, makeClassifiedResult, normalizeResult, probe, probeWithDeadline, withProfile, usernamePreflight, planUsernameScan, hasIntegrityAbstention, LAB_RUNTIME_FINGERPRINT,
  reserveScanSlot, refundScanSlot, acquireScanCapacity, releaseScanCapacity, sourceCooldownResult, recordSourceHealth,
  requestedRetryDelayMs, makeReqOptions, redirectRetainsProfileIdentity, RATE_LIMIT_MAX, MAX_ACTIVE_SCANS, MAX_QUEUED_SCANS, SOURCE_COOLDOWN_THRESHOLD };
