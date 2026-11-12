'use strict';

const fs = require('node:fs');
const { createPool } = require('../lib/billing/db');
const { checkDatabase, safeDatabaseError } = require('./billing-check');
const { saveAllocation } = require('../lib/billing/usage-allocation');

async function main(env = process.env, argv = process.argv.slice(2)) {
  if (env.PROBE_STAGING !== '1' || env.PAID_INFRA_ENABLED !== '0' ||
      env.PAID_WORKER_ENABLED !== '0' || env.PAID_ALLOCATION_ENABLED !== '1' ||
      (env.RENDER && env.RENDER_SERVICE_NAME !== 'probe-staging')) {
    throw new Error('Usage allocation: staging, disabled execution/worker and explicit allocation enablement required.');
  }
  if (argv.length !== 2) throw new Error('Usage allocation: provide a Stats import ID and a private membership-manifest JSON path.');
  const [id, file] = argv;
  if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('Usage allocation: manifest size limit exceeded.');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Usage allocation: invalid manifest JSON.'); }
  const pool = createPool(env);
  try {
    await checkDatabase(pool);
    const result = await saveAllocation(pool, id, manifest);
    console.log(JSON.stringify({ ok: true, allocationId: result.id, duplicate: result.duplicate, ...result.plan }, null, 2));
    return result;
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => {
  console.error(error.message?.startsWith('Usage allocation:') ? error.message :
    `[billing:allocate] ${safeDatabaseError(error)}`);
  process.exitCode = 1;
});
module.exports = { main };
