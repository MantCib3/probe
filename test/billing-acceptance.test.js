'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { acceptanceAllowed, runSetupAcceptance, assertAcceptanceEvent, TERMS_HASH } = require('../lib/billing/acceptance');

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
      return { rows: [{ id, state: 'active', customer_id: 'cus_private', payment_method_id: 'pm_private' }] };
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
    return { rows: zeroCap ? [{ id: guestId }] : [] };
  } };
  await assertAcceptanceEvent(pool, event);
  for (const type of ['payment_intent.succeeded', 'unrelated']) {
    await assert.rejects(assertAcceptanceEvent(pool, { ...event, type }), /acceptance_setup_event_required/);
  }
  await assert.rejects(assertAcceptanceEvent(pool, { ...event, livemode: true }), /acceptance_setup_event_required/);
  await assert.rejects(assertAcceptanceEvent(pool, { ...event, account: 'acct_connect' }), /acceptance_setup_event_required/);
  found = false;
  await assert.rejects(assertAcceptanceEvent(pool, event), /acceptance_fixture_required/);
  found = true; zeroCap = false;
  await assert.rejects(assertAcceptanceEvent(pool, event), /acceptance_fixture_required/);
});
