'use strict';

// Post-deploy verification: waits until the deployed service reports the
// expected commit, then checks catalog identity and core routes.
//   node scripts/verify-deploy.js <origin> <commit> [--timeout-min 20]

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [origin, commit] = process.argv.slice(2);
const timeoutIndex = process.argv.indexOf('--timeout-min');
const timeoutMs = (timeoutIndex > 0 ? Number(process.argv[timeoutIndex + 1]) : 20) * 60000;
if (!origin || !/^[0-9a-f]{7,40}$/.test(commit || '')) {
  console.error('usage: verify-deploy.js <origin> <commit-sha>');
  process.exit(2);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const get = (route, init = {}) => fetch(new URL(route, origin), { signal: AbortSignal.timeout(90000), redirect: 'manual', ...init });

(async () => {
  const started = Date.now();
  let identity = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await get('/version.json');
      if (response.ok) {
        identity = await response.json();
        if (identity.commit && identity.commit.startsWith(commit.slice(0, 7))) break;
        console.log(`live commit ${identity.commit || 'unknown'}; waiting for ${commit.slice(0, 7)}`);
      } else {
        console.log(`/version.json HTTP ${response.status}; waiting`);
      }
    } catch (error) {
      console.log(`unreachable (${error.cause?.code || error.name}); waiting`);
    }
    identity = null;
    await sleep(20000);
  }
  if (!identity) throw new Error(`deploy of ${commit} not live within ${timeoutMs / 60000} min`);

  const failures = [];
  const source = fs.readFileSync(path.join(__dirname, '..', 'sites.json'));
  if (identity.catalogSha256 !== crypto.createHash('sha256').update(source).digest('hex')) failures.push('catalog hash differs from the committed sites.json');
  const active = JSON.parse(source.toString('utf8')).filter(site => !site.defunct).length;
  if (identity.sources?.active !== active) failures.push(`active source count ${identity.sources?.active} != ${active}`);
  for (const route of ['/', '/blog/', '/sites.json', '/roadmap', '/llms.txt']) {
    const status = (await get(route)).status;
    if (status !== 200) failures.push(`${route} HTTP ${status}, expected 200`);
  }
  // Without the staging key, staging routes must never answer successfully.
  for (const route of ['/api/staging-health', '/api/staging-billing-health', '/api/staging-billing-accounting', '/api/staging-billing-stripe-health']) {
    const method = route.endsWith('-accounting') ? 'POST' : 'GET';
    const status = (await get(route, { method })).status;
    if (![401, 404].includes(status)) failures.push(`${route} HTTP ${status} without authentication, expected 401/404`);
  }

  console.log(JSON.stringify({ origin, commit: identity.commit, node: identity.node, sources: identity.sources, failures }, null, 2));
  if (failures.length) process.exit(1);
})().catch(error => { console.error(error.message); process.exit(1); });
