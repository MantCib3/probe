'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { probe } = require('../server');
const {
  buildRequest,
  classifyJsonResponse,
  inspectRedirectLocation,
  validateCatalog,
} = require('../source-request-adapter');
const { classify } = require('../server');

function source(requestAdapter) {
  return { name: 'Adapter fixture', requestAdapter };
}

test('builds constrained GET, HEAD, and POST request shapes', () => {
  const get = source({ method: 'GET', headers: { Accept: 'application/json' } });
  const head = source({ method: 'HEAD', response: { expectedStatus: 204 } });
  const post = source({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    bodyTemplate: '{"username":"{{username}}"}',
  });
  validateCatalog([get, head, post]);

  assert.deepEqual(buildRequest(get, 'alice'), {
    method: 'GET',
    headers: { accept: 'application/json' },
    body: null,
  });
  assert.deepEqual(buildRequest(head, 'alice'), { method: 'HEAD', headers: {}, body: null });
  assert.deepEqual(buildRequest(post, 'alice'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"username":"alice"}',
  });
});

test('rejects unsafe adapter methods, credentials, malformed predicates, and auth ambiguity', () => {
  const invalidSources = [
    source({ method: 'DELETE' }),
    source({ method: 'GET', headers: { Authorization: 'Bearer example' } }),
    source({ method: 'GET', headers: { 'X-Api-Key': 'example' } }),
    source({ method: 'POST', bodyTemplate: '{"password":"literal"}' }),
    source({ method: 'POST', bodyTemplate: '{"token":"literal","username":"{{username}}"}' }),
    source({ method: 'GET', response: { json: { positive: { path: '/id', op: 'contains', value: 'x' } } } }),
    source({ method: 'HEAD' }),
    source({ method: 'HEAD', response: { expectedStatus: 700 } }),
    { name: 'Conflicting auth semantics', authRedirectMeansFound: true, authRedirectMeansNotFound: true },
  ];
  for (const invalid of invalidSources) {
    assert.throws(() => validateCatalog([invalid]), /Invalid backend source configuration/);
  }
});

test('JSON evidence is explicit and conflicting or absent predicates abstain', () => {
  const adapter = {
    method: 'GET',
    response: {
      json: {
        positive: { path: '/profile/id', op: 'exists' },
        negative: { path: '/error/code', op: 'equals', value: 'NOT_FOUND' },
      },
    },
  };
  validateCatalog([source(adapter)]);

  assert.deepEqual(classifyJsonResponse(adapter, '{"profile":{"id":7}}'), {
    status: 'found',
    reason: 'adapter_json_positive',
  });
  assert.deepEqual(classifyJsonResponse(adapter, '{"error":{"code":"NOT_FOUND"}}'), {
    status: 'not_found',
    reason: 'adapter_json_negative',
  });
  assert.deepEqual(classifyJsonResponse(adapter, '{"profile":{"id":7},"error":{"code":"NOT_FOUND"}}'), {
    status: 'unknown',
    reason: 'adapter_predicate_conflict',
  });
  assert.deepEqual(classifyJsonResponse(adapter, '{"other":true}'), {
    status: 'unknown',
    reason: 'adapter_json_inconclusive',
  });
  assert.deepEqual(classifyJsonResponse(adapter, '{'), {
    status: 'unknown',
    reason: 'adapter_json_invalid',
  });
});

test('POST adapter sends its reviewed method, headers, username body, and uses JSON evidence', async t => {
  let observed;
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      observed = { method: req.method, contentType: req.headers['content-type'], body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user: { id: 17 } }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const site = {
    name: 'POST fixture',
    category: 'test',
    url: `http://127.0.0.1:${upstream.address().port}/lookup`,
    requestAdapter: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      bodyTemplate: '{"username":"{{username}}"}',
      response: {
        json: {
          positive: { path: '/user/id', op: 'exists' },
          negative: { path: '/error', op: 'exists' },
        },
      },
    },
  };

  const result = await probe(site, 'alice');
  assert.deepEqual(observed, {
    method: 'POST',
    contentType: 'application/json',
    body: '{"username":"alice"}',
  });
  assert.equal(result.status, 'found');
  assert.deepEqual(result.reasonCodes, ['adapter_json_positive']);
});

test('HEAD adapter sends no request body and abstains without response-body evidence', async t => {
  let observedMethod;
  const upstream = http.createServer((req, res) => {
    observedMethod = req.method;
    res.writeHead(204);
    res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const result = await probe({
    name: 'HEAD fixture',
    category: 'test',
    url: `http://127.0.0.1:${upstream.address().port}/lookup`,
    requestAdapter: { method: 'HEAD', response: { expectedStatus: 204 } },
  }, 'alice');
  assert.equal(observedMethod, 'HEAD');
  assert.equal(result.status, 'found');
  assert.deepEqual(result.reasonCodes, ['adapter_head_expected_status']);
});

test('HEAD adapter with a non-matching success status abstains', () => {
  const result = classify({
    name: 'HEAD fixture',
    category: 'test',
    requestAdapter: { method: 'HEAD', response: { expectedStatus: 204 } },
  }, 'alice', 'https://example.test/alice', 200, {}, '', 'http');
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.reasonCodes, ['adapter_head_status_unexpected']);
});

test('redirect validation rejects missing, malformed, non-http, and credential-bearing locations', () => {
  const base = 'https://example.test/profile/alice';
  for (const [location, reason] of [
    [undefined, 'redirect_location_missing'],
    ['/bad location', 'redirect_location_invalid'],
    ['http://[', 'redirect_location_invalid'],
    ['javascript:alert(1)', 'redirect_location_invalid'],
    ['https://user:pass@example.test/profile', 'redirect_location_invalid'],
  ]) {
    const result = inspectRedirectLocation(location, base);
    assert.equal(result.valid, false);
    assert.equal(result.reason, reason);
    const classified = classify({ name: 'Redirect fixture', category: 'test' },
      'alice', base, 302, { location }, '', 'http');
    assert.equal(classified.status, 'unknown');
    assert.equal(classified.reasonCodes[0], reason);
  }
});
