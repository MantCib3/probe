'use strict';

const { loadConfig } = require('../lib/billing/config');
const { createPool } = require('../lib/billing/db');
const { Store } = require('../lib/billing/store');
const { createStripe, collect } = require('../lib/billing/stripe');
const { execute } = require('../lib/billing/zyte');
const { SITES } = require('../lib/config');

async function tick(store, stripe, config, executeJob) {
  if (!config.enabled) throw new Error('Paid execution disabled.');
  await store.recover();
  for (const collection of await store.openCollections()) await collect(store, stripe, collection);
  const collection = await store.claimCollection(config);
  if (collection) await collect(store, stripe, collection);
  const job = await store.claimJob(config);
  if (job) {
    const outcome = await executeJob(job);
    await store.finishJob(job, outcome);
  }
}
async function main(env = process.env) {
  const config = loadConfig(env, SITES);
  if (!config.enabled || env.PAID_WORKER_ENABLED !== '1') throw new Error('Disabled worker.');
  const pool = createPool(env);
  let stopped = false;
  process.once('SIGTERM', () => { stopped = true; });
  process.once('SIGINT', () => { stopped = true; });
  try {
    const store = new Store(pool);
    const stripe = createStripe(env);
    do {
      try {
        await tick(store, stripe, config, job =>
          execute(job, SITES.find(s => s.name === job.source), env.ZYTE_API_KEY,
            undefined, undefined, evidence => store.authorizeAttempt(job, config, evidence)));
      } catch (_) {
        console.error('[billing:worker] tick failed; details withheld. Durable uncertain work needs review.');
        if (process.argv.includes('--once')) throw new Error('Worker failed.');
      }
      if (process.argv.includes('--once') || stopped) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
    } while (!stopped);
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(() => {
  console.error('[billing:worker] stopped or disabled; check private staging configuration.');
  process.exitCode = 1;
});
module.exports = { tick };
