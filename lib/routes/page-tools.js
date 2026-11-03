'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const sourceRequestAdapter = require('../../source-request-adapter');
const { chromiumStealth } = require('../config');
const { publicLookup, isPrivateHost } = require('../net-guard');
const { fetchStatusV } = require('../http-fetch');
const { classifyVerifyResponse } = require('../classifier');

let _browser     = null;
let _browserTask = null;
let _snapshotBusy = false;

/* ── Snapshot browser (only launched when a browser is available) ───── */
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

/* ── HTTP-only snapshot fallback (no browser — parses raw HTML) ─────── */
function httpSnapshotFallback(rawUrl, res) {
  const https = require('https');
  const http2 = require('http');
  const mod = rawUrl.startsWith('https') ? https : http2;
  const req = mod.get(rawUrl, {
    headers: {
      'User-Agent': sourceRequestAdapter.HONEST_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    lookup: publicLookup,
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
          'User-Agent': sourceRequestAdapter.HONEST_USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        lookup: publicLookup,
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
    headers: { 'User-Agent': sourceRequestAdapter.HONEST_USER_AGENT },
    timeout: 8000,
    lookup: publicLookup,
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

/* ── Link preview endpoint (dork result thumbnails) ──────────────────
 * Fetches a target page directly and pulls its og:image/twitter:image
 * meta tag so dork results can show a thumbnail, same as a normal
 * search engine results page. Lightweight: small byte cap, short
 * timeout, HEAD-of-document only — this is best-effort and many pages
 * simply won't have a usable image, which is fine (the client hides
 * the thumbnail slot when none is found). */
function handleLinkPreview(res, urlObj) {
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
      'User-Agent': sourceRequestAdapter.HONEST_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
    },
    timeout: 6000,
    lookup: publicLookup,
  }, (r) => {
    // Follow a single redirect hop (common for tracking/share links)
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      r.resume();
      try {
        const next = new URL(r.headers.location, parsed);
        if (!/^https?:$/.test(next.protocol) || isPrivateHost(next.hostname)) return sendNoImage(res);
        const nextMod = next.protocol === 'https:' ? https : http;
        const req2 = nextMod.get(next, {
          headers: { 'User-Agent': sourceRequestAdapter.HONEST_USER_AGENT },
          timeout: 6000,
          lookup: publicLookup,
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
function handleVerify(res, urlObj) {
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
    .then(response => {
      const result = classifyVerifyResponse({
        url: rawUrl,
        checkMethod,
        positiveMsg,
        errorMsg,
        notFoundStatus,
        expectedStatus: useWmnAlgorithm ? expectedStatus : 0,
        ...response,
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        verdict: result.status,
        reasonCodes: result.reasonCodes,
        status: response.status,
      }));
    })
    .catch(err => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, verdict: 'unknown', error: 'Verification unavailable.' }));
    });
  return;
}

/* ── OG image proxy endpoint ───────────────────────────────────────── */
function handleOgImage(res, urlObj) {
  const rawUrl = (urlObj.searchParams.get('url') || '').trim();
  let parsedOG;
  try {
    parsedOG = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsedOG.protocol)) throw new Error('bad protocol');
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Invalid URL' }));
  }
  if (isPrivateHost(parsedOG.hostname)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
  }
  proxyImage(rawUrl, res);
  return;
}

/* ── Fetch page HTML + cheerio metadata (for client-side capture) ──── */
function handleFetchPage(res, urlObj) {
  const rawUrl = (urlObj.searchParams.get('url') || '').trim();
  let parsedFP;
  try {
    parsedFP = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsedFP.protocol)) throw new Error('bad protocol');
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Invalid URL' }));
  }
  if (isPrivateHost(parsedFP.hostname)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
  }
  fetchPageCheerio(rawUrl, res);
  return;
}

/* ── Snapshot / metadata endpoint ──────────────────────────────────── */
function handleSnapshot(res, urlObj) {
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
  if (isPrivateHost(targetUrl.hostname)) {
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
        userAgent: sourceRequestAdapter.HONEST_USER_AGENT,
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
        res.end(JSON.stringify({ ok: false, error: 'Snapshot unavailable.' }));
      }
    } finally {
      if (context) await context.close().catch(() => {});
      _snapshotBusy = false;
    }
  })();
  return;
}

module.exports = { handleLinkPreview, handleVerify, handleOgImage, handleFetchPage, handleSnapshot };
