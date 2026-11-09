'use strict';

const fs = require('node:fs');
const { createPool } = require('../lib/billing/db');
const { Store } = require('../lib/billing/store');
async function main() {
  if (process.env.PROBE_STAGING !== '1' || process.env.PAID_RECONCILIATION_ENABLED !== '1' ||
      (process.env.RENDER && process.env.RENDER_SERVICE_NAME !== 'probe-staging')) {
    throw new Error('Operator staging reconciliation required.');
  }
  const file = process.argv[2];
  if (!file) throw new Error('An authoritative evidence JSON file is required.');
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pool = createPool();
  try {
    await new Store(pool).reconcile(input);
    console.log('[billing:reconcile] usage reconciled idempotently; no provider or payment request.');
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(() => {
  console.error('[billing:reconcile] failed; evidence/connection details withheld. Reservation retained.');
  process.exitCode = 1;
});
