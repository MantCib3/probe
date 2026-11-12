'use strict';

const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Store } = require('../lib/billing/store');
const { CONSENT_VERSION } = require('../lib/billing/config');
const { checkDatabase } = require('./billing-check');
const { transaction } = require('../lib/billing/db');

function accountingCheckAllowed(env = process.env) {
  return env.PROBE_STAGING === '1' &&
    (!env.RENDER || env.RENDER_SERVICE_NAME === 'probe-staging') &&
    env.PAID_USD_MONEY_PATH_VERIFIED !== '1' &&
    ['PAID_INFRA_ENABLED', 'PAID_WORKER_ENABLED', 'PAID_MONEY_PATH_VERIFIED']
      .every(name => env[name] === '0');
}

async function checkAccounting(pool) {
  const database = await checkDatabase(pool);
  const guard = await pool.connect();
  let locked = false;
  try {
    locked = (await guard.query('SELECT pg_try_advisory_lock(724196382) AS locked')).rows[0].locked;
    if (!locked) throw new Error('Accounting check already running.');
    // Global worker claims/recovery are safe only in an unused, disabled staging ledger.
    const existing = await guard.query('SELECT EXISTS(SELECT 1 FROM probe_billing.guests) AS populated');
    if (existing.rows[0].populated) throw new Error('Accounting check requires an empty guest ledger.');
    return { database, ...await runFixtures(pool), fixturesRemoved: true };
  } finally {
    try {
      if (locked) await guard.query('SELECT pg_advisory_unlock(724196382)');
    } finally {
      // Discarding the session also releases its advisory lock after a failed unlock.
      guard.release(true);
    }
  }
}

