'use strict';

const http  = require('http');
const https = require('https');
const dns = require('dns').promises;
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// Stealth browser — lazy-loaded; absent gracefully if not installed
let chromiumStealth = null;
try {
  chromiumStealth = require('playwright-extra').chromium;
  chromiumStealth.use(require('puppeteer-extra-plugin-stealth')());
} catch (_) { /* run: npm install playwright-extra puppeteer-extra-plugin-stealth */ }

const SITES      = JSON.parse(fs.readFileSync(path.join(__dirname, 'sites.json'), 'utf8')).filter(s => !s.defunct);
const NAME_SITES = JSON.parse(fs.readFileSync(path.join(__dirname, 'name-sites.json'), 'utf8'));
const PORT       = process.env.PORT || process.argv[2] || 3737;
const CONCURRENCY = 20;
const TIMEOUT_MS  = 10000;
const MAX_BODY    = 32768;
const SITE_PROBE_TIMEOUT_MS = 45000;

const STEALTH_CONCURRENCY = 4;
const STEALTH_TIMEOUT_MS  = 16000;
const ENABLE_USERNAME_BROWSER_FALLBACK = false;
const ENABLE_UNDETECTABLE_STEALTH = true;

const QUICK_SITE_NAMES = [
  'github', 'instagram', 'tiktok', 'x', 'twitter', 'reddit', 'youtube', 'twitch'
];

let _browser     = null;
let _browserTask = null;
let _bSlots      = 0;
const _bQueue    = [];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Auth/login redirect patterns — if a 3xx points here, account doesn't exist
const AUTH_REDIRECT_PATTERNS = [
  '/login', '/signin', '/sign-in', '/signup', '/sign-up', '/register',
  '/auth', 'accounts/login', 'account/login', 'users/sign_in',
  'login?', 'signin?', '?redirect=', '?returnurl=', '?next=',
  '?returnto=', '?redirecturi=', 'session/new',
];

// HTML title substrings that indicate a 200 page is actually a "not found" error
const NOT_FOUND_TITLE_PATTERNS = [
  'page not found', 'user not found', 'profile not found',
  'account not found', '404', 'nothing here', 'does not exist',
  "doesn't exist", 'no such user', 'not available',
];

// Title/body patterns that mean a bot-protection wall is blocking us
const BLOCKED_TITLE_PATTERNS = [
  'client challenge', 'just a moment', 'attention required',
  'ddos-guard', 'enable javascript and cookies', 'checking your browser',
  'one more step', 'please wait', 'security check',
];

// Body patterns that indicate JS-challenge / bot-protection pages (no title available)
const BLOCKED_BODY_PATTERNS = [
  'please enable js and disable any ad blocker',
  'please enable javascript and cookies to continue',
  'this process is automatic',
  'checking if the site connection is secure',
  'ray id',  // Cloudflare footer
];

// Body-text substrings that reliably indicate a missing profile (case-insensitive)
const NOT_FOUND_BODY_PATTERNS = [
  "this account doesn't exist",
  "this user doesn't exist",
  "this profile doesn't exist",
  "sorry, this account doesn't exist",
  "sorry, this page isn't available",
  "the specified profile could not be found",
  "no such user",
  "we couldn't find this user",
  "we can't find this account",
  "we couldn't find that user",
  "couldn't find that user",
  "user not found",
  "profile not found",
  "account not found",
  "member not found",
  "this username is not registered",
  "username is not available",
  "there is currently no user",
  "the user you requested",
  "page you requested does not exist",
  "the page you're looking for doesn't exist",
  "hmm, the page you were looking for",
  "oops! that page doesn't exist",
  "there's nothing here.",
  "that page doesn't exist",
  "we can't find this page",
  "this content isn't available",
  "this page isn't available",
  "no user with that username",
  "this page could not be found",
];

/* Phrases that indicate the account existed but is now gone (suspended/banned/deleted) */
const DELETED_BODY_PATTERNS = [
  "no longer exists",
  "account has been suspended",
  "account is suspended",
  "account was suspended",
  "this account has been suspended",
  "has been permanently suspended",
  "account has been deactivated",
  "account was deactivated",
  "this account has been deactivated",
  "account has been deleted",
  "account was deleted",
  "this account has been deleted",
  "account has been terminated",
  "account has been banned",
  "account was banned",
  "this account has been banned",
  "account has been closed",
  "account was closed",
  "user has been suspended",
  "user is suspended",
  "user has been deactivated",
  "user has been banned",
  "account has been withheld",
  "this account has been withheld",
];

/* ── Response classifier ─────────────────────────────────────────────── */
function hashBodySample(body) {
  return crypto.createHash('sha256').update(String(body || '').slice(0, 2048)).digest('hex');
}

function makeClassifiedResult(base, status, reasonCodes, confidence, extra = {}) {
  return {
    ...base,
    status,
    confidence,
    reasonCodes,
    evidence: {
      checkedAt: new Date().toISOString(),
      method: base.detectionMethod,
      statusCode: base.statusCode,
      bodyHash: base.bodyHash,
      reasons: reasonCodes,
    },
    ...extra,
  };
}

function normalizeResult(result) {
  if (typeof result.confidence === 'number' && Array.isArray(result.reasonCodes) && result.evidence) {
    return result;
  }

  const fallbackReason = result.status === 'timeout' ? 'request_timeout'
    : result.status === 'error' ? 'request_error'
    : result.status === 'unknown' ? 'inconclusive_result'
    : `status_${result.status}`;

  const confidenceByStatus = {
    found: 0.72,
    deleted: 0.8,
    not_found: 0.9,
    unknown: 0.3,
    timeout: 0.12,
    error: 0.1,
  };

  const reasonCodes = Array.isArray(result.reasonCodes) && result.reasonCodes.length
    ? result.reasonCodes
    : [fallbackReason];

  return {
    ...result,
    confidence: confidenceByStatus[result.status] ?? 0.5,
    reasonCodes,
    evidence: result.evidence || {
      checkedAt: new Date().toISOString(),
      method: result.resolvedBy === 'browser' ? 'browser' : 'http',
      statusCode: result.statusCode || 0,
      bodyHash: result.bodyHash || null,
      reasons: reasonCodes,
    },
  };
}

