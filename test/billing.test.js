'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const Stripe = require('stripe');
const { randomUUID } = require('node:crypto');
const { loadConfig, CONSENT_VERSION, CONSENT_TEXT } = require('../lib/billing/config');
const { transaction } = require('../lib/billing/db');
const { Store, reserveAllowed, centsForDebt } = require('../lib/billing/store');
const { startSetup, processWebhook, collect, createStripe, assertAustralianAccount, checkSandboxConfiguration } = require('../lib/billing/stripe');
const { execute, targetFor, classifyResponse } = require('../lib/billing/zyte');
const { createBillingHandler, COOKIE, csrfFor, hash, readRaw } = require('../lib/routes/billing');
const { tick } = require('../scripts/billing-worker');

const config = { staging: true, enabled: true, origin: 'https://staging.example.test',
  consentVersion: CONSENT_VERSION, consentText: CONSENT_TEXT, termsHash: 'a'.repeat(64),
  creditMicros: 1000000, thresholdMicros: 500000, minimumCents: 1,
  rates: [{ source: 'Fixture', mode: 'http', hosts: ['example.com'], supplierMicros: 2000,
    marginMicros: 1000, maximumMicros: 3000 }] };
const site = { name: 'Fixture', category: 'developer', url: 'https://example.com/{}',
  checkMethod: 'message', positiveMsg: 'profile-marker', errorMsg: 'user not found' };
const accounts = { async retrieve() { return { country: 'AU', default_currency: 'aud' }; } };
const guest = () => ({ id: randomUUID(), state: 'active', customer_id: 'cus_fixture',
  payment_method_id: 'pm_fixture', consent_version: CONSENT_VERSION, terms_hash: config.termsHash,
  consent_at: new Date(), expires_at: new Date(Date.now() + 3600000),
  cap_micros: null, debt_micros: '0', paid_micros: '0', reserved_micros: '0' });
