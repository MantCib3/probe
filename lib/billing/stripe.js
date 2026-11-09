'use strict';

const Stripe = require('stripe');
const { problem, intentPaymentMethodId } = require('./store');
function createStripe(env = process.env) {
  if (!/^sk_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY || '')) throw problem('sandbox_key_required', 503);
  return new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 0, timeout: 15000,
    appInfo: { name: 'PROBE staging accountless billing' } });
}
function checkoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && !url.username && !url.password;
  } catch (_) { return false; }
}
async function assertAustralianAccount(stripe) {
  const account = await stripe.accounts.retrieve();
  if (account.country !== 'AU' || account.default_currency !== 'aud') throw problem('australian_aud_account_required', 503);
}
async function checkSandboxConfiguration(stripe, env = process.env) {
  await assertAustralianAccount(stripe);
  return { country: 'AU', currency: 'aud', mode: 'test',
    webhookSecretConfigured: /^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET || ''),
    stripeRequests: 1, paymentRequests: 0, providerRequests: 0,
    acceptanceVerified: false };
}
async function cardOnlyConfiguration(stripe) {
  const name = 'PROBE sandbox card-only setup v1';
  const page = await stripe.paymentMethodConfigurations.list({ limit: 100 });
  if (page.has_more) throw problem('payment_configuration_operator_review', 503);
  let configuration = page.data.find(item => item.name === name && item.livemode === false);
  if (!configuration) {
    const defaults = page.data.find(item => item.is_default && item.livemode === false);
    if (!defaults?.card?.display_preference) throw problem('card_configuration_required', 503);
    const methods = Object.entries(defaults).filter(([, value]) =>
      value && typeof value === 'object' && value.display_preference);
    const params = { name, ...Object.fromEntries(methods.map(([method]) =>
      [method, { display_preference: { preference: method === 'card' ? 'on' : 'off' } }])) };
    configuration = await stripe.paymentMethodConfigurations.create(params,
      { idempotencyKey: 'probe-sandbox-card-only-setup-config-v1' });
  }
  if (!configuration.active || configuration.livemode !== false ||
      configuration.card?.available !== true || configuration.card.display_preference?.value !== 'on' ||
      Object.entries(configuration).some(([method, value]) =>
        method !== 'card' && value && typeof value === 'object' &&
        value.display_preference && value.display_preference.value !== 'off')) {
    throw problem('card_configuration_required', 503);
  }
  return configuration.id;
}
async function startSetup(store, stripe, guestId, config, replacement = false) {
  const setup = await store.prepareSetup(guestId, config, replacement);
  if (setup.state === 'ready') {
    if (!checkoutUrl(setup.checkout_url)) throw problem('invalid_hosted_checkout', 502);
    return setup.checkout_url;
  }
  try {
    await assertAustralianAccount(stripe);
    const paymentConfiguration = await cardOnlyConfiguration(stripe);
    let customerId = setup.customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ metadata: { probe_guest: guestId } },
        { idempotencyKey: `probe-guest-customer-${setup.id}` });
      customerId = customer.id;
      await store.setupCustomer(setup.id, customerId);
    }
    const metadata = { probe_guest: guestId, probe_setup: setup.id, probe_terms: config.termsHash };
    const checkout = await stripe.checkout.sessions.create({
      mode: 'setup', currency: 'aud', customer: customerId,
      payment_method_configuration: paymentConfiguration,
      setup_intent_data: { metadata },
      metadata,
      success_url: `${config.origin}/#paid`,
      cancel_url: `${config.origin}/#paid`,
      custom_text: { submit: { message: config.setupMessage ||
        'Sandbox AUD daily postpaid usage plus disclosed margin; inconclusive provider-billable checks count. Revocation stops new spending only.' } },
    }, { idempotencyKey: `probe-guest-setup-${setup.id}` });
    if (checkout.livemode !== false || !checkoutUrl(checkout.url)) throw problem('invalid_hosted_checkout', 502);
    await store.setupReady(setup.id, checkout);
    return checkout.url;
  } catch (error) {
    await store.setupUncertain(setup.id);
    throw problem(error.publicCode || 'setup_uncertain_operator_review', 502);
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function startRecovery(store, stripe, guestId, config) {
  const recovery = await store.prepareRecovery(guestId, config);
  if (recovery.state === 'ready') {
    if (!checkoutUrl(recovery.checkout_url)) throw problem('invalid_hosted_checkout', 502);
    return recovery.checkout_url;
  }
  try {
    await assertAustralianAccount(stripe);
    const paymentConfiguration = await cardOnlyConfiguration(stripe);
    if (recovery.prior_payment_intent_id) {
      const prior = await stripe.paymentIntents.retrieve(recovery.prior_payment_intent_id);
      if (prior.id !== recovery.prior_payment_intent_id || prior.livemode !== false ||
          prior.currency !== 'aud' || prior.customer !== recovery.customer_id ||
          prior.amount !== Number(recovery.amount_cents) ||
          prior.metadata?.probe_guest !== guestId || prior.metadata?.probe_collection !== recovery.collection_id ||
          (prior.status !== 'canceled' && intentPaymentMethodId(prior) !== recovery.payment_method_id)) {
        throw problem('payment_ownership_mismatch', 400);
      }
      if (prior.status === 'succeeded') {
        await store.paymentResult(recovery.collection_id, prior);
        await store.recoveryResolved(recovery.id);
        throw problem('payment_already_settled_refresh');
      }
      if (prior.status !== 'canceled') {
        if (!['requires_payment_method','requires_action','requires_confirmation'].includes(prior.status)) {
          throw problem('payment_uncertain_operator_review');
        }
        const canceled = await stripe.paymentIntents.cancel(prior.id, {},
          { idempotencyKey: `probe-recovery-cancel-${recovery.id}` });
        if (canceled.id !== prior.id || canceled.livemode !== false || canceled.status !== 'canceled') {
          throw problem('payment_uncertain_operator_review');
        }
      }
    }
    const metadata = { probe_guest: guestId, probe_recovery: recovery.id,
      probe_collection: recovery.collection_id, probe_terms: recovery.terms_hash };
    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment', customer: recovery.customer_id,
      payment_method_configuration: paymentConfiguration,
      line_items: [{ quantity: 1, price_data: { currency: 'aud', unit_amount: Number(recovery.amount_cents),
        product_data: { name: 'PROBE sandbox outstanding infrastructure usage' } } }],
      payment_intent_data: { setup_future_usage: 'off_session', metadata },
      metadata, success_url: `${config.origin}/#paid`, cancel_url: `${config.origin}/#paid`,
      custom_text: { submit: { message: 'Settle existing sandbox debt and save this card for future AUD postpaid usage. Spending stays paused until you explicitly resume; revocation remains in effect.' } },
    }, { idempotencyKey: `probe-recovery-checkout-${recovery.id}` });
    if (checkout.livemode !== false || !checkoutUrl(checkout.url)) throw problem('invalid_hosted_checkout', 502);
    await store.recoveryReady(recovery.id, checkout);
    return checkout.url;
  } catch (error) {
    await store.recoveryUncertain(recovery.id);
    console.error('[billing:recovery] checkout not started or outcome uncertain; spending remains paused.');
    throw problem(error.publicCode || 'recovery_pending_operator_review', error.status || 502);
  }
}
async function completeRecovery(store, stripe, event, checkout) {
  if (checkout.livemode !== false || checkout.mode !== 'payment' || checkout.status !== 'complete' ||
      checkout.payment_status !== 'paid' || checkout.currency !== 'aud' || !checkout.payment_intent ||
      !UUID.test(checkout.metadata?.probe_recovery || '')) throw problem('recovery_not_verified', 400);
  const intent = await stripe.paymentIntents.retrieve(checkout.payment_intent);
  if (intent.livemode !== false || intent.status !== 'succeeded' || intent.currency !== 'aud' ||
      intent.amount_received !== intent.amount || intent.setup_future_usage !== 'off_session' ||
      !intent.payment_method) throw problem('recovery_not_verified', 400);
  const method = await stripe.paymentMethods.retrieve(intent.payment_method);
  if (method.livemode !== false || method.type !== 'card') throw problem('sandbox_card_required', 400);
  await store.confirmRecovery(event, checkout, intent, method);
}
async function processWebhook(store, stripe, event) {
  if (event.livemode !== false || !event.id || event.account) throw problem('sandbox_event_required', 400);
  const object = event.data?.object;
  if (!object?.id) throw problem('invalid_event', 400);
  if (event.type === 'checkout.session.expired') {
    if (UUID.test(object.metadata?.probe_recovery || '')) {
      const checkout = await stripe.checkout.sessions.retrieve(object.id);
      if (checkout.livemode !== false || checkout.mode !== 'payment' ||
          checkout.metadata?.probe_recovery !== object.metadata.probe_recovery) throw problem('invalid_expired_recovery', 400);
      if (checkout.status === 'expired') await store.expireRecovery(event, checkout);
      return;
    }
    if (!UUID.test(object.metadata?.probe_setup || '')) return;
    const checkout = await stripe.checkout.sessions.retrieve(object.id);
    if (checkout.livemode !== false || checkout.mode !== 'setup' ||
        !UUID.test(checkout.metadata?.probe_setup || '')) throw problem('invalid_expired_setup', 400);
    if (checkout.status === 'expired') await store.expireSetup(event, checkout);
  } else if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (UUID.test(object.metadata?.probe_recovery || '')) {
      const checkout = await stripe.checkout.sessions.retrieve(object.id);
      await completeRecovery(store, stripe, event, checkout);
      return;
    }
    if (!UUID.test(object.metadata?.probe_setup || '')) return;
    const setup = await store.setupForCheckout(object.metadata.probe_setup);
    if (!setup) throw problem('unowned_checkout', 400);
    // Signed notification triggers an authoritative retrieve; neither redirects nor payload assertions authorize.
    const checkout = await stripe.checkout.sessions.retrieve(object.id);
    if (checkout.livemode !== false || checkout.mode !== 'setup' || checkout.status !== 'complete' ||
        !checkout.setup_intent || !UUID.test(checkout.metadata?.probe_setup || '')) throw problem('setup_not_complete', 400);
    const intent = await stripe.setupIntents.retrieve(checkout.setup_intent);
    if (intent.livemode !== false || intent.status !== 'succeeded' || intent.usage !== 'off_session' ||
        !intent.payment_method) throw problem('setup_not_verified', 400);
    const method = await stripe.paymentMethods.retrieve(intent.payment_method);
    if (method.livemode !== false || method.type !== 'card') throw problem('sandbox_card_required', 400);
    await store.confirmSetup(event, checkout, intent, method);
  } else if (['payment_intent.succeeded','payment_intent.payment_failed','payment_intent.requires_action',
    'payment_intent.processing','payment_intent.canceled'].includes(event.type)) {
    if (UUID.test(object.metadata?.probe_recovery || '')) {
      const recovery = await store.recoveryForCheckout(object.metadata.probe_recovery);
      if (!recovery) throw problem('unowned_recovery', 400);
      const intent = await stripe.paymentIntents.retrieve(object.id);
      if (intent.livemode !== false || intent.customer !== recovery.customer_id ||
          intent.metadata?.probe_recovery !== recovery.id ||
          intent.metadata?.probe_guest !== recovery.guest_id ||
          intent.metadata?.probe_collection !== recovery.collection_id ||
          intent.amount !== Number(recovery.amount_cents) || intent.currency !== 'aud') {
        throw problem('recovery_ownership_mismatch', 400);
      }
      if (intent.status !== 'succeeded') return;
      let checkoutId = recovery.checkout_id;
      if (!checkoutId) {
        const page = await stripe.checkout.sessions.list({ payment_intent: intent.id, limit: 2 });
        if (page.has_more || page.data.length !== 1) throw problem('recovery_pending_operator_review');
        checkoutId = page.data[0].id;
      }
      await completeRecovery(store, stripe, event, await stripe.checkout.sessions.retrieve(checkoutId));
      return;
    }
    if (!UUID.test(object.metadata?.probe_collection || '')) return;
    const intent = await stripe.paymentIntents.retrieve(object.id);
    await store.paymentResult(object.metadata.probe_collection, intent, event);
  }
}
async function collect(store, stripe, collection, requestKey = `probe-collection-${collection.id}`) {
  let phase = 'retrieve';
  try {
    let intent;
    if (collection.payment_intent_id) {
      intent = await stripe.paymentIntents.retrieve(collection.payment_intent_id);
    } else {
      // Stripe idempotency expires; never recreate an unknown payment after the conservative 20h window.
      if (Date.now() - new Date(collection.created_at).getTime() >= 20 * 3600000) {
        await store.freezeCollection(collection.id);
        return;
      }
      phase = 'account';
      await assertAustralianAccount(stripe);
      const paymentConfiguration = await cardOnlyConfiguration(stripe);
      phase = 'create';
      intent = await stripe.paymentIntents.create({
        amount: Number(collection.amount_cents), currency: 'aud', customer: collection.customer_id,
        payment_method: collection.payment_method_id, off_session: true, confirm: true,
        payment_method_configuration: paymentConfiguration,
        metadata: { probe_collection: collection.id, probe_guest: collection.guest_id },
        description: 'PROBE sandbox authoritative infrastructure usage',
      }, { idempotencyKey: requestKey });
    }
    phase = 'accounting';
    await store.paymentResult(collection.id, intent);
  } catch (error) {
    const intent = error.payment_intent;
    if (intent && typeof intent === 'object') {
      try {
        await store.paymentResult(collection.id, intent);
      } catch (accountingError) {
        await store.collectionUncertain(collection.id);
        await store.freezeCollection(collection.id);
        console.error('[billing:collection] failed-payment accounting rejected; collection frozen.');
        throw accountingError;
      }
      return;
    }
    await store.collectionUncertain(collection.id);
    // Suspend immediately on an unknown payment rather than accepting additional credit exposure.
    await store.freezeCollection(collection.id);
    const known = ['payment_ownership_mismatch', 'payment_amount_mismatch', 'unknown_collection'];
    const types = ['StripeInvalidRequestError', 'StripeIdempotencyError', 'StripeAuthenticationError', 'StripePermissionError',
      'StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError'];
    const detail = known.includes(error.publicCode) ? error.publicCode :
      types.includes(error.type) ? error.type : 'provider_or_database_error';
    console.error(`[billing:collection] unknown outcome (${phase}/${detail}); collection frozen.`);
    const failure = problem('payment_uncertain_operator_review', 502);
    failure.safeDiagnostic = { phase, type: detail,
      parameter: ['amount', 'currency', 'payment_method', 'payment_method_types', 'customer', 'off_session', 'confirm'].includes(error.param) ? error.param : null };
    throw failure;
  }
}
module.exports = { createStripe, startSetup, startRecovery, processWebhook, collect, checkoutUrl, UUID, assertAustralianAccount, checkSandboxConfiguration, cardOnlyConfiguration };
