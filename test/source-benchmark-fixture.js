'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createSourceBenchmark } = require('../lib/source-benchmark');

const env = { PROBE_STAGING: '1', PAID_INFRA_ENABLED: '0', PAID_WORKER_ENABLED: '0',
  PAID_MONEY_PATH_VERIFIED: '0', PAID_USD_MONEY_PATH_VERIFIED: '0', ZYTE_API_KEY: 'fixture-only' };
const sites = [{ name: 'BenchmarkFixture', url: 'https://example.com/{}' }];
const fingerprint = { catalogSha256: 'b'.repeat(64), classifierSha256: 'c'.repeat(64),
  profileMetadataSha256: 'd'.repeat(64), metadataHintsSha256: 'e'.repeat(64), nodeVersion: process.version };
const commit = 'a'.repeat(40);
function manifest() {
  return { schemaVersion: 1, runId: randomUUID(), commit, catalogSha256: fingerprint.catalogSha256,
    sources: [{ site: sites[0].name, controls: [{ username: 'alice', expected: 'found' },
      { username: 'bob', expected: 'not_found' }] }], limits: { direct: 2, http: 2, browser: 1 } };
}
async function runBenchmarkFixture(pool) {
  const input = manifest();
  let directCalls = 0;
  let supplierCalls = 0;
  let authorizeAgain;
  const options = { pool, sites, runtimeFingerprint: fingerprint, commit, env, region: 'fixture-region',
    direct(site, username, deadline) {
      assert.equal(deadline, 15000);
      directCalls++;
      return { promise: username === 'bob' ? Promise.reject(new Error('offline')) : Promise.resolve({
        status: 'found', profile: { displayName: 'Alice Fixture', bio: 'retained metadata' },
        statusCode: 200, reasonCodes: ['fixture_profile'], evidence: { checkedAt: new Date().toISOString() }, confidence: 1 }) };
    },
    async execute(job, site, key, fetchImpl, publicCheck, authorize) {
      assert.equal(key, env.ZYTE_API_KEY);
      assert.match(job.attempt_id, /^[0-9a-f-]{36}$/);
      await authorize({ domain: 'example.com', requestBytes: 123 });
      authorizeAgain = authorize;
      supplierCalls++;
      if (job.rate.mode === 'browser') return { state: 'provider_error', providerStatus: 429,
        providerRef: 'fixture-request', result: { status: 'unknown', reasonCodes: ['provider_http_failure'] } };
      throw new Error('lost provider response');
    } };
  const service = createSourceBenchmark(options);
  const restarted = createSourceBenchmark(options);
  const observe = (mode, username = 'alice', pass = 1) => ({ action: 'observe', runId: input.runId,
    site: sites[0].name, username, mode, pass });
  try {
    const first = await service({ action: 'start', manifest: input });
    assert.equal(first.run.paidExecutionEnabled, false);
    assert.equal(first.run.customerCharges, 0);
    assert.equal(first.nextOffset, null);
    assert.equal(first.run.region, 'fixture-region');
    assert.ok(first.run.createdAt);
    assert.ok(first.run.expiresAt);
    assert.deepEqual((await restarted({ action: 'start', manifest: input })).run.manifest, input);
    const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys)
      : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])])) : value;
    assert.deepEqual((await restarted({ action: 'start', manifest: reverseKeys(input) })).run.manifest, input);
    const reorderedIdentity = createSourceBenchmark({ ...options, runtimeFingerprint: reverseKeys(fingerprint) });
    assert.deepEqual((await reorderedIdentity({ action: 'status', runId: input.runId })).run.runtimeFingerprint, fingerprint);
    await assert.rejects(service({ action: 'start', manifest: { ...input, limits: { ...input.limits, direct: 1 } } }), /benchmark_manifest_conflict/);
    await assert.rejects(service({ action: 'start', manifest: manifest() }), /benchmark_run_in_progress/);
    await assert.rejects(service({ ...observe('http'), username: 'mallory' }), /benchmark_control_mismatch/);
    await assert.rejects(service({ ...observe('http'), headers: {} }), /invalid_benchmark_input/);
    const direct = (await service(observe('direct'))).attempt;
    assert.equal(direct.state, 'response');
    assert.equal(direct.result.profile.displayName, 'Alice Fixture');
    assert.equal(direct.result.statusCode, 200);
    assert.ok(direct.checkedAt);
    assert.equal(direct.cost, null);
    assert.equal(direct.costVerified, false);
    assert.deepEqual(direct.runtimeFingerprint, fingerprint);
    assert.deepEqual(direct.runtimeFingerprint, (await service(observe('direct'))).runtimeFingerprint);
    assert.equal((await restarted(observe('direct'))).attempt.id, direct.id);
    const failed = (await service(observe('direct', 'bob'))).attempt;
    assert.equal(failed.state, 'probe_error');
    assert.equal(failed.result.status, 'error');
    await assert.rejects(restarted(observe('direct', 'alice', 2)), /benchmark_lane_limit/);
    assert.equal(directCalls, 2);
    const uncertain = (await service(observe('http'))).attempt;
    assert.equal(uncertain.state, 'uncertain');
    assert.equal(uncertain.result.status, 'unknown');
    assert.equal((await restarted(observe('http'))).attempt.id, uncertain.id);
    await assert.rejects(authorizeAgain(), /benchmark_already_dispatched/);
    // Simulate process loss after reservation: replays must not dispatch even a started row.
    const pending = randomUUID();
    await pool.query(`INSERT INTO probe_lab.benchmark_attempts(id,run_id,site,username,mode,pass)
      VALUES($1,$2,$3,'bob','http',1)`, [pending, input.runId, sites[0].name]);
    const replay = (await restarted(observe('http', 'bob'))).attempt;
    assert.equal(replay.id, pending);
    assert.equal(replay.state, 'started');
    assert.equal(replay.result, null);
    const blocked = (await service(observe('browser'))).attempt;
    assert.equal(blocked.providerStatus, 429);
    assert.equal(blocked.providerRef, 'fixture-request');
    assert.equal((await restarted(observe('browser'))).attempt.id, blocked.id);
    await assert.rejects(service(observe('http', 'alice', 2)), /benchmark_supplier_stopped/);
    assert.equal(supplierCalls, 2);
    const status = await service({ action: 'status', runId: input.runId });
    assert.equal(status.attempts.length, 5);
    assert.equal(status.run.supplierStopped, true);
    assert.equal((await service({ action: 'status', runId: input.runId, offset: 5 })).attempts.length, 0);
    const changed = createSourceBenchmark({ ...options, runtimeFingerprint: { ...fingerprint, metadataHintsSha256: 'f'.repeat(64) } });
    await assert.rejects(changed({ action: 'status', runId: input.runId }), /benchmark_runtime_mismatch/);
    await pool.query(`UPDATE probe_lab.benchmark_runs SET expires_at=now()-interval '1 second' WHERE id=$1`, [input.runId]);
    await assert.rejects(service(observe('direct')), /benchmark_run_expired/);
  } finally {
    await pool.query('DELETE FROM probe_lab.benchmark_attempts WHERE run_id=$1', [input.runId]);
    await pool.query('DELETE FROM probe_lab.benchmark_runs WHERE id=$1', [input.runId]);
  }
}
async function runBenchmarkRaceFixture(pool) {
  const input = manifest();
  input.limits.direct = 1;
  const waiting = [];
  let entered = 0;
  let signal;
  const waitFor = async count => {
    while (entered < count) await new Promise(resolve => { signal = resolve; });
  };
  const block = async () => {
    entered++;
    const pending = new Promise(resolve => waiting.push(resolve));
    signal?.();
    await pending;
    return { status: 'unknown', reasonCodes: ['fixture'] };
  };
  const options = { pool, sites, runtimeFingerprint: fingerprint, commit, env,
    direct: () => ({ promise: block() }),
    execute: async (job, site, key, fetchImpl, publicCheck, authorize) => {
      await authorize();
      return { state: 'response', providerStatus: 200, result: await block() };
    } };
  const first = createSourceBenchmark(options);
  const second = createSourceBenchmark(options);
  const observe = (mode, pass = 1) => ({ action: 'observe', runId: input.runId,
    site: sites[0].name, username: 'alice', mode, pass });
  let active = [];
  try {
    const starts = await Promise.all([first, second].map(service => service({ action: 'start', manifest: input })));
    assert.equal(starts[0].run.id, starts[1].run.id);
    const competitors = [first(observe('direct')), second(observe('direct', 2))]
      .map(promise => promise.then(value => ({ value }), error => ({ error })));
    active.push(...competitors);
    await waitFor(1);
    const rejected = await Promise.race(competitors);
    assert.match(rejected.error?.message || '', /benchmark_lane_limit/);
    const winner = (await first({ action: 'status', runId: input.runId })).attempts[0];
    const replay = await second(observe('direct', winner.pass));
    assert.equal(replay.attempt.state, 'dispatched');
    assert.equal(replay.attempt.result, null);
    await assert.rejects(second(observe('direct', 3)), /benchmark_lane_limit/);
    waiting.shift()();
    const settled = await Promise.all(competitors);
    assert.equal(settled.filter(result => result.value).length, 1);
    active = [];
    const http = first(observe('http'));
    active.push(http);
    await waitFor(2);
    const http2 = second(observe('http', 2));
    active.push(http2);
    await waitFor(3);
    await assert.rejects(first(observe('browser')), /benchmark_rate_limited/);
    waiting.splice(0).forEach(resolve => resolve());
    await Promise.all(active);
    active = [];
    const quota = createSourceBenchmark({ ...options, hourlyLimit: 3 });
    await assert.rejects(quota(observe('browser')), /benchmark_rate_limited/);
    await assert.rejects(second(observe('http', 3)), /benchmark_lane_limit/);
    assert.equal(entered, 3);
    const status = await first({ action: 'status', runId: input.runId });
    assert.equal(status.attempts.length, 3);
    assert.equal(status.run.reserved.direct, 1);
    assert.equal(status.run.reserved.http, 2);
  } finally {
    waiting.splice(0).forEach(resolve => resolve());
    await Promise.allSettled(active);
    await pool.query('DELETE FROM probe_lab.benchmark_attempts WHERE run_id=$1', [input.runId]);
    await pool.query('DELETE FROM probe_lab.benchmark_runs WHERE id=$1', [input.runId]);
  }
}
module.exports = { env, sites, fingerprint, commit, manifest, runBenchmarkFixture, runBenchmarkRaceFixture };
