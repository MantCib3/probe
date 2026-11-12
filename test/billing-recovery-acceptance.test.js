'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSetupAcceptance, assertAcceptanceEvent, TERMS_HASH, RECOVERY_GUEST } = require('../lib/billing/acceptance');
const { randomUUID } = require('node:crypto');

function fixture() {
  const guest = { currency: 'usd', id: RECOVERY_GUEST, customer_id: 'cus_private', payment_method_id: 'pm_private',
    state: 'action_required', debt_micros: '1000000', paid_micros: '0',
    consent_at: new Date(), expires_at: new Date(Date.now() + 3600000) };
  const recovery = { id: randomUUID(), guest_id: guest.id, customer_id: guest.customer_id,
    collection_id: guest.id, amount_cents: '100', terms_hash: TERMS_HASH,
    state: 'ready', created_at: new Date(), checkout_id: 'cs_fixture', checkout_url: 'https://checkout.stripe.com/c/pay/fixture#complete-fragment' };
  const collection = { currency: 'usd', id: guest.id, guest_id: guest.id, state: 'failed', amount_cents: '100', payment_intent_id: 'pi_old' };
  const queries = [];
  let marker = { scenario: 'authentication', synthetic: true };
  const client = { release() {}, async query(sql, values) {
    queries.push(sql);
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
    if (sql.includes('FROM probe_billing.guests')) return { rows: [guest], rowCount: 1 };
    if (sql.includes('FROM probe_billing.jobs')) return { rows: [{ rate: marker }], rowCount: 1 };
    if (sql.includes('FROM probe_billing.recoveries')) return { rows: [recovery], rowCount: 1 };
    if (sql.includes('FROM probe_billing.collections')) return { rows: [collection], rowCount: 1 };
    if (sql.includes('count(*)')) return { rows: [{ n: recovery.state === 'confirmed' ? 1 : 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  return { guest, recovery, collection, queries,
    pool: { async connect() { return client; }, query: client.query },
    changeMarker(value) { marker = value; } };
}
const input = action => ({ action, guestId: RECOVERY_GUEST, confirmation: 'stripe-test-recovery-one-checkout-v1' });
test('sandbox recovery status is read-only, exposes safe counts and admits only the original synthetic authentication fixture', async () => {
  const f = fixture();
  const result = await runSetupAcceptance(f.pool, {}, input('recovery-status'));
  assert.equal(result.recoveryVerified, false);
  assert.equal(result.paidExecutionEnabled, false);
  assert.equal(result.spendingCapMicros, 0);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(f.queries.some(sql => /INSERT|UPDATE|DELETE/.test(sql)), false);
  for (const patch of [{ guestId: randomUUID() }, { action: 'pay' }, { amount: 100 }, { confirmation: 'wrong' }]) {
    await assert.rejects(runSetupAcceptance(f.pool, {}, { ...input('recovery-start'), ...patch }), /invalid_acceptance_confirmation/);
  }
  f.changeMarker({ scenario: 'decline', synthetic: true });
  await assert.rejects(runSetupAcceptance(f.pool, {}, input('recovery-status')), /recovery_acceptance_fixture_required/);
});
test('ready checkout returns its full URL without provider calls; completed/uncertain/expired runs cannot start another checkout', async () => {
  const f = fixture();
  const result = await runSetupAcceptance(f.pool, {}, input('recovery-start'));
  assert.equal(result.url, f.recovery.checkout_url);
  for (const state of ['confirmed','uncertain','expired','creating']) {
    f.recovery.state = state;
    await assert.rejects(runSetupAcceptance(f.pool, {}, input('recovery-start')), /already_started/);
  }
  f.recovery.state = 'ready';
  await assert.rejects(runSetupAcceptance(f.pool, {}, input('recovery-resume')), /not_verified/);
});
test('locked webhook recovery admits new test card only for exact owned amount, terms, guest and checkout; authoritative retrieval still follows', async () => {
  const f = fixture();
  const object = { id: 'cs_fixture', mode: 'payment', amount_total: 100, currency: 'usd',
    customer: f.guest.customer_id, metadata: { probe_recovery: f.recovery.id,
      probe_guest: RECOVERY_GUEST, probe_collection: RECOVERY_GUEST, probe_terms: TERMS_HASH } };
  const event = { type: 'checkout.session.completed', livemode: false, data: { object } };
  await assertAcceptanceEvent(f.pool, event);
  for (const patch of [{ amount_total: 101 }, { currency: 'aud' }, { id: 'cs_other' }, { mode: 'setup' },
    { customer: 'cus_other' }, { metadata: { ...object.metadata, probe_terms: 'b'.repeat(64) } },
    { metadata: { ...object.metadata, probe_guest: randomUUID() } }]) {
    await assert.rejects(assertAcceptanceEvent(f.pool, { ...event, data: { object: { ...object, ...patch } } }));
  }
  const intent = { ...object, id: 'pi_new', amount: 100, payment_method: 'pm_new' };
  await assertAcceptanceEvent(f.pool, { ...event, type: 'payment_intent.succeeded', data: { object: intent } });
  await assert.rejects(assertAcceptanceEvent(f.pool, { ...event, livemode: true }));
  await assert.rejects(assertAcceptanceEvent(f.pool, { ...event, account: 'acct_connect' }));
  await assert.rejects(assertAcceptanceEvent(f.pool, { ...event, type: 'unrelated' }));
});
test('replacement status verifies a changed card without charges; ready checkout reuses its full URL and blocks another setup', async () => {
  const f = fixture();
  f.guest.state = 'action_required';
  f.guest.debt_micros = '0';
  f.guest.paid_micros = '1000000';
  f.recovery.state = 'confirmed';
  f.collection.state = 'succeeded';
  f.collection.payment_method_id = 'pm_old';
  const setup = { id: randomUUID(), state: 'ready', terms_hash: TERMS_HASH,
    created_at: new Date(), checkout_id: 'cs_replacement',
    checkout_url: 'https://checkout.stripe.com/c/pay/replacement#full-fragment' };
  const baseQuery = f.pool.query;
  const query = async (sql, values) => {
    if (sql.includes('FROM probe_billing.setups')) return { rows: [setup], rowCount: 1 };
    if (sql.startsWith('SELECT id FROM probe_billing.recoveries')) return { rows: [], rowCount: 0 };
    return baseQuery(sql, values);
  };
  f.pool.query = query;
  f.pool.connect = async () => ({ query, release() {} });
  const request = action => ({ action, guestId: RECOVERY_GUEST, confirmation: 'stripe-test-replacement-one-setup-v1' });
  const ready = await runSetupAcceptance(f.pool, {}, request('replacement-start'));
  assert.equal(ready.url, setup.checkout_url);
  assert.equal(ready.replacementVerified, false);
  for (const state of ['confirmed','uncertain','expired','creating']) {
    setup.state = state;
    await assert.rejects(runSetupAcceptance(f.pool, {}, request('replacement-start')), /already_started/);
  }
  setup.state = 'confirmed';
  const verified = await runSetupAcceptance(f.pool, {}, request('replacement-status'));
  assert.equal(verified.replacementVerified, true);
  assert.equal(verified.cardChanged, true);
  assert.equal(verified.paymentLedgerEntries, 1);
  assert.equal(verified.guestState, 'action_required');
  assert.equal(verified.spendingCapMicros, 0);
  assert.equal(JSON.stringify(verified).includes('private'), false);
  f.collection.payment_method_id = f.guest.payment_method_id;
  assert.equal((await runSetupAcceptance(f.pool, {}, request('replacement-status'))).replacementVerified, false);
  await assert.rejects(runSetupAcceptance(f.pool, {}, request('replacement-resume')), /not_verified/);
  await assert.rejects(runSetupAcceptance(f.pool, {}, { ...request('replacement-start'), guestId: randomUUID() }), /invalid_acceptance/);
});
