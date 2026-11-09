'use strict';

const Stripe = require('stripe');
const { problem } = require('./store');
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
async function startSetup(store, stripe, guestId, config) {
  const setup = await store.prepareSetup(guestId, config);
  if (setup.state === 'ready') {
    if (!checkoutUrl(setup.checkout_url)) throw problem('invalid_hosted_checkout', 502);
    return setup.checkout_url;
  }
  try {
    await assertAustralianAccount(stripe);
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
      payment_method_types: ['card'],
      setup_intent_data: { metadata },
      metadata,
      success_url: `${config.origin}/#paid`,
      cancel_url: `${config.origin}/#paid`,
      custom_text: { submit: { message: 'Sandbox AUD daily postpaid usage plus disclosed margin; inconclusive provider-billable checks count. Revocation stops new spending only.' } },
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
async function processWebhook(store, stripe, event) {
  if (event.livemode !== false || !event.id || event.account) throw problem('sandbox_event_required', 400);
  const object = event.data?.object;
  if (!object?.id) throw problem('invalid_event', 400);
  if (event.type === 'checkout.session.expired') {
    if (!UUID.test(object.metadata?.probe_setup || '')) return;
    const checkout = await stripe.checkout.sessions.retrieve(object.id);
    if (checkout.livemode !== false || checkout.mode !== 'setup' ||
        !UUID.test(checkout.metadata?.probe_setup || '')) throw problem('invalid_expired_setup', 400);
    if (checkout.status === 'expired') await store.expireSetup(event, checkout);
  } else if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
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
    if (!UUID.test(object.metadata?.probe_collection || '')) return;
    const intent = await stripe.paymentIntents.retrieve(object.id);
    await store.paymentResult(object.metadata.probe_collection, intent, event);
  }
}
async function collect(store, stripe, collection) {
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
      await assertAustralianAccount(stripe);
      intent = await stripe.paymentIntents.create({
        amount: Number(collection.amount_cents), currency: 'aud', customer: collection.customer_id,
        payment_method: collection.payment_method_id, off_session: true, confirm: true,
        payment_method_types: ['card'],
        metadata: { probe_collection: collection.id, probe_guest: collection.guest_id },
        description: 'PROBE sandbox authoritative infrastructure usage',
      }, { idempotencyKey: `probe-collection-${collection.id}` });
    }
    await store.paymentResult(collection.id, intent);
  } catch (error) {
    const intent = error.payment_intent;
    if (intent && typeof intent === 'object') {
      await store.paymentResult(collection.id, intent);
      return;
    }
    await store.collectionUncertain(collection.id);
    // Suspend immediately on an unknown payment rather than accepting additional credit exposure.
    await store.freezeCollection(collection.id);
    throw problem('payment_uncertain_operator_review', 502);
  }
}
module.exports = { createStripe, startSetup, processWebhook, collect, checkoutUrl, UUID, assertAustralianAccount, checkSandboxConfiguration };
