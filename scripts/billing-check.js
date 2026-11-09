'use strict';

const fs = require('node:fs');

function connectionOptions(env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  let url;
  try { url = new URL(env.DATABASE_URL); }
  catch (_) { throw new Error('DATABASE_URL must be a PostgreSQL connection URI.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password) {
    throw new Error('DATABASE_URL must contain a PostgreSQL host, username and password.');
  }
  if (url.password.includes('YOUR-PASSWORD') || url.password.includes('YOUR_PASSWORD')) {
    throw new Error('Replace the password placeholder in DATABASE_URL privately.');
  }
  // pg connection-string SSL parameters override explicit SSL options.
  // Strip them so certificate verification cannot be disabled by the URI.
  for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const ssl = { rejectUnauthorized: true };
  if (env.DATABASE_CA_CERT_PATH) ssl.ca = fs.readFileSync(env.DATABASE_CA_CERT_PATH, 'utf8');
  return {
    connectionString: url.toString(), ssl, max: 1,
    connectionTimeoutMillis: 10000, query_timeout: 10000,
    application_name: 'probe-billing-readiness',
  };
}

function validateEnvironment(env) {
  if (env.PROBE_STAGING !== '1') throw new Error('Run this check only on staging (PROBE_STAGING=1).');
  if (env.PAID_INFRA_ENABLED && env.PAID_INFRA_ENABLED !== '0') {
    throw new Error('Keep PAID_INFRA_ENABLED=0 during setup.');
  }
  if (!/^sk_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY || '')) {
    throw new Error('STRIPE_SECRET_KEY must be a Stripe sandbox/test secret key, not a live or publishable key.');
  }
  if (!(env.ZYTE_API_KEY || '').trim()) throw new Error('ZYTE_API_KEY is required.');
  return connectionOptions(env);
}

async function checkDatabase(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query(`
      SELECT current_setting('server_version_num')::integer AS version,
        current_setting('transaction_read_only') = 'on' AS read_only,
        EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl) AS tls
    `);
    const row = result.rows[0];
    if (!row || row.version < 140000 || !row.read_only || !row.tls) {
      throw new Error('Database check requires PostgreSQL 14+, a read-only transaction and TLS.');
    }
    await client.query('COMMIT');
    return { postgresMajor: Math.floor(row.version / 10000), tls: true, readOnly: true };
  } finally {
    // Closing this one-shot pool also rolls back any failed transaction.
    client.release();
  }
}

async function main(env = process.env) {
  let pool;
  let database;
  try {
    const options = validateEnvironment(env);
    const { Pool } = require('pg');
    pool = new Pool(options);
    database = await checkDatabase(pool);
  } finally {
    if (pool) await pool.end();
  }
  console.log(JSON.stringify({
    ok: true, database, stripe: 'test_key_format_only', zyte: 'key_present_only',
    providerRequests: 0, paymentRequests: 0, databaseWrites: 0,
    billingImplemented: true, paidExecutionEnabled: false, acceptanceVerified: false,
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    // Driver errors can contain hostnames, connection details or SQL.
    const safeCodes = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', '28P01', '3D000',
      'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED']);
    const message = error.message || '';
    const validation = ['DATABASE_URL ', 'Replace the password ', 'Run this check ', 'Keep PAID_INFRA_ENABLED',
      'STRIPE_SECRET_KEY ', 'ZYTE_API_KEY ', 'Database check requires '].some(prefix => message.startsWith(prefix));
    console.error(`[billing:check] ${validation ? message :
      `Database connection/check failed (${safeCodes.has(error.code) ? error.code : 'see provider connection settings'}). Connection details withheld.`}`);
    process.exitCode = 1;
  });
}

module.exports = { checkDatabase, connectionOptions, validateEnvironment };
