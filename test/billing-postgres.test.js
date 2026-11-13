'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPool } = require('../lib/billing/db');
const { migrate } = require('../scripts/billing-migrate');
const { checkAccounting, accountingCheckAllowed } = require('../scripts/billing-accounting-check');
const { runRecoveryFixtures } = require('../scripts/billing-recovery-check');

test('hosted accounting fixtures require exact staging identity and all spending gates off', () => {
  const env = { PROBE_STAGING: '1', PAID_INFRA_ENABLED: '0',
    PAID_WORKER_ENABLED: '0', PAID_MONEY_PATH_VERIFIED: '0' };
  assert.equal(accountingCheckAllowed(env), true);
  for (const name of Object.keys(env)) {
    assert.equal(accountingCheckAllowed({ ...env, [name]: undefined }), false);
    assert.equal(accountingCheckAllowed({ ...env, [name]: name === 'PROBE_STAGING' ? '0' : '1' }), false);
  }
  assert.equal(accountingCheckAllowed({ ...env, RENDER: 'true', RENDER_SERVICE_NAME: 'probe' }), false);
  assert.equal(accountingCheckAllowed({ ...env, RENDER: 'true', RENDER_SERVICE_NAME: 'probe-staging' }), true);
});

test('accounting preflight refuses populated ledgers and competing runs without writes', async () => {
  for (const blocked of ['populated', 'locked']) {
    const queries = [];
    const releases = [];
    const client = {
      connection: { stream: { encrypted: true, authorized: true } },
      async query(sql) {
        queries.push(sql);
        if (sql.includes("current_setting('server_version_num')")) return { rows: [{ version: 170000, read_only: true }] };
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: blocked !== 'locked' }] };
        if (sql.includes('SELECT EXISTS')) return { rows: [{ populated: true }] };
        return { rows: [] };
      },
      release(discard) { releases.push(discard); },
    };
    const pool = { connect: async () => client, query: async () => assert.fail('Fixture writes must not start.') };
    await assert.rejects(checkAccounting(pool), blocked === 'populated' ? /empty guest ledger/ : /already running/);
    assert.equal(queries.some(sql => /INSERT|DELETE|UPDATE|CREATE/.test(sql)), false);
    assert.equal(queries.some(sql => sql.includes('pg_advisory_unlock')), blocked === 'populated');
    assert.equal(releases.at(-1), true);
  }
});

const localUri = process.env.PROBE_BILLING_TEST_DATABASE_URL;
test('real local PostgreSQL: cap race, durable recovery, reconciliation and webhook accounting', {
  skip: !localUri && process.env.PROBE_REQUIRE_POSTGRES !== '1' && 'No dedicated local TLS PostgreSQL provided; hosted acceptance is separate.',
}, async t => {
  assert.ok(localUri, 'Required PostgreSQL gate unavailable: configure a dedicated local TLS database.');
  const url = new URL(localUri);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Remote databases are forbidden in this test.');
  assert.match(url.pathname, /^\/probe_billing_test_[a-z0-9_]+$/, 'Use a dedicated test database.');
  const settings = { PROBE_STAGING: '1', PAID_INFRA_ENABLED: '0', PAID_WORKER_ENABLED: '0',
    PAID_MONEY_PATH_VERIFIED: '0', PAID_USD_MONEY_PATH_VERIFIED: '0' };
  const previous = Object.fromEntries(Object.keys(settings).map(name => [name, process.env[name]]));
  Object.assign(process.env, settings);
  t.after(() => Object.entries(previous).forEach(([name, value]) => {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }));
  const pool = createPool({ DATABASE_URL: localUri,
    DATABASE_CA_CERT_PATH: process.env.PROBE_BILLING_TEST_CA_PATH });
  try {
    await migrate(pool);
    await migrate(pool);
    const result = await checkAccounting(pool);
    assert.equal(result.checks.length, 17);
    assert.equal(result.fixturesRemoved, true);
    assert.equal(result.database.readOnly, true);
    assert.equal(result.readOnly, undefined);
    const recovery = await runRecoveryFixtures(pool);
    assert.equal(recovery.checks.length, 12);
    assert.equal(recovery.fixturesRemoved, true);
    await t.test('source benchmark durable reservations, metadata and uncertain outcomes without customer writes', async () => {
      const before = (await pool.query('SELECT count(*)::integer AS count FROM probe_billing.guests')).rows[0].count;
      await require('./source-benchmark-fixture').runBenchmarkFixture(pool);
      await require('./source-benchmark-fixture').runBenchmarkRaceFixture(pool);
      await require('./source-benchmark-fixture').runBenchmarkInterruptionFixture(pool);
      await require('./source-benchmark-fixture').runBenchmarkLifecycleFixture(pool);
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM probe_billing.guests')).rows[0].count, before);
    });
  } finally {
    await pool.end();
  }
});
