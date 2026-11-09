'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createStagingHandler } = require('../staging-probe');

const secret = 'a'.repeat(64);
function setup(overrides = {}) {
  let calls = 0;
  const handler = createStagingHandler({
    enabled: true, secret,
    sites: [{ name: 'Example' }, { name: 'Manual', undetectable: true }],
    isValidUsername: value => /^[a-zA-Z0-9._-]{1,50}$/.test(value),
    readBody: async req => req.body,
    probeWithDeadline: () => {
      calls++;
      return { promise: Promise.resolve({ status: 'unknown', reasonCodes: ['fixture'] }), cancel() {} };
    },
    normalizeResult: value => value,
    deadlineMs: 15000,
    runtimeFingerprint: { classifierSha256: 'fixture' },
    deployment: { commit: 'fixture' },
    ...overrides,
  });
  async function request({ method = 'POST', authorization = `Bearer ${secret}`, body = '{"site":"Example","username":"alice"}', route = '/api/staging-probe' } = {}) {
    const req = { method, headers: { authorization }, body, setTimeout() {} };
    const res = new EventEmitter();
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    res.end = value => { res.payload = JSON.parse(value); res.writableEnded = true; };
    await handler(route, req, res);
    return res;
  }
  return { request, calls: () => calls };
}

test('staging is opt-in and refuses a missing or short key', async () => {
  assert.throws(() => setup({ secret: '' }), /at least 32 bytes/);
  assert.throws(() => setup({ secret: 'short' }), /at least 32 bytes/);
  const fixture = setup({ enabled: false, secret: '' });
  assert.equal((await fixture.request()).status, 404);
  assert.equal(fixture.calls(), 0);
});

test('unauthenticated, wrong-key, and wrong-method requests do not probe', async () => {
  const fixture = setup();
  for (const authorization of ['', `Bearer ${'b'.repeat(64)}`, secret]) {
    assert.equal((await fixture.request({ authorization })).status, 401);
  }
  assert.equal((await fixture.request({ method: 'GET' })).status, 405);
  assert.equal(fixture.calls(), 0);
});

test('health exposes fingerprints and commit only after authentication', async () => {
  const fixture = setup();
  const response = await fixture.request({ method: 'GET', route: '/api/staging-health' });
  assert.equal(response.status, 200);
  assert.equal(response.payload.deployment.commit, 'fixture');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(fixture.calls(), 0);
});

test('billing health requires authentication, is bounded and reports failures explicitly', async () => {
  let checks = 0;
  const fixture = setup({ billingHealth: async () => { checks++; return { tls: true, readOnly: true }; } });
  const route = '/api/staging-billing-health';
  assert.equal((await fixture.request({ route, method: 'GET', authorization: '' })).status, 401);
  assert.equal(checks, 0);
  assert.equal((await fixture.request({ route })).status, 405);
  const result = await fixture.request({ route, method: 'GET' });
  assert.equal(result.status, 200);
  assert.equal(result.payload.database.readOnly, true);
  assert.equal((await fixture.request({ route, method: 'GET' })).status, 429);
  assert.equal(checks, 1);
  const failed = setup({ billingHealth: async () => { throw new Error('private connection details'); } });
  const failure = await failed.request({ route, method: 'GET' });
  assert.equal(failure.status, 503);
  assert.equal(JSON.stringify(failure.payload).includes('private connection details'), false);
  assert.equal((await setup().request({ route, method: 'GET' })).status, 404);
});

test('invalid JSON, arbitrary URLs, manual sources and invalid usernames are rejected', async () => {
  const fixture = setup();
  for (const body of ['null', '{', '{"site":"https://example.com","username":"alice"}', '{"site":"Manual","username":"alice"}', '{"site":"Example","username":"a/b"}']) {
    assert.equal((await fixture.request({ body })).status, 400);
  }
  assert.equal(fixture.calls(), 0);
});

