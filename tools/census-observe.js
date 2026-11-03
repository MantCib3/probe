'use strict';

// Staging/lab only: one bounded request, reduced to structured signals for the
// blocker census. Never returns the response body. Identical on both networks.

const crypto = require('node:crypto');
const { HONEST_USER_AGENT } = require('../source-request-adapter');

const BROWSERLIKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_BYTES = 512 * 1024;
const COOKIE_SIGNALS = {
  __cf_bm: 'cloudflare', cf_clearance: 'cloudflare', datadome: 'datadome', _px: 'perimeterx', _pxhd: 'perimeterx',
  _pxvid: 'perimeterx', ak_bmsc: 'akamai', _abck: 'akamai', bm_sz: 'akamai', incap_ses: 'imperva', visid_incap: 'imperva',
  'aws-waf-token': 'aws_waf', kpsdk: 'kasada',
};

function registrableDomain(hostname) {
  const labels = String(hostname).toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const second = labels[labels.length - 2];
  const shortTld = labels[labels.length - 1].length === 2;
  return labels.slice(shortTld && ['co', 'com', 'org', 'net', 'ac', 'gov', 'ne', 'or'].includes(second) ? -3 : -2).join('.');
}

function classifyLocation(location, requestUrl, username) {
  if (!location) return null;
  let target;
  try { target = new URL(location, requestUrl); } catch (_) { return 'invalid'; }
  const from = new URL(requestUrl);
  const where = `${target.pathname}${target.search}`.toLowerCase();
  if (/within\.website|anubis/.test(where)) return 'challenge';
  if (/captcha|challenge|cdn-cgi|px-captcha|blocked|denied|verify/.test(where)) return 'challenge';
  if (/log-?in|sign-?in|signin|auth|sso|account\/?\?|register|sign-?up|join/.test(where)) return 'login';
  if (/not-?found|404|deleted|inactiv|suspend|banned|error/.test(where)) return 'not_found_page';
  if (registrableDomain(target.hostname) !== registrableDomain(from.hostname)) return 'offsite';
  if (target.pathname === '/' || target.pathname === '') return 'home';
  if (username && decodeURIComponent(where).includes(username.toLowerCase())) return 'same_identity';
  if (target.hostname !== from.hostname && target.pathname === from.pathname) return 'host_change';
  return 'other';
}

