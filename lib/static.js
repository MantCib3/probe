'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT_DIR, IS_PRODUCTION } = require('./config');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml' : 'application/xml; charset=utf-8',
  '.txt' : 'text/plain; charset=utf-8',
  '.ico' : 'image/x-icon',
  '.svg' : 'image/svg+xml',
  '.png' : 'image/png',
};

/* ── Security headers ─────────────────────────────────────────────────
 * Applied to every response. CSP allows same-origin scripts/styles plus
 * the Cloudflare Turnstile script/frame (widget + its own beacon calls).
 * `style-src 'unsafe-inline'` is required because index.html uses a
 * handful of inline style="" attributes; script-src does NOT need
 * 'unsafe-inline' since there are no inline <script> blocks or on*=
 * handlers in the markup. */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CSP);
  if (IS_PRODUCTION) {
    // Render terminates TLS in front of this process, so it's safe to
    // tell browsers to always use HTTPS for this origin going forward.
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
}

/* ── Static file helper ───────────────────────────────────────────────── */
// Small in-memory cache for versioned static assets (css/js) to
// avoid a synchronous disk read on every single request. Data files that
// may be regenerated at runtime (sites.json, name-sites.json) are
// intentionally excluded so edits are picked up without a restart.
const _staticCache = new Map(); // filePath → Buffer
const CACHEABLE_EXT = new Set(['.css', '.js']);
const PUBLIC_SCRIPT_FILES = new Set(['script.min.js', 'roadmap.min.js']
  .map(filename => path.join(ROOT_DIR, filename).toLowerCase()));

function isPrivateScript(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const relative = path.relative(ROOT_DIR, path.resolve(filePath)).toLowerCase().split(path.sep);
  let resolved = relative;
  try {
    resolved = path.relative(fs.realpathSync(ROOT_DIR), fs.realpathSync(filePath)).toLowerCase().split(path.sep);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return true;
  }
  const billingPrivate = relative[0] === 'billing-private' ||
    (relative[0] === 'migrations' && relative[1] === 'billing') ||
    resolved[0] === '..' || resolved[0] === 'billing-private' ||
    (resolved[0] === 'migrations' && resolved[1] === 'billing');
  return billingPrivate || (ext === '.js' && !PUBLIC_SCRIPT_FILES.has(path.resolve(filePath).toLowerCase())) || ext === '.map';
}

const CLEAN_PAGE_ROUTES = new Map([
  ['/roadmap', 'roadmap.html'],
  ['/privacy', 'privacy.html'],
  ['/blog/audit-your-username-footprint', 'blog/audit-your-username-footprint.html'],
  ['/blog/choosing-a-private-username', 'blog/choosing-a-private-username.html'],
  ['/blog/what-were-building-next', 'blog/what-were-building-next.html'],
  ['/blog/how-to-search-a-username', 'blog/how-to-search-a-username.html'],
  ['/blog/the-internet-isnt-forever', 'blog/the-internet-isnt-forever.html'],
  ['/blog/the-soft-404-epidemic', 'blog/the-soft-404-epidemic.html'],
  ['/blog/decay-of-the-open-web', 'blog/decay-of-the-open-web.html'],
  ['/blog/when-a-profile-field-stays-empty', 'blog/when-a-profile-field-stays-empty.html'],
  ['/blog/reading-an-accuracy-snapshot', 'blog/reading-an-accuracy-snapshot.html'],
  ['/blog/profile-details-pilot', 'blog/profile-details-pilot.html'],
  ['/blog/checking-the-checks', 'blog/checking-the-checks.html'],
  ['/blog/what-your-username-doesnt-hide', 'blog/what-your-username-doesnt-hide.html'],
  ['/blog/improving-accuracy-without-guessing', 'blog/improving-accuracy-without-guessing.html'],
  ['/blog/measuring-username-search-accuracy', 'blog/measuring-username-search-accuracy.html'],
  ['/blog/why-probe-abstains', 'blog/why-probe-abstains.html'],
  ['/blog/maintaining-a-source-catalog', 'blog/maintaining-a-source-catalog.html'],
]);

const LEGACY_PAGE_REDIRECTS = new Map([
  ['/index.html', '/'],
  ...Array.from(CLEAN_PAGE_ROUTES, ([cleanPath, filePath]) => [`/${filePath}`, cleanPath]),
]);

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (isPrivateScript(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('Not found');
  }
  const ct  = MIME[ext] || 'application/octet-stream';
  try {
    let data = CACHEABLE_EXT.has(ext) ? _staticCache.get(filePath) : undefined;
    if (!data) {
      data = fs.readFileSync(filePath);
      if (CACHEABLE_EXT.has(ext)) _staticCache.set(filePath, data);
    }
    const cacheControl = ext === '.html'
      ? 'no-cache, no-store, must-revalidate'
      : CACHEABLE_EXT.has(ext)
        ? 'public, max-age=86400'
        : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': cacheControl });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

function handleHead(res, pathname) {
  let decodedHeadPath;
  try { decodedHeadPath = decodeURIComponent(pathname); }
  catch (_) { res.writeHead(400); return res.end(); }
  const headPath = pathname === '/'
    ? 'index.html'
    : CLEAN_PAGE_ROUTES.get(pathname) || decodedHeadPath.replace(/^\//, '');
  const safeHeadPath = path.normalize(headPath).replace(/^(\.\.[\\/])+/, '');
  const fullHeadPath = path.join(ROOT_DIR, safeHeadPath);
  if (isPrivateScript(fullHeadPath)) {
    res.writeHead(404, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (!fullHeadPath.startsWith(ROOT_DIR + path.sep) || !fs.existsSync(fullHeadPath)) {
    res.writeHead(404);
    return res.end();
  }
  const ext = path.extname(fullHeadPath).toLowerCase();
  const cacheControl = ext === '.html'
    ? 'no-cache, no-store, must-revalidate'
    : CACHEABLE_EXT.has(ext)
      ? 'public, max-age=86400'
      : 'public, max-age=3600';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl,
  });
  return res.end();
}

/* ── Static files ───────────────────────────────────────────────────── */
function serveRequestPath(res, pathname) {
  let filePath;
  if (pathname === '/') {
    filePath = path.join(ROOT_DIR, 'index.html');
  } else if (CLEAN_PAGE_ROUTES.has(pathname)) {
    filePath = path.join(ROOT_DIR, CLEAN_PAGE_ROUTES.get(pathname));
  } else {
    // Sanitize – prevent path traversal
    let decodedPath;
    try { decodedPath = decodeURIComponent(pathname); }
    catch (_) { res.writeHead(400); return res.end('Bad Request'); }
    const normalized = path.normalize(decodedPath).replace(/^(\.\.[\\/])+/, '');
    filePath = path.join(ROOT_DIR, normalized);
    if (!filePath.startsWith(ROOT_DIR + path.sep) && filePath !== ROOT_DIR) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    try {
      if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    } catch (_) { /* serveStatic returns the 404 */ }
  }

  serveStatic(res, filePath);
}

module.exports = { setSecurityHeaders, LEGACY_PAGE_REDIRECTS, serveStatic, handleHead,
  serveRequestPath };
