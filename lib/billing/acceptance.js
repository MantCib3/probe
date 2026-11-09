'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { accountingCheckAllowed } = require('../../scripts/billing-accounting-check');
const { Store, problem, intentPaymentMethodId } = require('./store');
const { CONSENT_VERSION } = require('./config');
const { startSetup, collect, UUID, assertAustralianAccount } = require('./stripe');
const { transaction } = require('./db');

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
  if (input?.confirmation === 'stripe-test-payments-v1') return runPaymentAcceptance(pool, stripe, input);
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
async function runPaymentAcceptance(pool, stripe, input) {
  if (!UUID.test(input.guestId || '') || !['pay', 'payment-status', 'repair-rejected'].includes(input.action) ||
      !['success', 'decline', 'authentication', 'unknown'].includes(input.scenario) ||
      input.confirmation !== 'stripe-test-payments-v1' || Object.keys(input).length !== 4) {
    throw problem('invalid_acceptance_confirmation', 400);
  }
  const id = input.guestId;
  const guard = await pool.connect();
  let locked = false;
  try {
    locked = (await guard.query('SELECT pg_try_advisory_lock(724196383,hashtext($1)) AS locked', [id])).rows[0].locked;
    if (!locked) throw problem('acceptance_in_progress', 409);
    const store = new Store(pool);
    if (input.action === 'repair-rejected') {
      const guest = await fixtureGuest(pool, id);
      const run = (await pool.query(`SELECT rate FROM probe_billing.jobs WHERE id=$1 AND guest_id=$1
        AND source='StripeAcceptanceFixture' AND terms_hash=$2`, [id, TERMS_HASH])).rows[0];
      const collection = (await pool.query('SELECT * FROM probe_billing.collections WHERE id=$1 AND guest_id=$1', [id])).rows[0];
      if (input.scenario !== 'success' || run?.rate?.scenario !== 'success' ||
          run.rate.rejectedRequest?.type !== 'StripeIdempotencyError' || run.rate.stripeRequestVersion ||
          !collection || collection.state !== 'uncertain' || collection.payment_intent_id ||
          guest.paid_micros !== '0') throw problem('definitive_rejected_fixture_required', 409);
      const page = await stripe.paymentIntents.list({ customer: guest.customer_id, limit: 100 });
      if (page.has_more || page.data.some(item => item.metadata?.probe_collection === id)) {
        throw problem('payment_exists_or_lookup_incomplete', 409);
      }
      // Only the definitively rejected zero-cap sandbox fixture may use a corrected request key.
      await pool.query(`UPDATE probe_billing.jobs SET rate=jsonb_set(rate,'{stripeRequestVersion}','2'::jsonb)
        WHERE id=$1`, [id]);
    }
    if (['pay', 'repair-rejected'].includes(input.action)) {
      await assertAustralianAccount(stripe);
      if (input.scenario !== 'success') {
        await pool.query(`INSERT INTO probe_billing.guests(id,token_hash,csrf_hash,terms_hash,cap_micros)
          VALUES($1,$2,$3,$4,0) ON CONFLICT(id) DO NOTHING`,
        [id, tokenHash(id), createHash('sha256').update(randomBytes(32)).digest('hex'), TERMS_HASH]);
      }
      const fixture = await fixtureGuest(pool, id);
      await pool.query(`INSERT INTO probe_billing.jobs
        (id,guest_id,request_key,source,rate,terms_hash,reservation_micros,state)
        VALUES($1,$1,$1,'StripeAcceptanceFixture',$2,$3,1,'cancelled') ON CONFLICT(id) DO NOTHING`,
      [id, JSON.stringify({ scenario: input.scenario, synthetic: true }), TERMS_HASH]);
      const scenario = (await pool.query(`SELECT rate FROM probe_billing.jobs
        WHERE id=$1 AND guest_id=$1 AND source='StripeAcceptanceFixture' AND terms_hash=$2`,
      [id, TERMS_HASH])).rows[0];
      if (scenario?.rate?.scenario !== input.scenario || scenario.rate.synthetic !== true) {
        throw problem('acceptance_scenario_conflict', 409);
      }
      if (input.scenario !== 'success') {
        const signedSetup = await pool.query('SELECT id FROM probe_billing.setups WHERE guest_id=$1', [id]);
        if (signedSetup.rowCount) throw problem('fresh_failure_fixture_required', 409);
        const guest = fixture;
        if (!guest.customer_id) {
          const customer = await stripe.customers.create({ metadata: { probe_acceptance: id, scenario: input.scenario } },
            { idempotencyKey: `probe-acceptance-customer-${id}` });
          await pool.query('UPDATE probe_billing.guests SET customer_id=$2 WHERE id=$1', [id, customer.id]);
        }
        const current = await fixtureGuest(pool, id);
        if (!current.payment_method_id) {
          const method = await stripe.paymentMethods.attach(input.scenario === 'decline' ?
            'pm_card_chargeCustomerFail' : input.scenario === 'authentication' ?
              'pm_card_authenticationRequired' : 'pm_card_visa',
          { customer: current.customer_id }, { idempotencyKey: `probe-acceptance-method-${id}-${input.scenario}${input.scenario === 'decline' ? '-attachable-v2' : ''}` });
          if (method.livemode !== false || method.type !== 'card' || method.customer !== current.customer_id) {
            throw problem('sandbox_card_required', 400);
          }
          await pool.query(`UPDATE probe_billing.guests SET payment_method_id=$2,
            consent_at=now(),consent_version=$3,state='active' WHERE id=$1`, [id, method.id, CONSENT_VERSION]);
        }
      } else {
        const setup = (await pool.query(`SELECT state FROM probe_billing.setups
          WHERE guest_id=$1 AND terms_hash=$2 AND state='confirmed'`, [id, TERMS_HASH])).rows[0];
        if (!setup) throw problem('signed_setup_required', 403);
      }
      await fixtureGuest(pool, id);
      const collection = await transaction(pool, async client => {
        const guest = (await client.query('SELECT * FROM probe_billing.guests WHERE id=$1 FOR UPDATE', [id])).rows[0];
        const prior = (await client.query('SELECT * FROM probe_billing.collections WHERE id=$1', [id])).rows[0];
        if (!prior) {
          if (guest.state !== 'active' || guest.debt_micros !== '0' || guest.paid_micros !== '0') {
            throw problem('acceptance_balance_required', 409);
          }
          // Synthetic AUD 1.00 test balance only; never represents supplier usage.
          await client.query('UPDATE probe_billing.guests SET debt_micros=1000000 WHERE id=$1', [id]);
          await client.query(`INSERT INTO probe_billing.collections(id,guest_id,amount_cents,state)
            VALUES($1,$1,100,'claimed')`, [id]);
        }
        const saved = (await client.query('SELECT * FROM probe_billing.collections WHERE id=$1', [id])).rows[0];
        if (saved.guest_id !== id || Number(saved.amount_cents) !== 100) throw problem('acceptance_collection_required', 403);
        return { ...saved, customer_id: guest.customer_id, payment_method_id: guest.payment_method_id };
      });
      if (collection.state !== 'failed') {
        const loseResponse = input.scenario === 'unknown' && collection.state === 'claimed' && !collection.payment_intent_id;
        const client = loseResponse ? {
          accounts: stripe.accounts,
          paymentMethodConfigurations: stripe.paymentMethodConfigurations,
          paymentIntents: {
            async create(params, options) {
              await stripe.paymentIntents.create(params, options);
              throw new Error('Simulated lost sandbox response after Stripe accepted the request.');
            },
          },
        } : stripe;
        try {
          const run = (await pool.query('SELECT rate FROM probe_billing.jobs WHERE id=$1', [id])).rows[0];
          await collect(store, client, collection, run.rate.stripeRequestVersion === 2 ?
            `probe-acceptance-corrected-v2-${id}` : `probe-collection-${id}`);
        } catch (error) {
          if (!loseResponse || error.publicCode !== 'payment_uncertain_operator_review') {
            if (error.safeDiagnostic) await pool.query(`UPDATE probe_billing.jobs
              SET rate=jsonb_set(rate,'{rejectedRequest}',$2::jsonb) WHERE id=$1`, [id, JSON.stringify(error.safeDiagnostic)]);
            throw error;
          }
          console.warn('[billing:acceptance] simulated lost test-payment response; recovery uses the original collection key.');
        }
      }
    }
    const guest = await fixtureGuest(pool, id);
    const bound = (await pool.query(`SELECT rate FROM probe_billing.jobs WHERE id=$1 AND guest_id=$1
      AND source='StripeAcceptanceFixture' AND terms_hash=$2`, [id, TERMS_HASH])).rows[0];
    if (bound?.rate?.scenario !== input.scenario || bound.rate.synthetic !== true) throw problem('acceptance_scenario_conflict', 409);
    const collection = (await pool.query('SELECT * FROM probe_billing.collections WHERE id=$1 AND guest_id=$1', [id])).rows[0];
    const payments = (await pool.query(`SELECT count(*)::int AS n FROM probe_billing.ledger
      WHERE collection_id=$1 AND kind='payment'`, [id])).rows[0].n;
    const signed = collection?.payment_intent_id ? (await pool.query(`SELECT count(*)::int AS n
      FROM probe_billing.payment_events WHERE object_id=$1 AND event_type LIKE 'payment_intent.%'`,
    [collection.payment_intent_id])).rows[0].n : 0;
    let intent = collection?.payment_intent_id ? await stripe.paymentIntents.retrieve(collection.payment_intent_id) : null;
    if (!intent && input.action === 'payment-status' && guest.customer_id && collection) {
      const page = await stripe.paymentIntents.list({ customer: guest.customer_id, limit: 100 });
      if (page.has_more) throw problem('acceptance_payment_lookup_incomplete', 409);
      const matches = page.data.filter(item => item.metadata?.probe_collection === id);
      if (matches.length > 1) throw problem('acceptance_multiple_payment_intents', 409);
      intent = matches[0] || null;
    }
    const errorCode = intent?.last_payment_error?.code;
    return { guestId: id, scenario: input.scenario, collectionState: collection?.state || 'absent',
      guestState: guest.state, debtMicros: guest.debt_micros, paidMicros: guest.paid_micros,
      paymentLedgerEntries: payments, signedPaymentEvents: signed,
      stripeStatus: intent?.status || null,
      stripeOwnership: intent ? {
        testMode: intent.livemode === false, aud: intent.currency === 'aud',
        amountMatches: intent.amount === 100, customerMatches: intent.customer === guest.customer_id,
        methodMatches: intentPaymentMethodId(intent) === guest.payment_method_id,
        guestMatches: intent.metadata?.probe_guest === id,
      } : null,
      stripeFailureCode: ['card_declined', 'authentication_required'].includes(errorCode) ? errorCode : null,
      simulatedResponseLoss: input.scenario === 'unknown',
      sandbox: true, syntheticAmountCents: 100, paidExecutionEnabled: false, supplierRequests: 0 };
  } finally {
    try {
      if (locked) await guard.query('SELECT pg_advisory_unlock(724196383,hashtext($1))', [id]);
    } finally {
      guard.release(true);
    }
  }
}
async function assertAcceptanceEvent(pool, event) {
  if (event.livemode !== false || event.account) {
    throw problem('acceptance_setup_event_required', 400);
  }
  const object = event.data?.object;
  if (['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.requires_action',
    'payment_intent.processing', 'payment_intent.canceled'].includes(event.type)) {
    const id = object?.metadata?.probe_collection;
    if (!UUID.test(id || '')) throw problem('acceptance_collection_required', 403);
    const collection = (await pool.query('SELECT * FROM probe_billing.collections WHERE id=$1 AND guest_id=$1', [id])).rows[0];
    const guest = await fixtureGuest(pool, id);
    if (!collection || Number(collection.amount_cents) !== 100 || object.amount !== 100 ||
        object.currency !== 'aud' || object.customer !== guest.customer_id ||
        intentPaymentMethodId(object) !== guest.payment_method_id || object.metadata.probe_guest !== id ||
        (collection.payment_intent_id && collection.payment_intent_id !== object.id)) {
      throw problem('acceptance_collection_required', 403);
    }
    return;
  }
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired'].includes(event.type)) {
    throw problem('acceptance_setup_event_required', 400);
  }
  if (!UUID.test(object?.metadata?.probe_setup || '')) throw problem('acceptance_fixture_required', 403);
  const setup = (await pool.query(`SELECT guest_id,checkout_id FROM probe_billing.setups
    WHERE id=$1 AND terms_hash=$2`, [object.metadata.probe_setup, TERMS_HASH])).rows[0];
  if (!setup || setup.checkout_id !== object.id) throw problem('acceptance_fixture_required', 403);
  await fixtureGuest(pool, setup.guest_id);
}

module.exports = { acceptanceAllowed, runSetupAcceptance, runPaymentAcceptance, assertAcceptanceEvent, TERMS_HASH };
