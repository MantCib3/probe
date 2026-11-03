'use strict';

const crypto = require('crypto');
const { URL } = require('url');
const sourceRequestAdapter = require('../source-request-adapter');

// These signals mean the observed response is materially ambiguous, not merely
// incomplete; browser rendering or archive history must not turn them into found.
const INTEGRITY_ABSTENTION_REASONS = new Set([
  'redirect_location_missing',
  'redirect_location_invalid',
  'redirect_hop_limit',
  'redirect_requires_follow',
  'redirect_profile_identity_lost',
  'redirect_auth_login',
  'redirect_bot_challenge',
  'cloudflare_or_challenge_detected',
  'title_blocked_pattern',
  'body_blocked_pattern',
  'body_authentication_required',
  'body_rate_limited',
  'site_marker_conflict',
  'site_positive_message_missing',
  'site_positive_message_missing_incomplete_body',
  'adapter_predicate_conflict',
  'adapter_json_inconclusive',
  'adapter_json_invalid',
  'adapter_head_status_unexpected',
]);

function hasIntegrityAbstention(result) {
  return Array.isArray(result && result.reasonCodes) &&
    result.reasonCodes.some(reason => INTEGRITY_ABSTENTION_REASONS.has(reason));
}

// Known authentication/login redirect path fragments; redirects are ambiguous by default.
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
  'one more step', 'please wait', 'security check', 'sina visitor system',
  "making sure you're not a bot", 'making sure you&#39;re not a bot',
];

// Body patterns that indicate JS-challenge / bot-protection pages (no title available)
const BLOCKED_BODY_PATTERNS = [
  'please enable js and disable any ad blocker',
  'please enable javascript and cookies to continue',
  'this process is automatic',
  'checking if the site connection is secure',
  'cf-challenge-running',
  'cf-chl-',
];

const AUTH_BODY_PATTERNS = [
  'authorization required',
  'authentication required',
  'sign in to continue',
  'log in to continue',
  'please sign in to view this profile',
  'you must be logged in to view this page',
];

