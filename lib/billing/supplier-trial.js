'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { accountingCheckAllowed } = require('../../scripts/billing-accounting-check');
const { transaction } = require('./db');
const { problem } = require('./store');
const { execute, targetFor } = require('./zyte');

const TRIAL_ID = 'a9648ee6-8aaf-4619-bff9-82ce365e7d40';
const TERMS_HASH = createHash('sha256').update('probe-four-http-supplier-trial-v1').digest('hex');
const CONTROLS = [
  { source: 'HackerOne', username: 'born2hack', expected: 'found' },
  { source: 'HackerOne', username: 'prbad7f0291ab', expected: 'not_found' },
  { source: 'Tellonym', username: 'jane', expected: 'found' },
  { source: 'Tellonym', username: 'prbad7f0291ab', expected: 'not_found' },
];
function trialAllowed(env) {
  return accountingCheckAllowed(env) && Boolean((env.ZYTE_API_KEY || '').trim());
}
async function trialStatus(pool) {
  const rows = (await pool.query(`SELECT j.source,j.username,j.result,j.rate,j.created_at,
    a.id AS attempt_id,a.state AS attempt_state,a.provider_status,a.target_status,a.provider_ref
    FROM probe_billing.jobs j JOIN probe_billing.attempts a ON a.job_id=j.id
    WHERE j.guest_id=$1 AND j.terms_hash=$2 ORDER BY j.created_at,j.source,j.username`, [TRIAL_ID, TERMS_HASH])).rows;
  return { trialId: TRIAL_ID, maximumRequests: 4, attempts: rows.map(row => ({
    source: row.source, username: row.username, expected: row.rate.expected,
    state: row.attempt_state, providerStatus: row.provider_status, targetStatus: row.target_status,
    providerReference: row.provider_ref, attemptId: row.attempt_id, startedAt: row.created_at,
    result: row.result, matchesExpected: row.result?.status === row.rate.expected,
  })), paidExecutionEnabled: false, customerCharges: 0,
  supplierCostVerified: false, billability: 'Awaiting authoritative supplier usage evidence; never customer debt.' };
}
async function runSupplierTrial(pool, sites, key, input, executeImpl = execute) {
  if (!input || !['start', 'status'].includes(input.action) ||
      input.confirmation !== 'four-http-requests-no-retries-v1' || Object.keys(input).length !== 2) {
    throw problem('supplier_trial_confirmation_required', 400);
  }
  if (input.action === 'status') return trialStatus(pool);
  const controls = CONTROLS.map(control => {
    const site = sites.find(item => item.name === control.source && !item.defunct && !item.undetectable);
    if (!site) throw problem('trial_catalog_source_missing', 409);
    const rate = { mode: 'http', hosts: [new URL(site.url.replaceAll('{}', control.username)).hostname],
      expected: control.expected, trialOnly: true };
    return { ...control, site, rate, target: targetFor(site, control.username, rate) };
  });
  const guard = await pool.connect();
  let locked = false;
  try {
    locked = (await guard.query('SELECT pg_try_advisory_lock(724196384) AS locked')).rows[0].locked;
    if (!locked) throw problem('supplier_trial_in_progress', 409);
    const prior = await pool.query('SELECT id FROM probe_billing.guests WHERE id=$1', [TRIAL_ID]);
    if (prior.rowCount) throw problem('supplier_trial_already_started_no_retries', 409);
    const hash = createHash('sha256').update(TRIAL_ID).digest('hex');
    const jobs = await transaction(pool, async client => {
      await client.query(`INSERT INTO probe_billing.guests(id,token_hash,csrf_hash,terms_hash,cap_micros)
        VALUES($1,$2,$2,$3,0)`, [TRIAL_ID, hash, TERMS_HASH]);
      const jobs = [];
      for (const control of controls) {
        const id = randomUUID();
        const attempt = randomUUID();
        await client.query(`INSERT INTO probe_billing.jobs
          (id,guest_id,request_key,source,username,target_url,rate,terms_hash,reservation_micros,state)
          VALUES($1,$2,$1,$3,$4,$5,$6,$7,1,'cancelled')`,
        [id, TRIAL_ID, control.source, control.username, control.target, JSON.stringify(control.rate), TERMS_HASH]);
        await client.query("INSERT INTO probe_billing.attempts(id,job_id,state) VALUES($1,$2,'started')", [attempt, id]);
        jobs.push({ id, attempt_id: attempt, source: control.source, username: control.username,
          target_url: control.target, rate: control.rate, site: control.site });
      }
      return jobs;
    });
    for (const job of jobs) {
      const outcome = await executeImpl(job, job.site, key, undefined, undefined, async evidence => {
        const updated = await pool.query(`UPDATE probe_billing.attempts SET state='dispatched',
          dispatched_at=now(),dispatch_evidence=$3::jsonb
          WHERE id=$1 AND job_id=$2 AND state='started' RETURNING id`,
        [job.attempt_id, job.id, evidence ? JSON.stringify(evidence) : null]);
        if (updated.rowCount !== 1) throw problem('trial_attempt_already_dispatched', 409);
      });
      await transaction(pool, async client => {
        await client.query(`UPDATE probe_billing.attempts SET state=$2,provider_status=$3,
          target_status=$4,provider_ref=$5,completed_at=now() WHERE id=$1`,
        [job.attempt_id, outcome.state, outcome.providerStatus || null, outcome.targetStatus || null, outcome.providerRef || null]);
        // Retain classification evidence only, never scraped profile metadata or response bodies.
        await client.query('UPDATE probe_billing.jobs SET result=$2 WHERE id=$1',
          [job.id, JSON.stringify({ status: outcome.result.status, reasonCodes: outcome.result.reasonCodes || [] })]);
      });
      if (outcome.state === 'provider_error' && [400, 401, 403, 422, 429].includes(outcome.providerStatus)) break;
    }
    return trialStatus(pool);
  } finally {
    try {
      if (locked) await guard.query('SELECT pg_advisory_unlock(724196384)');
    } finally {
      guard.release(true);
    }
  }
}
module.exports = { trialAllowed, runSupplierTrial, CONTROLS, TRIAL_ID };
