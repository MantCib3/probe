'use strict';

const { isDeepStrictEqual } = require('node:util');

const METHODS = new Set(['GET', 'HEAD', 'POST']);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const SECRET_HEADER = /(?:authorization|cookie|credential|password|secret|token|api[-_]?key)/i;
const SECRET_VALUE = /\bBearer\s+\S+|\b(?:access[_-]?token|api[_-]?key|client[_-]?secret|secret|token|password|authorization|cookie|credential)\s*["']?\s*[:=]\s*["']?[^"'\s,}]+/i;
const SECRET_BODY = /\b(?:access[_-]?token|api[_-]?key|client[_-]?secret|secret|token|password|authorization|cookie|credential)\s*["']?\s*[:=]\s*["']?[^"'\s,}]+/i;
const USERNAME_PLACEHOLDER = '{{username}}';
const MAX_HEADER_VALUE_LENGTH = 1024;
const MAX_BODY_TEMPLATE_LENGTH = 8192;
const MAX_PREDICATE_VALUE_LENGTH = 4096;
const MAX_JSON_DEPTH = 10;

function fail(site, message) {
  throw new TypeError(`Invalid backend source configuration for "${site.name}": ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertKeys(value, allowed, site, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(site, `${label} contains unsupported key "${key}"`);
  }
}

function validateJsonValue(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => validateJsonValue(item, depth + 1));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([key, item]) =>
    !['__proto__', 'prototype', 'constructor'].includes(key) && validateJsonValue(item, depth + 1));
}

function validatePredicate(predicate, site, label) {
  if (!isPlainObject(predicate)) fail(site, `${label} must be an object`);
  assertKeys(predicate, new Set(['path', 'op', 'value']), site, label);
  if (typeof predicate.path !== 'string' || !predicate.path.startsWith('/')) {
    fail(site, `${label}.path must be a non-root JSON Pointer`);
  }
  const parts = predicate.path.slice(1).split('/');
  if (parts.some(part => /~(?![01])/.test(part) ||
      ['__proto__', 'prototype', 'constructor'].includes(part.replace(/~1/g, '/').replace(/~0/g, '~')))) {
    fail(site, `${label}.path contains an invalid or unsafe segment`);
  }
  if (!['exists', 'equals', 'truthy', 'falsey'].includes(predicate.op)) {
    fail(site, `${label}.op must be exists, equals, truthy, or falsey`);
  }
  if (predicate.op === 'equals') {
    if (!Object.hasOwn(predicate, 'value') || !validateJsonValue(predicate.value)) {
      fail(site, `${label}.value must be a JSON value`);
    }
    if (Buffer.byteLength(JSON.stringify(predicate.value), 'utf8') > MAX_PREDICATE_VALUE_LENGTH) {
      fail(site, `${label}.value exceeds ${MAX_PREDICATE_VALUE_LENGTH} bytes`);
    }
  } else if (Object.hasOwn(predicate, 'value')) {
    fail(site, `${label}.value is only valid with the equals operator`);
  }
}

function validateAdapter(site) {
  const adapter = site.requestAdapter;
  if (!isPlainObject(adapter)) fail(site, 'requestAdapter must be an object');
  assertKeys(adapter, new Set(['method', 'headers', 'bodyTemplate', 'response']), site, 'requestAdapter');

  if (typeof adapter.method !== 'string' || !METHODS.has(adapter.method)) {
    fail(site, 'requestAdapter.method must be GET, HEAD, or POST');
  }

  if (adapter.headers !== undefined) {
    if (!isPlainObject(adapter.headers)) fail(site, 'requestAdapter.headers must be an object');
    for (const [name, value] of Object.entries(adapter.headers)) {
      const lowerName = name.toLowerCase();
      if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/i.test(name) ||
          HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === 'host' ||
          lowerName === 'content-length' || SECRET_HEADER.test(name)) {
        fail(site, `requestAdapter.headers contains forbidden header "${name}"`);
      }
      if (typeof value !== 'string' || value.length > MAX_HEADER_VALUE_LENGTH ||
          /[\r\n\0]/.test(value) || SECRET_VALUE.test(value) || value.includes(USERNAME_PLACEHOLDER)) {
        fail(site, `requestAdapter.headers["${name}"] must be a safe, static string`);
      }
    }
  }

  if (adapter.method === 'POST') {
    if (typeof adapter.bodyTemplate !== 'string' ||
        adapter.bodyTemplate.length > MAX_BODY_TEMPLATE_LENGTH ||
        !adapter.bodyTemplate.includes(USERNAME_PLACEHOLDER) ||
        SECRET_BODY.test(adapter.bodyTemplate)) {
      fail(site, `POST bodyTemplate must be a safe string containing ${USERNAME_PLACEHOLDER}`);
    }
  } else if (adapter.bodyTemplate !== undefined) {
    fail(site, 'bodyTemplate is only valid for POST requests');
  }

  if (adapter.response !== undefined) {
    if (!isPlainObject(adapter.response)) fail(site, 'requestAdapter.response must be an object');
    assertKeys(adapter.response, new Set(['json', 'expectedStatus']), site, 'requestAdapter.response');
    if (adapter.response.json !== undefined) {
      if (adapter.method === 'HEAD') fail(site, 'HEAD requests cannot use JSON response predicates');
      const json = adapter.response.json;
      if (!isPlainObject(json)) fail(site, 'requestAdapter.response.json must be an object');
      assertKeys(json, new Set(['positive', 'negative']), site, 'requestAdapter.response.json');
      if (json.positive === undefined && json.negative === undefined) {
        fail(site, 'JSON response configuration needs a positive or negative predicate');
      }
      if (json.positive !== undefined) validatePredicate(json.positive, site, 'positive predicate');
      if (json.negative !== undefined) validatePredicate(json.negative, site, 'negative predicate');
    }
    if (adapter.response.expectedStatus !== undefined) {
      if (adapter.method !== 'HEAD' || !Number.isInteger(adapter.response.expectedStatus) ||
          adapter.response.expectedStatus < 100 || adapter.response.expectedStatus > 599) {
        fail(site, 'response.expectedStatus must be an HTTP status from 100 to 599 and is only valid for HEAD');
      }
    }
  }
  if (adapter.method === 'HEAD' && (!adapter.response || adapter.response.expectedStatus === undefined)) {
    fail(site, 'HEAD requires response.expectedStatus to define positive status evidence');
  }
}

function validateCatalog(sites) {
  if (!Array.isArray(sites)) throw new TypeError('Backend source catalog must be an array');
  for (const site of sites) {
    if (!isPlainObject(site) || typeof site.name !== 'string') {
      throw new TypeError('Backend source entries must be objects with a name');
    }
    for (const field of ['authRedirectMeansFound', 'authRedirectMeansNotFound']) {
      if (site[field] !== undefined && typeof site[field] !== 'boolean') {
        fail(site, `${field} must be a boolean when configured`);
      }
    }
    if (site.authRedirectMeansFound === true && site.authRedirectMeansNotFound === true) {
      fail(site, 'auth redirect cannot mean both found and not found');
    }
    if (site.requestAdapter !== undefined) validateAdapter(site);
  }
}

function buildRequest(site, username) {
  const adapter = site.requestAdapter;
  if (!adapter) return { method: 'GET', headers: {}, body: null };
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{1,50}$/.test(username)) {
    throw new TypeError('Username is not safe for source request templates');
  }
  const headers = {};
  for (const [name, value] of Object.entries(adapter.headers || {})) headers[name.toLowerCase()] = value;
  const body = adapter.method === 'POST'
    ? adapter.bodyTemplate.split(USERNAME_PLACEHOLDER).join(username)
    : null;
  return { method: adapter.method, headers, body };
}

function inspectRedirectLocation(rawLocation, baseUrl) {
  if (typeof rawLocation !== 'string' || !rawLocation.trim()) {
    return { valid: false, reason: 'redirect_location_missing', url: null };
  }
  if (rawLocation.length > 8192 || rawLocation !== rawLocation.trim() ||
      /[\u0000-\u0020\\]/.test(rawLocation) || /%(?![0-9a-f]{2})/i.test(rawLocation)) {
    return { valid: false, reason: 'redirect_location_invalid', url: null };
  }
  try {
    const destination = new URL(rawLocation, baseUrl);
    if ((destination.protocol !== 'http:' && destination.protocol !== 'https:') ||
        destination.username || destination.password) {
      return { valid: false, reason: 'redirect_location_invalid', url: null };
    }
    return { valid: true, reason: null, url: destination.href };
  } catch (_) {
    return { valid: false, reason: 'redirect_location_invalid', url: null };
  }
}

function resolvePointer(root, pointer) {
  let current = root;
  for (const rawPart of pointer.slice(1).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(part)) return { exists: false, value: undefined };
      const index = Number(part);
      if (index >= current.length || !Object.hasOwn(current, index)) return { exists: false, value: undefined };
      current = current[index];
    } else if (isPlainObject(current) && Object.hasOwn(current, part)) {
      current = current[part];
    } else {
      return { exists: false, value: undefined };
    }
  }
  return { exists: true, value: current };
}

function matchesPredicate(root, predicate) {
  const resolved = resolvePointer(root, predicate.path);
  switch (predicate.op) {
    case 'exists': return resolved.exists;
    case 'equals': return resolved.exists && isDeepStrictEqual(resolved.value, predicate.value);
    case 'truthy': return resolved.exists && Boolean(resolved.value);
    case 'falsey': return resolved.exists && !resolved.value;
    default: throw new TypeError(`Unsupported JSON predicate operator "${predicate.op}"`);
  }
}

function classifyJsonResponse(adapter, body) {
  const jsonConfig = adapter && adapter.response && adapter.response.json;
  if (!jsonConfig) return null;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_) {
    return { status: 'unknown', reason: 'adapter_json_invalid' };
  }

  const positive = jsonConfig.positive ? matchesPredicate(parsed, jsonConfig.positive) : false;
  const negative = jsonConfig.negative ? matchesPredicate(parsed, jsonConfig.negative) : false;
  if (positive && negative) return { status: 'unknown', reason: 'adapter_predicate_conflict' };
  if (positive) return { status: 'found', reason: 'adapter_json_positive' };
  if (negative) return { status: 'not_found', reason: 'adapter_json_negative' };
  return { status: 'unknown', reason: 'adapter_json_inconclusive' };
}

module.exports = { buildRequest, classifyJsonResponse, inspectRedirectLocation, validateCatalog };