function poolWith(query) {
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
      return query(sql, values);
    },
    release() {},
  };
  return { queries, async connect() { return client; }, query: client.query };
}
async function fixtureServer(t, handler) {
  const server = http.createServer((req, res) => { void handler(new URL(req.url, 'http://localhost').pathname, req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  return (pathname, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/paid/${pathname}`,
      method: options.method || 'GET', headers: options.headers || {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}
test('disabled and non-staging endpoints never initialize dependencies or spend', async t => {
  let calls = 0;
  const store = new Proxy({}, { get() { calls++; throw new Error('external dependency forbidden'); } });
  const request = await fixtureServer(t, createBillingHandler({ env: { PROBE_STAGING: '1' }, store, stripe: {} }));
  assert.equal((await request('config')).body.enabled, false);
  assert.equal((await request('jobs', { method: 'POST', body: {} })).status, 503);
  assert.equal((await request('webhook', { method: 'POST' })).status, 503);
  assert.equal(calls, 0);
  const other = await fixtureServer(t, createBillingHandler({ env: {}, store, stripe: {} }));
  assert.equal((await other('config')).status, 404);
  assert.equal(loadConfig({ PROBE_STAGING: '1', PAID_INFRA_ENABLED: '1' }, [site]).enabled, false);
  assert.throws(() => createStripe({ STRIPE_SECRET_KEY: 'sk_live_fixture' }), /sandbox_key/);
});
test('real rate parser requires explicit gates, measured per-source AUD rates, private storage and test keys', t => {
  const directory = path.join(__dirname, '..', 'billing-private', `fixture-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const file = path.join(directory, 'rate-fixture.json');
  const card = { currency: 'aud', billability: 'authoritative-reconciliation', measured: true,
    measurementReference: 'UNIT-TEST-ONLY-NOT-LAUNCH-RATES', creditMicros: config.creditMicros,
    thresholdMicros: config.thresholdMicros, minimumCents: config.minimumCents, sources: config.rates };
  fs.writeFileSync(file, JSON.stringify(card));
  const env = { PROBE_STAGING: '1', PAID_INFRA_ENABLED: '1', PAID_MONEY_PATH_VERIFIED: '1',
    STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', ZYTE_API_KEY: 'fixture',
    DATABASE_URL: 'not-contacted', PAID_ORIGIN: config.origin, PAID_RATE_CONFIG_PATH: file,
    TURNSTILE_SECRET: 'fixture', TURNSTILE_HOSTNAMES: 'staging.example.test' };
  assert.equal(loadConfig(env, [site]).enabled, true);
  for (const patch of [{ PAID_MONEY_PATH_VERIFIED: '0' }, { STRIPE_SECRET_KEY: 'sk_live_fixture' },
    { PROBE_STAGING: '0' }, { RENDER: '1', RENDER_SERVICE_NAME: 'probe-production' },
    { TURNSTILE_SECRET: '' }, { PAID_ORIGIN: 'http://staging.example.test' },
    { PAID_RATE_CONFIG_PATH: path.join(__dirname, 'fixture.json') }]) {
    assert.equal(loadConfig({ ...env, ...patch }, [site]).enabled, false);
  }
  const baseline = loadConfig(env, [site]).termsHash;
  assert.notEqual(loadConfig(env, [{ ...site, positiveMsg: 'changed-marker' }]).termsHash, baseline);
  for (const patch of [{ measured: false }, { minimumCents: 0 }, { currency: 'usd' },
    { sources: [{ ...card.sources[0], hosts: ['127.0.0.1'] }] },
    { sources: [{ ...card.sources[0], mode: 'browser' }] },
    { sources: [{ ...card.sources[0], hosts: ['example.com', '*.example.com'] }] },
    { sources: [{ ...card.sources[0], supplierMicros: 1.1 }] },
    { sources: [{ ...card.sources[0], maximumMicros: 1, supplierMicros: 2000000 }] }]) {
    fs.writeFileSync(file, JSON.stringify({ ...card, ...patch }));
    assert.equal(loadConfig(env, [site]).enabled, false);
  }
});
test('session cookies are random Secure HttpOnly hashed, rate-controlled and bot checked', async t => {
  const created = [];
  const store = { async createGuest(...args) { created.push(args); }, async authenticate() { return null; } };
  const request = await fixtureServer(t, createBillingHandler({ config, store, stripe: {}, verifyToken: async token => token === 'fixture' }));
  const headers = { origin: config.origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  const missing = await request('session', { method: 'POST', headers, body: {} });
  assert.equal(missing.status, 403);
  const response = await request('session', { method: 'POST', headers, body: { cfToken: 'fixture' } });
  assert.equal(response.status, 201);
  const cookie = response.headers['set-cookie'][0];
  assert.match(cookie, /; Path=\/; HttpOnly; Secure; SameSite=Strict;/);
  const token = cookie.split(';')[0].split('=')[1];
  assert.equal(token.length, 43);
  assert.equal(created[0][0], hash(token));
  assert.equal(created[0][1], hash(response.body.csrf));
  assert.equal(response.body.csrf, csrfFor(token));
  assert.equal(JSON.stringify(created).includes(token), false);
});
test('forged sessions, missing CSRF, cross-origin and cross-site requests fail closed', async t => {
  const token = 'b'.repeat(43);
  const owner = { ...guest(), csrf_hash: hash(csrfFor(token)) };
  let changes = 0;
  const store = { async authenticate(value) { return value === hash(token) ? owner : null; },
    async revoke() { changes++; }, async status(id) { assert.equal(id, owner.id); return { state: 'active', jobs: [], usage: [] }; } };
  const request = await fixtureServer(t, createBillingHandler({ config, store, stripe: {} }));
  const headers = { origin: config.origin, cookie: `${COOKIE}=${token}`, 'content-type': 'application/json',
    'x-probe-csrf': csrfFor(token) };
  assert.equal((await request('status')).status, 401);
  assert.equal((await request('status', { headers: { cookie: `${COOKIE}=${'x'.repeat(43)}` } })).status, 401);
  assert.equal((await request('revoke', { method: 'POST', headers: { ...headers, 'x-probe-csrf': '' }, body: {} })).status, 403);
  assert.equal((await request('revoke', { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body: {} })).status, 403);
  assert.equal((await request('revoke', { method: 'POST', headers: { ...headers, 'sec-fetch-site': 'cross-site' }, body: {} })).status, 403);
  assert.equal((await request('status', { headers: { cookie: headers.cookie } })).status, 200);
  assert.equal((await request('revoke', { method: 'POST', headers, body: {} })).status, 200);
  assert.equal(changes, 1);
  assert.equal((await request('session', { method: 'POST', headers: { ...headers, cookie: `${COOKIE}=${'x'.repeat(43)}` }, body: {} })).status, 401);
});
test('setup requires explicit current consent and does not authorize through a return URL', async t => {
  const token = 'c'.repeat(43);
  const owner = { ...guest(), csrf_hash: hash(csrfFor(token)) };
  let setupCalls = 0;
  const store = { async authenticate() { return owner; }, async prepareSetup() { setupCalls++; throw new Error('not expected'); } };
  const request = await fixtureServer(t, createBillingHandler({ config, store, stripe: {} }));
  const headers = { origin: config.origin, cookie: `${COOKIE}=${token}`, 'content-type': 'application/json', 'x-probe-csrf': csrfFor(token) };
  for (const body of [{}, { consent: true }, { consent: true, consentVersion: CONSENT_VERSION, termsHash: 'wrong' }]) {
    assert.equal((await request('setup', { method: 'POST', headers, body })).status, 403);
  }
  assert.equal((await request('setup', { headers })).status, 405);
  assert.equal(setupCalls, 0);
});
test('hosted setup creation uses durable ownership metadata and distinct idempotency keys', async () => {
  const setup = { id: randomUUID(), state: 'creating', customer_id: null };
  const calls = [];
  const store = {
    async prepareSetup() { return setup; },
    async setupCustomer(id, customer) { assert.equal(id, setup.id); setup.customer_id = customer; },
    async setupReady(id, checkout) { setup.state = 'ready'; setup.checkout_url = checkout.url; },
    async setupUncertain() { throw new Error('unexpected'); },
  };
  const stripe = {
    accounts,
    customers: { async create(params, opts) { calls.push({ params, opts }); return { id: 'cus_fixture' }; } },
    checkout: { sessions: { async create(params, opts) {
      calls.push({ params, opts });
      assert.equal(params.mode, 'setup');
      assert.equal(params.currency, 'aud');
      assert.equal(params.customer, 'cus_fixture');
      assert.equal(params.setup_intent_data.metadata.probe_setup, setup.id);
      assert.equal(params.success_url.includes('?'), false);
      return { id: 'cs_test_fixture', livemode: false, url: 'https://checkout.stripe.com/c/pay/cs_test_fixture' };
    } } },
  };
  const id = randomUUID();
  const first = await startSetup(store, stripe, id, config);
  assert.equal(await startSetup(store, stripe, id, config), first);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].opts.idempotencyKey, calls[1].opts.idempotencyKey);
});
test('uncertain setup is persisted rather than silently re-created', async () => {
  let uncertain = 0;
  const store = { async prepareSetup() { return { id: randomUUID(), state: 'creating', customer_id: 'cus_fixture' }; },
    async setupUncertain() { uncertain++; } };
  await assert.rejects(startSetup(store, { accounts, checkout: { sessions: { async create() { throw new Error('network'); } } } },
    randomUUID(), config), /setup_uncertain/);
  assert.equal(uncertain, 1);
});
test('Stripe account must be Australian with AUD settlement before new hosted setup/collection', async () => {
  await assertAustralianAccount({ accounts });
  await assert.rejects(assertAustralianAccount({ accounts: { async retrieve() {
    return { country: 'US', default_currency: 'usd' };
  } } }), /australian_aud_account_required/);
});
test('sandbox readiness retrieves only AU/AUD configuration and never exposes identity or secrets', async () => {
  let calls = 0;
  const stripe = { accounts: { async retrieve() {
    calls++;
    return { country: 'AU', default_currency: 'aud', id: 'acct_private', email: 'private@example.com' };
  } } };
  const result = await checkSandboxConfiguration(stripe, { STRIPE_WEBHOOK_SECRET: 'whsec_private' });
  assert.deepEqual(result, { country: 'AU', currency: 'aud', mode: 'test', webhookSecretConfigured: true,
    stripeRequests: 1, paymentRequests: 0, providerRequests: 0, acceptanceVerified: false });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal((await checkSandboxConfiguration(stripe, {})).webhookSecretConfigured, false);
  assert.throws(() => createStripe({ STRIPE_SECRET_KEY: 'sk_live_private' }), /sandbox_key_required/);
  await assert.rejects(checkSandboxConfiguration({ accounts: { async retrieve() {
    return { country: 'US', default_currency: 'usd' };
  } } }, {}), /australian_aud_account_required/);
});
test('webhook consumes signed raw bytes; invalid signatures and live events never authorize', async t => {
  const sdk = new Stripe('sk_test_fixture');
  const secret = 'whsec_fixture';
  const event = { id: 'evt_fixture', type: 'unrelated', livemode: false, data: { object: { id: 'obj_fixture' } } };
  const raw = JSON.stringify(event);
  let retrieved = 0;
  sdk.checkout.sessions.retrieve = async () => { retrieved++; throw new Error('forbidden'); };
  const request = await fixtureServer(t, createBillingHandler({ config, store: {}, stripe: sdk,
    env: { STRIPE_WEBHOOK_SECRET: secret } }));
  assert.equal((await request('webhook', { method: 'POST', headers: { 'stripe-signature': 'bad' }, body: event })).status, 400);
  const signature = sdk.webhooks.generateTestHeaderString({ payload: raw, secret });
  assert.equal((await request('webhook', { method: 'POST', headers: { 'stripe-signature': signature }, body: event })).status, 200);
  const live = { ...event, livemode: true };
  const liveSignature = sdk.webhooks.generateTestHeaderString({ payload: JSON.stringify(live), secret });
  assert.equal((await request('webhook', { method: 'POST', headers: { 'stripe-signature': liveSignature }, body: live })).status, 400);
  assert.equal(retrieved, 0);
});
test('verified SetupIntent must be succeeded off-session test card before confirmation', async () => {
  const setupId = randomUUID();
  const guestId = randomUUID();
  let confirmations = 0;
  const event = { id: 'evt_setup', type: 'checkout.session.completed', livemode: false,
    data: { object: { id: 'cs_fixture', metadata: { probe_setup: setupId } } } };
  const intent = { id: 'seti_fixture', status: 'succeeded', usage: 'off_session', livemode: false,
    customer: 'cus_fixture', payment_method: 'pm_fixture' };
  const stripe = {
    checkout: { sessions: { async retrieve() { return { id: 'cs_fixture', mode: 'setup', status: 'complete',
      livemode: false, customer: 'cus_fixture', setup_intent: intent.id, metadata: { probe_setup: setupId, probe_guest: guestId } }; } } },
    setupIntents: { async retrieve() { return intent; } },
    paymentMethods: { async retrieve() { return { id: 'pm_fixture', customer: 'cus_fixture', type: 'card', livemode: false }; } },
  };
  const store = { async setupForCheckout() { return { id: setupId }; }, async confirmSetup() { confirmations++; } };
  await processWebhook(store, stripe, event);
  intent.status = 'requires_action';
  await assert.rejects(processWebhook(store, stripe, event), /setup_not_verified/);
  intent.status = 'succeeded';
  intent.livemode = true;
  await assert.rejects(processWebhook(store, stripe, event), /setup_not_verified/);
  assert.equal(confirmations, 1);
});
test('duplicate setup webhook does not reapply consent and revocation remains terminal in SQL', async () => {
  const owner = guest();
  const setup = { id: randomUUID(), guest_id: owner.id, customer_id: owner.customer_id,
    checkout_id: 'cs_fixture', state: 'ready', consent_at: new Date(), terms_hash: config.termsHash,
    consent_version: CONSENT_VERSION };
  const seen = new Set();
  const pool = poolWith(async (sql, values) => {
    if (sql.startsWith('SELECT guest_id FROM probe_billing.setups')) return { rows: [{ guest_id: owner.id }] };
    if (sql.startsWith('SELECT * FROM probe_billing.setups')) return { rows: [setup] };
    if (sql.startsWith('SELECT * FROM probe_billing.guests')) return { rows: [owner] };
    if (sql.includes('INSERT INTO probe_billing.payment_events')) {
      if (seen.has(values[0])) return { rows: [], rowCount: 0 };
      seen.add(values[0]); return { rows: [{ id: values[0] }], rowCount: 1 };
    }
    if (sql.includes("UPDATE probe_billing.setups SET state='confirmed'")) setup.state = 'confirmed';
    return { rows: [], rowCount: 1 };
  });
  const store = new Store(pool);
  const event = { id: 'evt_once', type: 'checkout.session.completed' };
  const checkout = { id: setup.checkout_id, customer: owner.customer_id, metadata: { probe_setup: setup.id, probe_guest: owner.id } };
  const intent = { id: 'seti_fixture', customer: owner.customer_id,
    metadata: { probe_setup: setup.id, probe_guest: owner.id, probe_terms: setup.terms_hash } };
  const method = { id: owner.payment_method_id, customer: owner.customer_id };
  await store.confirmSetup(event, checkout, intent, method);
  await store.confirmSetup(event, checkout, intent, method);
  await store.confirmSetup({ ...event, id: 'evt_other_duplicate' }, checkout, intent, method);
  assert.equal(pool.queries.filter(q => q.sql.includes('UPDATE probe_billing.guests SET customer_id')).length, 1);
  assert.match(pool.queries.find(q => q.sql.includes('UPDATE probe_billing.guests SET customer_id')).sql,
    /state IN \('revoked','action_required'\) THEN state/);
  await assert.rejects(store.confirmSetup({ ...event, id: 'evt_wrong' }, checkout,
    { ...intent, customer: 'cus_other' }, method), /ownership_mismatch/);
});
test('caps and credit use exact micro-units including reservations and previously collected usage', () => {
  const owner = guest();
  owner.cap_micros = '7000'; owner.paid_micros = '2000'; owner.reserved_micros = '2000';
  reserveAllowed(owner, 3000, config);
  assert.throws(() => reserveAllowed(owner, 3001, config), /customer_cap/);
  owner.cap_micros = null; owner.debt_micros = '999000';
  assert.throws(() => reserveAllowed(owner, 3000, config), /credit_limit/);
  for (const state of ['new','revoked','action_required']) assert.throws(() => reserveAllowed({ ...guest(), state }, 1, config), /consent_or_payment/);
  assert.throws(() => reserveAllowed({ ...guest(), terms_hash: 'old' }, 1, config), /consent_or_payment/);
  assert.equal(centsForDebt('19999', 1), 1);
  assert.equal(centsForDebt('9999', 1), 0);
  assert.equal(centsForDebt('19999', 2), 0);
});
test('transactions roll back failures and release/discard connections exactly once', async () => {
  let releases = 0;
  const operations = [];
  const pool = { async connect() { return {
    async query(sql) { operations.push(sql); }, release() { releases++; },
  }; } };
  await assert.rejects(transaction(pool, async () => { throw new Error('fixture'); }), /fixture/);
  assert.deepEqual(operations, ['BEGIN','ROLLBACK']);
  assert.equal(releases, 1);
  let discarded = 0;
  await assert.rejects(transaction({ async connect() { return {
    async query(sql) { if (sql === 'ROLLBACK') throw new Error('connection gone'); },
    release(force) { assert.equal(force, true); discarded++; },
  }; } }, async () => { throw new Error('original'); }), /original/);
  assert.equal(discarded, 1);
});
test('Zyte adapter preserves positive/negative/challenge, body cap and identity evidence', () => {
  const rate = config.rates[0];
  const target = targetFor(site, 'alice', rate);
  const data = body => ({ url: target, statusCode: 200, httpResponseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
    httpResponseBody: Buffer.from(body).toString('base64') });
  assert.equal(classifyResponse(site, 'alice', target, rate, data('<title>Alice</title>profile-marker alice')).status, 'found');
  assert.equal(classifyResponse(site, 'alice', target, rate, { ...data('missing'), statusCode: 404 }).status, 'not_found');
  assert.equal(classifyResponse(site, 'alice', target, rate, data('<title>Just a moment</title>profile-marker alice')).status, 'blocked');
  assert.notEqual(classifyResponse(site, 'alice', target, rate, data('x'.repeat(32768) + 'profile-marker alice')).status, 'found');
  assert.equal(classifyResponse(site, 'alice', target, rate, { ...data('profile-marker alice'), url: 'https://example.com/bob' }).status, 'unknown');
  assert.throws(() => targetFor(site, '../admin', rate), /invalid_source_username/);
  assert.throws(() => targetFor({ ...site, url: 'http://127.0.0.1/{}' }, 'alice', rate), /paid_host_guard/);
  assert.throws(() => classifyResponse(site, 'alice', target, rate, { ...data('x'), url: 'https://evil.example/alice' }), /paid_host_guard/);
  assert.equal(classifyResponse(site, 'alice', target, { ...rate, mode: 'browser' },
    { ...data(''), browserHtml: '<title>Just a moment</title>profile-marker alice' }).status, 'blocked');
});
test('provider HTTP failure differs from billable target 404; timeout never retries', async () => {
  const job = { source: site.name, username: 'alice', rate: config.rates[0], attempt_id: randomUUID(),
    target_url: targetFor(site, 'alice', config.rates[0]) };
  let calls = 0;
  const fetch404 = async (_url, opts) => {
    calls++;
    assert.equal(JSON.parse(opts.body).followRedirect, false);
    assert.equal(opts.redirect, 'error');
    return new Response(JSON.stringify({ url: job.target_url, statusCode: 404, echoData: JSON.parse(opts.body).echoData,
      httpResponseHeaders: [], httpResponseBody: Buffer.from('missing').toString('base64') }),
    { status: 200, headers: { 'request-id': 'provider-fixture' } });
  };
  const result = await execute(job, site, 'fixture-key', fetch404, async () => {}, async () => {});
  assert.equal(result.state, 'response');
  assert.equal(result.providerStatus, 200); assert.equal(result.targetStatus, 404);
  assert.equal(result.result.status, 'not_found');
  const failure = await execute(job, site, 'fixture-key', async () => new Response('failure', { status: 500 }), async () => {}, async () => {});
  assert.equal(failure.state, 'provider_error');
  const unknown = await execute(job, site, 'fixture-key', async () => { calls++; throw new Error('timeout'); }, async () => {}, async () => {});
  assert.equal(unknown.state, 'uncertain');
  assert.equal(calls, 2);
  let forbidden = 0;
  const guard = await execute({ ...job, target_url: 'https://evil.test/' }, site, 'fixture',
    async () => { forbidden++; }, async () => {});
  assert.equal(guard.state, 'probe_error'); assert.equal(forbidden, 0);
  const revoked = await execute(job, site, 'fixture-key', async () => { forbidden++; }, async () => {},
    async () => { throw new Error('revoked before dispatch'); });
  assert.equal(revoked.state, 'probe_error'); assert.equal(forbidden, 0);
});
test('authoritative reconciliation charges successful target evidence, absorbs errors and blocks rate overrun', async () => {
  for (const state of ['response','provider_error','uncertain','probe_error']) {
    const owner = guest();
    const job = { id: randomUUID(), guest_id: owner.id, state: 'reconcile', rate: config.rates[0],
      reservation_micros: '3000', result: { status: 'unknown' } };
    const attempt = { state, provider_status: state === 'provider_error' ? 500 : 200, target_status: 404, provider_ref: 'provider-fixture' };
    const pool = poolWith(async sql => {
      if (sql.includes('SELECT guest_id FROM probe_billing.jobs')) return { rows: [{ guest_id: owner.id }] };
      if (sql.includes('SELECT * FROM probe_billing.guests')) return { rows: [owner] };
      if (sql.includes('SELECT * FROM probe_billing.jobs')) return { rows: [job] };
      if (sql.includes('SELECT * FROM probe_billing.attempts')) return { rows: [attempt] };
      return { rows: [], rowCount: 1 };
    });
    const store = new Store(pool);
    const input = { jobId: job.id, supplierMicros: 2000, authoritative: true, disposition: 'billed',
      evidenceReference: 'verified-usage-export:fixture', providerReference: 'provider-fixture' };
    await assert.rejects(store.reconcile({ ...input, authoritative: false }), /authoritative_evidence/);
    await assert.rejects(store.reconcile({ ...input, providerReference: 'other' }), /provider_reference_mismatch/);
    if (state === 'response') {
      await assert.rejects(store.reconcile({ ...input, supplierMicros: 2001 }), /supplier_rate_exceeded/);
      attempt.provider_ref = null;
      await assert.rejects(store.reconcile(input), /supplier_reference_unverified/);
      attempt.provider_ref = 'provider-fixture';
    }
    await store.reconcile(input);
    const ledger = pool.queries.find(q => q.sql.includes('INSERT INTO probe_billing.ledger'));
    assert.equal(ledger.values[2], state === 'response' ? 'usage' : 'absorbed');
    assert.equal(ledger.values[3], state === 'response' ? 3000 : 0);
  }
});
test('collection retries are keyed to durable claims, cents leave remainder, stale unknowns freeze', async () => {
  const collection = { id: randomUUID(), guest_id: randomUUID(), amount_cents: 3,
    customer_id: 'cus_fixture', payment_method_id: 'pm_fixture', created_at: new Date() };
  const keys = [];
  let results = 0; let frozen = 0;
  const stripe = { accounts, paymentIntents: { async create(params, opts) {
    keys.push(opts.idempotencyKey);
    assert.equal(params.off_session, true); assert.equal(params.confirm, true); assert.equal(params.currency, 'aud');
    return { id: 'pi_fixture', status: 'succeeded' };
  } } };
  const store = { async paymentResult() { results++; }, async freezeCollection() { frozen++; } };
  await collect(store, stripe, collection); await collect(store, stripe, collection);
  assert.equal(keys[0], keys[1]);
  assert.equal(results, 2);
  await collect(store, stripe, { ...collection, created_at: new Date(Date.now() - 21 * 3600000) });
  assert.equal(frozen, 1); assert.equal(keys.length, 2);
  const sql = new Store(poolWith(async () => ({ rows: [] })));
  await sql.claimCollection(config);
  assert.match(sql.pool.queries[1].sql, /interval '1 day'/);
  assert.match(sql.pool.queries[1].sql, /'claimed','pending','uncertain','failed'/);
});
test('payment failure and uncertainty suspend spending; succeeded webhook cannot bill twice', async () => {
  const owner = guest();
  const collection = { id: randomUUID(), guest_id: owner.id, amount_cents: '1', state: 'claimed',
    payment_intent_id: null };
  const pool = poolWith(async (sql, values) => {
    if (sql.startsWith('SELECT guest_id FROM probe_billing.collections')) return { rows: [{ guest_id: owner.id }] };
    if (sql.startsWith('SELECT * FROM probe_billing.guests')) return { rows: [owner] };
    if (sql.startsWith('SELECT * FROM probe_billing.collections')) return { rows: [{ ...collection }] };
    if (sql.includes("SET state='succeeded'")) collection.state = 'succeeded';
    return { rows: [], rowCount: 1 };
  });
  const store = new Store(pool);
  const intent = { id: 'pi_fixture', amount: 1, amount_received: 1, currency: 'aud', livemode: false,
    customer: owner.customer_id, payment_method: owner.payment_method_id, status: 'succeeded',
    metadata: { probe_collection: collection.id, probe_guest: owner.id } };
  await store.paymentResult(collection.id, intent);
  await store.paymentResult(collection.id, intent);
  assert.equal(pool.queries.filter(q => q.sql.includes('INSERT INTO probe_billing.ledger')).length, 1);
  await assert.rejects(store.paymentResult(collection.id, { ...intent, customer: 'cus_other' }), /ownership_mismatch/);
  collection.state = 'claimed';
  await store.paymentResult(collection.id, { ...intent, status: 'requires_action' });
  assert.equal(pool.queries.some(q => q.sql.includes("ELSE 'action_required'")), true);
  let frozen = 0; let uncertain = 0;
  await assert.rejects(collect({ async collectionUncertain() { uncertain++; }, async freezeCollection() { frozen++; } },
    { accounts, paymentIntents: { async create() { throw new Error('network'); } } },
    { ...collection, created_at: new Date() }), /payment_uncertain/);
  assert.equal(uncertain, 1); assert.equal(frozen, 1);
});
test('expired leases retain reservations and never requeue uncertain provider side effects', async () => {
  const pool = poolWith(async () => ({ rows: [] }));
  await new Store(pool).recover();
  assert.equal(pool.queries.some(q => q.sql.includes("state='queued'")), false);
  assert.equal(pool.queries.some(q => q.sql.includes('reserved_micros')), false);
  const storeSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'billing', 'store.js'), 'utf8');
  assert.match(storeSource, /SET state='reconcile',lease_until=NULL/);
  assert.match(storeSource, /job_id=\$1 AND state IN \('started','dispatched'\)/);
});
test('disabled worker performs no DB or external work and raw bodies are bounded buffers', async () => {
  await assert.rejects(tick({}, {}, { enabled: false }, () => { throw new Error('external'); }), /disabled/);
  const request = new PassThrough();
  const promise = readRaw(request, 4);
  request.end(Buffer.from([0xff, 0x00, 0x41]));
  assert.deepEqual(await promise, Buffer.from([0xff, 0x00, 0x41]));
  const large = new PassThrough();
  const rejection = assert.rejects(readRaw(large, 4), /body_too_large/);
  large.end('12345');
  await rejection;
});
test('frontend is opt-in, separated from free scans, same-origin and has no guest URL tokens', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  assert.match(html, /type="checkbox" id="paidOptIn" disabled/);
  assert.doesNotMatch(html, /id="paidOptIn"[^>]*checked/);
  assert.match(script, /credentials: 'same-origin'/);
  assert.match(script, /if \(!optIn.checked \|\| state !== 'active'\)/);
  assert.match(script, /window.location.assign\(url.href\)/);
  assert.match(script, /element\('paidJobs'\).append\(item\)/);
  assert.doesNotMatch(script, /sk_test_|sk_live_|ZYTE_API_KEY/);
});
