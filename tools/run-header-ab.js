'use strict';

// Unattended header A/B on the hosted staging service. Each control is
// probed under every variant; rounds interleave sources so one host sees a
// request only every few minutes. Writes one immutable report.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function main() {
  const [originText, manifestPath, outputPath] = process.argv.slice(2);
  const secret = process.env.STAGING_PROBE_KEY || '';
  if (!originText || !manifestPath || !outputPath || Buffer.byteLength(secret) < 32) {
    throw new Error('Usage: STAGING_PROBE_KEY=... node tools/run-header-ab.js <origin> <manifest.json> <new-report.json>');
  }
  if (fs.existsSync(outputPath)) throw new Error('Report already exists; refusing to overwrite.');
  const root = path.join(__dirname, '..');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()) {
    throw new Error('Commit staging changes before a hosted A/B.');
  }
  const origin = new URL(originText);
  const headers = { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
  const health = await (await fetch(new URL('/api/staging-health', origin), { headers, signal: AbortSignal.timeout(180000) })).json();
  if (!health.ok || health.deployment.commit !== commit) throw new Error('Deployed commit differs from this checkout.');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const intervalMs = Math.max(2000, manifest.intervalMs || 3000);
  const perSource = manifest.sources.map((source, index) => {
    const variants = index % 2 ? [...source.variants].reverse() : source.variants;
    return source.controls.flatMap(control => variants.map(variant => ({ site: source.site, variant, ...control })));
  });
  const rounds = Math.max(...perSource.map(tasks => tasks.length));
  const rows = [];
  for (let round = 0; round < rounds; round++) {
    for (const tasks of perSource) {
      const task = tasks[round];
      if (!task) continue;
      if (rows.length) await new Promise(resolve => setTimeout(resolve, intervalMs));
      let row;
      try {
        const response = await fetch(new URL('/api/staging-probe', origin), {
          method: 'POST', headers,
          body: JSON.stringify({ site: task.site, username: task.username, variant: task.variant }),
          signal: AbortSignal.timeout(50000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (payload.runtimeFingerprint.classifierSha256 !== health.runtimeFingerprint.classifierSha256) throw new Error('runtime changed');
        const r = payload.result;
        row = { ...task, actual: r.status, statusCode: r.statusCode, reasons: r.reasonCodes || [], profileFields: Object.keys(r.profile || {}) };
      } catch (error) {
        row = { ...task, actual: null, error: error.message };
        if (/HTTP 429|runtime changed/.test(error.message)) { rows.push(row); throw Object.assign(error, { rows }); }
      }
      rows.push(row);
      process.stdout.write(`${rows.length} `);
    }
  }
  return { commit, health, rows, manifest };
}

function summarize({ commit, health, rows, manifest }) {
  const sources = manifest.sources.map(source => {
    const byVariant = Object.fromEntries(source.variants.map(variant => {
      const subset = rows.filter(row => row.site === source.site && row.variant === variant);
      return [variant, {
        correct: subset.filter(row => row.actual === row.expected).length,
        decided: subset.filter(row => row.actual === 'found' || row.actual === 'not_found').length,
        wrong: subset.filter(row => (row.actual === 'found' || row.actual === 'not_found') && row.actual !== row.expected).length,
        total: subset.length,
        outcomes: subset.map(row => `${row.expected[0]}:${row.actual || 'error'}${row.reasons?.length ? '(' + row.reasons.join('+') + ')' : ''}`),
      }];
    }));
    return { site: source.site, ...byVariant };
  });
  return { createdAt: new Date().toISOString(), commit, deployment: health.deployment, credentialsConfigured: health.credentialsConfigured,
    caveats: ['Single hosted run; repeat before treating differences as stable.', 'Labels are diagnostic campaign controls, not certified ground truth.'],
    sources, rows };
}

main().then(result => {
  const report = summarize(result);
  fs.writeFileSync(process.argv[4], JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log('\nsaved');
}).catch(error => {
  if (error.rows) fs.writeFileSync(`${process.argv[4]}.partial.json`, JSON.stringify({ error: error.message, rows: error.rows }, null, 2), { flag: 'wx' });
  console.error(error.message);
  process.exitCode = 1;
});