async function runFixtures(pool) {
  const store = new Store(pool);
  const owner = randomUUID();
  const other = randomUUID();
  const termsHash = createHash('sha256').update('test-only-terms').digest('hex');
  const config = { enabled: true, consentVersion: CONSENT_VERSION, termsHash,
    creditMicros: 100000, thresholdMicros: 20000, minimumCents: 1 };
  const rate = { source: 'AccountingFixture', synthetic: true, mode: 'http', hosts: ['example.com'],
    supplierMicros: 10003, marginMicros: 1, maximumMicros: 10004 };
  const site = { name: rate.source };
  // Delete only this test's UUID-owned records, never shared data or schema.
  const cleanup = async () => {
    const ids = [owner, other];
    await transaction(pool, async client => {
      await client.query('DELETE FROM probe_billing.payment_events WHERE id=ANY($1::text[])',
        [[`evt_fixture_${owner}`, `evt_fixture_${owner}_late`]]);
      await client.query('DELETE FROM probe_billing.ledger WHERE guest_id=ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM probe_billing.attempts WHERE job_id IN (SELECT id FROM probe_billing.jobs WHERE guest_id=ANY($1::uuid[]))', [ids]);
      await client.query('DELETE FROM probe_billing.jobs WHERE guest_id=ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM probe_billing.collections WHERE guest_id=ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM probe_billing.setups WHERE guest_id=ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM probe_billing.guests WHERE id=ANY($1::uuid[])', [ids]);
    });
  };
  try {
    for (const id of [owner, other]) {
      await pool.query(`INSERT INTO probe_billing.guests(id,token_hash,csrf_hash,state,
        consent_version,terms_hash,consent_at,customer_id,payment_method_id,cap_micros)
        VALUES($1,$2,$3,'active',$4,$5,now(),$6,$7,$8)`,
      [id, createHash('sha256').update(id).digest('hex'), termsHash, CONSENT_VERSION,
        termsHash, `cus_fixture_${id}`, `pm_fixture_${id}`, 10004]);
    }
    const requests = await Promise.allSettled([
      store.enqueue(owner, randomUUID(), site, 'alice', 'https://example.com/alice', rate, config),
      store.enqueue(owner, randomUUID(), site, 'bob', 'https://example.com/bob', rate, config),
    ]);
    assert.equal(requests.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(requests.find(r => r.status === 'rejected').reason.message, /customer_cap/);
    const successful = requests.find(r => r.status === 'fulfilled').value;
    const saved = (await pool.query('SELECT * FROM probe_billing.jobs WHERE id=$1', [successful])).rows[0];
    assert.equal(await store.enqueue(owner, saved.request_key, site, saved.username, saved.target_url, rate, config), successful);
    await assert.rejects(store.enqueue(owner, saved.request_key, site, 'different', saved.target_url, rate, config), /idempotency_conflict/);
    assert.equal((await store.status(other)).jobs.length, 0);
    assert.equal((await store.status(owner)).reservedMicros, '10004');
    await assert.rejects(store.cap(owner, 10003), /cap_below_committed_spend/);
    const job = await store.claimJob(config);
    assert.equal(job.id, successful);
    await store.authorizeAttempt(job, config);
    await assert.rejects(store.authorizeAttempt(job, config), /attempt_already_dispatched/);
    await pool.query("UPDATE probe_billing.jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    await store.recover();
    assert.equal(await store.claimJob(config), null);
    assert.equal((await store.status(owner)).reservedMicros, '10004');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM probe_billing.attempts WHERE job_id=$1', [job.id])).rows[0].n, 1);
    await store.finishJob(job, { state: 'response', providerStatus: 200, targetStatus: 404,
      providerRef: `provider_fixture_${job.id}`, result: { status: 'not_found', reasonCodes: ['http_404'] } });
    const evidence = { sandboxFixture: true, jobId: job.id, supplierMicros: 10003, disposition: 'billed',
      authoritative: true, evidenceReference: `fixture-usage-export:${job.id}`,
      providerReference: `provider_fixture_${job.id}` };
    await store.reconcileFixture(evidence);
    await store.reconcileFixture(evidence);
    let status = await store.status(owner);
    assert.equal(status.debtMicros, '10004'); assert.equal(status.reservedMicros, '0');
    await pool.query("UPDATE probe_billing.guests SET last_collection_at=now()-interval '2 days' WHERE id=$1", [owner]);
    const claims = await Promise.allSettled([store.claimCollection(config), store.claimCollection(config)]);
    assert.equal(claims.filter(r => r.status === 'fulfilled').length, 2);
    const collections = claims.map(r => r.value);
    assert.equal(collections.filter(Boolean).length, 1);
    const collection = collections.find(Boolean);
    const intent = { id: `pi_fixture_${collection.id}`, status: 'succeeded', livemode: false, currency: 'usd',
      customer: `cus_fixture_${owner}`, payment_method: `pm_fixture_${owner}`, amount: 1, amount_received: 1,
      metadata: { probe_collection: collection.id, probe_guest: owner } };
    await assert.rejects(store.paymentResult(collection.id, { ...intent, customer: `cus_fixture_${other}` }), /payment_ownership_mismatch/);
    const event = { id: `evt_fixture_${owner}`, type: 'payment_intent.succeeded' };
    const payments = await Promise.allSettled([
      store.paymentResult(collection.id, intent, event), store.paymentResult(collection.id, intent, event),
    ]);
    assert.equal(payments.filter(r => r.status === 'fulfilled').length, 2);
    await store.paymentResult(collection.id, { ...intent, status: 'processing' },
      { ...event, id: `${event.id}_late`, type: 'payment_intent.processing' });
    status = await store.status(owner);
    assert.equal(status.debtMicros, '4'); assert.equal(status.paidMicros, '10000');
    assert.equal(status.usage.filter(entry => entry.kind === 'payment').length, 1);
    assert.equal(await store.claimCollection(config), null);
    await store.cap(owner, 100000);
    for (const state of ['probe_error', 'uncertain', 'response']) {
      const id = await store.enqueue(owner, randomUUID(), site, state, `https://example.com/${state}`, rate, config);
      const next = await store.claimJob(config);
      assert.equal(next.id, id);
      await store.authorizeAttempt(next, config);
      await store.finishJob(next, { state, providerStatus: state === 'response' ? 200 : null,
        targetStatus: state === 'response' ? 200 : null, providerRef: `provider_fixture_${id}`,
        result: { status: 'unknown', reasonCodes: ['fixture_inconclusive'] } });
      if (state !== 'probe_error') {
        await store.reconcileFixture({ ...evidence, jobId: id, evidenceReference: `fixture-usage-export:${id}`,
          providerReference: `provider_fixture_${id}` });
      }
      const result = await store.status(owner);
      assert.equal(result.reservedMicros, '0');
      assert.equal(result.debtMicros, state === 'response' ? '10008' : '4');
    }
    await pool.query("UPDATE probe_billing.guests SET last_collection_at=now()-interval '2 days' WHERE id=$1", [owner]);
    const failure = await store.claimCollection(config);
    assert.equal(failure.guest_id, owner);
    const failedIntent = { ...intent, id: `pi_fixture_${failure.id}`, status: 'requires_action',
      metadata: { probe_collection: failure.id, probe_guest: owner } };
    await store.paymentResult(failure.id, failedIntent);
    await store.paymentResult(failure.id, { ...failedIntent, status: 'processing' });
    assert.equal((await store.status(owner)).state, 'action_required');
    assert.equal((await pool.query('SELECT state FROM probe_billing.collections WHERE id=$1', [failure.id])).rows[0].state, 'failed');
    await assert.rejects(store.enqueue(owner, randomUUID(), site, 'paused', 'https://example.com/paused', rate, config), /consent_or_payment/);
    assert.equal(await store.claimCollection(config), null);
    const queued = await store.enqueue(other, randomUUID(), site, 'carol', 'https://example.com/carol', rate, config);
    await store.revoke(other);
    assert.equal((await store.status(other)).reservedMicros, '0');
    assert.equal((await pool.query('SELECT state FROM probe_billing.jobs WHERE id=$1', [queued])).rows[0].state, 'cancelled');
    await assert.rejects(store.enqueue(other, randomUUID(), site, 'dan', 'https://example.com/dan', rate, config), /consent_or_payment/);
    return { checks: ['cap_race', 'cap_below_reservation', 'request_idempotency',
      'guest_isolation', 'single_dispatch', 'expired_lease_no_retry',
      'reconciliation_idempotency', 'collection_race', 'duplicate_payment_event',
      'out_of_order_payment_event', 'whole_cent_remainder', 'revocation',
      'payment_ownership', 'probe_error_absorbed', 'uncertain_outcome_absorbed',
      'billable_inconclusive', 'payment_failure_pauses_spending'],
      providerRequests: 0, paymentRequests: 0, fixtureWrites: true };
  } finally {
    await cleanup();
    const remaining = await pool.query('SELECT count(*)::int AS n FROM probe_billing.guests WHERE id=ANY($1::uuid[])', [[owner, other]]);
    assert.equal(remaining.rows[0].n, 0, 'Accounting fixtures were not removed.');
  }
}

module.exports = { checkAccounting, accountingCheckAllowed };
