'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const { createSourceBenchmark, validateManifest, initialize } = require('../lib/source-benchmark');
const { createStagingHandler } = require('../staging-probe');
const { env, sites, fingerprint, commit, manifest, runBenchmarkFixture, runBenchmarkRaceFixture,
  runBenchmarkInterruptionFixture, runBenchmarkLifecycleFixture } = require('./source-benchmark-fixture');

test('benchmark rejects malformed/untrusted manifests, inactive sources and deployment drift', () => {
  const good = manifest();
  assert.equal(validateManifest(good, sites, commit, fingerprint), good);
  const invalid = [
    { ...good, schemaVersion: '1' }, { ...good, runId: 123 },
    { ...good, url: 'https://example.com/' }, { ...good, limits: { ...good.limits, http: 1001 } },
    { ...good, limits: { ...good.limits, direct: '1' } }, { ...good, sources: Array(301).fill(good.sources[0]) },
    { ...good, sources: [{ site: sites[0].name, controls: [{ username: 'ALICE', expected: 'found' }, { username: 'alice', expected: 'found' }] }] },
    { ...good, sources: [{ site: sites[0].name, controls: [{ username: 'alice', expected: 'unknown' }] }] },
    { ...good, sources: [{ site: sites[0].name, controls: [{ username: 'a/b', expected: 'found' }] }] },
  ];
  for (const value of invalid) assert.throws(() => validateManifest(value, sites, commit, fingerprint));
  for (const flag of ['defunct', 'undetectable', 'manual']) assert.throws(() =>
    validateManifest(good, [{ ...sites[0], [flag]: true }], commit, fingerprint));
  assert.throws(() => validateManifest(good, sites, 'f'.repeat(40), fingerprint), /deployment_mismatch/);
  const { targetFor } = require('../lib/billing/zyte');
  for (const extra of [{ apiUrl: 'https://example.com/api/{}' }, { checkUrl: 'https://example.com/check/{}' },
    { requestAdapter: { method: 'GET' } }, { credential: { env: 'FIXTURE_KEY' } }]) {
    assert.throws(() => targetFor({ ...sites[0], ...extra }, 'alice', { mode: 'http', hosts: ['example.com'] }),
      error => error.status === 400 && error.publicCode === 'unsupported_paid_source');
  }
});

test('benchmark cannot activate public/customer billing and has no database fallback', async () => {
  for (const key of ['PROBE_STAGING', 'PAID_INFRA_ENABLED', 'PAID_WORKER_ENABLED', 'PAID_MONEY_PATH_VERIFIED', 'PAID_USD_MONEY_PATH_VERIFIED', 'ZYTE_API_KEY']) {
    const service = createSourceBenchmark({ sites, runtimeFingerprint: fingerprint, commit,
      env: { ...env, [key]: key === 'PROBE_STAGING' ? '0' : key === 'ZYTE_API_KEY' ? '' : '1' } });
    await assert.rejects(service({ action: 'start', manifest: manifest() }), /spending_gates_required/);
  }
  await assert.rejects(createSourceBenchmark({ env, sites, runtimeFingerprint: fingerprint, commit })({ action: 'start', manifest: manifest() }), /database_required/);
});

test('benchmark endpoint authenticates, bounds JSON, keeps status outside probe quota and reports failures', async () => {
  let calls = 0;
  const secret = 'x'.repeat(64);
  const handler = createStagingHandler({ enabled: true, secret, sites, hourlyLimit: 1,
    readBody: async (req, limit) => {
      assert.equal(limit, 256 * 1024);
      if (req.body === 'large') throw Object.assign(new Error('large'), { code: 'BODY_TOO_LARGE' });
      return req.body;
    }, runtimeFingerprint: fingerprint,
    sourceBenchmark: async input => {
      calls++;
      if (input.fail) throw Object.assign(new Error('private'), { status: 409, publicCode: 'benchmark_runtime_mismatch' });
      return { run: { id: 'fixture' } };
    } });
  async function request(body, authorization = `Bearer ${secret}`, method = 'POST') {
    const req = { body, method, headers: { authorization }, setTimeout() {} };
    const res = { writeHead(status) { this.status = status; }, end(text) { this.payload = JSON.parse(text); } };
    await handler('/api/staging-source-benchmark', req, res);
    return res;
  }
  assert.equal((await request('{}', '')).status, 401);
  assert.equal((await request('{}', undefined, 'GET')).status, 405);
  assert.equal((await request('large')).status, 413);
  assert.equal((await request('{')).status, 400);
  for (let n = 0; n < 3; n++) {
    const response = await request('{"action":"status"}');
    assert.equal(response.status, 200);
    assert.deepEqual(response.payload.runtimeFingerprint, fingerprint);
  }
  const failure = await request('{"fail":true}');
  assert.equal(failure.status, 409);
  assert.equal(failure.payload.error, 'benchmark_runtime_mismatch');
  assert.equal(calls, 4);
  for (const options of [{ enabled: false }, { enabled: true }]) {
    const disabled = createStagingHandler({ ...options, secret, sites });
    const res = { writeHead(status) { this.status = status; }, end() {} };
    await disabled('/api/staging-source-benchmark',
      { method: 'POST', headers: { authorization: `Bearer ${secret}` } }, res);
    assert.equal(res.status, 404);
  }
});

