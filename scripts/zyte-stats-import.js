'use strict';

const { createPool } = require('../lib/billing/db');
const { fetchStats, parseWindow, saveStats } = require('../lib/billing/zyte-stats');
const { checkDatabase, safeDatabaseError } = require('./billing-check');

function sumDecimals(values) {
  const scale = 8;
  const total = values.reduce((sum, value) => {
    const [whole, fraction = ''] = value.split('.');
    return sum + BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
  }, 0n);
  const whole = total / 10n ** BigInt(scale);
  const fraction = String(total % 10n ** BigInt(scale)).padStart(scale, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function argumentsFrom(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--organization-id', '--start-time', '--end-time'].includes(key) || !argv[i + 1] || result[key]) {
      throw new Error('Usage: node scripts/zyte-stats-import.js --organization-id ID --start-time ISO_UTC --end-time ISO_UTC');
    }
    result[key] = argv[++i];
  }
  if (Object.keys(result).length !== 3) throw new Error('Usage: node scripts/zyte-stats-import.js --organization-id ID --start-time ISO_UTC --end-time ISO_UTC');
  const organizationId = Number(result['--organization-id']);
  if (!Number.isSafeInteger(organizationId) || organizationId < 1) throw new Error('organization_id must be a positive integer.');
  return { organizationId, ...parseWindow(result['--start-time'], result['--end-time']) };
}

async function main(env = process.env) {
  if (env.PROBE_STAGING !== '1' || env.PAID_INFRA_ENABLED !== '0' || env.RENDER) {
    throw new Error('Run this importer only from the private local staging checkout with paid execution disabled.');
  }
  const args = argumentsFrom(process.argv.slice(2));
  if (!env.ZYTE_STATS_API_KEY) throw new Error('ZYTE_STATS_API_KEY is required.');
  const pool = createPool(env);
  try {
    const database = await checkDatabase(pool);
    const tables = await pool.query(`SELECT
      to_regclass('probe_billing.zyte_stats_imports') IS NOT NULL AS imports,
      to_regclass('probe_billing.zyte_stats_domains') IS NOT NULL AS domains`);
    if (!tables.rows[0]?.imports || !tables.rows[0]?.domains) {
      throw new Error('Supplier stats tables are not migrated. Run the separately authorized staging migration first.');
    }
    const stats = await fetchStats({ ...args, apiKey: env.ZYTE_STATS_API_KEY });
    const saved = await saveStats(pool, stats);
    console.log(JSON.stringify({
      ok: true,
      importId: saved.id,
      duplicate: saved.duplicate,
      organizationId: stats.organizationId,
      startTime: stats.startTime,
      endTime: stats.endTime,
      domains: stats.domains.length,
      requests: stats.domains.reduce((sum, row) => sum + BigInt(row.requestCount), 0n).toString(),
      totalMicrousd: sumDecimals(stats.domains.map(row => row.costMicrousdTotal)),
      currency: 'USD',
      database,
      customerLedgerWrites: 0,
      providerExtractionRequests: 0,
      paymentRequests: 0,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch(error => {
  const message = error.message || '';
  const safe = /^(Usage:|organization_id |Stats window |Run this importer|ZYTE_STATS_API_KEY |Zyte Stats API |A different Stats API snapshot|Supplier stats tables )/.test(message)
    ? message
    : safeDatabaseError(error);
  console.error(`[zyte:stats-import] ${safe}`);
  process.exitCode = 1;
});

module.exports = { argumentsFrom, main, sumDecimals };
