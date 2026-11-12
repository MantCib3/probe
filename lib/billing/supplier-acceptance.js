'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { transaction } = require('./db');
const { CONSENT_VERSION, CONSENT_TEXT, fingerprint } = require('./config');
const { TERMS_HASH } = require('./acceptance');
const { Store, problem } = require('./store');
const { execute, targetFor } = require('./zyte');
const { trialAllowed } = require('./supplier-trial');
const { parseWindow, validatePage, saveStats } = require('./zyte-stats');
const { POLICY, saveAllocation, allocateUsage } = require('./usage-allocation');
const { postAllocation } = require('./allocation-posting');

const CONFIRMATION = 'two-http-usd-allocation-no-retries-v1';
const JOB_IDS = ['cad9fa28-9a9f-45f1-b707-8c4ccae0f301', 'cad9fa28-9a9f-45f1-b707-8c4ccae0f302'];
const CONTROLS = ['born2hack', 'prbad7f0291ab'];
const rate = { source: 'HackerOne', mode: 'http', hosts: ['hackerone.com'],
  supplierMicros: 10000, marginMicros: 0, maximumMicros: 10000 };
const termsHash = fingerprint({ consentVersion: CONSENT_VERSION, consentText: CONSENT_TEXT,
  currency: 'usd', policy: POLICY, rate, campaign: CONFIRMATION });
const config = { enabled: true, consentVersion: CONSENT_VERSION, termsHash, creditMicros: 20000 };

function validateInput(input) {
  const allowed = input?.action === 'post' ? ['action', 'confirmation', 'page', 'manifest'] :
    input?.action === 'start' ? ['action', 'confirmation', 'guestId'] : ['action', 'confirmation'];
  if (!input || input.confirmation !== CONFIRMATION || !['start', 'status', 'post'].includes(input.action) ||
      Object.keys(input).sort().join(',') !== allowed.sort().join(',') ||
      (input.action === 'start' && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.guestId || ''))) {
    throw problem('supplier_acceptance_confirmation_required', 400);
  }
}

async function status(pool) {
  const rows = (await pool.query(`SELECT j.id,j.guest_id,j.state,j.result,j.created_at,j.rate,
    a.provider_ref,a.provider_status,a.target_status,a.state AS attempt_state,a.dispatched_at,a.completed_at,
    a.dispatch_evidence FROM probe_billing.jobs j JOIN probe_billing.attempts a ON a.job_id=j.id
    WHERE j.id=ANY($1::uuid[]) ORDER BY j.id`, [JOB_IDS])).rows;
  return { currency: 'usd', maximumRequests: 2, supplierCeilingMicros: 10000, marginMicros: 0,
    requests: rows.map(row => ({ jobId: row.id, guestId: row.guest_id, state: row.state,
      providerReference: row.provider_ref, providerStatus: row.provider_status, targetStatus: row.target_status,
      attemptState: row.attempt_state, dispatchedAt: row.dispatched_at, completedAt: row.completed_at,
      dispatchEvidence: row.dispatch_evidence, result: row.result })),
    paidExecutionEnabled: false, paymentRequests: 0 };
}

async function start(pool, sites, key, guestId, executeImpl) {
  const site = sites.find(site => site.name === 'HackerOne' && !site.defunct && !site.undetectable);
  if (!site) throw problem('acceptance_source_missing');
  const targets = CONTROLS.map(name => targetFor(site, name, rate));
  const jobs = await transaction(pool, async client => {
    const guest = (await client.query('SELECT * FROM probe_billing.guests WHERE id=$1 FOR UPDATE', [guestId])).rows[0];
    if (!guest || guest.currency !== 'usd' || guest.terms_hash !== TERMS_HASH ||
        guest.token_hash !== createHash('sha256').update(`probe-stripe-acceptance:${guestId}`).digest('hex') ||
        guest.state !== 'active' || String(guest.cap_micros) !== '0' ||
        String(guest.debt_micros) !== '0' || String(guest.reserved_micros) !== '0' ||
        String(guest.paid_micros) !== '1000000' || !guest.customer_id || !guest.payment_method_id ||
        new Date(guest.expires_at).getTime() <= Date.now()) throw problem('verified_usd_success_fixture_required');
    const signed = await client.query(`SELECT e.id FROM probe_billing.payment_events e
      JOIN probe_billing.setups s ON s.checkout_id=e.object_id WHERE s.guest_id=$1
      AND s.state='confirmed' AND e.event_type='checkout.session.completed'`, [guestId]);
    if (!signed.rowCount) throw problem('signed_setup_required');
    await client.query(`UPDATE probe_billing.guests SET consent_version=$2,terms_hash=$3,
      consent_at=now(),cap_micros=paid_micros+20000,reserved_micros=20000 WHERE id=$1`,
    [guestId, CONSENT_VERSION, termsHash]);
    const jobs = [];
    for (let i = 0; i < JOB_IDS.length; i++) {
      const leaseId = randomUUID(), attemptId = randomUUID();
      const job = (await client.query(`INSERT INTO probe_billing.jobs
        (id,guest_id,request_key,source,username,target_url,rate,terms_hash,reservation_micros,state,lease_id,lease_until)
        VALUES($1,$2,$1,'HackerOne',$3,$4,$5::jsonb,$6,10000,'leased',$7,now()+interval '5 minutes') RETURNING *`,
      [JOB_IDS[i], guestId, CONTROLS[i], targets[i], JSON.stringify(rate), termsHash, leaseId])).rows[0];
      await client.query("INSERT INTO probe_billing.attempts(id,job_id,state) VALUES($1,$2,'started')", [attemptId, job.id]);
      jobs.push({ ...job, attempt_id: attemptId });
    }
    return jobs;
  });
  const store = new Store(pool);
  for (const job of jobs) {
    const outcome = await executeImpl(job, site, key, undefined, undefined,
      evidence => store.authorizeAttempt(job, config, evidence));
    const safeOutcome = { ...outcome, result: { status: outcome.result.status, reasonCodes: outcome.result.reasonCodes || [] } };
    await store.finishJob(job, safeOutcome);
    if (outcome.state !== 'response') break;
  }
  return status(pool);
}

