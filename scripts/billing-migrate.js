'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPool, transaction } = require('../lib/billing/db');
const { hasVerifiedTls } = require('./billing-check');

async function migrate(pool) {
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(724196381)");
    const version = await client.query("SELECT current_setting('server_version_num')::integer AS version");
    if (!hasVerifiedTls(client) || version.rows[0]?.version < 140000) throw new Error('Verified database TLS and PostgreSQL 14+ required.');
    await client.query('CREATE SCHEMA IF NOT EXISTS probe_billing');
    await client.query('REVOKE ALL ON SCHEMA probe_billing FROM PUBLIC');
    await client.query(`CREATE TABLE IF NOT EXISTS probe_billing.migrations
      (version text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('REVOKE ALL ON probe_billing.migrations FROM PUBLIC');
    const directory = path.join(__dirname, '..', 'migrations', 'billing');
    const files = fs.readdirSync(directory).filter(name => /^\d{3}-.+\.sql$/.test(name)).sort();
    for (const version of files) {
      const sql = fs.readFileSync(path.join(directory, version), 'utf8');
      const canonical = sql.replace(/\r\n/g, '\n');
      const digest = value => crypto.createHash('sha256').update(value).digest('hex');
      const hash = digest(canonical);
      const prior = await client.query('SELECT sha256 FROM probe_billing.migrations WHERE version=$1', [version]);
      if (prior.rowCount) {
        // Older Windows runs recorded CRLF bytes; accept only the identical SQL with LF/CRLF endings.
        if (![hash, digest(canonical.replace(/\n/g, '\r\n'))].includes(prior.rows[0].sha256)) {
          const error = new Error('Applied migration checksum mismatch.');
          error.code = 'MIGRATION_CHECKSUM_MISMATCH';
          throw error;
        }
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
