'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStagingHandler } = require('../../staging-probe');
const { ROOT_DIR, SITES, PROBE_DEADLINE_MS, LAB_RUNTIME_FINGERPRINT } = require('../config');
const { normalizeResult } = require('../classifier');
const { isValidUsername } = require('../validation');
const { probeWithDeadline } = require('../probe-engine');
const { readBody } = require('../request');
const { accountingCheckAllowed } = require('../../scripts/billing-accounting-check');

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
  hourlyLimit: Number(process.env.STAGING_PROBE_HOURLY_LIMIT) || 120,
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
  credentialsConfigured: Object.fromEntries([...new Set(SITES.filter(site => site.credential).map(site => site.credential.env))]
    .map(name => [name, Boolean((process.env[name] || '').trim())])),
  runtimeFingerprint: {
    ...LAB_RUNTIME_FINGERPRINT,
    profileMetadataSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT_DIR, 'profile-metadata.js'))).digest('hex'),
    metadataHintsSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT_DIR, 'metadata-hints.json'))).digest('hex'),
    stagingHandlerSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT_DIR, 'staging-probe.js'))).digest('hex'),
  },
  deployment: {
    commit: process.env.RENDER_GIT_COMMIT || null,
    region: process.env.RENDER_REGION || null,
    provider: process.env.RENDER ? 'render' : 'local',
  },
});

module.exports = { handleStaging };
