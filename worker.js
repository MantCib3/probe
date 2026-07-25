/**
 * probe-proxy — Cloudflare Worker
 *
 * Proxies HTTP GET requests for a fixed allowlist of hostnames so the
 * browser-side scan can reach CF-protected sites using CF's own network.
 *
 * Deploy:
 *   npx wrangler deploy          (after `npx wrangler login`)
 *   OR paste this file into the Cloudflare dashboard → Workers & Pages.
 *
 * After deploy, copy the worker URL (e.g. https://probe-proxy.xxx.workers.dev)
 * into script.js → CF_WORKER_URL constant.
 *
 * Free tier: 100,000 requests / day — plenty for personal OSINT scans.
 */

// ── Allowed hostnames (exact match OR *.suffix match) ─────────────────
// Only these domains can be proxied — prevents open-proxy abuse / SSRF.
const EXACT = new Set([
  'atcoder.jp',
  'buymeacoffee.com',
  'codepen.io',
  'dribbble.com',
  'genius.com',
  'giphy.com',
  'hashnode.com',
  'imgur.com',
  'jsfiddle.net',
  'kick.com',
  'knowyourmeme.com',
  'ko-fi.com',
  'lemmy.world',
  'letterboxd.com',
  'open.spotify.com',
  'pcpartpicker.com',
  'poshmark.com',
  'rumble.com',
  'slashdot.org',
  'society6.com',
  'solo.to',
  'sourceforge.net',
  'trakt.tv',
  'unsplash.com',
  'untappd.com',
  'vsco.co',
  'weheartit.com',
  'wellfound.com',
  'www.anime-planet.com',
  'www.artstation.com',
  'www.bigo.tv',
  'www.depop.com',
  'www.destructoid.com',
  'www.ebay.com',
  'www.etsy.com',
  'www.fandom.com',
  'www.fiverr.com',
  'www.gamespot.com',
  'www.kaggle.com',
  'www.librarything.com',
  'www.patreon.com',
  'www.producthunt.com',
  'www.quora.com',
  'www.redbubble.com',
  'www.scribd.com',
  'www.slideshare.net',
  'www.steamgifts.com',
  'www.threadless.com',
  'www.udemy.com',
  'www.upwork.com',
  'www.wattpad.com',
  'armorgames.com',
  'www.armorgames.com',
  'replit.com',
  'udemy.com',
  'newgrounds.com',
  'kaggle.com',
  // Signup/availability APIs (CORS-enabled, residential bypass)
  'api.imgur.com',
  'api.x.com',
  'app.buymeacoffee.com',
  'auth.roblox.com',
  'www.wattpad.com',
  // Auth-gated social — server IP blocked, CF edge gets through
  'www.instagram.com',
  'www.facebook.com',
  'www.snapchat.com',
  'www.threads.com',
  'www.threads.net',
  'www.pinterest.com',
  // Additional platforms
  'www.genius.com',
  'genius.com',
  'www.tiktok.com',
  'open.spotify.com',
  'www.spotify.com',
  'letterboxd.com',
  'trakt.tv',
  'www.etsy.com',
  'www.ebay.com',
  'x.com',
  // Twitter oEmbed (CORS, no auth needed)
  'publish.twitter.com',
  // LinkedIn (Googlebot UA injected by worker)
  'www.linkedin.com',
]);

// Hostname suffixes — allows subdomains (e.g. cerberus.newgrounds.com)
const SUFFIXES = ['.newgrounds.com', '.fandom.com', '.roblox.com'];

function allowed(hostname) {
  if (EXACT.has(hostname)) return true;
  for (const s of SUFFIXES) if (hostname.endsWith(s)) return true;
  return false;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResp(body, status, extra = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  });
}

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return corsResp('Method not allowed', 405);
    }

    const { searchParams } = new URL(request.url);
    const target = searchParams.get('url');
    if (!target) return corsResp('Missing ?url= parameter', 400);

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return corsResp('Invalid URL', 400);
    }

    // SSRF + allowlist guard
    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      return corsResp('Protocol not allowed', 403);
    }
    if (!allowed(targetUrl.hostname)) {
      return corsResp('Host not in allowlist', 403);
    }

    try {
      // Site-specific request headers (e.g. Instagram needs X-IG-App-ID)
      const extraHeaders = {};
      const h = targetUrl.hostname;
      if (h === 'www.instagram.com' || h === 'instagram.com') {
        extraHeaders['X-IG-App-ID'] = '936619743392459';
        extraHeaders['X-Requested-With'] = 'XMLHttpRequest';
      }
      if (h === 'api.x.com' || h === 'x.com') {
        extraHeaders['Authorization'] = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
      }
      if (h === 'www.linkedin.com' || h === 'linkedin.com') {
        // Googlebot UA causes LinkedIn to serve public profiles instead of redirecting to login
        extraHeaders['User-Agent'] = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
      }

      const upstream = await fetch(targetUrl.toString(), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          ...extraHeaders,
        },
        redirect: 'follow',
        // 10 s timeout via AbortSignal
        signal: AbortSignal.timeout(10000),
      });

      // Cap body at 150 KB — enough for any errorMsg/positiveMsg check
      const reader = upstream.body.getReader();
      const chunks = [];
      let total = 0;
      const LIMIT = 150 * 1024;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
        if (total >= LIMIT) break;
      }
      reader.cancel().catch(() => {});

      const body = new TextDecoder().decode(
        chunks.reduce((a, b) => {
          const c = new Uint8Array(a.byteLength + b.byteLength);
          c.set(a); c.set(b, a.byteLength);
          return c;
        }, new Uint8Array(0))
      );

      return corsResp(body, upstream.status, { 'X-Proxy-Status': String(upstream.status) });
    } catch (err) {
      return corsResp('Proxy error: ' + err.message, 502);
    }
  },
};
