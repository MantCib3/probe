'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { acceptanceAllowed, runSetupAcceptance, runPaymentAcceptance, assertAcceptanceEvent, TERMS_HASH } = require('../lib/billing/acceptance');

test('sandbox acceptance requires disabled spending, test credentials and signing secret', () => {
  const env = { PROBE_STAGING: '1', PAID_INFRA_ENABLED: '0', PAID_WORKER_ENABLED: '0',
    PAID_MONEY_PATH_VERIFIED: '0', STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture' };
  assert.equal(acceptanceAllowed(env), true);
  for (const key of Object.keys(env)) assert.equal(acceptanceAllowed({ ...env, [key]: '' }), false);
  assert.equal(acceptanceAllowed({ ...env, STRIPE_SECRET_KEY: 'sk_live_fixture' }), false);
  assert.equal(acceptanceAllowed({ ...env, RENDER: '1', RENDER_SERVICE_NAME: 'probe' }), false);
});

test('acceptance status proves a signed setup event without exposing payment or customer records', async () => {
  const id = randomUUID();
  const queried = [];
  const pool = { async query(sql, values) {
    queried.push(sql);
    if (sql.includes('SELECT * FROM probe_billing.guests')) {
      assert.equal(values[0], id);
      assert.equal(values[1], createHash('sha256').update(`probe-stripe-acceptance:${id}`).digest('hex'));
      assert.equal(values[2], TERMS_HASH);
      assert.match(sql, /cap_micros=0/);
      return { rows: [{ currency: 'usd', id, state: 'active', customer_id: 'cus_private', payment_method_id: 'pm_private' }] };
    }
    if (sql.includes('SELECT state,checkout_id')) return { rows: [{ state: 'confirmed', checkout_id: 'cs_test_fixture' }] };
    return { rows: [{ n: 1 }] };
  } };
  const result = await runSetupAcceptance(pool, {}, { action: 'status', guestId: id, confirmation: 'stripe-test-setup-only-v1' });
  assert.equal(result.setupVerified, true);
  assert.equal(result.paymentAcceptanceVerified, false);
  assert.equal(result.spendingCapMicros, 0);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(queried.some(sql => /INSERT|UPDATE|DELETE/.test(sql)), false);
  await assert.rejects(runSetupAcceptance(pool, {}, { action: 'collect', guestId: id, confirmation: 'stripe-test-setup-only-v1' }), /invalid_acceptance_confirmation/);
});

test('disabled public webhook admits only exact owned zero-cap acceptance setup objects', async () => {
  const guestId = randomUUID();
  const setupId = randomUUID();
  const event = { livemode: false, type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_fixture', metadata: { probe_setup: setupId } } } };
  let found = true;
  let zeroCap = true;
  const pool = { async query(sql, values) {
    if (sql.includes('FROM probe_billing.setups')) {
      assert.equal(values[1], TERMS_HASH);
      return { rows: found ? [{ guest_id: guestId, checkout_id: 'cs_test_fixture' }] : [] };
    }
    assert.match(sql, /cap_micros=0/);
    return { rows: zeroCap ? [{ currency: 'usd', id: guestId }] : [] };
  } };
  await assertAcceptanceEvent(pool, event);
  for (const type of ['unrelated']) {
    await assert.rejects(assertAcceptanceEvent(pool, { ...event, type }), /acceptance_setup_event_required/);
  }
  await assert.rejects(assertAcceptanceEvent(pool, { ...event, type: 'payment_intent.succeeded' }), /acceptance_collection_required/);
  await assert.rejects(assertAcceptanceEvent(pool, { ...event, livemode: true }), /acceptance_setup_event_required/);
  await assert.rejects(assertAcceptanceEvent(pool, { ...event, account: 'acct_connect' }), /acceptance_setup_event_required/);
  found = false;
  await assert.rejects(assertAcceptanceEvent(pool, event), /acceptance_fixture_required/);
  found = true; zeroCap = false;
  await assert.rejects(assertAcceptanceEvent(pool, event), /acceptance_fixture_required/);
});

test('sandbox payment webhooks require exact synthetic collection, customer, method, amount and zero-cap fixture', async () => {
  const id = randomUUID();
  const intent = { id: 'pi_fixture', amount: 100, currency: 'usd', customer: 'cus_fixture',
    payment_method: 'pm_fixture', metadata: { probe_collection: id, probe_guest: id } };
  const event = { livemode: false, type: 'payment_intent.succeeded', data: { object: intent } };
  const pool = { async query(sql) {
    if (sql.includes('FROM probe_billing.collections')) return { rows: [{ currency: 'usd', id, guest_id: id, amount_cents: '100', payment_intent_id: 'pi_fixture' }] };
    assert.match(sql, /cap_micros=0/);
    return { rows: [{ currency: 'usd', id, customer_id: 'cus_fixture', payment_method_id: 'pm_fixture' }] };
  } };
  await assertAcceptanceEvent(pool, event);
  for (const changes of [{ amount: 101 }, { currency: 'aud' }, { customer: 'cus_other' },
    { payment_method: 'pm_other' }, { id: 'pi_other' }, { metadata: { probe_collection: id, probe_guest: randomUUID() } }]) {
    await assert.rejects(assertAcceptanceEvent(pool, { ...event, data: { object: { ...intent, ...changes } } }), /acceptance_collection_required/);
  }
});

test('payment acceptance reuses durable collection and simulates unknown response without retrying a new key', async () => {
  for (const scenario of ['success', 'decline', 'authentication', 'unknown']) {
    const id = randomUUID();
    const guest = { currency: 'usd', id, state: 'active', debt_micros: '0', paid_micros: '0',
      customer_id: scenario === 'success' ? 'cus_fixture' : null,
      payment_method_id: scenario === 'success' ? 'pm_fixture' : null, cap_micros: '0' };
    let collection;
    let ledger = 0;
    let creates = 0;
    let frozen = 0;
    const client = { async query(sql, values) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('FROM probe_billing.setups')) return { rows: scenario === 'success' ? [{ state: 'confirmed' }] : [], rowCount: scenario === 'success' ? 1 : 0 };
      if (sql.includes('FROM probe_billing.jobs')) return { rows: [{ rate: { scenario, synthetic: true } }] };
      if (sql.includes('SELECT guest_id FROM probe_billing.collections')) return { rows: [{ guest_id: id }] };
      if (sql.includes('FROM probe_billing.guests')) return { rows: [guest] };
      if (sql.includes('SELECT * FROM probe_billing.collections')) return { rows: collection ? [collection] : [] };
      if (sql.includes('INSERT INTO probe_billing.collections')) collection = {
        currency: 'usd', id, guest_id: id, amount_cents: '100', state: 'claimed', created_at: new Date() };
      if (sql.includes('SET debt_micros=1000000')) guest.debt_micros = '1000000';
      if (sql.includes('SET customer_id=$2')) guest.customer_id = values[1];
      if (sql.includes('SET payment_method_id=$2')) guest.payment_method_id = values[1];
      if (sql.includes('INSERT INTO probe_billing.ledger')) ledger++;
      if (sql.includes('debt_micros=debt_micros-$2')) { guest.debt_micros = '0'; guest.paid_micros = '1000000'; }
      if (sql.includes("SET state='succeeded'")) { collection.state = 'succeeded'; collection.payment_intent_id = values[1]; }
      if (sql.includes("SET state='failed'")) { collection.state = 'failed'; collection.payment_intent_id = values[1]; }
      if (sql.includes("SET state='uncertain'")) collection.state = 'uncertain';
      if (sql.includes("ELSE 'action_required'")) { guest.state = 'action_required'; frozen++; }
      if (sql.includes('FROM probe_billing.ledger')) return { rows: [{ n: ledger }] };
      if (sql.includes('FROM probe_billing.payment_events')) return { rows: [{ n: 0 }] };
      return { rows: [], rowCount: 1 };
    }, release() {} };
    const pool = { connect: async () => client, query: (sql, values) => client.query(sql, values) };
    const intent = { id: 'pi_fixture', livemode: false, amount: 100, amount_received: 100,
      currency: 'usd', customer: 'cus_fixture', payment_method: 'pm_fixture',
      metadata: { probe_collection: id, probe_guest: id },
      status: ['success', 'unknown'].includes(scenario) ? 'succeeded' : scenario === 'decline' ? 'requires_payment_method' : 'requires_action' };
    if (scenario === 'decline') {
      intent.payment_method = null;
      intent.last_payment_error = { code: 'card_declined', payment_method: { id: 'pm_fixture' } };
    }
    const stripe = { accounts: { retrieve: async () => ({ country: 'AU', default_currency: 'aud' }) },
      customers: { async create(params, options) {
        assert.equal(options.idempotencyKey, `probe-acceptance-customer-${id}`);
        return { id: 'cus_fixture' };
      } },
      paymentMethods: { async attach(method, params, options) {
        assert.equal(method, scenario === 'decline' ? 'pm_card_chargeCustomerFail' :
          scenario === 'authentication' ? 'pm_card_authenticationRequired' : 'pm_card_visa');
        assert.equal(params.customer, 'cus_fixture');
        assert.match(options.idempotencyKey, /probe-acceptance-method-/);
        return { id: 'pm_fixture', type: 'card', livemode: false, customer: 'cus_fixture' };
      } },
      paymentMethodConfigurations: { async list() { return { has_more: false, data: [{
        id: 'pmc_fixture', name: 'PROBE sandbox card-only setup v1', active: true, livemode: false,
        card: { available: true, display_preference: { value: 'on' } },
      }] }; } },
      paymentIntents: { async create(params, options) {
        creates++;
        assert.equal(params.amount, 100);
        assert.equal(params.payment_method_configuration, 'pmc_fixture');
        assert.equal(Object.hasOwn(params, 'payment_method_types'), false);
        assert.equal(options.idempotencyKey, `probe-collection-${id}`);
        return intent;
      }, retrieve: async () => intent } };
    const input = { guestId: id, action: 'pay', scenario, confirmation: 'stripe-test-payments-v1' };
    const first = await runSetupAcceptance(pool, stripe, input);
    if (scenario === 'unknown') {
      assert.equal(first.collectionState, 'uncertain');
      assert.equal(first.guestState, 'action_required');
      assert.equal(ledger, 0);
    }
    const second = await runSetupAcceptance(pool, stripe, input);
    assert.equal(second.collectionState, ['success', 'unknown'].includes(scenario) ? 'succeeded' : 'failed');
    assert.equal(ledger, ['success', 'unknown'].includes(scenario) ? 1 : 0);
    assert.equal(creates, scenario === 'unknown' ? 2 : 1);
    if (!['success', 'unknown'].includes(scenario)) assert.ok(frozen > 0);
    const third = await runSetupAcceptance(pool, stripe, input);
    assert.equal(third.paymentLedgerEntries, ledger);
    assert.equal(creates, scenario === 'unknown' ? 2 : 1);
  }
});

