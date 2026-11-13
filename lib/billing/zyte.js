'use strict';

const dns = require('node:dns').promises;
const { isPrivateHost } = require('../net-guard');
const { classify, redirectRetainsProfileIdentity } = require('../classifier');
const { withProfile } = require('../probe-engine');
const { MAX_BODY } = require('../config');
const usernameRules = require('../../username-rules');
const { problem } = require('./store');
const MAX_RESPONSE = 2 * 1024 * 1024;
const DIAGNOSTIC_CODES = new Set([
  'paid_transport_guard', 'paid_integrity_guard', 'paid_dns_guard', 'paid_host_guard',
  'attempt_authorization_required', 'provider_response_too_large', 'provider_target_status_missing',
  'provider_target_headers_missing', 'provider_target_body_missing', 'provider_attempt_identity_mismatch',
]);

function failureCode(error) {
  if (DIAGNOSTIC_CODES.has(error.publicCode)) return error.publicCode;
  if (error instanceof SyntaxError) return 'provider_json_invalid';
  if (['AbortError', 'TimeoutError'].includes(error.name)) return 'provider_timeout';
  return 'provider_processing_failed';
}

function targetFor(site, username, rate) {
  if (!site || typeof username !== 'string' || !/^[A-Za-z0-9_.-]{1,50}$/.test(username) ||
      usernameRules.incompatibleReason(site, username)) throw problem('invalid_source_username', 400);
  if (!site || !site.url.includes('{}') || site.apiUrl || site.checkUrl || site.requestAdapter || site.credential) {
    throw problem('unsupported_paid_source', 400);
  }
  const url = new URL(site.url.replaceAll('{}', encodeURIComponent(username)));
  assertUrl(url, rate);
  return url.href;
}
function assertUrl(url, rate) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      isPrivateHost(url.hostname) || !rate.hosts.includes(url.hostname)) throw problem('paid_host_guard', 400);
}
async function assertPublic(url) {
  // The remote browser resolves separately. Fixed operator-approved catalog hosts,
  // no client URL/headers, plus local DNS vetting; redirect bodies remain untrusted.
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length) throw problem('paid_dns_guard', 400);
  for (const address of addresses) if (isPrivateHost(address.address)) throw problem('paid_dns_guard', 400);
}
async function responseBytes(response, limit) {
  const parts = [];
  let length = 0;
  for await (const part of response.body) {
    length += part.length;
    if (length > limit) throw problem('provider_response_too_large', 502);
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}
function classifyResponse(site, username, target, rate, data) {
  const fetched = new URL(data.url);
  assertUrl(fetched, rate);
  const status = data.statusCode;
  if (!Number.isInteger(status) || status < 100 || status > 599) throw problem('provider_target_status_missing', 502);
  if (fetched.href !== target && !redirectRetainsProfileIdentity(target, fetched.href, username)) {
    return { status: 'unknown', reasonCodes: ['redirect_profile_identity_lost'], source: site.name, url: target };
  }
  const headers = {};
  if (!Array.isArray(data.httpResponseHeaders)) throw problem('provider_target_headers_missing', 502);
  for (const header of data.httpResponseHeaders) {
    if (typeof header.name === 'string' && typeof header.value === 'string' &&
        ['content-type','location'].includes(header.name.toLowerCase())) headers[header.name.toLowerCase()] = header.value.slice(0, 2048);
  }
  let bytes;
  if (rate.mode === 'browser') {
    if (typeof data.browserHtml !== 'string') throw problem('provider_target_body_missing', 502);
    bytes = Buffer.from(data.browserHtml);
  } else {
    if (typeof data.httpResponseBody !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.httpResponseBody)) throw problem('provider_target_body_missing', 502);
    bytes = Buffer.from(data.httpResponseBody, 'base64');
  }
  const incomplete = bytes.length >= MAX_BODY;
  const body = bytes.subarray(0, MAX_BODY).toString('utf8');
  const result = classify(site, username, target, status, headers, body, rate.mode === 'browser' ? 'browser' : 'http', incomplete);
  return withProfile(result, site, username, body, headers['content-type'] || '', fetched.href);
}
async function execute(job, site, key, fetchImpl = fetch, publicCheck = assertPublic, authorizeAttempt) {
  const rate = job.rate;
  let called = false;
  let providerRef = null;
  let providerStatus = null;
  let targetStatus = null;
  let stage = 'pre_dispatch';
  try {
    if (!['http', 'browser'].includes(rate.mode) ||
        (rate.ipType !== undefined && !['datacenter', 'residential'].includes(rate.ipType))) {
      throw problem('paid_transport_guard', 400);
    }
    const target = targetFor(site, job.username, rate);
    if (target !== job.target_url || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.attempt_id || '')) {
      throw problem('paid_integrity_guard');
    }
    await publicCheck(new URL(target));
    const request = rate.mode === 'browser'
      ? { url: target, browserHtml: true, httpResponseHeaders: true, followRedirect: false,
        requestHeaders: { referer: 'https://usernameprobe.com/' } }
      : { url: target, httpResponseBody: true, httpResponseHeaders: true, followRedirect: false,
        customHttpRequestHeaders: [{ name: 'User-Agent', value: 'PROBE/1.0 (+https://usernameprobe.com/; username research)' }] };
    const attempt = job.attempt_id;
    if (rate.ipType !== undefined) request.ipType = rate.ipType;
    request.echoData = { probeAttempt: attempt };
    if (typeof authorizeAttempt !== 'function') throw problem('attempt_authorization_required', 403);
    const requestBody = JSON.stringify(request);
    await authorizeAttempt({
      domain: new URL(target).hostname,
      pricing: {
        mode: rate.mode,
        ipType: request.ipType || 'automatic',
        features: rate.mode === 'http'
          ? ['httpResponseBody', 'httpResponseHeaders', 'customHttpRequestHeaders']
          : ['browserHtml', 'httpResponseHeaders', 'requestHeaders'],
      },
      requestBytes: Buffer.byteLength(requestBody),
    });
    called = true;
    stage = 'transport';
    const response = await fetchImpl('https://api.zyte.com/v1/extract', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(65000),
      headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: requestBody,
    });
    providerRef = (response.headers.get('request-id') || response.headers.get('x-request-id'))?.slice(0, 256) || null;
    providerStatus = response.status;
    if (response.status !== 200) {
      await response.body?.cancel();
      return { state: 'provider_error', providerStatus: response.status, providerRef,
        diagnostic: { stage: 'provider', code: response.status === 451 ? 'provider_policy_restriction' : 'provider_http_failure' },
        result: { status: 'unknown', reasonCodes: ['provider_http_failure'], source: site.name } };
    }
    stage = 'decode';
    const data = JSON.parse((await responseBytes(response, MAX_RESPONSE)).toString('utf8'));
    if (data.echoData?.probeAttempt !== attempt) throw problem('provider_attempt_identity_mismatch', 502);
    if (Number.isInteger(data.statusCode) && data.statusCode >= 100 && data.statusCode <= 599) targetStatus = data.statusCode;
    stage = 'classify';
    const result = classifyResponse(site, job.username, target, rate, data);
    return { state: 'response', providerStatus: 200, targetStatus: data.statusCode,
      providerRef: providerRef?.slice(0, 256) || null, result };
  } catch (error) {
    const code = failureCode(error);
    console.error(`[billing:zyte] ${stage}: ${code}; details withheld, no automatic retry.`);
    return { state: called ? 'uncertain' : 'probe_error',
      providerRef, providerStatus, targetStatus, diagnostic: { stage, code },
      result: { status: 'unknown', source: site?.name || job.source,
        reasonCodes: [called ? 'provider_outcome_uncertain' : 'paid_integrity_guard', code] } };
  }
}
module.exports = { execute, targetFor, classifyResponse, assertPublic, responseBytes, MAX_RESPONSE };
