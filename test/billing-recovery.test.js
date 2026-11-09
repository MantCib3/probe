'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startRecovery, processWebhook } = require('../lib/billing/stripe');
const { Store } = require('../lib/billing/store');

const config = { origin: 'https://staging.example.test', termsHash: 'a'.repeat(64) };
function fixture() {
  const recovery = { id: randomUUID(), guest_id: randomUUID(), collection_id: randomUUID(),
    prior_payment_intent_id: 'pi_old', customer_id: 'cus_fixture', payment_method_id: 'pm_old',
    state: 'creating', amount_cents: '100', terms_hash: config.termsHash };
  const prior = { id: 'pi_old', status: 'requires_payment_method', livemode: false, customer: recovery.customer_id,
    currency: 'aud', amount: 100, payment_method: null, last_payment_error: { payment_method: 'pm_old' },
    metadata: { probe_guest: recovery.guest_id, probe_collection: recovery.collection_id } };
  const checkout = { id: 'cs_fixture', livemode: false, url: 'https://checkout.stripe.com/c/pay/fixture#full-fragment',
    mode: 'payment', status: 'complete', payment_status: 'paid', payment_intent: 'pi_new',
    customer: recovery.customer_id, currency: 'aud', amount_total: 100,
    metadata: { probe_guest: recovery.guest_id, probe_collection: recovery.collection_id,
      probe_recovery: recovery.id, probe_terms: config.termsHash } };
  const intent = { ...prior, id: 'pi_new', status: 'succeeded', amount_received: 100,
    payment_method: 'pm_new', setup_future_usage: 'off_session', metadata: checkout.metadata };
  const method = { id: 'pm_new', customer: recovery.customer_id, type: 'card', livemode: false };
  const calls = [];
  const store = {
    async prepareRecovery() { calls.push('prepare'); return recovery; },
    async recoveryReady(id, session) { calls.push('ready'); assert.equal(id, recovery.id); recovery.state = 'ready'; recovery.checkout_url = session.url; },
    async recoveryUncertain() { calls.push('uncertain'); },
    async recoveryResolved() { calls.push('resolved'); },
    async recoveryForCheckout() { return recovery; },
    async confirmRecovery(event, session, payment, card) { calls.push('confirm'); assert.deepEqual([session, payment, card], [checkout, intent, method]); },
    async expireRecovery() { calls.push('expired'); },
    async paymentResult() { calls.push('accounting'); },
  };
  const stripe = {
    accounts: { async retrieve() { return { country: 'AU', default_currency: 'aud' }; } },
    paymentMethodConfigurations: { async list() { return { has_more: false, data: [{
      id: 'pmc_fixture', name: 'PROBE sandbox card-only setup v1', active: true, livemode: false,
      card: { available: true, display_preference: { value: 'on' } },
    }] }; } },
    paymentIntents: {
      async retrieve(id) { calls.push('retrieve'); return id === 'pi_old' ? prior : intent; },
      async cancel(id, params, options) {
        calls.push('cancel');
        assert.equal(id, prior.id);
        assert.equal(options.idempotencyKey, `probe-recovery-cancel-${recovery.id}`);
        return { ...prior, status: 'canceled' };
      },
    },
    paymentMethods: { async retrieve() { return method; } },
    checkout: { sessions: {
      async create(params, options) {
        calls.push('create');
        assert.equal(params.mode, 'payment');
        assert.equal(params.line_items[0].price_data.unit_amount, 100);
        assert.equal(params.line_items[0].price_data.currency, 'aud');
        assert.equal(params.customer, recovery.customer_id);
        assert.equal(params.payment_intent_data.setup_future_usage, 'off_session');
        assert.equal(params.payment_method_configuration, 'pmc_fixture');
        assert.deepEqual(params.payment_intent_data.metadata, checkout.metadata);
        assert.equal(options.idempotencyKey, `probe-recovery-checkout-${recovery.id}`);
        return checkout;
      },
      async retrieve() { return checkout; },
      async list(params) { assert.deepEqual(params, { payment_intent: intent.id, limit: 2 }); return { data: [checkout], has_more: false }; },
    } },
  };
  return { recovery, prior, checkout, intent, method, store, stripe, calls };
}
test('hosted debt recovery cancels the owned failed intent before creating one fixed checkout and reuses its full URL', async () => {
  const f = fixture();
  assert.equal(await startRecovery(f.store, f.stripe, f.recovery.guest_id, config), f.checkout.url);
  assert.deepEqual(f.calls, ['prepare','retrieve','cancel','create','ready']);
  assert.equal(await startRecovery(f.store, f.stripe, f.recovery.guest_id, config), f.checkout.url);
  assert.equal(f.calls.filter(call => call === 'create').length, 1);
});
test('unknown/foreign/live payments and uncertain cancellation never start a second payment', async () => {
  for (const patch of [{ status: 'processing' }, { livemode: true }, { customer: 'cus_foreign' },
    { amount: 200 }, { metadata: {} }, { payment_method: 'pm_foreign' }]) {
    const f = fixture();
    Object.assign(f.prior, patch);
    await assert.rejects(startRecovery(f.store, f.stripe, f.recovery.guest_id, config));
    assert.equal(f.calls.includes('create'), false);
    assert.equal(f.calls.includes('uncertain'), true);
  }
  const f = fixture();
  f.stripe.paymentIntents.cancel = async () => { throw new Error('lost response'); };
  await assert.rejects(startRecovery(f.store, f.stripe, f.recovery.guest_id, config), /recovery_pending/);
  assert.equal(f.calls.includes('create'), false);
});
test('already-paid prior intent is reconciled instead of charging again; checkout response loss freezes recovery', async () => {
  const f = fixture();
  Object.assign(f.prior, { status: 'succeeded', payment_method: 'pm_old', amount_received: 100 });
  await assert.rejects(startRecovery(f.store, f.stripe, f.recovery.guest_id, config), /already_settled/);
  assert.equal(f.calls.includes('accounting'), true);
  assert.equal(f.calls.includes('resolved'), true);
  assert.equal(f.calls.includes('create'), false);
  const lost = fixture();
  lost.stripe.checkout.sessions.create = async () => { throw new Error('lost checkout response'); };
  await assert.rejects(startRecovery(lost.store, lost.stripe, lost.recovery.guest_id, config));
  assert.equal(lost.calls.includes('uncertain'), true);
});
test('signed recovery notifications retrieve authoritative paid checkout, intent and card; early payment events recover missing checkout storage', async () => {
  for (const type of ['checkout.session.completed','payment_intent.succeeded']) {
    const f = fixture();
    const object = type.startsWith('checkout') ? f.checkout : f.intent;
    await processWebhook(f.store, f.stripe, { id: 'evt_fixture', livemode: false, type, data: { object } });
    assert.equal(f.calls.includes('confirm'), true);
    assert.equal(f.calls.includes('accounting'), false);
  }
});
test('unpaid checkout, unverified card and mismatched recovery payment cannot settle debt', async () => {
  for (const field of ['checkout','intent','method']) {
    const f = fixture();
    if (field === 'checkout') f.checkout.payment_status = 'unpaid';
    if (field === 'intent') f.intent.amount_received = 99;
    if (field === 'method') f.method.livemode = true;
    await assert.rejects(processWebhook(f.store, f.stripe, { id: 'evt_bad', livemode: false,
      type: 'checkout.session.completed', data: { object: f.checkout } }));
    assert.equal(f.calls.includes('confirm'), false);
  }
  const f = fixture();
  f.intent.customer = 'cus_other';
  await assert.rejects(processWebhook(f.store, f.stripe, { id: 'evt_bad', livemode: false,
    type: 'payment_intent.succeeded', data: { object: f.intent } }), /ownership/);
});
test('checkout failure remains recoverable in Stripe, expiry is authoritative, incomplete checkout lookup fails closed', async () => {
  const f = fixture();
  f.intent.status = 'requires_action';
  await processWebhook(f.store, f.stripe, { id: 'evt_pending', livemode: false,
    type: 'payment_intent.requires_action', data: { object: f.intent } });
  assert.equal(f.calls.includes('confirm'), false);
  f.checkout.status = 'expired';
  await processWebhook(f.store, f.stripe, { id: 'evt_expired', livemode: false,
    type: 'checkout.session.expired', data: { object: f.checkout } });
  assert.equal(f.calls.includes('expired'), true);
  const incomplete = fixture();
  incomplete.stripe.checkout.sessions.list = async () => ({ data: [incomplete.checkout], has_more: true });
  await assert.rejects(processWebhook(incomplete.store, incomplete.stripe, { id: 'evt_pending', livemode: false,
    type: 'payment_intent.succeeded', data: { object: incomplete.intent } }), /operator_review/);
});
function sqlPool(guest, blocked = false) {
  const queries = [];
  const client = { release() {}, async query(sql, values) {
    queries.push({ sql, values });
    if (sql.includes('SELECT * FROM probe_billing.guests')) return { rows: [guest], rowCount: 1 };
    if (sql.includes('UNION ALL')) return { rows: blocked ? [{ id: 'pending' }] : [], rowCount: blocked ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  } };
  return { queries, async connect() { return client; } };
}
test('explicit resume rejects revoked/expired sessions, debt, reservations and unresolved external effects', async () => {
  const guest = { id: randomUUID(), state: 'action_required', customer_id: 'cus_fixture', payment_method_id: 'pm_fixture',
    consent_at: new Date(), expires_at: new Date(Date.now() + 3600000), debt_micros: '0', reserved_micros: '0' };
  for (const patch of [{ state: 'revoked' }, { expires_at: new Date(0) }, { debt_micros: '10000' },
    { reserved_micros: '1' }, { payment_method_id: null }]) {
    const pool = sqlPool({ ...guest, ...patch });
    await assert.rejects(new Store(pool).resume(guest.id, config));
    assert.equal(pool.queries.some(q => q.sql.includes("SET state='active'")), false);
  }
  await assert.rejects(new Store(sqlPool(guest, true)).resume(guest.id, config), /recovery_not_complete/);
  const pool = sqlPool({ ...guest, debt_micros: '9999' });
  await new Store(pool).resume(guest.id, config);
  assert.equal(pool.queries.some(q => q.sql.includes("SET state='active'")), true);
  assert.equal(pool.queries.some(q => q.sql.includes('cap_micros=')), false);
});