const RATE_LIMIT_BODY_PATTERNS = [
  'rate limit exceeded',
  'too many requests',
  'you are being rate limited',
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

function classify(site, username, url, sc, headers, body, detectionMethod = 'http', bodyIncomplete = false, expectedStatus = 0) {
  const base = {
    name: site.name,
    category: site.category,
    url,
    statusCode: sc,
    detectionMethod,
    bodyHash: hashBodySample(body),
  };

  if (site.notFoundStatus !== undefined && sc === site.notFoundStatus) {
    return makeClassifiedResult(base, 'not_found', ['site_specific_not_found_status'], 0.94);
  }

  if (sc >= 301 && sc <= 308) {
    const rawLocation = headers && headers.location;
    const redirect = sourceRequestAdapter.inspectRedirectLocation(rawLocation, url);
    if (!redirect.valid) return makeClassifiedResult(base, 'unknown', [redirect.reason], 0.3);
    const loc = redirect.url.toLowerCase();
    if (loc.includes('.within.website') || /\/cdn-cgi\/challenge(?:[/?#]|$)/.test(loc) ||
        loc.includes('/_/challenge') || loc.includes('verify-browser') || loc.includes('bot-check')) {
      return makeClassifiedResult(base, 'blocked', ['redirect_bot_challenge'], 0.9);
    }
    if (AUTH_REDIRECT_PATTERNS.some(p => loc.includes(p))) {
      const authStatus = site.authRedirectMeansFound === true ? 'found'
        : site.authRedirectMeansNotFound === true ? 'not_found' : 'unknown';
      const reason = authStatus === 'found' ? 'site_auth_redirect_found'
        : authStatus === 'not_found' ? 'site_auth_redirect_not_found' : 'redirect_auth_login';
      return makeClassifiedResult(base, authStatus, [reason], authStatus === 'unknown' ? 0.3 : 0.92);
    }
    return makeClassifiedResult(base, 'unknown', ['redirect_requires_follow'], 0.3);
  }

  if (sc === 404 || sc === 410) {
    return makeClassifiedResult(base, 'not_found', [sc === 404 ? 'http_404' : 'http_410'], 0.98);
  }

  if (sc === 403 || sc === 401 || sc === 429 || sc === 999) {
    return makeClassifiedResult(base, 'blocked', [`blocked_http_${sc}`], 0.9);
  }

  if (headers && headers['x-amzn-waf-action']) {
    return makeClassifiedResult(base, 'blocked', ['blocked_aws_waf_challenge'], 0.9);
  }

  if (sc === 202 && (body.includes('token.awswaf.com') || body.includes('aws-waf') || body.includes('challenge.js'))) {
    return makeClassifiedResult(base, 'blocked', ['blocked_aws_waf_challenge'], 0.9);
  }

  if (site.requestAdapter && site.requestAdapter.method === 'HEAD') {
    const expected = site.requestAdapter.response.expectedStatus;
    if (sc === expected) return makeClassifiedResult(base, 'found', ['adapter_head_expected_status'], 0.9);
    return makeClassifiedResult(base, 'unknown', ['adapter_head_status_unexpected'], 0.3);
  }

  if (expectedStatus && sc === expectedStatus) {
    const lowerBody = body.toLowerCase();
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&').toLowerCase().trim() : '';
    if (BLOCKED_TITLE_PATTERNS.some(pattern => title.includes(pattern))) {
      return makeClassifiedResult(base, 'blocked', ['title_blocked_pattern'], 0.9);
    }
    if (BLOCKED_BODY_PATTERNS.some(pattern => lowerBody.includes(pattern))) {
      return makeClassifiedResult(base, 'blocked', ['body_blocked_pattern'], 0.9);
    }
    if (AUTH_BODY_PATTERNS.some(pattern => lowerBody.includes(pattern))) {
      return makeClassifiedResult(base, 'unknown', ['body_authentication_required'], 0.3);
    }
    if (RATE_LIMIT_BODY_PATTERNS.some(pattern => lowerBody.includes(pattern))) {
      return makeClassifiedResult(base, 'blocked', ['body_rate_limited'], 0.9);
    }
    const positive = site.positiveMsg ? body.includes(site.positiveMsg) : false;
    const negative = site.errorMsg ? body.includes(site.errorMsg) : false;
    if (positive && negative) return makeClassifiedResult(base, 'unknown', ['site_marker_conflict'], 0.3);
    if (negative) return makeClassifiedResult(base, 'not_found', ['site_error_message'], 0.92);
    if (site.positiveMsg && !positive) {
      return makeClassifiedResult(base, 'unknown',
        [bodyIncomplete ? 'site_positive_message_missing_incomplete_body' : 'site_positive_message_missing'], 0.3);
    }
    return makeClassifiedResult(base, 'found', ['site_expected_status'], 0.9);
  }

  if (sc === 200) {
    const lbody = body.toLowerCase();
    const tm = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = tm ? tm[1].replace(/&#039;/g, "'").replace(/&amp;/g, '&').toLowerCase().trim() : '';

    if (BLOCKED_TITLE_PATTERNS.some(p => title.includes(p))) {
      return makeClassifiedResult(base, 'blocked', ['title_blocked_pattern'], 0.9);
    }

    if (BLOCKED_BODY_PATTERNS.some(p => lbody.includes(p))) {
      return makeClassifiedResult(base, 'blocked', ['body_blocked_pattern'], 0.9);
    }

    if (AUTH_BODY_PATTERNS.some(p => lbody.includes(p))) {
      return makeClassifiedResult(base, 'unknown', ['body_authentication_required'], 0.3);
    }

    if (RATE_LIMIT_BODY_PATTERNS.some(p => lbody.includes(p))) {
      return makeClassifiedResult(base, 'blocked', ['body_rate_limited'], 0.9);
    }

    const jsonVerdict = sourceRequestAdapter.classifyJsonResponse(site.requestAdapter, body);
    if (jsonVerdict) {
      const confidence = jsonVerdict.status === 'found' ? 0.9
        : jsonVerdict.status === 'not_found' ? 0.92 : 0.3;
      return makeClassifiedResult(base, jsonVerdict.status, [jsonVerdict.reason], confidence);
    }

    if (site.requestAdapter && site.requestAdapter.method === 'HEAD') {
      return makeClassifiedResult(base, 'unknown', ['adapter_head_without_body_evidence'], 0.3);
    }

    if (site.positiveMsg) {
      const found = body.includes(site.positiveMsg);
      const negative = site.errorMsg ? body.includes(site.errorMsg) : false;
      if (found && negative) {
        return makeClassifiedResult(base, 'unknown', ['site_marker_conflict'], 0.3);
      }
      if (found) return makeClassifiedResult(base, 'found', ['site_positive_message'], 0.9);
      if (negative) return makeClassifiedResult(base, 'not_found', ['site_error_message'], 0.92);
      if (bodyIncomplete) {
        return makeClassifiedResult(base, 'unknown', ['site_positive_message_missing_incomplete_body'], 0.3);
      }
      const missingStatus = site.positiveMissingStatus === 'unknown' ? 'unknown' : 'not_found';
      return makeClassifiedResult(base, missingStatus,
        [missingStatus === 'unknown' ? 'site_positive_message_missing' : 'site_positive_message'],
        missingStatus === 'unknown' ? 0.3 : 0.9);
    }

    if (site.errorMsg && body.includes(site.errorMsg)) {
      return makeClassifiedResult(base, 'not_found', ['site_error_message'], 0.92);
    }

    if (NOT_FOUND_TITLE_PATTERNS.some(p => title.includes(p))) {
      return makeClassifiedResult(base, 'not_found', ['title_not_found_pattern'], 0.9);
    }

    if (DELETED_BODY_PATTERNS.some(p => lbody.includes(p))) {
      return makeClassifiedResult(base, 'deleted', ['body_deleted_pattern'], 0.86);
    }

    if (NOT_FOUND_BODY_PATTERNS.some(p => lbody.includes(p))) {
      return makeClassifiedResult(base, 'not_found', ['body_not_found_pattern'], 0.87);
    }

    if (site.abstainOn200) {
      return makeClassifiedResult(base, 'unknown', ['site_200_abstention'], 0.3);
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

function classifyVerifyResponse({
  url,
  checkMethod,
  positiveMsg,
  errorMsg,
  notFoundStatus,
  expectedStatus,
  status,
  body,
  redirects = [],
  redirectError = null,
  redirectHopLimitReached = false,
  complete = true,
}) {
  const site = {
    name: 'Verification target',
    category: 'verify',
    positiveMsg,
    errorMsg,
    positiveMissingStatus: 'unknown',
    ...(notFoundStatus ? { notFoundStatus } : {}),
  };
  const unknown = reason => ({ status: 'unknown', reasonCodes: [reason] });

  if (notFoundStatus && (status === notFoundStatus ||
      redirects.some(redirect => redirect.status === notFoundStatus))) {
    return { status: 'not_found', reasonCodes: ['site_specific_not_found_status'] };
  }
  if (redirectError) return unknown(redirectError);

  for (const redirect of redirects) {
    const inspected = sourceRequestAdapter.inspectRedirectLocation(redirect.location, redirect.fromUrl || url);
    if (!inspected.valid) return unknown(inspected.reason);
    const verdict = classify(site, '', url, redirect.status, { location: redirect.location }, '', 'http');
    if (verdict.status === 'not_found' || verdict.status === 'blocked' ||
        (verdict.status === 'unknown' &&
         (verdict.reasonCodes[0] !== 'redirect_requires_follow' || status === redirect.status))) {
      return { status: verdict.status, reasonCodes: verdict.reasonCodes };
    }
  }
  if (redirectHopLimitReached) return unknown('redirect_hop_limit');

  if (expectedStatus > 0 && status !== expectedStatus) {
    if (status === 404 || status === 410 || status === 401 || status === 403 || status === 429 ||
        (notFoundStatus && status === notFoundStatus)) {
      const verdict = classify(site, '', url, status, {}, body, 'http', !complete);
      return { status: verdict.status, reasonCodes: verdict.reasonCodes };
    }
    return unknown('site_expected_status_missing');
  }

  const statusEvidence = expectedStatus || (checkMethod === 'status_code' ? 200 : 0);
  const verdict = classify(site, '', url, status, {}, body, 'http', !complete, statusEvidence);
  if (verdict.status === 'found' && redirects.length) {
    const last = redirects[redirects.length - 1];
    const destination = sourceRequestAdapter.inspectRedirectLocation(last.location, last.fromUrl || url);
    if (!redirectRetainsProfileIdentity(url, destination.url)) return unknown('redirect_profile_identity_lost');
  }
  return { status: verdict.status, reasonCodes: verdict.reasonCodes };
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

function redirectRetainsProfileIdentity(originalUrl, finalUrl, username = '') {
  const original = new URL(originalUrl);
  const final = new URL(finalUrl);
  const host = url => url.hostname.toLowerCase().replace(/^www\./, '');
  if (host(original) !== host(final)) return false;
  const pathname = url => url.pathname.replace(/\/+$/, '');
  if (pathname(original) === pathname(final) && original.search === final.search) return true;
  if (!username) return false;
  const target = username.toLowerCase();
  // Hostname-label sources (alice.example.com): staying on that exact host
  // keeps identity even when the path changes (e.g. to a featured page).
  if (host(final).split('.')[0] === target && host(final).split('.').length > 2) return true;
  const segments = final.pathname.split('/').map(segment => {
    try { return decodeURIComponent(segment).replace(/^[@~]/, '').toLowerCase(); }
    catch (_) { return ''; }
  });
  return segments.includes(target) ||
    [...final.searchParams.values()].some(value => value.toLowerCase() === target);
}

module.exports = { hasIntegrityAbstention, AUTH_REDIRECT_PATTERNS, hashBodySample,
  makeClassifiedResult, normalizeResult, classify, classifyVerifyResponse,
  redirectRetainsProfileIdentity };
