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
