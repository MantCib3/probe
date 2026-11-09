'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createPool } = require('../lib/billing/db');
const { Store } = require('../lib/billing/store');
const { migrate } = require('../scripts/billing-migrate');
const { CONSENT_VERSION } = require('../lib/billing/config');

const localUri = process.env.PROBE_BILLING_TEST_DATABASE_URL;
test('real local PostgreSQL: cap race, durable recovery, reconciliation and webhook accounting', {
  skip: !localUri && 'No dedicated local TLS PostgreSQL provided; money path remains gated.',
}, async t => {
  const url = new URL(localUri);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname), 'Remote databases are forbidden in this test.');
  assert.match(url.pathname, /^\/probe_billing_test_[a-z0-9_]+$/, 'Use a dedicated test database.');
  const pool = createPool({ DATABASE_URL: localUri,
    DATABASE_CA_CERT_PATH: process.env.PROBE_BILLING_TEST_CA_PATH });
  let cleanup = async () => {};
  t.after(async () => { try { await cleanup(); } finally { await pool.end(); } });
  await migrate(pool);
  await migrate(pool);
  const store = new Store(pool);
  const owner = randomUUID();
  const other = randomUUID();
  const termsHash = createHash('sha256').update('test-only-terms').digest('hex');
  const config = { enabled: true, consentVersion: CONSENT_VERSION, termsHash,
    creditMicros: 100000, thresholdMicros: 20000, minimumCents: 1 };
  const rate = { source: 'LocalFixture', mode: 'http', hosts: ['example.com'],
    supplierMicros: 10003, marginMicros: 1, maximumMicros: 10004 };
  const site = { name: rate.source };
  // Delete only this test's UUID-owned records, never shared data or schema.
  cleanup = async () => {
    const ids = [owner, other];
    await pool.query('DELETE FROM probe_billing.payment_events WHERE id LIKE $1', [`evt_local_${owner}%`]);
    await pool.query('DELETE FROM probe_billing.ledger WHERE guest_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM probe_billing.attempts WHERE job_id IN (SELECT id FROM probe_billing.jobs WHERE guest_id=ANY($1::uuid[]))', [ids]);
    await pool.query('DELETE FROM probe_billing.jobs WHERE guest_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM probe_billing.collections WHERE guest_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM probe_billing.setups WHERE guest_id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM probe_billing.guests WHERE id=ANY($1::uuid[])', [ids]);
  };
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
  assert.equal((await store.status(other)).jobs.length, 0);
  assert.equal((await store.status(owner)).reservedMicros, '10004');
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
  const evidence = { jobId: job.id, supplierMicros: 10003, disposition: 'billed',
    authoritative: true, evidenceReference: `fixture-usage-export:${job.id}`,
    providerReference: `provider_fixture_${job.id}` };
  await store.reconcile(evidence);
  await store.reconcile(evidence);
  let status = await store.status(owner);
  assert.equal(status.debtMicros, '10004'); assert.equal(status.reservedMicros, '0');
  await pool.query("UPDATE probe_billing.guests SET last_collection_at=now()-interval '2 days' WHERE id=$1", [owner]);
  const claims = await Promise.all([store.claimCollection(config), store.claimCollection(config)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const collection = claims.find(Boolean);
  const intent = { id: `pi_fixture_${collection.id}`, status: 'succeeded', livemode: false, currency: 'aud',
    customer: `cus_fixture_${owner}`, payment_method: `pm_fixture_${owner}`, amount: 1, amount_received: 1,
    metadata: { probe_collection: collection.id, probe_guest: owner } };
  const event = { id: `evt_local_${owner}`, type: 'payment_intent.succeeded' };
  await Promise.all([store.paymentResult(collection.id, intent, event), store.paymentResult(collection.id, intent, event)]);
  await store.paymentResult(collection.id, { ...intent, status: 'processing' },
    { ...event, id: `${event.id}_late`, type: 'payment_intent.processing' });
  status = await store.status(owner);
  assert.equal(status.debtMicros, '4'); assert.equal(status.paidMicros, '10000');
  assert.equal(status.usage.filter(entry => entry.kind === 'payment').length, 1);
  assert.equal(await store.claimCollection(config), null);
  const queued = await store.enqueue(other, randomUUID(), site, 'carol', 'https://example.com/carol', rate, config);
  await store.revoke(other);
  assert.equal((await store.status(other)).reservedMicros, '0');
  assert.equal((await pool.query('SELECT state FROM probe_billing.jobs WHERE id=$1', [queued])).rows[0].state, 'cancelled');
  await assert.rejects(store.enqueue(other, randomUUID(), site, 'dan', 'https://example.com/dan', rate, config), /consent_or_payment/);
});
