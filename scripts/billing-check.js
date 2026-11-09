'use strict';

const fs = require('node:fs');

function safeDatabaseError(error) {
  const messages = {
    '28P01': 'Database authentication failed (28P01). Check the database password and exact session-pooler username from Supabase Connect.',
    '3D000': 'Database does not exist (3D000). Use the database name supplied in the Supabase connection URI.',
    '3F000': 'A database schema is missing (3F000). Check which service produced the log; do not create schemas or enable Data API merely to suppress it.',
    ENOTFOUND: 'Database hostname could not be resolved (ENOTFOUND). Check the copied pooler hostname.',
    ECONNREFUSED: 'Database connection refused (ECONNREFUSED). Check the project status, pooler method and port.',
    ETIMEDOUT: 'Database connection timed out (ETIMEDOUT). Check network access and project status.',
    SELF_SIGNED_CERT_IN_CHAIN: 'Database TLS chain is not trusted. Provide the official Supabase CA certificate; do not disable verification.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Database TLS chain could not be verified. Provide the official Supabase CA certificate.',
    CERT_HAS_EXPIRED: 'Database TLS certificate has expired. Check the certificate and contact the database provider.',
  };
  if (messages[error?.code]) return messages[error.code];
  const message = error?.message || '';
  const prefixes = ['DATABASE_URL ', 'Replace the password ', 'Run this check ', 'Keep PAID_INFRA_ENABLED',
    'STRIPE_SECRET_KEY ', 'ZYTE_API_KEY ', 'Database check requires '];
  if (prefixes.some(prefix => message.startsWith(prefix))) return message;
  return 'Database connection/check failed. Connection details withheld; check the private URI, project status and TLS settings.';
}

function connectionOptions(env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  let input = env.DATABASE_URL.trim();
  if ((input.startsWith('"') && input.endsWith('"')) ||
      (input.startsWith("'") && input.endsWith("'"))) {
    input = input.slice(1, -1).trim();
  }
  if (/^(?:psql\b|DATABASE_URL\s*=|jdbc:)/i.test(input)) {
    throw new Error('DATABASE_URL needs only the connection URI, without psql, DATABASE_URL= or jdbc: prefixes.');
  }
  if (!/^postgres(?:ql)?:\/\//i.test(input)) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URI. The received input does not start with postgresql:// or postgres://; check that the whole URI was pasted.');
  }
  if (/[\u0000-\u0020\u007f]/.test(input)) {
    throw new Error('DATABASE_URL contains whitespace or control characters inside the URI. Copy a single-line URI and percent-encode password spaces.');
  }
  let url;
  try { url = new URL(input); }
  catch (_) { throw new Error('DATABASE_URL starts with a PostgreSQL prefix but its structure is invalid. Check the host, port, and percent-encoded password; no connection attempted.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password) {
    throw new Error('DATABASE_URL must contain a PostgreSQL host, username and password.');
  }
  if (url.password.includes('YOUR-PASSWORD') || url.password.includes('YOUR_PASSWORD') ||
      /YOUR[-_]PASSWORD/i.test(decodeURIComponent(url.password))) {
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
        current_setting('transaction_read_only') = 'on' AS read_only
    `);
    const row = result.rows[0];
    if (!row || row.version < 140000 || !row.read_only || !hasVerifiedTls(client)) {
      throw new Error('Database check requires PostgreSQL 14+, a read-only transaction and TLS.');
    }
    await client.query('COMMIT');
    return { postgresMajor: Math.floor(row.version / 10000), tls: true, readOnly: true };
  } finally {
    // Closing this one-shot pool also rolls back any failed transaction.
    client.release();
  }
}

function hasVerifiedTls(client) {
  const stream = client.connection?.stream;
  return stream?.encrypted === true && stream.authorized === true;
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
    console.error(`[billing:check] ${safeDatabaseError(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { checkDatabase, connectionOptions, validateEnvironment, safeDatabaseError, hasVerifiedTls };