function classify(site, username, url, sc, headers, body, detectionMethod = 'http') {
  const base = {
    name: site.name,
    category: site.category,
    url,
    statusCode: sc,
    detectionMethod,
    bodyHash: hashBodySample(body),
  };

  if (sc >= 301 && sc <= 308) {
    const loc = (headers['location'] || '').toLowerCase();
    if (loc) {
      if (AUTH_REDIRECT_PATTERNS.some(p => loc.includes(p))) {
        return makeClassifiedResult(base, 'not_found', ['redirect_auth_login'], 0.95);
      }
      if (loc.includes('.within.website') || loc.includes('/_/') ||
          loc.includes('/cdn-cgi/') || loc.includes('challenge') ||
          body.toLowerCase().includes('authorization required')) {
        return makeClassifiedResult(base, 'unknown', ['redirect_bot_challenge'], 0.25);
      }
    }
    return makeClassifiedResult(base, 'found', ['redirect_reachable'], 0.7);
  }

  if (sc === 404 || sc === 410) {
    return makeClassifiedResult(base, 'not_found', [sc === 404 ? 'http_404' : 'http_410'], 0.98);
  }

  if (sc === 403 || sc === 401 || sc === 429 || sc === 999) {
    return makeClassifiedResult(base, 'unknown', [`blocked_http_${sc}`], 0.2);
  }

  if (site.notFoundStatus !== undefined && sc === site.notFoundStatus) {
    return makeClassifiedResult(base, 'not_found', ['site_specific_not_found_status'], 0.94);
  }

  if (sc === 200) {
    const lbody = body.toLowerCase();

    if (site.positiveMsg) {
      const found = body.includes(site.positiveMsg);
      return makeClassifiedResult(base, found ? 'found' : 'not_found', ['site_positive_message'], found ? 0.9 : 0.9);
    }

    if (site.errorMsg && body.includes(site.errorMsg)) {
      return makeClassifiedResult(base, 'not_found', ['site_error_message'], 0.92);
    }

    const tm = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = tm ? tm[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&').toLowerCase().trim() : '';

    if (BLOCKED_TITLE_PATTERNS.some(p => title.includes(p))) {
      return makeClassifiedResult(base, 'unknown', ['title_blocked_pattern'], 0.25);
    }

    if (NOT_FOUND_TITLE_PATTERNS.some(p => title.includes(p))) {
      return makeClassifiedResult(base, 'not_found', ['title_not_found_pattern'], 0.9);
    }

    if (BLOCKED_BODY_PATTERNS.some(p => lbody.includes(p))) {
      return makeClassifiedResult(base, 'unknown', ['body_blocked_pattern'], 0.25);
    }

    if (DELETED_BODY_PATTERNS.some(p => lbody.includes(p))) {
      return makeClassifiedResult(base, 'deleted', ['body_deleted_pattern'], 0.86);
    }

    if (NOT_FOUND_BODY_PATTERNS.some(p => lbody.includes(p))) {
      return makeClassifiedResult(base, 'not_found', ['body_not_found_pattern'], 0.87);
    }

    if (site.usernameInBody) {
      const found = lbody.includes(username.toLowerCase());
      const displayName = found ? extractDisplayName(title, username) : null;
      return makeClassifiedResult(
        base,
        found ? 'found' : 'not_found',
        [found ? 'username_present_in_body' : 'username_missing_in_body'],
        found ? 0.9 : 0.85,
        displayName ? { displayName } : {}
      );
    }

    if (!site.skipBodyCheck) {
      const found = lbody.includes(username.toLowerCase());
      const displayName = found ? extractDisplayName(title, username) : null;
      return makeClassifiedResult(
        base,
        found ? 'found' : 'unknown',
        [found ? 'body_guard_username_match' : 'body_guard_no_username_match'],
        found ? 0.74 : 0.35,
        displayName ? { displayName } : {}
      );
    }

    const displayName = extractDisplayName(title, username);
    return makeClassifiedResult(base, 'found', ['skip_body_check_enabled'], 0.68, displayName ? { displayName } : {});
  }

  return makeClassifiedResult(base, 'unknown', [`unhandled_status_${sc}`], 0.3);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico' : 'image/x-icon',
  '.svg' : 'image/svg+xml',
};

/* ── Input validation ─────────────────────────────────────────────────── */
function isValidUsername(u) {
  return typeof u === 'string' && u.length >= 1 && u.length <= 50
    && /^[a-zA-Z0-9._\-]+$/.test(u);
}

function isValidName(n) {
  return typeof n === 'string' && n.trim().length >= 2 && n.trim().length <= 80
    && /^[a-zA-Z][a-zA-Z '\-.]+$/.test(n.trim());
}

function isValidEmail(email) {
  return typeof email === 'string' && email.length >= 3 && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function normalizePhone(phone) {
  const raw = String(phone || '').trim();
  const stripped = raw.replace(/[\s().-]/g, '');
  if (!stripped) return '';
  return stripped.startsWith('+')
    ? `+${stripped.slice(1).replace(/[^0-9]/g, '')}`
    : stripped.replace(/[^0-9]/g, '');
}

function isValidPhone(phone) {
  const normalized = normalizePhone(phone);
  return /^\+?[0-9]{7,15}$/.test(normalized);
}

function normalizeDomain(domain) {
  let d = String(domain || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '');
  d = d.split('/')[0].split('?')[0].split('#')[0];
  d = d.replace(/\.$/, '');
  return d;
}

function isValidDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d || d.length > 253) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashEmail(email) {
  return crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function makeIntelResult({ category, name, status, url, summary, detail, reasonCodes = [], extra = {} }) {
  return normalizeResult({
    name,
    category,
    status,
    url,
    summary,
    detail,
    mode: category,
    reasonCodes,
    evidence: {
      checkedAt: new Date().toISOString(),
      method: extra.method || (status === 'link' ? 'link' : `${category}_probe`),
      statusCode: extra.statusCode || 0,
      bodyHash: extra.bodyHash || null,
      reasons: reasonCodes,
    },
    ...extra,
  });
}

function makeEmailResult({ name, status, url, summary, detail, reasonCodes = [], extra = {} }) {
  return makeIntelResult({
    category: 'email',
    name,
    status,
    url,
    summary,
    detail,
    reasonCodes,
    extra,
  });
}

function fetchStatus(targetUrl) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (_) { return resolve({ statusCode: 0, body: '' }); }

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length >= MAX_BODY) res.destroy();
      });
      res.on('close', () => resolve({ statusCode: res.statusCode || 0, body }));
      res.on('error', () => resolve({ statusCode: 0, body: '' }));
    });

    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', () => resolve({ statusCode: 0, body: '' }));
    req.end();
  });
}

async function probeGravatar(email) {
  const emailHash = hashEmail(email);
  const avatarUrl = `https://www.gravatar.com/avatar/${emailHash}?d=404&s=256`;
  const profileUrl = `https://gravatar.com/${emailHash}`;
  const resp = await fetchStatus(avatarUrl);

  if (resp.statusCode === 200) {
    return makeEmailResult({
      name: 'Gravatar',
      status: 'found',
      url: profileUrl,
      summary: 'Public Gravatar avatar or profile data appears to exist for this email.',
      detail: 'Useful for avatars, bios, linked accounts, and profile metadata when the owner has enabled it.',
      reasonCodes: ['gravatar_profile_found'],
      extra: { statusCode: 200, bodyHash: hashBodySample(resp.body), method: 'gravatar' },
    });
  }

  if (resp.statusCode === 404) {
    return makeEmailResult({
      name: 'Gravatar',
      status: 'not_found',
      url: profileUrl,
      summary: 'No public Gravatar avatar was found for this email hash.',
      detail: 'This does not rule out the email being valid; it only means no public Gravatar profile was exposed here.',
      reasonCodes: ['gravatar_profile_not_found'],
      extra: { statusCode: 404, bodyHash: hashBodySample(resp.body), method: 'gravatar' },
    });
  }

  return makeEmailResult({
    name: 'Gravatar',
    status: 'unknown',
    url: profileUrl,
    summary: 'Gravatar lookup was inconclusive.',
    detail: 'The upstream service did not return a clear found/not found response.',
    reasonCodes: ['gravatar_inconclusive'],
    extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'gravatar' },
  });
}

