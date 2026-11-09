'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSupplierTrial, trialAllowed, TRIAL_ID } = require('../lib/billing/supplier-trial');
const sites = [
  { name: 'HackerOne', url: 'https://hackerone.com/{}' },
  { name: 'Tellonym', url: 'https://tellonym.me/{}' },
];
function fixture() {
  let exists = false;
  const jobs = [];
  const attempts = new Map();
  const client = { async query(sql, values) {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql === 'SELECT id FROM probe_billing.guests WHERE id=$1') return { rowCount: exists ? 1 : 0, rows: [] };
    if (sql.includes('INSERT INTO probe_billing.guests')) exists = true;
    if (sql.includes('INSERT INTO probe_billing.jobs')) jobs.push({ id: values[0], guest: values[1], source: values[2], username: values[3] });
    if (sql.includes('INSERT INTO probe_billing.attempts')) attempts.set(values[0], 'started');
    if (sql.includes("SET state='dispatched'")) {
      if (attempts.get(values[0]) !== 'started') return { rowCount: 0, rows: [] };
      attempts.set(values[0], 'dispatched');
      return { rowCount: 1, rows: [{ id: values[0] }] };
    }
    if (sql.includes('SELECT j.source')) return { rows: [] };
    return { rows: [], rowCount: 1 };
  }, release() {} };
  return { pool: { connect: async () => client, query: (sql, values) => client.query(sql, values) }, jobs };
}
const input = { action: 'start', confirmation: 'four-http-requests-no-retries-v1' };
test('supplier trial requires exact disabled-spending gates and provider key', () => {
  const env = { PROBE_STAGING: '1', PAID_INFRA_ENABLED: '0', PAID_WORKER_ENABLED: '0',
    PAID_MONEY_PATH_VERIFIED: '0', ZYTE_API_KEY: 'fixture' };
  assert.equal(trialAllowed(env), true);
  for (const key of Object.keys(env)) assert.equal(trialAllowed({ ...env, [key]: '' }), false);
  assert.equal(trialAllowed({ ...env, RENDER: '1', RENDER_SERVICE_NAME: 'probe' }), false);
});
test('fixed supplier campaign durably bounds requests to four across repeated invocations', async () => {
  const { pool, jobs } = fixture();
  let calls = 0;
  const execute = async (job, site, key, fetchImpl, dns, authorize) => {
    await authorize();
    await assert.rejects(authorize(), /trial_attempt_already_dispatched/);
    calls++;
    assert.equal(job.rate.mode, 'http');
    assert.equal(key, 'fixture');
    return { state: 'response', providerStatus: 200, targetStatus: 200,
      result: { status: 'unknown', reasonCodes: ['fixture'], profile: { private: 'must not be retained' } } };
  };
  await runSupplierTrial(pool, sites, 'fixture', input, execute);
  assert.equal(calls, 4);
  assert.equal(jobs.length, 4);
  assert.ok(jobs.every(job => job.guest === TRIAL_ID));
  await assert.rejects(runSupplierTrial(pool, sites, 'fixture', input, execute), /already_started_no_retries/);
  assert.equal(calls, 4);
  await runSupplierTrial(pool, sites, 'fixture', { ...input, action: 'status' }, execute);
  assert.equal(calls, 4);
});
test('provider setup failures stop remaining requests and never retry the campaign', async () => {
  const { pool } = fixture();
  let calls = 0;
  const execute = async (job, site, key, fetchImpl, dns, authorize) => {
    await authorize(); calls++;
    return { state: 'provider_error', providerStatus: 401, result: { status: 'unknown' } };
  };
  await runSupplierTrial(pool, sites, 'fixture', input, execute);
  assert.equal(calls, 1);
  await assert.rejects(runSupplierTrial(pool, sites, 'fixture', input, execute), /already_started_no_retries/);
  assert.equal(calls, 1);
});
test('supplier trial rejects arbitrary controls, URLs, modes and confirmation', async () => {
  const { pool } = fixture();
  for (const change of [{ url: 'https://example.com' }, { mode: 'browser' }, { action: 'retry' },
    { confirmation: 'other' }]) {
    await assert.rejects(runSupplierTrial(pool, sites, 'fixture', { ...input, ...change }), /confirmation_required/);
  }
  await assert.rejects(runSupplierTrial(pool, [{ ...sites[0], undetectable: true }, sites[1]], 'fixture', input), /catalog_source_missing/);
});
