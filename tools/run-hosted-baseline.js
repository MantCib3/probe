'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const fingerprintFiles = {
  classifierSha256: 'server.js',
  sourceRequestAdapterSha256: 'source-request-adapter.js',
  catalogSha256: 'sites.json',
  usernameRulesSha256: 'username-rules.js',
  profileMetadataSha256: 'profile-metadata.js',
  metadataHintsSha256: 'metadata-hints.json',
  stagingHandlerSha256: 'staging-probe.js',
};

async function main() {
  const [originText, manifestPath, outputPath] = process.argv.slice(2);
  if (!originText || !manifestPath || !outputPath) {
    throw new Error('Usage: node tools/run-hosted-baseline.js <origin> <manifest.json> <new-report.json>; set STAGING_PROBE_KEY in your environment.');
  }
  const origin = new URL(originText);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (origin.username || origin.password || (!local && origin.protocol !== 'https:') ||
      !['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Use a plain HTTPS service origin (HTTP is allowed only on loopback).');
  }
  const secret = process.env.STAGING_PROBE_KEY || '';
  if (Buffer.byteLength(secret) < 32) throw new Error('STAGING_PROBE_KEY must be set to the staging service secret.');
  if (fs.existsSync(outputPath)) throw new Error('Report already exists; refusing to overwrite.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const controls = manifest.controls;
  const intervalMs = manifest.intervalMs ?? 10000;
  if (!Number.isInteger(intervalMs) || intervalMs < 10000 || intervalMs > 60000) {
    throw new Error('Manifest intervalMs must be 10000-60000 for low-frequency testing.');
  }
  if (!Array.isArray(controls) || !controls.length || controls.length > 60 ||
      controls.some(row => !row || typeof row.site !== 'string' ||
        typeof row.username !== 'string' || !['found', 'not_found'].includes(row.expected))) {
    throw new Error('Manifest must contain 1-60 explicit {site, username, expected} controls.');
  }
  const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
  const expected = Object.fromEntries(Object.entries(fingerprintFiles).map(([key, file]) =>
    [key, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim());
  if (dirty) throw new Error('Commit staging changes before recording a hosted comparison.');
  function assertFingerprint(actual) {
    for (const [key, value] of Object.entries(expected)) {
      if (!actual || actual[key] !== value) throw new Error(`Runtime mismatch: ${key}`);
    }
  }
  const healthResponse = await fetch(new URL('/api/staging-health', origin), {
    headers, signal: AbortSignal.timeout(180000), redirect: 'error',
  });
  if (!healthResponse.ok) throw new Error(`Staging health HTTP ${healthResponse.status}; authenticate and wake the service first.`);
  const health = await healthResponse.json();
  if (!health.ok) throw new Error('Staging health failed.');
  if (health.runtimeFingerprint?.nodeVersion !== process.version) throw new Error('Node runtime version differs.');
  assertFingerprint(health.runtimeFingerprint);
  if (!local && health.deployment.commit !== commit) throw new Error('Deployed commit differs from this checkout.');
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), origin: origin.origin,
    commit, dirty, deployment: health.deployment, runtimeFingerprint: health.runtimeFingerprint,
    manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'),
    intervalMs,
    caveats: [
      'Diagnostic labels, not independently certified ground truth.',
      'Single-source production probe parity; not public scan UI or scheduler parity.',
      'No automatic retries; transport errors are retained separately.',
      'This hosting instance and time window do not represent all production deployments.',
    ],
    rows: [],
  };
  let failed = false;
  let fatalError;
  try {
    for (const control of controls) {
      if (report.rows.length) await new Promise(resolve => setTimeout(resolve, intervalMs));
      const started = Date.now();
      let response;
      try {
        response = await fetch(new URL('/api/staging-probe', origin), {
          method: 'POST', headers,
          body: JSON.stringify({ site: control.site, username: control.username }),
          signal: AbortSignal.timeout(50000), redirect: 'error',
        });
      } catch (error) {
        failed = true;
        report.rows.push({ ...control, actual: null, error: 'transport_error', message: error.message, durationMs: Date.now() - started });
        console.error(`${control.site}: transport error`);
        continue;
      }
      if (!response.ok) throw new Error(`Probe HTTP ${response.status} for ${control.site}; stopping, not treating this as a source verdict.`);
      const payload = await response.json();
      if (!payload.ok || !payload.result) throw new Error(`Invalid probe response for ${control.site}`);
      assertFingerprint(payload.runtimeFingerprint);
      report.rows.push({ ...control, actual: payload.result.status, result: payload.result, durationMs: Date.now() - started, error: null });
      console.log(`${control.site}: ${payload.result.status}`);
    }
  } catch (error) {
    failed = true;
    fatalError = error;
    report.failure = error.message;
  }
  report.finishedAt = new Date().toISOString();
  report.summary = {
    controls: controls.length,
    attempted: report.rows.length,
    complete: report.rows.length === controls.length && !fatalError,
    completed: report.rows.filter(row => !row.error).length,
    transportErrors: report.rows.filter(row => row.error).length,
    statuses: report.rows.reduce((counts, row) => {
      const status = row.actual || 'transport_error';
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {}),
    positiveProfiles: report.rows.filter(row => row.expected === 'found' && row.result?.profile).length,
    negativeProfileLeaks: report.rows.filter(row => row.expected === 'not_found' && row.result?.profile).length,
  };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report.summary, null, 2));
  if (fatalError) throw fatalError;
  if (failed || report.summary.negativeProfileLeaks) process.exitCode = 2;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