async function analyzeEmailDomain(email) {
  const domain = normalizeEmail(email).split('@')[1] || '';
  let mx = [];
  let txt = [];
  let dmarc = [];

  try { mx = await dns.resolveMx(domain); } catch (_) {}
  try { txt = await dns.resolveTxt(domain); } catch (_) {}
  try { dmarc = await dns.resolveTxt(`_dmarc.${domain}`); } catch (_) {}

  const flatTxt = txt.flat().join(' ');
  const flatDmarc = dmarc.flat().join(' ');
  const hasMx = mx.length > 0;
  const hasSpf = /v=spf1/i.test(flatTxt);
  const hasDmarc = /v=dmarc1/i.test(flatDmarc);
  const mxPreview = hasMx ? mx.slice(0, 3).map(entry => entry.exchange).join(', ') : 'none detected';

  return makeEmailResult({
    name: 'Email Domain',
    status: hasMx ? 'found' : 'unknown',
    url: `https://${domain}`,
    summary: `MX ${hasMx ? 'present' : 'missing'} | SPF ${hasSpf ? 'present' : 'missing'} | DMARC ${hasDmarc ? 'present' : 'missing'}`,
    detail: `Mail exchangers: ${mxPreview}`,
    reasonCodes: [hasMx ? 'domain_mx_present' : 'domain_mx_missing'],
    extra: { method: 'dns' },
  });
}

async function probeHibpPublicPage(email) {
  const target = `https://haveibeenpwned.com/account/${encodeURIComponent(normalizeEmail(email))}`;
  const resp = await fetchStatus(target);
  const body = (resp.body || '').toLowerCase();

  if (body.includes('good news') && body.includes('no pwnage found')) {
    return makeEmailResult({
      name: 'Have I Been Pwned',
      status: 'not_found',
      url: target,
      summary: 'Public breach page indicates no known pwnage for this email.',
      detail: 'Treat as an indicator only. Breach status can change over time.',
      reasonCodes: ['hibp_page_no_pwnage'],
      extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'hibp_page' },
    });
  }

  if (body.includes('oh no') && body.includes('pwned')) {
    return makeEmailResult({
      name: 'Have I Been Pwned',
      status: 'found',
      url: target,
      summary: 'Public breach page indicates this email appears in known breaches.',
      detail: 'Open the source for breach names and exposure details.',
      reasonCodes: ['hibp_page_pwned'],
      extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'hibp_page' },
    });
  }

  return makeEmailResult({
    name: 'Have I Been Pwned',
    status: 'unknown',
    url: target,
    summary: 'Breach page could not be classified automatically.',
    detail: 'Open the page directly to validate current status.',
    reasonCodes: ['hibp_page_inconclusive'],
    extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'hibp_page' },
  });
}

async function probeWebSearch(name, target, markerRegex, foundReason, notFoundReason) {
  const resp = await fetchStatus(target);
  const body = String(resp.body || '');
  const matchCount = (body.match(markerRegex) || []).length;

  if (matchCount > 0) {
    return makeEmailResult({
      name,
      status: 'found',
      url: target,
      summary: `Indexed references found (${matchCount} signal${matchCount === 1 ? '' : 's'}).`,
      detail: 'Open source results to inspect context and attribution.',
      reasonCodes: [foundReason],
      extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'web_search', signalCount: matchCount },
    });
  }

  if (resp.statusCode === 200) {
    return makeEmailResult({
      name,
      status: 'not_found',
      url: target,
      summary: 'No strong indexed references were detected automatically.',
      detail: 'Manual review may still reveal edge-case hits.',
      reasonCodes: [notFoundReason],
      extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'web_search', signalCount: 0 },
    });
  }

  return makeEmailResult({
    name,
    status: 'unknown',
    url: target,
    summary: 'Search source response was inconclusive.',
    detail: 'Source may block automation or require interactive checks.',
    reasonCodes: ['email_source_inconclusive'],
    extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'web_search', signalCount: 0 },
  });
}

async function fetchRenderedPageText(targetUrl) {
  if (!chromiumStealth) return { ok: false, text: '', title: '', statusCode: 0 };

  await acquireBSlot();
  let context;
  try {
    const b = await ensureBrowser();
    context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    let title = '';
    let text = '';
    let statusCode = 0;
    let blocked = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      await delay(350 + Math.floor(Math.random() * 650));
      const resp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: STEALTH_TIMEOUT_MS }).catch(() => null);
      statusCode = resp ? (resp.status() || statusCode) : statusCode;
      await page.waitForLoadState('networkidle', { timeout: 7000 }).catch(() => {});
      title = await page.title().catch(() => '');
      text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');

      const tl = String(title || '').toLowerCase();
      const bl = String(text || '').toLowerCase();
      blocked = BLOCKED_TITLE_PATTERNS.some(p => tl.includes(p)) || BLOCKED_BODY_PATTERNS.some(p => bl.includes(p));
      if (!blocked) break;
      if (attempt === 0) await page.waitForTimeout(2500);
    }
    await context.close();

    return {
      ok: !!(text || title),
      text: `${title}\n${text}`,
      title,
      statusCode: statusCode || 200,
      blocked,
    };
  } catch (_) {
    if (context) try { await context.close(); } catch (_) {}
    return { ok: false, text: '', title: '', statusCode: 0 };
  } finally {
    releaseBSlot();
  }
}

async function probeWebSearchWithBrowserFallback(name, target, markerRegex, foundReason, notFoundReason) {
  const first = await probeWebSearch(name, target, markerRegex, foundReason, notFoundReason);
  if (first.status !== 'unknown') return first;
  if (!chromiumStealth) return first;

  const rendered = await fetchRenderedPageText(target);
  if (!rendered.ok) {
    return makeEmailResult({
      name,
      status: 'unknown',
      url: target,
      summary: first.summary,
      detail: `${first.detail} Browser-render fallback could not load source content.`,
      reasonCodes: Array.from(new Set([...(first.reasonCodes || []), 'browser_fallback'])),
      extra: { statusCode: 0, bodyHash: null, method: 'web_search_browser' },
    });
  }

  const matchCount = (String(rendered.text || '').match(markerRegex) || []).length;

  if (matchCount > 0) {
    return makeEmailResult({
      name,
      status: 'found',
      url: target,
      summary: `Browser-rendered source loaded and produced indexed results (${matchCount}).`,
      detail: 'Source required browser rendering for reliable parsing.',
      reasonCodes: ['browser_fallback', foundReason],
      extra: {
        statusCode: rendered.statusCode || 200,
        bodyHash: hashBodySample(rendered.text),
        method: 'web_search_browser',
        signalCount: matchCount,
      },
    });
  }

  return makeEmailResult({
    name,
    status: 'not_found',
    url: target,
    summary: rendered.blocked
      ? 'Source was reachable but challenge-protected; strong indexed references were not confirmed automatically.'
      : 'Browser-rendered source loaded but no strong indexed references were detected.',
    detail: rendered.blocked
      ? 'This source appears challenge-protected. Manual review is recommended for final confirmation.'
      : 'Manual review may still find edge-case references.',
    reasonCodes: rendered.blocked ? ['browser_fallback', 'cloudflare_or_challenge_detected', notFoundReason] : ['browser_fallback', notFoundReason],
    extra: {
      statusCode: rendered.statusCode || 200,
      bodyHash: hashBodySample(rendered.text),
      method: 'web_search_browser',
      signalCount: 0,
    },
  });
}

async function probeDuckDuckGoEmail(email) {
  const target = `https://duckduckgo.com/html/?q=${encodeURIComponent(`"${normalizeEmail(email)}"`)}`;
  return probeWebSearchWithBrowserFallback('DuckDuckGo', target, /result__a|result-link/gi, 'duckduckgo_email_hits', 'duckduckgo_email_no_hits');
}

async function probeBingEmail(email) {
  const target = `https://www.bing.com/search?q=${encodeURIComponent(`"${normalizeEmail(email)}"`)}`;
  return probeWebSearchWithBrowserFallback('Bing', target, /<li class="b_algo"|b_title/gi, 'bing_email_hits', 'bing_email_no_hits');
}

