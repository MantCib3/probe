'use strict';

const { createPool } = require('../lib/billing/db');
const { postAllocation } = require('../lib/billing/allocation-posting');
const { checkDatabase, safeDatabaseError } = require('./billing-check');
const { UUID } = require('../lib/billing/stripe');
const { problem } = require('../lib/billing/store');

async function main(env = process.env, argv = process.argv.slice(2)) {
  if (env.PROBE_STAGING !== '1' || env.PAID_RECONCILIATION_ENABLED !== '1' ||
      env.PAID_INFRA_ENABLED !== '0' || env.PAID_WORKER_ENABLED !== '0' ||
      (env.RENDER && env.RENDER_SERVICE_NAME !== 'probe-staging')) {
    throw problem('allocation_posting_disabled', 503);
  }
  if (argv.length !== 1 || !UUID.test(argv[0])) throw problem('saved_allocation_uuid_required', 400);
  const pool = createPool(env);
  try {
    await checkDatabase(pool);
    const result = await postAllocation(pool, argv[0]);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return result;
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => {
  console.error(`[billing:reconcile] ${error.publicCode || safeDatabaseError(error)}; transaction held or rolled back.`);
  process.exitCode = 1;
});
module.exports = { main };
