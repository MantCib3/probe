'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { checkDatabase, connectionOptions, validateEnvironment } = require('../scripts/billing-check');

const env = () => ({
  PROBE_STAGING: '1', PAID_INFRA_ENABLED: '0',
  DATABASE_URL: 'postgresql://postgres.project:example%21@pooler.example.test:5432/postgres',
  STRIPE_SECRET_KEY: 'sk_test_example', ZYTE_API_KEY: 'example',
});

test('readiness refuses production, live keys, missing secrets and activation', () => {
  for (const patch of [{ PROBE_STAGING: '' }, { STRIPE_SECRET_KEY: 'sk_live_example' },
    { STRIPE_SECRET_KEY: 'pk_test_example' }, { ZYTE_API_KEY: '' },
    { PAID_INFRA_ENABLED: '1' }, { DATABASE_URL: '' }]) {
    assert.throws(() => validateEnvironment({ ...env(), ...patch }));
  }
  assert.equal(validateEnvironment(env()).max, 1);
});

test('connection uses session pooler with mandatory verified TLS and bounded timeouts', () => {
  const options = connectionOptions({ ...env(), DATABASE_URL: `${env().DATABASE_URL}?sslmode=no-verify&sslrootcert=ignored&ssl=false` });
  assert.equal(options.ssl.rejectUnauthorized, true);
  const url = new URL(options.connectionString);
  assert.equal(url.port, '5432');
  assert.equal(url.searchParams.has('sslmode'), false);
  assert.equal(url.searchParams.has('sslrootcert'), false);
  assert.equal(url.searchParams.has('ssl'), false);
  assert.equal(options.connectionTimeoutMillis, 10000);
  assert.equal(options.query_timeout, 10000);
  assert.throws(() => connectionOptions({ DATABASE_URL: 'https://example.test' }));
  assert.throws(() => connectionOptions({ DATABASE_URL: 'postgresql://u:[YOUR-PASSWORD]@host/db' }), /placeholder/);
});

test('database check uses only a read-only transaction and releases the connection', async () => {
  const queries = [];
  let released = false;
  const pool = { async connect() {
    return {
      async query(sql) {
        queries.push(sql);
        return { rows: [{ version: 170000, read_only: true, tls: true }] };
      },
      release() { released = true; },
    };
  } };
  assert.deepEqual(await checkDatabase(pool), { postgresMajor: 17, tls: true, readOnly: true });
  assert.equal(queries[0], 'BEGIN READ ONLY');
  assert.equal(queries[2], 'COMMIT');
  assert.equal(released, true);
});

test('insecure or failed database checks fail explicitly and release connections', async () => {
  for (const row of [{ version: 130000, read_only: true, tls: true },
    { version: 170000, read_only: true, tls: false }, { version: 170000, read_only: false, tls: true }]) {
    let released = false;
    await assert.rejects(checkDatabase({ async connect() {
      return { async query() { return { rows: [row] }; }, release() { released = true; } };
    } }), /requires/);
    assert.equal(released, true);
  }
  let released = false;
  await assert.rejects(checkDatabase({ async connect() {
    return { async query() { throw new Error('fixture failure'); }, release() { released = true; } };
  } }), /fixture failure/);
  assert.equal(released, true);
});