test('recovery migration/check is authenticated, bounded, separately confirmed and does not invoke accounting or providers', async () => {
  let checks = 0;
  const fixture = setup({ billingRecovery: async () => {
    checks++;
    return { migrations: 2, checks: ['fixture'], fixturesRemoved: true, providerRequests: 0, paymentRequests: 0 };
  }, billingAccounting: async () => assert.fail('Original accounting must not run.') });
  const route = '/api/staging-billing-recovery';
  const body = '{"confirmation":"migrate-and-uuid-owned-recovery-fixtures-v1"}';
  assert.equal((await fixture.request({ route, body, authorization: '' })).status, 401);
  assert.equal((await fixture.request({ route, method: 'GET' })).status, 405);
  for (const invalid of ['{}','{"confirmation":"uuid-owned-accounting-fixtures-v1"}',
    '{"confirmation":"migrate-and-uuid-owned-recovery-fixtures-v1","extra":true}']) {
    assert.equal((await fixture.request({ route, body: invalid })).status, 400);
  }
  const result = await fixture.request({ route, body });
  assert.equal(result.status, 200);
  assert.equal(result.payload.recovery.fixturesRemoved, true);
  assert.equal(result.payload.recovery.paymentRequests, 0);
  assert.equal(checks, 1);
  assert.equal((await fixture.request({ route, body })).status, 429);
  assert.equal((await setup().request({ route, body })).status, 404);
  assert.equal(fixture.calls(), 0);
});
test('hosted sandbox recovery action requires its own exact bounded confirmation', async () => {
  let calls = 0;
  const fixture = setup({ stripeSetup: async input => { calls++; return { action: input.action, supplierRequests: 0 }; } });
  const route = '/api/staging-billing-stripe-setup';
  const body = '{"action":"recovery-start","guestId":"bd9c7b44-b2af-4ba9-b855-086f878662ed","confirmation":"stripe-test-recovery-one-checkout-v1"}';
  assert.equal((await fixture.request({ route, body, authorization: '' })).status, 401);
  assert.equal((await fixture.request({ route, body: body.replace('stripe-test-recovery-one-checkout-v1','stripe-test-setup-only-v1') })).status, 400);
  assert.equal((await fixture.request({ route, body: body.replace('recovery-start','pay') })).status, 400);
  assert.equal((await fixture.request({ route, body: body.replace('}', ',"amount":100}') })).status, 400);
  const result = await fixture.request({ route, body });
  assert.equal(result.status, 200);
  assert.equal(result.payload.setup.action, 'recovery-start');
  assert.equal(calls, 1);
});

test('accounting writes require authentication, POST, explicit confirmation and a bounded body', async () => {
  let checks = 0;
  const fixture = setup({ billingAccounting: async () => { checks++; return { fixtureWrites: true, fixturesRemoved: true }; } });
  const route = '/api/staging-billing-accounting';
  const body = '{"confirmation":"uuid-owned-accounting-fixtures-v1"}';
  assert.equal((await fixture.request({ route, body, authorization: '' })).status, 401);
  assert.equal((await fixture.request({ route, body, method: 'GET' })).status, 405);
  for (const invalid of ['null', '{', '[]', '{}', '{"confirmation":"other"}',
    '{"confirmation":"uuid-owned-accounting-fixtures-v1","url":"https://example.com"}']) {
    assert.equal((await fixture.request({ route, body: invalid })).status, 400);
  }
  assert.equal(checks, 0);
  assert.equal((await fixture.request({ route, body })).status, 200);
  assert.equal((await fixture.request({ route, body })).status, 429);
  assert.equal(checks, 1);
  assert.equal((await setup().request({ route, body })).status, 404);
  const large = setup({ billingAccounting: async () => { checks++; },
    readBody: async () => { throw Object.assign(new Error('large'), { code: 'BODY_TOO_LARGE' }); } });
  assert.equal((await large.request({ route, body })).status, 413);
  assert.equal(checks, 1);
});

test('accounting checks exclude concurrent invocations and report cleanup failures without secrets', async () => {
  let finish;
  const route = '/api/staging-billing-accounting';
  const body = '{"confirmation":"uuid-owned-accounting-fixtures-v1"}';
  const fixture = setup({ billingAccounting: () => new Promise(resolve => { finish = resolve; }) });
  const first = fixture.request({ route, body });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fixture.request({ route, body })).status, 429);
  finish({ fixturesRemoved: true });
  assert.equal((await first).status, 200);
  const failed = setup({ billingAccounting: async () => { throw new Error('private connection details'); } });
  const result = await failed.request({ route, body });
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result.payload).includes('private connection details'), false);
});

