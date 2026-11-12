'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { isPrivateHost } = require('../net-guard');

const CONSENT_VERSION = 'sandbox-usd-equal-share-v1';
const CONSENT_TEXT = 'Save a payment method for USD daily postpaid collection or earlier at the credit threshold. Pay your share of measured supplier usage before promotional credits, allocated equally across comparable requests, plus the separately disclosed PROBE margin, including inconclusive results. Supplier credits may reduce PROBE payment without reducing your usage charge. PROBE tests, errors and duplicate attempts are absorbed, not redistributed. Fractional amounts carry forward without rounding each request up. Your card issuer may charge currency conversion fees. Revocation stops new spending, not already incurred debt. Stripe may retain identity/payment records; PROBE stores pseudonymous references, consent and a ledger.';
const MAX_MICROS = 1_000_000_000_000;
function integer(value, min = 1, max = MAX_MICROS) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid integer billing configuration.');
  return value;
}
function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function loadConfig(env = process.env, sites = []) {
  const disabled = { staging: env.PROBE_STAGING === '1' &&
      (!env.RENDER || env.RENDER_SERVICE_NAME === 'probe-staging'), enabled: false,
    reason: 'Sandbox paid checks disabled; measured rates and operator enablement required.',
    consentVersion: CONSENT_VERSION, consentText: CONSENT_TEXT, currency: 'usd', rates: [] };
  if (!disabled.staging || env.PAID_INFRA_ENABLED !== '1') return disabled;
  if (env.PAID_MONEY_PATH_VERIFIED !== '1' || env.PAID_USD_MONEY_PATH_VERIFIED !== '1') {
    return { ...disabled, reason: 'Sandbox money path locked pending real PostgreSQL and authorized sandbox acceptance verification.' };
  }
  try {
    if (!/^sk_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY || '') ||
        !/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET || '') ||
        !env.DATABASE_URL || !env.ZYTE_API_KEY) throw new Error('Missing sandbox credentials.');
    const origin = new URL(env.PAID_ORIGIN);
    if (origin.protocol !== 'https:' || origin.origin !== env.PAID_ORIGIN || isPrivateHost(origin.hostname)) {
      throw new Error('Invalid paid origin.');
    }
    if (!(env.TURNSTILE_SECRET || '').trim() ||
        !(env.TURNSTILE_HOSTNAMES || '').split(',').map(s => s.trim()).includes(origin.hostname)) {
      throw new Error('Verified paid-session bot control required.');
    }
    const root = path.resolve(__dirname, '..', '..');
    const ratePath = path.resolve(env.PAID_RATE_CONFIG_PATH);
    if (ratePath.startsWith(root + path.sep) && !ratePath.startsWith(path.join(root, 'billing-private') + path.sep)) {
      throw new Error('In-repository rates must be private.');
    }
    const card = JSON.parse(fs.readFileSync(ratePath, 'utf8'));
    if (card.currency !== 'usd' || card.billability !== 'authoritative-reconciliation' ||
        card.allocationPolicy !== 'domain-window-equal-share-usd-v1' || card.costBasis !== 'pre-credit' ||
        card.measured !== true || typeof card.measurementReference !== 'string' ||
        !card.measurementReference.trim() || !Array.isArray(card.sources) || !card.sources.length) {
      throw new Error('Measured rates and reconciliation policy required.');
    }
    const creditMicros = integer(card.creditMicros);
    const thresholdMicros = integer(card.thresholdMicros, 500000, creditMicros);
    const minimumCents = integer(card.minimumCents, 50, Math.floor(thresholdMicros / 10000));
    const rates = card.sources.map(rate => {
      const site = sites.find(s => s.name === rate.source);
      if (!site || site.defunct || site.undetectable || rate.mode !== 'http' ||
          !Array.isArray(rate.hosts) || !rate.hosts.length ||
          rate.hosts.some(host => typeof host !== 'string' || isPrivateHost(host) ||
            new URL(`https://${host}`).hostname !== host || host.includes(':') ||
            host.includes('*') || net.isIP(host))) {
        throw new Error('Unapproved source configuration.');
      }
      // Custom adapters must be independently approved, not silently replaced with a profile GET.
      if (site.requestAdapter || site.request || site.credential || site.apiUrl || site.checkUrl) throw new Error('Custom adapters require separate approval.');
      const supplierMicros = integer(rate.supplierMicros);
      if (rate.ipType !== undefined && !['datacenter', 'residential'].includes(rate.ipType)) {
        throw new Error('Invalid supplier IP type.');
      }
      const marginMicros = integer(rate.marginMicros, 0);
      const maximumMicros = integer(supplierMicros + marginMicros, 1, creditMicros);
      if (!site.url.includes('{}')) throw new Error('Profile template required.');
      const target = new URL(site.url.replaceAll('{}', 'probe'));
      if (target.protocol !== 'https:' || !rate.hosts.includes(target.hostname)) throw new Error('Invalid catalog host.');
      return { source: site.name, mode: rate.mode, hosts: rate.hosts,
        supplierMicros, marginMicros, maximumMicros,
        ...(rate.ipType === undefined ? {} : { ipType: rate.ipType }) };
    });
    if (new Set(rates.map(r => r.source)).size !== rates.length) throw new Error('Duplicate rates.');
    const terms = { consentVersion: CONSENT_VERSION, consentText: CONSENT_TEXT,
      currency: 'usd', allocationPolicy: card.allocationPolicy, costBasis: card.costBasis,
      creditMicros, thresholdMicros, minimumCents, rates,
      sourcePolicyHash: fingerprint(rates.map(rate => sites.find(site => site.name === rate.source))) };
    return { ...disabled, ...terms, enabled: true, reason: 'Stripe sandbox only; billability awaits authoritative reconciliation.',
      origin: origin.origin, termsHash: fingerprint(terms), measurementReference: card.measurementReference };
  } catch (_) {
    console.error('[billing:config] sandbox configuration rejected; execution disabled. Check private credentials, origin and measured rate configuration.');
    return { ...disabled, reason: 'Sandbox billing configuration invalid; fail-closed. Check private operator configuration.' };
  }
}
module.exports = { loadConfig, integer, fingerprint, CONSENT_VERSION, CONSENT_TEXT, MAX_MICROS };
