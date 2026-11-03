'use strict';

const { URL } = require('url');
const { fetchText } = require('../http-fetch');

/* ── Dork proxy endpoint ──────────────────────────────────────────── */
function handleDorkSearch(res, urlObj) {
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

  function parseSearchResults(text, parserKey) {
    let results = extractSerpEntries(text, parserKey).slice(0, 8);
    if (!results.length) {
      results = extractByEngine(text, parserKey).slice(0, 8).map(url => ({
        title: url, url, snippet: '', engine: engineKey,
      }));
    }
    return results.map(result => ({ ...result, engine: engineKey }));
  }

  (async () => {
    const attempts = [{ url: searchUrl, parserKey: engineKey }];
    if (engineKey === 'bing' || engineKey === 'yandex') {
      attempts.push({
        url: `https://r.jina.ai/https://duckduckgo.com/html/?q=${q}`,
        parserKey: 'ddg',
      });
    }

    let lastError = null;
    for (const attempt of attempts) {
      try {
        const text = await fetchText(attempt.url, 6500, 4, {});
        const results = parseSearchResults(text, attempt.parserKey);
        if (results.length) return results;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return [];
  })()
    .then(results => {
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

module.exports = { handleDorkSearch };