async function probeGitHubEmail(email) {
  const target = `https://github.com/search?q=${encodeURIComponent(`"${normalizeEmail(email)}"`)}&type=code`;
  return probeWebSearchWithBrowserFallback('GitHub Search', target, /code-list-item|search-title|repo-list-item/gi, 'github_email_hits', 'github_email_no_hits');
}

function buildEmailPivots(email) {
  const encoded = encodeURIComponent(normalizeEmail(email));

  return [
    makeEmailResult({
      name: 'IntelX Search Pivot',
      status: 'link',
      url: `https://intelx.io/?s=${encoded}`,
      summary: 'Open deep-index search for leaked and indexed references.',
      detail: 'Useful for deeper manual validation when automated checks are inconclusive.',
      reasonCodes: ['manual_intel_pivot'],
      extra: { method: 'link' },
    }),
  ];
}

function guessPhoneRegion(phone) {
  const p = normalizePhone(phone);
  if (p.startsWith('+1')) return 'North America (+1)';
  if (p.startsWith('+44')) return 'United Kingdom (+44)';
  if (p.startsWith('+61')) return 'Australia (+61)';
  if (p.startsWith('+91')) return 'India (+91)';
  if (p.startsWith('+81')) return 'Japan (+81)';
  if (p.startsWith('+49')) return 'Germany (+49)';
  if (p.startsWith('+33')) return 'France (+33)';
  if (p.startsWith('+34')) return 'Spain (+34)';
  return p.startsWith('+') ? 'International format detected' : 'Local format detected';
}

function analyzePhoneNumber(phone) {
  const normalized = normalizePhone(phone);
  const valid = isValidPhone(normalized);
  return makeIntelResult({
    category: 'phone',
    name: 'Phone Structure',
    status: valid ? 'found' : 'unknown',
    url: `https://www.google.com/search?q=${encodeURIComponent(`"${normalized}"`)}`,
    summary: valid
      ? `Format valid (${normalized.length - (normalized.startsWith('+') ? 1 : 0)} digits).`
      : 'Phone format could not be validated confidently.',
    detail: valid
      ? `Region hint: ${guessPhoneRegion(normalized)}`
      : 'Try international format with country code, e.g. +1 555 123 4567.',
    reasonCodes: [valid ? 'phone_format_valid' : 'phone_format_unknown'],
    extra: { method: 'phone_format' },
  });
}

async function probeDuckDuckGoPhone(phone) {
  const normalized = normalizePhone(phone);
  const target = `https://duckduckgo.com/html/?q=${encodeURIComponent(`"${normalized}"`)}`;
  const result = await probeWebSearchWithBrowserFallback('DuckDuckGo Phone', target, /result__a|result-link/gi, 'phone_search_hits', 'phone_search_no_hits');
  return { ...result, category: 'phone', mode: 'phone' };
}

async function probeBingPhone(phone) {
  const normalized = normalizePhone(phone);
  const target = `https://www.bing.com/search?q=${encodeURIComponent(`"${normalized}"`)}`;
  const result = await probeWebSearchWithBrowserFallback('Bing Phone', target, /<li class="b_algo"|b_title/gi, 'phone_search_hits', 'phone_search_no_hits');
  return { ...result, category: 'phone', mode: 'phone' };
}