test('Stripe readiness requires authentication and shares the bounded database readiness budget', async () => {
  let checks = 0;
  const fixture = setup({ stripeHealth: async () => { checks++; return { mode: 'test', paymentRequests: 0 }; },
    billingHealth: async () => { throw new Error('Shared budget should prevent this call.'); } });
  const route = '/api/staging-billing-stripe-health';
  assert.equal((await fixture.request({ route, method: 'GET', authorization: '' })).status, 401);
  assert.equal((await fixture.request({ route })).status, 405);
  assert.equal(checks, 0);
  const response = await fixture.request({ route, method: 'GET' });
  assert.equal(response.status, 200);
  assert.equal(response.payload.stripe.mode, 'test');
  assert.equal((await fixture.request({ route: '/api/staging-billing-health', method: 'GET' })).status, 429);
  assert.equal((await fixture.request({ route, method: 'GET' })).status, 429);
  assert.equal(checks, 1);
  assert.equal((await setup().request({ route, method: 'GET' })).status, 404);
  const failed = setup({ stripeHealth: async () => { throw new Error('private account details'); } });
  const failure = await failed.request({ route, method: 'GET' });
  assert.equal(failure.status, 503);
  assert.equal(JSON.stringify(failure.payload).includes('private account details'), false);
});

test('sandbox setup requires authenticated explicit bounded confirmation and excludes concurrent calls', async () => {
  const route = '/api/staging-billing-stripe-setup';
  const body = JSON.stringify({ action: 'start', guestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    confirmation: 'stripe-test-setup-only-v1' });
  let calls = 0;
  let finish;
  const fixture = setup({ stripeSetup: async input => {
    calls++;
    assert.equal(input.action, 'start');
    return new Promise(resolve => { finish = resolve; });
  } });
  assert.equal((await fixture.request({ route, body, authorization: '' })).status, 401);
  assert.equal((await fixture.request({ route, body, method: 'GET' })).status, 405);
  for (const invalid of ['null', '{}', '[1]', '{', body.replace('start', 'collect'),
    body.replace('aaaaaaaa-aaaa', 'invalid')]) {
    assert.equal((await fixture.request({ route, body: invalid })).status, 400);
  }
  assert.equal(calls, 0);
  const first = fixture.request({ route, body });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fixture.request({ route, body })).status, 429);
  finish({ sandbox: true });
  assert.equal((await first).status, 200);
  assert.equal((await fixture.request({ route, body })).status, 429);
  assert.equal(calls, 1);
  assert.equal((await setup().request({ route, body })).status, 404);
});

test('test-payment action requires its own exact confirmation and fixed scenario', async () => {
  let calls = 0;
  const fixture = setup({ stripeSetup: async input => { calls++; return { scenario: input.scenario }; } });
  const route = '/api/staging-billing-stripe-setup';
  const input = { action: 'pay', guestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    scenario: 'success', confirmation: 'stripe-test-payments-v1' };
  for (const changes of [{ confirmation: 'stripe-test-setup-only-v1' }, { scenario: 'custom' },
    { amount: 100000 }, { action: 'refund' }]) {
    assert.equal((await fixture.request({ route, body: JSON.stringify({ ...input, ...changes }) })).status, 400);
  }
  assert.equal(calls, 0);
  assert.equal((await fixture.request({ route, body: JSON.stringify(input) })).status, 200);
  assert.equal(calls, 1);
});

test('supplier trial is authenticated, bounded and never accepts caller controls or retries', async () => {
  let calls = 0;
  const fixture = setup({ supplierTrial: async () => { calls++; return { maximumRequests: 4 }; } });
  const route = '/api/staging-billing-supplier-trial';
  const input = { action: 'start', confirmation: 'four-http-requests-no-retries-v1' };
  const body = JSON.stringify(input);
  assert.equal((await fixture.request({ route, body, authorization: '' })).status, 401);
  assert.equal((await fixture.request({ route, body, method: 'GET' })).status, 405);
  for (const invalid of ['null', '{', JSON.stringify({ ...input, mode: 'browser' }),
    JSON.stringify({ ...input, action: 'retry' })]) {
    assert.equal((await fixture.request({ route, body: invalid })).status, 400);
  }
  assert.equal(calls, 0);
  assert.equal((await fixture.request({ route, body })).status, 200);
  assert.equal(calls, 1);
  assert.equal((await setup().request({ route, body })).status, 404);
});

