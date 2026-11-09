'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { accountingCheckAllowed } = require('../../scripts/billing-accounting-check');
const { Store, problem } = require('./store');
const { CONSENT_VERSION } = require('./config');
const { startSetup, UUID } = require('./stripe');

const TERMS_HASH = createHash('sha256').update('probe-stripe-acceptance-setup-v1').digest('hex');
const tokenHash = id => createHash('sha256').update(`probe-stripe-acceptance:${id}`).digest('hex');
function acceptanceAllowed(env) {
  return accountingCheckAllowed(env) &&
    /^sk_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY || '') &&
    /^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET || '');
}
async function fixtureGuest(pool, id) {
  if (!UUID.test(id || '')) throw problem('invalid_acceptance_fixture', 400);
  const guest = (await pool.query(`SELECT * FROM probe_billing.guests
    WHERE id=$1 AND token_hash=$2 AND terms_hash=$3 AND cap_micros=0`,
  [id, tokenHash(id), TERMS_HASH])).rows[0];
  if (!guest) throw problem('acceptance_fixture_required', 403);
  return guest;
}
async function runSetupAcceptance(pool, stripe, input) {
  if (!input || !UUID.test(input.guestId || '') || !['start', 'status'].includes(input.action) ||
      input.confirmation !== 'stripe-test-setup-only-v1' || Object.keys(input).length !== 3) {
    throw problem('invalid_acceptance_confirmation', 400);
  }
  const id = input.guestId;
  const store = new Store(pool);
  if (input.action === 'start') {
    // Operator UUID is also the retry key; a lost HTTP response never creates another guest.
    await pool.query(`INSERT INTO probe_billing.guests(id,token_hash,csrf_hash,terms_hash,cap_micros)
      VALUES($1,$2,$3,$4,0) ON CONFLICT(id) DO NOTHING`,
    [id, tokenHash(id), createHash('sha256').update(randomBytes(32)).digest('hex'), TERMS_HASH]);
    await fixtureGuest(pool, id);
    const url = await startSetup(store, stripe, id, {
      consentVersion: CONSENT_VERSION, termsHash: TERMS_HASH,
      origin: 'https://probe-staging.onrender.com',
      setupMessage: 'PROBE operator sandbox acceptance only. Use a Stripe test card, never a real card. No supplier checks or usage charges are enabled.',
    });
    return { guestId: id, url, sandbox: true, spendingCapMicros: 0, paidExecutionEnabled: false };
  }
  const guest = await fixtureGuest(pool, id);
  const setup = (await pool.query(`SELECT state,checkout_id FROM probe_billing.setups
    WHERE guest_id=$1 AND terms_hash=$2 ORDER BY created_at DESC LIMIT 1`, [id, TERMS_HASH])).rows[0];
  const events = setup?.checkout_id ? (await pool.query(`SELECT count(*)::int AS n
    FROM probe_billing.payment_events WHERE object_id=$1 AND event_type IN
    ('checkout.session.completed','checkout.session.async_payment_succeeded')`, [setup.checkout_id])).rows[0].n : 0;
  return { guestId: id, setupState: setup?.state || 'absent', guestState: guest.state,
    signedSetupEvents: events, setupVerified: setup?.state === 'confirmed' && guest.state === 'active' && events > 0,
    paidExecutionEnabled: false, spendingCapMicros: 0, paymentAcceptanceVerified: false };
}
async function assertAcceptanceEvent(pool, event) {
  if (event.livemode !== false || event.account ||
      !['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired'].includes(event.type)) {
    throw problem('acceptance_setup_event_required', 400);
  }
  const object = event.data?.object;
  if (!UUID.test(object?.metadata?.probe_setup || '')) throw problem('acceptance_fixture_required', 403);
  const setup = (await pool.query(`SELECT guest_id,checkout_id FROM probe_billing.setups
    WHERE id=$1 AND terms_hash=$2`, [object.metadata.probe_setup, TERMS_HASH])).rows[0];
  if (!setup || setup.checkout_id !== object.id) throw problem('acceptance_fixture_required', 403);
  await fixtureGuest(pool, setup.guest_id);
}

module.exports = { acceptanceAllowed, runSetupAcceptance, assertAcceptanceEvent, TERMS_HASH };