test('embedded PostgreSQL retains metadata, reservations and uncertain outcomes across service restarts', { timeout: 120000 }, async t => {
  const db = new PGlite();
  let queue = Promise.resolve();
  const query = async (sql, values) => {
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool = { query, async connect() {
    const previous = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await previous;
    return { query, release };
  } };
  try {
    await t.test('legacy roots migrate budget identity without losing existing attempt reservations', async () => {
      await db.exec(`CREATE SCHEMA probe_lab;
        CREATE TABLE probe_lab.benchmark_runs(
          id uuid PRIMARY KEY,manifest jsonb NOT NULL,fingerprint jsonb NOT NULL,region text,
          created_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL DEFAULT (now()+interval '72 hours'),
          supplier_stopped boolean NOT NULL DEFAULT false);
        CREATE TABLE probe_lab.benchmark_attempts(
          sequence bigserial UNIQUE,id uuid PRIMARY KEY,
          run_id uuid NOT NULL REFERENCES probe_lab.benchmark_runs(id),
          site text NOT NULL,username text NOT NULL,mode text NOT NULL,pass integer NOT NULL,
          state text NOT NULL DEFAULT 'started',created_at timestamptz NOT NULL DEFAULT now(),
          dispatched_at timestamptz,completed_at timestamptz,outcome jsonb,duration_ms integer,
          dispatch_evidence jsonb,UNIQUE(run_id,site,username,mode,pass));`);
      const legacy = manifest();
      await pool.query(`INSERT INTO probe_lab.benchmark_runs(id,manifest,fingerprint,expires_at)
        VALUES($1,$2::jsonb,$3::jsonb,now()-interval '1 second')`,
      [legacy.runId, JSON.stringify(legacy), JSON.stringify(fingerprint)]);
      await pool.query(`INSERT INTO probe_lab.benchmark_attempts(id,run_id,site,username,mode,pass,state)
        VALUES($1,$1,$2,'alice','browser',1,'uncertain')`, [legacy.runId, sites[0].name]);
      await initialize(pool);
      await initialize(pool);
      const migratedService = createSourceBenchmark({ pool, sites, env, commit, runtimeFingerprint: fingerprint });
      const migrated = await migratedService({ action: 'status', runId: legacy.runId });
      assert.equal(migrated.run.budgetId, legacy.runId);
      assert.equal(migrated.run.lifecycle, 'expired');
      assert.deepEqual(migrated.run.manifest, legacy);
      assert.deepEqual(migrated.run.reserved, { direct: 0, http: 0, browser: 1 });
      assert.deepEqual(migrated.run.runReserved, { direct: 0, http: 0, browser: 1 });
      assert.equal(migrated.attempts.length, 1);
      const successorManifest = { ...legacy, runId: manifest().runId };
      const successor = await migratedService({
        action: 'start', manifest: successorManifest, predecessorRunId: legacy.runId,
      });
      assert.equal(successor.run.budgetId, legacy.runId);
      assert.deepEqual(successor.run.reserved, { direct: 0, http: 0, browser: 1 });
      assert.deepEqual(successor.run.runReserved, { direct: 0, http: 0, browser: 0 });
      assert.equal(successor.run.remaining.browser, 0);
      await pool.query('DELETE FROM probe_lab.benchmark_runs WHERE id=$1', [successorManifest.runId]);
      await pool.query('DELETE FROM probe_lab.benchmark_attempts WHERE run_id=$1', [legacy.runId]);
      await pool.query('DELETE FROM probe_lab.benchmark_runs WHERE id=$1', [legacy.runId]);
    });
    await runBenchmarkFixture(pool);
    await runBenchmarkRaceFixture(pool);
    await runBenchmarkInterruptionFixture(pool);
    await t.test('versioned successors share immutable lineage budgets across deployment changes', () => runBenchmarkLifecycleFixture(pool));
  }
  finally { await db.close(); }
});
