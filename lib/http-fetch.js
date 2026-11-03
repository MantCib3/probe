'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const sourceRequestAdapter = require('../source-request-adapter');
const { TIMEOUT_MS, MAX_BODY } = require('./config');
const { publicLookup } = require('./net-guard');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchText(url, timeoutMs = 20000, maxRedirects = 5, headers = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      fn(arg);
    };
    // Hard backstop in case socket-idle timeout doesn't fire (e.g. a slow
    // trickle of bytes keeps the connection "active" indefinitely).
    const hardDeadline = setTimeout(() => {
      req.destroy(new Error('request timeout'));
      finish(reject, new Error('request timeout'));
    }, timeoutMs + 3000);

    // Default UA mimics a desktop Chrome browser for sites that need one.
    // Pass headers = {} explicitly to send NO custom headers at all — some
    // bot-protection (e.g. Cloudflare in front of r.jina.ai) challenges a
    // spoofed-Chrome UA that's missing the rest of a real browser's header
    // fingerprint (sec-ch-ua, Accept-Language, etc.) more aggressively than
    // it challenges a plain/no UA request.
    const reqHeaders = headers || { 'User-Agent': sourceRequestAdapter.HONEST_USER_AGENT };

    const req = transport.get(parsed, { headers: reqHeaders }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) {
          finish(reject, new Error('too many redirects'));
          return;
        }
        finish(resolve, fetchText(new URL(res.headers.location, parsed).toString(), timeoutMs, maxRedirects - 1, headers));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => finish(resolve, body));
      res.on('error', err => finish(reject, err));
    });
    req.on('error', err => finish(reject, err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timeout'));
    });
  });
}

// Like fetchText() but also exposes the final HTTP status code — used by
// /api/verify to classify found/not_found/blocked server-side (Node's http/
// https client is not subject to browser CORS, so this works for any site
// regardless of whether it sends Access-Control-Allow-Origin headers).
// NOTE: named fetchStatusV (not fetchStatus) to avoid colliding with the
// pre-existing single-arg fetchStatus(targetUrl) used by the legacy probe*
// functions further down this file — function declarations hoist and the
// later one wins, which silently broke /api/verify during initial testing.
function fetchStatusV(url, timeoutMs = 10000, maxRedirects = 4, redirects = [], initialRedirectLimit = maxRedirects) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      fn(arg);
    };
    const hardDeadline = setTimeout(() => {
      req.destroy(new Error('request timeout'));
      finish(reject, new Error('request timeout'));
    }, timeoutMs + 3000);

    const req = transport.get(parsed, {
      headers: { 'User-Agent': sourceRequestAdapter.HONEST_USER_AGENT },
      lookup: publicLookup,
    }, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308) {
        const redirect = {
          status: res.statusCode,
          location: res.headers.location,
          fromUrl: parsed.href,
        };
        const nextRedirects = [...redirects, redirect];
        const inspected = sourceRequestAdapter.inspectRedirectLocation(redirect.location, parsed.href);
        if (!inspected.valid || maxRedirects === 0) {
          res.resume();
          finish(resolve, {
            status: res.statusCode,
            body: '',
            redirects: nextRedirects,
            redirectError: inspected.valid ? null : inspected.reason,
            redirectHopLimitReached: inspected.valid && initialRedirectLimit > 0,
            complete: true,
          });
          return;
        }
        res.resume(); // discard body, follow redirect
        finish(resolve, fetchStatusV(
          inspected.url,
          timeoutMs,
          maxRedirects - 1,
          nextRedirects,
          initialRedirectLimit
        ));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      let truncated = false;
      res.on('data', chunk => {
        if (body.length + chunk.length <= 200000) body += chunk;
        else {
          body += chunk.slice(0, 200000 - body.length);
          truncated = true;
          res.destroy();
        }
      });
      res.on('end', () => finish(resolve, {
        status: res.statusCode,
        body,
        redirects,
        redirectError: null,
        redirectHopLimitReached: false,
        complete: res.complete && !truncated,
      }));
      res.on('close', () => {
        if (!settled && (truncated || !res.complete)) finish(resolve, {
          status: res.statusCode || 0,
          body,
          redirects,
          redirectError: null,
          redirectHopLimitReached: false,
          complete: false,
        });
      });
      res.on('error', err => finish(reject, err));
    });
    req.on('error', err => finish(reject, err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timeout'));
    });
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
        'User-Agent': sourceRequestAdapter.HONEST_USER_AGENT,
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

module.exports = { delay, fetchText, fetchStatusV, fetchStatus };