function buildPhonePivots(phone) {
  const normalized = normalizePhone(phone);
  const encoded = encodeURIComponent(normalized);
  const digitsOnly = normalized.replace(/^\+/, '');
  return [
    makeIntelResult({
      category: 'phone',
      name: 'Google Reverse Pivot',
      status: 'link',
      url: `https://www.google.com/search?q=${encodeURIComponent(`"${normalized}"`)}`,
      summary: 'Open web search pivot for reverse-phone traces.',
      detail: 'Useful for listings, forum posts, and cached directories.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
    makeIntelResult({
      category: 'phone',
      name: 'IntelX Phone Pivot',
      status: 'link',
      url: `https://intelx.io/?s=${encoded}`,
      summary: 'Open deep-index phone pivot for leaked/indexed mentions.',
      detail: 'Useful when direct indexing checks are inconclusive.',
      reasonCodes: ['manual_intel_pivot'],
      extra: { method: 'link' },
    }),
    makeIntelResult({
      category: 'phone',
      name: 'That\'sThem Pivot',
      status: 'link',
      url: `https://thatsthem.com/phone/${encodeURIComponent(digitsOnly)}`,
      summary: 'Open reverse-phone directory pivot.',
      detail: 'Best-effort public directory source; verify manually.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
  ];
}

async function probeDomainDns(domain) {
  const d = normalizeDomain(domain);
  let a = [];
  let aaaa = [];
  let mx = [];
  let ns = [];

  try { a = await dns.resolve4(d); } catch (_) {}
  try { aaaa = await dns.resolve6(d); } catch (_) {}
  try { mx = await dns.resolveMx(d); } catch (_) {}
  try { ns = await dns.resolveNs(d); } catch (_) {}

  const hasSignals = a.length > 0 || aaaa.length > 0 || mx.length > 0 || ns.length > 0;
  const summary = `A ${a.length} | AAAA ${aaaa.length} | MX ${mx.length} | NS ${ns.length}`;

  return makeIntelResult({
    category: 'domain',
    name: 'DNS Signals',
    status: hasSignals ? 'found' : 'unknown',
    url: `https://${d}`,
    summary,
    detail: hasSignals
      ? `NS sample: ${(ns.slice(0, 2).join(', ') || 'n/a')}`
      : 'No strong DNS signals detected via resolver checks.',
    reasonCodes: [hasSignals ? 'domain_dns_present' : 'domain_dns_missing'],
    extra: { method: 'dns' },
  });
}

async function probeDomainReachability(domain) {
  const d = normalizeDomain(domain);
  const httpsResp = await fetchStatus(`https://${d}`);
  const httpResp = await fetchStatus(`http://${d}`);

  if (httpsResp.statusCode >= 200 && httpsResp.statusCode < 500) {
    return makeIntelResult({
      category: 'domain',
      name: 'Web Reachability',
      status: 'found',
      url: `https://${d}`,
      summary: `HTTPS responded with status ${httpsResp.statusCode}.`,
      detail: 'Domain is reachable over HTTPS.',
      reasonCodes: ['domain_https_reachable'],
      extra: { statusCode: httpsResp.statusCode, bodyHash: hashBodySample(httpsResp.body), method: 'http' },
    });
  }

  if (httpResp.statusCode >= 200 && httpResp.statusCode < 500) {
    return makeIntelResult({
      category: 'domain',
      name: 'Web Reachability',
      status: 'unknown',
      url: `http://${d}`,
      summary: `HTTP responded with status ${httpResp.statusCode}; HTTPS did not respond clearly.`,
      detail: 'Domain appears reachable but TLS endpoint may be restricted or unavailable.',
      reasonCodes: ['domain_http_only'],
      extra: { statusCode: httpResp.statusCode, bodyHash: hashBodySample(httpResp.body), method: 'http' },
    });
  }

  return makeIntelResult({
    category: 'domain',
    name: 'Web Reachability',
    status: 'unknown',
    url: `https://${d}`,
    summary: 'Domain web endpoint did not respond clearly.',
    detail: 'Could be offline, parked, blocked, or challenge-protected.',
    reasonCodes: ['domain_unreachable'],
    extra: { statusCode: httpsResp.statusCode || httpResp.statusCode || 0, method: 'http' },
  });
}

async function probeDomainCrtSh(domain) {
  const d = normalizeDomain(domain);
  const target = `https://crt.sh/?q=${encodeURIComponent(d)}&output=json`;
  const resp = await fetchStatus(target);
  const body = String(resp.body || '');
  const count = (body.match(/"name_value"/g) || []).length;
  const found = resp.statusCode === 200 && count > 0;

  return makeIntelResult({
    category: 'domain',
    name: 'Certificate Transparency',
    status: found ? 'found' : (resp.statusCode === 200 ? 'not_found' : 'unknown'),
    url: `https://crt.sh/?q=${encodeURIComponent(d)}`,
    summary: found
      ? `Certificate records detected (${count} entries).`
      : resp.statusCode === 200
        ? 'No certificate records detected in this query response.'
        : 'Certificate lookup response was inconclusive.',
    detail: 'Use certificate history to pivot on subdomains and infrastructure.',
    reasonCodes: [found ? 'crtsh_hits' : 'crtsh_no_hits'],
    extra: { statusCode: resp.statusCode, bodyHash: hashBodySample(resp.body), method: 'crtsh' },
  });
}

function buildDomainPivots(domain) {
  const d = normalizeDomain(domain);
  return [
    makeIntelResult({
      category: 'domain',
      name: 'Whois Lookup Pivot',
      status: 'link',
      url: `https://who.is/whois/${encodeURIComponent(d)}`,
      summary: 'Open WHOIS pivot for registration history and registrar data.',
      detail: 'Useful for ownership and registration timeline checks.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
    makeIntelResult({
      category: 'domain',
      name: 'DNSdumpster Pivot',
      status: 'link',
      url: `https://dnsdumpster.com/static/map/${encodeURIComponent(d)}.png`,
      summary: 'Open DNS infrastructure pivot.',
      detail: 'Best-effort infrastructure map artifact; may not exist for every domain.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
    makeIntelResult({
      category: 'domain',
      name: 'VirusTotal GUI Pivot',
      status: 'link',
      url: `https://www.virustotal.com/gui/domain/${encodeURIComponent(d)}`,
      summary: 'Open reputation and passive DNS pivot.',
      detail: 'Useful for reputation context and linked artifacts.',
      reasonCodes: ['manual_search_pivot'],
      extra: { method: 'link' },
    }),
  ];
}

/* ── Display name extractor (optional field on 'found' results) ────────── */
function extractDisplayName(title, username) {
  if (!title) return null;
  const uLow = username.toLowerCase();
  const t = title.trim();

  // "Full Name (@handle)" or "Full Name (@handle) on Platform"
  let m = t.match(/^(.+?)\s*\(@?[a-zA-Z0-9._\-]+\)/);
  if (m) {
    const name = m[1].trim();
    if (name.toLowerCase() !== uLow && name.length > 1 && name.length < 60) return name;
  }

  // "handle (Full Name) · Platform" — GitHub style
  m = t.match(/^@?[a-zA-Z0-9._\-]+ \((.+?)\)/);
  if (m) {
    const name = m[1].trim();
    if (name.toLowerCase() !== uLow && name.length > 1 && name.length < 60) return name;
  }

  // "Full Name | Platform" or "Full Name · Platform" or "Full Name — Platform" or "Full Name - Platform"
  m = t.match(/^(.+?)\s*[|·\u2013\u2014]\s*.+$/);
  if (m) {
    const name = m[1].trim();
    if (name.toLowerCase() !== uLow && name.length > 1 && name.length < 60
        && name.includes(' ')) return name;
  }

  return null;
}

/* ── Name-site URL builder ───────────────────────────────────────────────── */
function toSlug(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function toTitleSlug(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('-');
}

const US_STATE_CODES = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
  'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV',
  'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY',
  'north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK',
  'oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT',
  'vermont':'VT','virginia':'VA','washington':'WA','west virginia':'WV',
  'wisconsin':'WI','wyoming':'WY','district of columbia':'DC',
};

const STATE_CODE_TO_NAME = Object.fromEntries(
  Object.entries(US_STATE_CODES).map(([name, code]) => [code, name])
);

function toStateCode(s) {
  if (!s) return '';
  const t = s.trim();
  if (t.length <= 3) return t.toUpperCase();
  return US_STATE_CODES[t.toLowerCase()] || t.slice(0, 2).toUpperCase();
}

function toStateName(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (!t) return '';
  const code = toStateCode(t);
  const raw = STATE_CODE_TO_NAME[code] || t.toLowerCase();
  return raw.split(' ').map(part => part ? (part[0].toUpperCase() + part.slice(1)) : '').join(' ');
}

function toPlusParam(s) {
  return encodeURIComponent(String(s || '').trim()).replace(/%20/g, '+');
}

function buildNameUrl(site, firstName, lastName, filters = {}) {
  const city     = (filters.city  || '').trim();
  const stateRaw = (filters.state || '').trim();
  const state    = toStateCode(stateRaw);
  const stateFull = toStateName(stateRaw);
  const ageMin   = String(filters.ageMin || '');
  const ageMax   = String(filters.ageMax || '');

  const fLow  = firstName.toLowerCase();
  const lLow  = lastName.toLowerCase();

  const encFirst  = encodeURIComponent(firstName);
  const encLast   = encodeURIComponent(lastName);
  const encFull   = encodeURIComponent(`${firstName} ${lastName}`);
  const encHyphen = encodeURIComponent(`${fLow}-${lLow}`);
  const encUnder  = encodeURIComponent(`${fLow}_${lLow}`);
  const encPlus   = encodeURIComponent(`${firstName}+${lastName}`);

  const citySlug       = toSlug(city);
  const cityTitleSlug  = toTitleSlug(city);
  const cityPlus       = toPlusParam(city);
  const stateSlug      = toSlug(stateRaw);
  const stateCodeLower = state.toLowerCase();
  const locationPath = city && state ? `${citySlug}-${stateCodeLower}`
                     : city          ? citySlug
                     : stateCodeLower;
  const locationQs = city && state ? encodeURIComponent(`${city}, ${state}`)
                   : city          ? encodeURIComponent(city)
                   : encodeURIComponent(state);
  const locationQsDouble = encodeURIComponent(locationQs);
  const fullNameDouble = encodeURIComponent(encFull);

  const hasCity  = !!city;
  const hasState = !!state;
  const hasAge   = !!(ageMin || ageMax);
  let template = site.url;
  if (site.urlFiltered) {
    const fr = site.filterRequires || 'any';
    const useFiltered =
      (fr === 'city_and_state' && hasCity && hasState) ||
      ((fr === 'state' || fr === 'any') && (hasCity || hasState || hasAge));
    if (useFiltered) template = site.urlFiltered;
  }

  return template
    .replace('{first}',               encFirst)
    .replace('{last}',                encLast)
    .replace('{first_lower}',         encodeURIComponent(fLow))
    .replace('{last_lower}',          encodeURIComponent(lLow))
    .replace('{fullname}',            encFull)
    .replace('{fullname_hyphen}',     encHyphen)
    .replace('{fullname_hyphen_lower}', `${fLow}-${lLow}`)
    .replace('{fullname_underscore}', encUnder)
    .replace('{fullname_underscore_lower}', `${fLow}_${lLow}`)
    .replace('{fullname_plus}',       encodeURIComponent(`${fLow} ${lLow}`))
    .replace('{fullname_plus_lower}', `${encodeURIComponent(fLow)}+${encodeURIComponent(lLow)}`)
    .replace('{city}',                encodeURIComponent(city))
    .replace('{city_slug}',           citySlug)
    .replace('{city_title_slug}',     cityTitleSlug)
    .replace('{city_plus}',           cityPlus)
    .replace('{state_code}',          state)
    .replace('{state_code_lower}',    stateCodeLower)
    .replace('{state_full}',          encodeURIComponent(stateFull))
    .replace('{state_slug}',          stateSlug)
    .replace('{city_state_slug}',     locationPath)
    .replace('{location_path}',       locationPath)
    .replace('{location_qs}',         locationQs)
    .replace('{location_qs_double}',  locationQsDouble)
    .replace('{fullname_double}',     fullNameDouble)
    .replace('{age_min}',             ageMin)
    .replace('{age_max}',             ageMax);
}

/* ── Name-site stealth probe ───────────────────────────────────────────────────────── */
async function probeNameSearch(site, firstName, lastName, filters = {}) {
  const profileUrl = buildNameUrl(site, firstName, lastName, filters);

  const base = { name: site.name, category: 'people-finder', url: profileUrl, mode: 'name' };

  if (!chromiumStealth) return { ...base, status: 'unknown', statusCode: 0 };

  await acquireBSlot();
  let context;
  try {
    const b = await ensureBrowser();
    context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale   : 'en-US',
      viewport : { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    let title = '';
    let text  = '';
    let statusCode = 0;
    let challengeSeen = false;

    for (let attempt = 0; attempt < 1; attempt++) {
      try {
        await delay(350 + Math.floor(Math.random() * 650));
        const resp = await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: STEALTH_TIMEOUT_MS }).catch(() => null);
        statusCode = resp ? (resp.status() || statusCode) : statusCode;
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      } catch (_) {}

      title = await page.title().catch(() => '');
      text  = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 5000) : '').catch(() => '');
      const tl = String(title || '').toLowerCase();
      const bl = String(text || '').toLowerCase();
      challengeSeen = BLOCKED_TITLE_PATTERNS.some(p => tl.includes(p)) || BLOCKED_BODY_PATTERNS.some(p => bl.includes(p));
      if (!challengeSeen) break;
    }
    await context.close();

    const tLow = title.toLowerCase();
    const bLow = text.toLowerCase();
    const combined = tLow + ' ' + bLow;

    // Bot-wall detection
    if (challengeSeen || BLOCKED_TITLE_PATTERNS.some(p => tLow.includes(p)) || BLOCKED_BODY_PATTERNS.some(p => bLow.includes(p))) {
      // Compliant fallback: retry with a plain HTTP fetch parser before declaring blocked.
      const httpFallback = await fetchStatus(profileUrl);
      const fbBody = String(httpFallback.body || '').toLowerCase();
      const fbBlocked = BLOCKED_BODY_PATTERNS.some(p => fbBody.includes(p));

      if (httpFallback.statusCode === 404 || httpFallback.statusCode === 410) {
        return { ...base, status: 'not_found', statusCode: httpFallback.statusCode, reasonCodes: ['http_fallback_not_found'] };
      }

      if (!fbBlocked && httpFallback.statusCode === 200) {
        if (site.noResultsMsg && fbBody.includes(site.noResultsMsg.toLowerCase())) {
          return { ...base, status: 'not_found', statusCode: 200, reasonCodes: ['http_fallback_no_results'] };
        }
        if (site.resultsPattern && fbBody.includes(site.resultsPattern.toLowerCase())) {
          return { ...base, status: 'found', statusCode: 200, reasonCodes: ['http_fallback_results_pattern'] };
        }
      }

      return { ...base, status: 'unknown', statusCode: statusCode || httpFallback.statusCode || 0, reasonCodes: ['cloudflare_or_challenge_detected'] };
    }

    if (statusCode === 404 || statusCode === 410) {
      return { ...base, status: 'not_found', statusCode };
    }

    if (site.noResultsMsg && combined.includes(site.noResultsMsg.toLowerCase())) {
      return { ...base, status: 'not_found', statusCode: statusCode || 200 };
    }

    // Try to count results
    let resultCount = null;
    const countMatch = combined.match(/(\d+)\s+(?:result|record|people|person|match)/i);
    if (countMatch) resultCount = parseInt(countMatch[1], 10);

    if (site.resultsPattern && combined.includes(site.resultsPattern.toLowerCase())) {
      return { ...base, status: 'found', statusCode: statusCode || 200, resultCount };
    }

    // Fallback: if page loaded without a "no results" message and has enough content, assume found
    if (bLow.length > 500) {
      return { ...base, status: 'found', statusCode: statusCode || 200, resultCount };
    }

    return { ...base, status: 'unknown', statusCode: statusCode || 0 };
  } catch (err) {
    if (context) try { await context.close(); } catch (_) {}
    return { ...base, status: 'unknown', statusCode: 0 };
  } finally {
    releaseBSlot();
  }
}

/* ── Safe URL for href (prevent javascript: etc.) ─────────────────────── */
function isSafeUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch (_) { return false; }
}

/* ── Single-site probe (follows redirects up to MAX_REDIRECT_HOPS) ─────── */
const MAX_REDIRECT_HOPS = 3;

function makeReqOptions(parsed) {
  return {
    hostname: parsed.hostname,
    port    : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path    : parsed.pathname + parsed.search,
    method  : 'GET',
    headers : {
      'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control'  : 'no-cache',
    },
    timeout: TIMEOUT_MS,
  };
}

function doRequest(site, username, origUrl, url, hops, finish) {
  let parsed;
  try { parsed = new URL(url); }
  catch (_) { return finish({ name: site.name, category: site.category, url: origUrl, status: 'error', statusCode: 0 }); }

  const mod  = parsed.protocol === 'https:' ? https : http;
  const base = { name: site.name, category: site.category, url: origUrl };

  const req = mod.request(makeReqOptions(parsed), (res) => {
    const sc      = res.statusCode;
    const headers = res.headers;

    // ── Handle redirects ───────────────────────────────────────────────
    if (sc >= 301 && sc <= 308) {
      res.resume(); // drain to free socket
      const locRaw = headers['location'] || '';
      if (!locRaw) return finish({ ...base, status: 'found', statusCode: sc });
      const loc = locRaw.toLowerCase();

      let absLoc;
      try { absLoc = new URL(locRaw, url).href; }
      catch (_) { return finish({ ...base, status: 'found', statusCode: sc }); }

      // Auth/login redirect → not_found
      if (AUTH_REDIRECT_PATTERNS.some(p => loc.includes(p))) {
        return finish({ ...base, status: 'not_found', statusCode: sc });
      }
      // Bot-protection redirect → unknown (can't determine)
      if (loc.includes('.within.website') || loc.includes('/_/') ||
          loc.includes('/cdn-cgi/') || loc.includes('challenge') ||
          loc.includes('/captcha') || loc.includes('splashui') ||
          loc.includes('verify-browser') || loc.includes('bot-check')) {
        return finish({ ...base, status: 'unknown', statusCode: sc });
      }
      // Redirect to domain root (no sub-path) → user doesn't exist
      try {
        const absURL = new URL(locRaw, url);
        if (absURL.pathname === '/' && !absURL.search) {
          return finish({ ...base, status: 'not_found', statusCode: sc });
        }
        // Redirect to /404 or /not-found path → user doesn't exist
        if (/\/(404|not[-_]?found|account[-_]?deleted|deleted[-_]?account|user[-_]?not[-_]?found|no[-_]?user)(\/|$)/i.test(absURL.pathname)) {
          return finish({ ...base, status: 'not_found', statusCode: sc });
        }
      } catch (_) {}

      // Follow redirect if within hop limit
      if (hops < MAX_REDIRECT_HOPS) {
        return doRequest(site, username, origUrl, absLoc, hops + 1, finish);
      }
      // Gave up following — treat as found
      return finish({ ...base, status: 'found', statusCode: sc });
    }

    // ── Non-redirect: read body and classify ──────────────────────────
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      body += chunk;
      if (body.length >= MAX_BODY) res.destroy();
    });
    res.on('close', () => {
      finish(classify(site, username, origUrl, sc, headers, body));
    });
    res.on('error', () => finish({ ...base, status: 'error', statusCode: 0 }));
  });

  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', (err) => {
    if (err.message === 'timeout') {
      finish({ ...base, status: 'timeout', statusCode: 0 });
    } else {
      finish({ ...base, status: 'error', statusCode: 0 });
    }
  });

  req.end();
}

