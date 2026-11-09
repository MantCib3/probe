'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSetupAcceptance, assertAcceptanceEvent, TERMS_HASH, RECOVERY_GUEST } = require('../lib/billing/acceptance');
const { randomUUID } = require('node:crypto');

function fixture() {
  const guest = { id: RECOVERY_GUEST, customer_id: 'cus_private', payment_method_id: 'pm_private',
    state: 'action_required', debt_micros: '1000000', paid_micros: '0',
    consent_at: new Date(), expires_at: new Date(Date.now() + 3600000) };
  const recovery = { id: randomUUID(), guest_id: guest.id, customer_id: guest.customer_id,
    collection_id: guest.id, amount_cents: '100', terms_hash: TERMS_HASH,
    state: 'ready', created_at: new Date(), checkout_id: 'cs_fixture', checkout_url: 'https://checkout.stripe.com/c/pay/fixture#complete-fragment' };
  const collection = { id: guest.id, guest_id: guest.id, state: 'failed', amount_cents: '100', payment_intent_id: 'pi_old' };
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
  const object = { id: 'cs_fixture', mode: 'payment', amount_total: 100, currency: 'aud',
    customer: f.guest.customer_id, metadata: { probe_recovery: f.recovery.id,
      probe_guest: RECOVERY_GUEST, probe_collection: RECOVERY_GUEST, probe_terms: TERMS_HASH } };
  const event = { type: 'checkout.session.completed', livemode: false, data: { object } };
  await assertAcceptanceEvent(f.pool, event);
  for (const patch of [{ amount_total: 101 }, { currency: 'usd' }, { id: 'cs_other' }, { mode: 'setup' },
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
