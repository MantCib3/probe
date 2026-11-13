'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStagingHandler } = require('../../staging-probe');
const { ROOT_DIR, SITES, PROBE_DEADLINE_MS, LAB_RUNTIME_FINGERPRINT } = require('../config');
const { normalizeResult } = require('../classifier');
const { isValidUsername } = require('../validation');
const { probeWithDeadline } = require('../probe-engine');
const { readBody, getClientIp } = require('../request');
const { createLabViewHandler, createPgStore } = require('./lab-view');
const { accountingCheckAllowed } = require('../../scripts/billing-accounting-check');
const { acceptanceAllowed, runSetupAcceptance } = require('../billing/acceptance');
const { trialAllowed, runSupplierTrial } = require('../billing/supplier-trial');
const { runSupplierAcceptance } = require('../billing/supplier-acceptance');
const { createSourceBenchmark } = require('../source-benchmark');

const runtimeFingerprint = {
  ...LAB_RUNTIME_FINGERPRINT,
  profileMetadataSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT_DIR, 'profile-metadata.js'))).digest('hex'),
  metadataHintsSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT_DIR, 'metadata-hints.json'))).digest('hex'),
  stagingHandlerSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT_DIR, 'staging-probe.js'))).digest('hex'),
};
let sourceBenchmark;
const benchmarkEnabled = trialAllowed(process.env);

/* ── Staging probe handler (inert unless PROBE_STAGING=1) ────────────── */
const handleStaging = createStagingHandler({
  enabled: process.env.PROBE_STAGING === '1',
  secret: process.env.STAGING_PROBE_KEY,
  sites: SITES,
  isValidUsername,
  readBody,
  probeWithDeadline,
  deadlineMs: PROBE_DEADLINE_MS,
  normalizeResult,
  hourlyLimit: 600,
  sourceBenchmark: benchmarkEnabled ? async input => {
    if (!trialAllowed(process.env)) throw new Error('Benchmark requires disabled spending.');
    sourceBenchmark ||= createSourceBenchmark({
      pool: process.env.DATABASE_URL ? require('../billing/db').createPool() : undefined,
      sites: SITES, runtimeFingerprint, commit: process.env.RENDER_GIT_COMMIT,
      hourlyLimit: Number(process.env.STAGING_PROBE_HOURLY_LIMIT) || 120,
    });
    return sourceBenchmark(input);
  } : undefined,
  billingHealth: process.env.PROBE_STAGING === '1' &&
    (!process.env.RENDER || process.env.RENDER_SERVICE_NAME === 'probe-staging') ? async () => {
      const { createPool } = require('../billing/db');
      const { checkDatabase } = require('../../scripts/billing-check');
      const pool = createPool();
      try {
        const result = await checkDatabase(pool);
        return { ...result, writes: 0, providerRequests: 0, paymentRequests: 0 };
      } finally {
        await pool.end();
      }
    } : undefined,
  billingAccounting: accountingCheckAllowed() ? async () => {
    if (!accountingCheckAllowed()) throw new Error('Accounting acceptance requires disabled spending.');
    const { createPool } = require('../billing/db');
    const { checkAccounting } = require('../../scripts/billing-accounting-check');
    const pool = createPool();
    try {
      return await checkAccounting(pool);
    } finally {
      await pool.end();
    }
  } : undefined,
  billingRecovery: accountingCheckAllowed() ? async () => {
    if (!accountingCheckAllowed()) throw new Error('Recovery verification requires disabled spending.');
    const { createPool } = require('../billing/db');
    const { checkRecovery } = require('../../scripts/billing-recovery-check');
    const pool = createPool();
    try { return await checkRecovery(pool); }
    finally { await pool.end(); }
  } : undefined,
  stripeHealth: accountingCheckAllowed() ? async () => {
    if (!accountingCheckAllowed()) throw new Error('Stripe readiness requires disabled spending.');
    const { createStripe, checkSandboxConfiguration } = require('../billing/stripe');
    return checkSandboxConfiguration(createStripe());
  } : undefined,
  stripeSetup: acceptanceAllowed(process.env) ? async input => {
    if (!acceptanceAllowed(process.env)) throw new Error('Sandbox setup acceptance is locked.');
    const { createPool } = require('../billing/db');
    const { createStripe } = require('../billing/stripe');
    const pool = createPool();
    try {
      return await runSetupAcceptance(pool, createStripe(), input);
    } finally {
      await pool.end();
    }
  } : undefined,
  supplierAcceptance: trialAllowed(process.env) ? async input => {
    const { createPool } = require('../billing/db');
    const pool = createPool();
    try { return await runSupplierAcceptance(pool, SITES, process.env, input); }
    finally { await pool.end(); }
  } : undefined,
  supplierTrial: trialAllowed(process.env) ? async input => {
    if (!trialAllowed(process.env)) throw new Error('Supplier trial requires disabled spending.');
    const { createPool } = require('../billing/db');
    const pool = createPool();
    try {
      return await runSupplierTrial(pool, SITES, process.env.ZYTE_API_KEY, input);
    } finally {
      await pool.end();
    }
  } : undefined,
  credentialsConfigured: Object.fromEntries([...new Set(SITES.filter(site => site.credential).map(site => site.credential.env))]
    .map(name => [name, Boolean((process.env[name] || '').trim())])),
  runtimeFingerprint,
  deployment: {
    commit: process.env.RENDER_GIT_COMMIT || null,
    region: process.env.RENDER_REGION || null,
    provider: process.env.RENDER ? 'render' : 'local',
  },
});

/* ── Password-protected nightly lab report (inert unless staging + LAB_VIEW_PASSWORD) ── */
const labViewEnabled = process.env.PROBE_STAGING === '1' &&
  (!process.env.RENDER || process.env.RENDER_SERVICE_NAME === 'probe-staging');
const handleLabView = createLabViewHandler({
  enabled: labViewEnabled,
  password: process.env.LAB_VIEW_PASSWORD,
  uploadSecret: process.env.STAGING_PROBE_KEY,
  readBody,
  getClientIp,
  store: labViewEnabled && process.env.DATABASE_URL
    ? createPgStore(() => require('../billing/db').createPool())
    : undefined,
});

module.exports = { handleStaging, handleLabView };