/* ── Stealth browser pool ─────────────────────────────────────────────── */
function acquireBSlot() {
  return new Promise(r => {
    if (_bSlots < STEALTH_CONCURRENCY) { _bSlots++; r(); }
    else _bQueue.push(r);
  });
}
function releaseBSlot() {
  if (_bQueue.length) { _bQueue.shift()(); }
  else _bSlots--;
}

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

async function probeStealth(site, username) {
  const profileUrl = site.url.replace(/\{\}/g, encodeURIComponent(username));
  const base = { name: site.name, category: site.category, url: profileUrl };

  if (!chromiumStealth) {
    return { ...base, status: 'unknown', statusCode: 0 };
  }

  await acquireBSlot();
  let context;
  try {
    const b = await ensureBrowser();
    context = await b.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale   : 'en-US',
      viewport : { width: 1280, height: 800 },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const page = await context.newPage();
    let statusCode = 0;
    let title = '', text = '';
    try {
      const response = await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: STEALTH_TIMEOUT_MS }).catch(() => null);
      statusCode = response ? (response.status() || 0) : statusCode;
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    } catch (_) { /* partial content is acceptable */ }
    title = await page.title().catch(() => '');
    text  = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    await context.close();
    const syntheticBody = `<title>${title}</title>\n${text}`;
    return classify(site, username, profileUrl, statusCode || 200, {}, syntheticBody, 'browser');
  } catch (err) {
    if (context) try { await context.close(); } catch (_) {}
    return { ...base, status: 'unknown', statusCode: 0 };
  } finally {
    releaseBSlot();
  }
}