function detectVendor(status, headers, text, cookieNames) {
  const h = name => (headers.get(name) || '').toLowerCase();
  const signals = new Set(cookieNames.map(name => COOKIE_SIGNALS[name] || (name.startsWith('_px') ? 'perimeterx' : null)).filter(Boolean));
  if (h('cf-mitigated') === 'challenge' || /just a moment\.\.\.|cf-chl-|challenge-platform\/h\/[bg]\/orchestrate/i.test(text)) return 'cloudflare_challenge';
  if (/attention required! \| cloudflare|sorry, you have been blocked|error code:? 1020/i.test(text)) return 'cloudflare_block';
  if (headers.get('x-datadome') || headers.get('x-dd-b') || /captcha-delivery\.com|geo\.captcha-delivery/i.test(text)) return 'datadome';
  if (/px-captcha|perimeterx|human touch|_pxCaptcha/i.test(text) || (status === 403 && signals.has('perimeterx'))) return 'perimeterx';
  if (headers.get('x-amzn-waf-action') || /awswaf|aws-waf-token|challenge\.js.*token/i.test(text) || (status === 202 && /gokuProps/i.test(text))) return 'aws_waf';
  if (headers.get('x-kpsdk-ct') || headers.get('x-kpsdk-cd') || /kpsdk/i.test(text)) return 'kasada';
  if (headers.get('x-iinfo') || /_Incapsula_Resource|incapsula incident/i.test(text)) return 'imperva';
  if (/akamaighost/.test(h('server')) && status === 403) return 'akamai';
  if (/access denied[\s\S]{0,400}reference #/i.test(text)) return 'akamai';
  if (h('x-vercel-mitigated') === 'challenge' || /vercel security checkpoint/i.test(text)) return 'vercel_challenge';
  if (/anubis|making sure you('|&#39;)re not a bot|oh noes!/i.test(text)) return 'anubis';
  if (/ddos-guard/i.test(h('server')) || /ddos-guard/i.test(text)) return 'ddos_guard';
  if (status === 999) return 'linkedin_999';
  if (status === 429) return 'rate_limited';
  if (/<title>[^<]*(captcha|prove your humanity|are you a robot|verify you are human|security measure|bot protection|client challenge|checking your browser|one moment, please|robot check|request blocked|access denied)/i.test(text)) return 'generic_challenge';
  if (status === 403 && /cloudflare/.test(h('server'))) return 'cloudflare_403';
  if (status === 403) return 'origin_403';
  return null;
}

function pick(text, regex) {
  const match = text.match(regex);
  return match ? match[1].replace(/\s+/g, ' ').trim().slice(0, 140) : null;
}

function jsonSignals(text, username) {
  let value;
  try { value = JSON.parse(text); } catch (_) { return null; }
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 20) : [];
  const lower = username.toLowerCase();
  let usernameValue = false;
  let leaves = 0;
  const walk = (node, depth) => {
    if (usernameValue || depth > 6 || leaves > 5000) return;
    if (typeof node === 'string') { leaves++; if (node.toLowerCase() === lower) usernameValue = true; return; }
    if (node && typeof node === 'object') for (const child of Object.values(node)) walk(child, depth + 1);
  };
  walk(value, 0);
  const shape = Array.isArray(value) ? `array:${value.length}` : value === null ? 'null' : typeof value;
  const emptyish = value === null || (Array.isArray(value) && !value.length) || (keys.length > 0 && keys.every(key => {
    const child = value[key];
    return child === null || child === false || (Array.isArray(child) && !child.length);
  }));
  return { shape, keys, usernameValue, emptyish };
}

async function observe({ url, method = 'GET', body = null, contentType = null, username, variant = 'honest', timeoutMs = 15000, fetchImpl = fetch }) {
  const started = Date.now();
  const headers = {
    'User-Agent': variant === 'browserlike' ? BROWSERLIKE_USER_AGENT : HONEST_USER_AGENT,
    Accept: 'text/html,application/json,application/rss+xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.8',
  };
  if (contentType) headers['Content-Type'] = contentType;
  try {
    const response = await fetchImpl(url, { method, headers, body: body || undefined, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    let text = '';
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        text += decoder.decode(value, { stream: true });
        if (size >= MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
      }
    }
    const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const cookieNames = [...new Set(setCookie.map(value => value.split('=', 1)[0].trim()).filter(Boolean))].slice(0, 20);
    const lower = text.toLowerCase();
    const name = String(username || '').toLowerCase();
    const location = response.headers.get('location');
    const title = pick(text, /<title[^>]*>([\s\S]*?)<\/title>/i);
    const canonical = pick(text, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i) || pick(text, /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
    const ogTitle = pick(text, /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)/i);
    const ogUrl = pick(text, /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']*)/i);
    const jsonLdTypes = [...text.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
      .flatMap(match => [...match[1].matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map(type => type[1])).slice(0, 8);
    const contentTypeHeader = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const has = value => Boolean(value && name && value.toLowerCase().includes(name));
    return {
      status: response.status,
      ms: Date.now() - started,
      contentType: contentTypeHeader || null,
      server: (response.headers.get('server') || '').slice(0, 40) || null,
      location: location ? location.slice(0, 200) : null,
      locationClass: classifyLocation(location, url, name),
      retryAfter: response.headers.get('retry-after'),
      cookieNames,
      vendor: detectVendor(response.status, response.headers, text.slice(0, 100000), cookieNames),
      bytes: Buffer.byteLength(text),
      bodyHash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
      title, canonical, ogTitle, ogUrl, jsonLdTypes,
      usernameMentions: name ? lower.split(name).length - 1 : 0,
      usernameInTitle: has(title), usernameInCanonical: has(canonical) || has(ogUrl), usernameInOgTitle: has(ogTitle),
      notFoundText: /(page|user|profile|account)[^<]{0,40}(not found|doesn['’]t exist|does not exist|no longer available)|404/i.test(title || '') ||
        /user (not found|does not exist)|profile (not found|unavailable)|this page (isn['’]t|is not) available/i.test(text.slice(0, 200000)),
      loginText: /<title>[^<]*(log ?in|sign ?in|sign ?up|вход|войти|ログイン|登录|anmelden|connexion)/i.test(text) ||
        /<h[12][^>]*>[^<]*(log ?in to|sign ?in to|вход через|войдите|ログイン|登录)/i.test(text.slice(0, 100000)),
      json: contentTypeHeader.includes('json') || /^\s*[[{]/.test(text.slice(0, 50)) ? jsonSignals(text, name) : null,
    };
  } catch (error) {
    return { status: 0, ms: Date.now() - started, error: error.name === 'TimeoutError' ? 'timeout' : String(error.cause?.code || error.message).slice(0, 80) };
  }
}

module.exports = { BROWSERLIKE_USER_AGENT, classifyLocation, detectVendor, observe, registrableDomain };