test('oversized bodies are rejected explicitly', async () => {
  const fixture = setup({ readBody: async () => { throw Object.assign(new Error('large'), { code: 'BODY_TOO_LARGE' }); } });
  assert.equal((await fixture.request()).status, 413);
  assert.equal(fixture.calls(), 0);
});

test('valid input uses the supplied production probe without promoting unknown', async () => {
  const fixture = setup();
  const response = await fixture.request();
  assert.equal(response.status, 200);
  assert.equal(response.payload.result.status, 'unknown');
  assert.equal(fixture.calls(), 1);
});

test('two in-flight probes exhaust capacity and release it after completion', async () => {
  const pending = [];
  const fixture = setup({ probeWithDeadline: () => ({ promise: new Promise(resolve => pending.push(resolve)), cancel() {} }) });
  const first = fixture.request();
  const second = fixture.request();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fixture.request()).status, 429);
  pending.splice(0).forEach(resolve => resolve({ status: 'unknown' }));
  await Promise.all([first, second]);
  const next = fixture.request();
  await new Promise(resolve => setImmediate(resolve));
  pending[0]({ status: 'unknown' });
  assert.equal((await next).status, 200);
});

test('hourly request budget is global and bounded', async () => {
  const fixture = setup();
  for (let i = 0; i < 120; i++) assert.equal((await fixture.request()).status, 200);
  const limited = await fixture.request();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['Retry-After']) > 0);
  assert.equal(fixture.calls(), 120);
});

test('probe failures are HTTP errors rather than unknown success results', async () => {
  const fixture = setup({ probeWithDeadline: () => ({ promise: Promise.reject(new Error('fixture failure')), cancel() {} }) });
  const response = await fixture.request();
  assert.equal(response.status, 500);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.result, undefined);
});

function censusSetup() {
  const seen = [];
  const fixture = setup({
    sites: [{ name: 'Example', url: 'https://www.example.com/{}', apiUrl: 'https://api.example.co.uk/u/{}' }, { name: 'Gone', url: 'https://defunct.test/{}', defunct: true }],
    observe: async request => { seen.push(request); return { status: 200, bytes: 10 }; },
  });
  const census = value => fixture.request({ body: JSON.stringify({ census: value }) });
  return { fixture, census, seen };
}

test('census reaches only HTTPS hosts on active catalog domains', async () => {
  const { fixture, census, seen } = censusSetup();
  for (const url of ['https://example.com/a', 'https://old.example.com/a', 'https://api.example.co.uk/u/x']) {
    assert.equal((await census({ url, username: 'alice' })).status, 200, url);
  }
  for (const url of ['http://www.example.com/a', 'https://defunct.test/a', 'https://example.org/a', 'https://evil.co.uk/a',
    'https://www.example.com:8443/a', 'https://user:pw@www.example.com/a', 'https://127.0.0.1/a', 'not a url']) {
    assert.equal((await census({ url, username: 'alice' })).status, 400, url);
  }
  assert.equal(seen.length, 3);
  assert.equal(fixture.calls(), 0);
});

test('census validates method, body, content type, variant and username', async () => {
  const { census, seen } = censusSetup();
  const url = 'https://www.example.com/x';
  for (const value of [null, [], { url }, { url, username: 'a/b' }, { url, username: 'alice', method: 'DELETE' },
    { url, username: 'alice', body: '{}' }, { url, username: 'alice', method: 'POST', body: 'x'.repeat(1501) },
    { url, username: 'alice', method: 'POST', body: '{}', contentType: 'text/xml' }, { url, username: 'alice', variant: 'googlebot' }]) {
    assert.equal((await census(value)).status, 400, JSON.stringify(value));
  }
  const ok = await census({ url, username: 'alice', method: 'POST', body: '{"q":1}', contentType: 'application/json', variant: 'browserlike' });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.census.observation.status, 200);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['body', 'contentType', 'method', 'timeoutMs', 'url', 'username', 'variant']);
});

test('census shares the hourly budget with catalog probes', async () => {
  const { fixture, census } = censusSetup();
  for (let i = 0; i < 60; i++) assert.equal((await census({ url: 'https://www.example.com/x', username: 'alice' })).status, 200);
  for (let i = 0; i < 60; i++) assert.equal((await fixture.request()).status, 200);
  assert.equal((await census({ url: 'https://www.example.com/x', username: 'alice' })).status, 429);
});