function probe(site, username) {
  // Optional fast-path: skip stealth for undetectable sites.
  if (site.undetectable && !ENABLE_UNDETECTABLE_STEALTH) {
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

  if (site.undetectable) return probeStealth(site, username);

  return new Promise((resolve) => {
    // Sites with a calibrated internal API endpoint — hit that directly
    const targetTemplate = site.apiUrl || site.url;
    let url;
    try {
      url = targetTemplate.replace(/\{\}/g, encodeURIComponent(username));
    } catch (_) {
      return resolve({ name: site.name, category: site.category, url: site.url, status: 'error', statusCode: 0 });
    }

    // The URL shown to the user in results is always the profile URL, not the API URL
    const profileUrl = site.url.replace(/\{\}/g, encodeURIComponent(username));
    doRequest(site, username, profileUrl, url, 0, resolve);
  });
}

async function probeWithBrowserFallback(site, username) {
  const first = await probe(site, username);

  // Keep fast-path result when already conclusive.
  if (first.status !== 'unknown') return first;
  if (!ENABLE_USERNAME_BROWSER_FALLBACK && !site.allowBrowserFallback) return first;
  if (!chromiumStealth) return first;

  // Skip fallback when explicitly disabled per-site.
  if (site.noBrowserFallback) return first;

  const second = await probeStealth(site, username);
  const secondReasons = Array.isArray(second.reasonCodes) ? second.reasonCodes : [];
  return {
    ...second,
    preBrowserStatus: first.status,
    resolvedBy: 'browser',
    reasonCodes: secondReasons.includes('browser_fallback') ? secondReasons : [...secondReasons, 'browser_fallback'],
  };
}

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
  if (status === 'found' || status === 'deleted') return 'taken';
  if (status === 'not_found') return 'available';
  return 'unknown';
}

/* ── Static file helper ───────────────────────────────────────────────── */
function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const ct  = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

async function streamTaskResults(send, startPayload, taskFactories) {
  const total = taskFactories.length;
  let done = 0;
  send({ type: 'start', total, ...startPayload });

  await Promise.all(taskFactories.map(factory => Promise.resolve()
    .then(factory)
    .catch(() => null)
    .then(item => {
      done += 1;
      if (item) send({ type: 'result', ...item, done, total });
    })));

  send({ type: 'done', done: total, total });
}