test('sandbox payment acceptance refuses concurrent runs and arbitrary scenarios', async () => {
  const input = { guestId: randomUUID(), action: 'pay', scenario: 'success', confirmation: 'stripe-test-payments-v1' };
  const pool = { connect: async () => ({ query: async () => ({ rows: [{ locked: false }] }), release() {} }) };
  await assert.rejects(runPaymentAcceptance(pool, {}, input), /acceptance_in_progress/);
  await assert.rejects(runPaymentAcceptance(pool, {}, { ...input, scenario: 'custom' }), /invalid_acceptance_confirmation/);
});

test('rejected-request repair refuses an existing Stripe payment or incomplete lookup', async () => {
  for (const page of [{ has_more: true, data: [] }, { has_more: false, data: [{ metadata: {} }] }]) {
    const id = randomUUID();
    if (page.data.length) page.data[0].metadata.probe_collection = id;
    let writes = 0;
    const client = { async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('FROM probe_billing.guests')) return { rows: [{ currency: 'usd', id, customer_id: 'cus_fixture', paid_micros: '0' }] };
      if (sql.includes('FROM probe_billing.jobs')) return { rows: [{ rate: {
        scenario: 'success', rejectedRequest: { type: 'StripeIdempotencyError' } } }] };
      if (sql.includes('FROM probe_billing.collections')) return { rows: [{ state: 'uncertain', payment_intent_id: null }] };
      if (sql.includes('UPDATE')) writes++;
      return { rows: [] };
    }, release() {} };
    const pool = { connect: async () => client, query: sql => client.query(sql) };
    await assert.rejects(runSetupAcceptance(pool, { paymentIntents: { list: async () => page } },
      { action: 'repair-rejected', guestId: id, scenario: 'success', confirmation: 'stripe-test-payments-v1' }),
    /payment_exists_or_lookup_incomplete/);
    assert.equal(writes, 0);
  }
});