async function post(pool, input) {
  const current = await status(pool);
  if (current.requests.length !== 2 || current.requests.some((request, i) =>
    request.attemptState !== 'response' || request.providerStatus !== 200 ||
    request.result?.status !== (i === 0 ? 'found' : 'not_found'))) throw problem('acceptance_successful_controls_required');
  const manifest = input.manifest;
  if (manifest?.organizationId !== 1053513 || manifest.costBasis !== 'pre-credit' ||
      manifest.costBasisVerified !== true || manifest.requests?.length !== 2) throw problem('acceptance_verified_manifest_required');
  for (const request of current.requests) {
    const member = manifest.requests.find(member => member.jobId === request.jobId);
    if (!member || member.guestId !== request.guestId || member.providerReference !== request.providerReference ||
        member.purpose !== 'customer' || member.result !== request.result.status) throw problem('acceptance_membership_mismatch');
  }
  const window = parseWindow(manifest.startTime, manifest.endTime);
  const page = validatePage(input.page, { organizationId: 1053513, page: 1 });
  if (page.totalResultCount !== 1 || page.results.length !== 1 || page.results[0].domain !== 'hackerone.com' ||
      page.results[0].requestCount !== 2) throw problem('acceptance_two_request_window_required');
  const snapshot = { organizationId: 1053513, ...window, domains: page.results };
  allocateUsage({ ...snapshot, domains: page.results.map(row => ({ ...row,
    statusCodes: input.page.results.find(raw => raw.domain.toLowerCase() === row.domain).status_codes })) }, manifest);
  const imported = await saveStats(pool, { ...snapshot, totalResultCount: 1, pageCount: 1, response: { pages: [input.page] } });
  const allocation = await saveAllocation(pool, imported.id, manifest);
  const first = await postAllocation(pool, allocation.id);
  const store = new Store(pool);
  const before = await store.status(current.requests[0].guestId);
  const replay = await postAllocation(pool, allocation.id);
  const after = await store.status(current.requests[0].guestId);
  if (JSON.stringify(before) !== JSON.stringify(after) || replay.duplicate !== true ||
      after.reservedMicros !== '0' || after.jobs.filter(job => JOB_IDS.includes(job.id) && job.state === 'settled').length !== 2) {
    throw problem('acceptance_posting_replay_failed');
  }
  return { importId: imported.id, allocationId: allocation.id, posting: first,
    replayVerified: true, guest: after, paymentRequests: 0, providerExtractionRequests: 0, paidExecutionEnabled: false };
}

async function runSupplierAcceptance(pool, sites, env, input, executeImpl = execute) {
  if (!trialAllowed(env)) throw problem('supplier_acceptance_disabled', 503);
  validateInput(input);
  if (input.action === 'status') return status(pool);
  const guard = await pool.connect();
  let locked = false;
  try {
    locked = (await guard.query('SELECT pg_try_advisory_lock(724196386) AS locked')).rows[0].locked;
    if (!locked) throw problem('supplier_acceptance_in_progress', 409);
    if (input.action === 'post') return await post(pool, input);
    const prior = await pool.query('SELECT id FROM probe_billing.jobs WHERE id=ANY($1::uuid[])', [JOB_IDS]);
    if (prior.rowCount) throw problem('supplier_acceptance_already_started_no_retries');
    return await start(pool, sites, env.ZYTE_API_KEY, input.guestId, executeImpl);
  } finally {
    try { if (locked) await guard.query('SELECT pg_advisory_unlock(724196386)'); }
    finally { guard.release(true); }
  }
}

module.exports = { runSupplierAcceptance, CONFIRMATION, JOB_IDS };