/* ── HTTP server ──────────────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  let urlObj;
  try { urlObj = new URL(req.url, `http://localhost:${PORT}`); }
  catch (_) { res.writeHead(400); return res.end('Bad Request'); }

  const pathname = urlObj.pathname;

  // Only allow GET
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    return res.end('Method Not Allowed');
  }

  /* ── SSE endpoint ───────────────────────────────────────────────────── */
  if (pathname === '/api/check') {
    const username = (urlObj.searchParams.get('username') || '').trim();
    if (!isValidUsername(username)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid username. Use letters, numbers, dots, hyphens, underscores (1-50 chars).' }));
    }

    res.writeHead(200, {
      'Content-Type' : 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection'   : 'keep-alive',
    });

    let cancelled = false;
    req.on('close', () => { cancelled = true; });

    const queue = [...SITES];
    const total = queue.length;
    let idx = 0, active = 0, done = 0;

    const send = (obj) => {
      if (!cancelled && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };

    send({ type: 'start', total, username });

    function tick() {
      while (active < CONCURRENCY && idx < total) {
        const site = queue[idx++];
        active++;
        probeWithBrowserFallback(site, username).then(result => {
          active--;
          done++;
          const normalized = normalizeResult(result);
          if (!cancelled) send({ type: 'result', ...normalized, done, total });
          tick();
        }).catch(() => {
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
      if (idx >= total && active === 0 && !res.writableEnded) {
        send({ type: 'done', done, total });
        res.end();
      }
    }

    tick();
    return;
  }

  /* ── Quick check endpoint (instant, top platforms) ─────────────────── */
  if (pathname === '/api/quick-check') {
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

  /* ── Email investigation SSE endpoint ──────────────────────────────── */
  if (pathname === '/api/email-check') {
    const email = (urlObj.searchParams.get('q') || '').trim();
    if (!isValidEmail(email)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid email address.' }));
    }

    res.writeHead(200, {
      'Content-Type' : 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection'   : 'keep-alive',
    });

    let cancelled = false;
    req.on('close', () => { cancelled = true; });

    const send = (obj) => {
      if (!cancelled && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };

    (async () => {
      const pivots = buildEmailPivots(email);
      const tasks = [
        () => probeGravatar(email),
        () => analyzeEmailDomain(email),
        () => probeHibpPublicPage(email),
        () => probeDuckDuckGoEmail(email),
        () => probeBingEmail(email),
        () => probeGitHubEmail(email),
        ...pivots.map(item => () => item),
      ];

      await streamTaskResults(send, { email: normalizeEmail(email) }, tasks);
      res.end();
    })().catch(() => {
      if (!res.writableEnded) {
        send({ type: 'done', done: 0, total: 0 });
        res.end();
      }
    });
    return;
  }

  if (pathname === '/api/phone-check') {
    const phone = (urlObj.searchParams.get('q') || '').trim();
    if (!isValidPhone(phone)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid phone number. Use 7-15 digits with optional leading +.' }));
    }

    res.writeHead(200, {
      'Content-Type' : 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection'   : 'keep-alive',
    });

    let cancelled = false;
    req.on('close', () => { cancelled = true; });

    const send = (obj) => {
      if (!cancelled && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };

    (async () => {
      const normalized = normalizePhone(phone);
      const pivots = buildPhonePivots(normalized);
      const tasks = [
        () => analyzePhoneNumber(normalized),
        () => probeDuckDuckGoPhone(normalized),
        () => probeBingPhone(normalized),
        ...pivots.map(item => () => item),
      ];

      await streamTaskResults(send, { phone: normalized }, tasks);
      res.end();
    })().catch(() => {
      if (!res.writableEnded) {
        send({ type: 'done', done: 0, total: 0 });
        res.end();
      }
    });
    return;
  }

  if (pathname === '/api/domain-check') {
    const rawDomain = (urlObj.searchParams.get('q') || '').trim();
    if (!isValidDomain(rawDomain)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid domain. Use a hostname like example.com.' }));
    }

    const domain = normalizeDomain(rawDomain);

    res.writeHead(200, {
      'Content-Type' : 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection'   : 'keep-alive',
    });

    let cancelled = false;
    req.on('close', () => { cancelled = true; });

    const send = (obj) => {
      if (!cancelled && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };

    (async () => {
      const pivots = buildDomainPivots(domain);
      const tasks = [
        () => probeDomainDns(domain),
        () => probeDomainReachability(domain),
        () => probeDomainCrtSh(domain),
        ...pivots.map(item => () => item),
      ];

      await streamTaskResults(send, { domain }, tasks);
      res.end();
    })().catch(() => {
      if (!res.writableEnded) {
        send({ type: 'done', done: 0, total: 0 });
        res.end();
      }
    });
    return;
  }

  /* ── Serve sites.json for client ────────────────────────────────────── */
  if (pathname === '/sites.json') {
    return serveStatic(res, path.join(__dirname, 'sites.json'));
  }

  /* ── Serve name-sites.json for client ───────────────────────────────── */
  if (pathname === '/name-sites.json') {
    return serveStatic(res, path.join(__dirname, 'name-sites.json'));
  }

  /* ── Real-name SSE endpoint ─────────────────────────────────────────── */
  if (pathname === '/api/name-check') {
    const q = (urlObj.searchParams.get('q') || '').trim();
    const city = (urlObj.searchParams.get('city') || '').trim();
    const state = (urlObj.searchParams.get('state') || '').trim();
    const ageMinRaw = (urlObj.searchParams.get('ageMin') || '').trim();
    const ageMaxRaw = (urlObj.searchParams.get('ageMax') || '').trim();
    const ageMinNum = ageMinRaw === '' ? null : Number(ageMinRaw);
    const ageMaxNum = ageMaxRaw === '' ? null : Number(ageMaxRaw);
    const ageMin = Number.isFinite(ageMinNum) && ageMinNum >= 0 && ageMinNum <= 120 ? String(Math.floor(ageMinNum)) : '';
    const ageMax = Number.isFinite(ageMaxNum) && ageMaxNum >= 0 && ageMaxNum <= 120 ? String(Math.floor(ageMaxNum)) : '';
    const filters = {
      city: city.slice(0, 60),
      state: state.slice(0, 40),
      ageMin,
      ageMax,
    };
    if (!isValidName(q)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid name. Use letters, spaces, hyphens, apostrophes (2-80 chars).' }));
    }

    // Parse first / last names
    const parts     = q.split(/\s+/);
    const firstName = parts[0];
    const lastName  = parts.slice(1).join(' ') || '';

    res.writeHead(200, {
      'Content-Type' : 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection'   : 'keep-alive',
    });

    let cancelled = false;
    req.on('close', () => { cancelled = true; });

    const queue = [...NAME_SITES];
    const total = queue.length;
    let idx = 0, active = 0, done = 0;
    const NAME_CONCURRENCY = 2;

    const send = (obj) => {
      if (!cancelled && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      }
    };

    send({ type: 'start', total, name: q, firstName, lastName, filters });

    function normalizeNameResult(site, rawResult) {
      const resultCount = typeof rawResult.resultCount === 'number' ? rawResult.resultCount : null;
      const statusReason = rawResult.status === 'found'
        ? 'name_results_pattern_matched'
        : rawResult.status === 'not_found'
          ? 'name_no_results_message'
          : 'name_search_inconclusive';
      const reasonCodes = Array.isArray(rawResult.reasonCodes) && rawResult.reasonCodes.length
        ? rawResult.reasonCodes
        : [statusReason];
      const challengeDetected = reasonCodes.includes('cloudflare_or_challenge_detected');

      const summary = challengeDetected
        ? 'Source returned a challenge page, so automatic classification was limited.'
        : rawResult.status === 'found'
        ? `Potential people records detected${resultCount !== null ? ` (${resultCount})` : ''}.`
        : rawResult.status === 'not_found'
          ? 'No obvious people records detected.'
          : 'Result was inconclusive and may need manual verification.';
      const detail = challengeDetected
        ? `Source: ${site.name}. Challenge protection detected; open source manually to continue.`
        : `Source: ${site.name}`;

      return normalizeResult({
        ...rawResult,
        mode: 'name',
        summary,
        detail,
        reasonCodes,
        evidence: rawResult.evidence || {
          checkedAt: new Date().toISOString(),
          method: 'name_search',
          statusCode: rawResult.statusCode || 0,
          bodyHash: null,
          reasons: reasonCodes,
        },
      });
    }

    function tick() {
      while (active < NAME_CONCURRENCY && idx < total) {
        const site = queue[idx++];
        active++;
        probeNameSearch(site, firstName, lastName, filters)
          .then(raw => normalizeNameResult(site, raw))
          .catch(() => normalizeNameResult(site, {
            name: site.name,
            category: 'people-finder',
            url: buildNameUrl(site, firstName, lastName, filters),
            status: 'unknown',
            statusCode: 0,
          }))
          .then(result => {
            active--;
            done++;
            if (!cancelled) send({ type: 'result', ...result, done, total });
            tick();
          });
      }

      if (idx >= total && active === 0 && !res.writableEnded) {
        send({ type: 'done', done, total });
        res.end();
      }
    }

    tick();
    return;
  }

  /* ── Static files ───────────────────────────────────────────────────── */
  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = path.join(__dirname, 'index.html');
  } else {
    // Sanitize – prevent path traversal
    const normalized = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[\\/])+/, '');
    filePath = path.join(__dirname, normalized);
    if (!filePath.startsWith(__dirname + path.sep) && filePath !== __dirname) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
  }

  serveStatic(res, filePath);
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
  if (chromiumStealth && (ENABLE_UNDETECTABLE_STEALTH || ENABLE_USERNAME_BROWSER_FALLBACK)) {
    ensureBrowser().catch(() => {});
    console.log(`  Stealth browser: warming up (${STEALTH_CONCURRENCY} concurrent tabs)\n`);
  } else {
    console.log(`  Stealth browser: disabled for username scans\n`);
  }
});
