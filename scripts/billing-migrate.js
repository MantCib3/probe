'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPool, transaction } = require('../lib/billing/db');

async function migrate(pool) {
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(724196381)");
    const tls = await client.query(`SELECT ssl,current_setting('server_version_num')::integer AS version
      FROM pg_stat_ssl WHERE pid=pg_backend_pid()`);
    if (!tls.rows[0]?.ssl || tls.rows[0].version < 140000) throw new Error('Verified database TLS and PostgreSQL 14+ required.');
    await client.query('CREATE SCHEMA IF NOT EXISTS probe_billing');
    await client.query('REVOKE ALL ON SCHEMA probe_billing FROM PUBLIC');
    await client.query(`CREATE TABLE IF NOT EXISTS probe_billing.migrations
      (version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('REVOKE ALL ON probe_billing.migrations FROM PUBLIC');
    const directory = path.join(__dirname, '..', 'migrations', 'billing');
    const files = fs.readdirSync(directory).filter(name => /^\d{3}-.+\.sql$/.test(name)).sort();
    for (const version of files) {
      const sql = fs.readFileSync(path.join(directory, version), 'utf8');
      const hash = crypto.createHash('sha256').update(sql).digest('hex');
      const prior = await client.query('SELECT sha256 FROM probe_billing.migrations WHERE version=$1', [version]);
      if (prior.rowCount) {
        if (prior.rows[0].sha256 !== hash) throw new Error('Applied migration checksum mismatch.');
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO probe_billing.migrations(version,sha256) VALUES($1,$2)', [version, hash]);
    }
    return files.length;
  });
}
async function main() {
  if (process.env.PROBE_STAGING !== '1' || process.env.PAID_INFRA_ENABLED !== '0' ||
      (process.env.RENDER && process.env.RENDER_SERVICE_NAME !== 'probe-staging')) {
    throw new Error('Staging and disabled execution required.');
  }
  const pool = createPool();
  try { console.log(`[billing:migrate] verified ${await migrate(pool)} migration(s).`); }
  finally { await pool.end(); }
}
if (require.main === module) main().catch(() => {
  console.error('[billing:migrate] failed; connection/SQL details withheld. Check staging, TLS and migration history.');
  process.exitCode = 1;
});
module.exports = { migrate };
