'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { CONSENT_VERSION } = require('../lib/billing/config');
const { POLICY, allocateUsage, allocationDigest } = require('../lib/billing/usage-allocation');
const { carryShare, postAllocation } = require('../lib/billing/allocation-posting');
const { Store, reserveAllowed } = require('../lib/billing/store');
const { main: reconcileCommand } = require('../scripts/billing-reconcile');

const pricing = { mode: 'http', ipType: 'automatic',
  features: ['httpResponseBody', 'httpResponseHeaders', 'customHttpRequestHeaders'] };
function fixture({ splitGuests = false, absorbed = false } = {}) {
  const allocationId = randomUUID();
  const owners = [randomUUID(), randomUUID()].sort();
  const requests = Array.from({ length: 3 }, (_, i) => ({
    providerReference: (i + 1).toString(16).padStart(32, '0'), domain: 'example.com',
    supplierTimestamp: '2026-11-09T07:30:10Z', providerStatus: 200, purpose: 'customer',
    pricing, currency: 'usd', guestId: owners[splitGuests && i === 2 ? 1 : 0], jobId: randomUUID(), result: 'unknown',
  }));
  const jobs = requests.map(request => ({ id: request.jobId, guest_id: request.guestId, currency: 'usd',
    state: 'reconcile', terms_hash: 'a'.repeat(64), result: { status: 'unknown' },
    rate: { supplierMicros: 2, marginMicros: 0 }, reservation_micros: '2' }));
  const attempts = requests.map(request => ({ job_id: request.jobId, provider_ref: request.providerReference,
    provider_status: 200, target_status: 404, state: 'response', dispatched_at: new Date().toISOString(),
    completed_at: new Date().toISOString(), dispatch_evidence: { domain: request.domain, pricing } }));
  if (absorbed) {
    requests[2] = { providerReference: requests[2].providerReference, domain: 'example.com',
      supplierTimestamp: requests[2].supplierTimestamp, providerStatus: 200, purpose: 'uncertain', pricing };
    attempts[2].state = 'uncertain';
  }
  const plan = allocateUsage({
    organizationId: 1053513, startTime: '2026-11-09T07:30:00Z', endTime: '2026-11-09T07:31:00Z',
    domains: [{ domain: 'example.com', requestCount: 3, costMicrousdTotal: '1', statusCodes: [{ code: 200, count: 3 }] }],
  }, {
    schemaVersion: 1, policy: POLICY, organizationId: 1053513,
    startTime: '2026-11-09T07:30:00Z', endTime: '2026-11-09T07:31:00Z',
    windowMembershipVerified: true, pricingConditionsVerified: true, costBasis: 'pre-credit', costBasisVerified: true,
    evidenceReference: 'operator-verified-fixture', requests,
  });
  let state = {
    plan, jobs, attempts, postings: [], ledger: [], receipt: null,
    guests: owners.filter(id => jobs.some(job => job.guest_id === id)).map(id => ({
      id, currency: 'usd', consent_version: CONSENT_VERSION, consent_at: new Date().toISOString(),
      terms_hash: 'a'.repeat(64), reserved_micros: String(jobs.filter(job => job.guest_id === id).length * 2),
      debt_micros: '0', paid_micros: '0', cap_micros: null, remainder_numerator: '0', remainder_denominator: '1',
    })),
  };
  let before;
  const statements = [];
  const client = {
    release() {},
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql === 'BEGIN') before = structuredClone(state);
      if (sql === 'ROLLBACK') state = before;
      if (sql.startsWith('SELECT * FROM probe_billing.usage_allocations')) {
        return { rows: [{ id: allocationId, plan: state.plan, sha256: allocationDigest(state.plan) }] };
      }
      if (sql.startsWith('SELECT receipt')) return { rows: state.receipt ? [{ receipt: state.receipt }] : [] };
      if (sql.includes('JOIN probe_billing.jobs')) {
        const found = state.attempts.find(attempt => attempt.provider_ref === values[0]);
        const job = state.jobs.find(job => job.id === found?.job_id && job.currency === 'usd');
        return { rows: job ? [{ id: job.id, guest_id: job.guest_id }] : [] };
      }
      for (const table of ['guests', 'jobs', 'attempts']) {
        if (sql.startsWith(`SELECT * FROM probe_billing.${table}`)) {
          return { rows: state[table].filter(row => (table === 'attempts' ? row.job_id : row.id) === values[0]) };
        }
      }
      if (sql.startsWith('INSERT INTO probe_billing.usage_allocation_postings')) state.postings.push(values);
      if (sql.startsWith('INSERT INTO probe_billing.ledger')) state.ledger.push({ sql, values });
      if (sql.startsWith('INSERT INTO probe_billing.usage_allocation_batches')) state.receipt = JSON.parse(values[1]);
      return { rows: [], rowCount: 1 };
    },
  };
  return { allocationId, statements, get state() { return state; }, async connect() { return client; } };
}

test('exact fractions carry across changing denominators without rounding up', () => {
  let remainder = { numerator: '0', denominator: '1' };
  let whole = 0n;
  for (const [numerator, denominator] of [['1', '3'], ['1', '6'], ['1', '2']]) {
    const result = carryShare({ numerator, denominator }, remainder);
    whole += result.wholeMicros;
    remainder = result.remainder;
  }
  assert.equal(whole, 1n);
  assert.deepEqual(remainder, { numerator: '0', denominator: '1' });
  assert.throws(() => carryShare({ numerator: '1', denominator: '0' }, remainder));
  assert.throws(() => carryShare({ numerator: '1', denominator: '1' }, { numerator: '2', denominator: '2' }));
});

test('JSONB object-key reordering preserves allocation digest', () => {
  const pool = fixture();
  const reorder = value => Array.isArray(value) ? value.map(reorder) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
  assert.equal(allocationDigest(pool.state.plan), allocationDigest(reorder(pool.state.plan)));
});

test('posting is atomic, whole-micro exact and idempotent including remainder-only usage', async () => {
  const pool = fixture();
  const first = await postAllocation(pool, pool.allocationId);
  assert.equal(first.supplierWholeMicros, '1');
  assert.equal(first.customerLedgerWrites, 3);
  assert.equal(pool.state.guests[0].debt_micros, '1');
  assert.equal(pool.state.guests[0].reserved_micros, '0');
  assert.equal(pool.state.guests[0].remainder_numerator, '0');
  assert.deepEqual(pool.state.ledger.map(row => row.values[2]), ['0', '0', '1']);
  const before = structuredClone(pool.state);
  const second = await postAllocation(pool, pool.allocationId);
  assert.equal(second.duplicate, true);
  assert.deepEqual(pool.state, before);
  assert.equal(second.paymentRequests, 0);
  assert.equal(second.providerExtractionRequests, 0);
});

test('fractions remain owned by each guest; locks are acquired in deterministic order', async () => {
  const pool = fixture({ splitGuests: true });
  await postAllocation(pool, pool.allocationId);
  assert.deepEqual(pool.state.guests.map(guest => guest.debt_micros), ['0', '0']);
  assert.deepEqual(pool.state.guests.map(guest => guest.remainder_numerator), ['2', '1']);
  assert.deepEqual(pool.state.guests.map(guest => guest.remainder_denominator), ['3', '3']);
  const locks = pool.statements.filter(row => row.sql.startsWith('SELECT * FROM probe_billing.guests')).map(row => row.values[0]);
  assert.deepEqual(locks, [...locks].sort());
});

test('uncertain local outcomes release their reservations but their share stays with PROBE', async () => {
  const pool = fixture({ absorbed: true });
  const result = await postAllocation(pool, pool.allocationId);
  assert.equal(result.customerRequests, 2);
  assert.equal(result.probeAbsorbedRequests, 1);
  assert.equal(pool.state.guests[0].debt_micros, '0');
  assert.equal(pool.state.guests[0].remainder_numerator, '2');
  assert.equal(pool.state.guests[0].remainder_denominator, '3');
  assert.equal(pool.state.guests[0].reserved_micros, '0');
  assert.ok(pool.state.ledger[2].sql.includes("'absorbed'"));
});

test('ownership, consent, currency, outcome, pricing, supplier cap and pre-credit failures roll back the entire batch', async () => {
  for (const change of [
    state => { state.guests[0].currency = 'aud'; },
    state => { state.jobs[1].guest_id = randomUUID(); },
    state => { state.jobs[1].terms_hash = 'b'.repeat(64); },
    state => { state.guests[0].consent_version = 'sandbox-aud-postpaid-v1'; },
    state => { state.attempts[1].provider_ref = 'f'.repeat(32); },
    state => { state.attempts[1].state = 'provider_error'; },
    state => { state.attempts[1].dispatch_evidence = { domain: 'other.example', pricing }; },
    state => { state.jobs[1].rate.supplierMicros = 0; },
    state => { state.plan.shares[1].allocatedMicrousd = { numerator: '7', denominator: '3' }; },
    state => { state.plan.costBasisVerified = false; },
    state => { state.guests[0].cap_micros = '0'; },
  ]) {
    const pool = fixture();
    change(pool.state);
    const before = structuredClone(pool.state);
    await assert.rejects(postAllocation(pool, pool.allocationId));
    assert.deepEqual(pool.state, before);
    assert.ok(pool.statements.some(row => row.sql === 'ROLLBACK'));
    assert.equal(pool.statements.some(row => row.sql === 'COMMIT'), false);
  }
});

test('legacy sessions and raw supplier totals cannot enter the new USD path', async () => {
  const pool = fixture();
  const owner = pool.state.guests[0];
  owner.currency = 'aud';
  await assert.rejects(new Store(pool).cap(owner.id, 100), /legacy_currency_frozen/);
  await assert.rejects(new Store(pool).reconcile({ supplierMicros: 133, authoritative: true }), /usd_allocation_reconciliation_required/);
});

test('fractional committed spend counts against credit and lifetime cap boundaries', () => {
  const guest = { currency: 'usd', state: 'active', consent_version: CONSENT_VERSION, terms_hash: 'terms',
    payment_method_id: 'pm_fixture', customer_id: 'cus_fixture', expires_at: new Date(Date.now() + 60000),
    debt_micros: '0', reserved_micros: '0', paid_micros: '0', cap_micros: '2',
    remainder_numerator: '1', remainder_denominator: '3' };
  assert.throws(() => reserveAllowed(guest, 2, { termsHash: 'terms', creditMicros: 3 }), /customer_cap/);
  guest.cap_micros = null;
  assert.throws(() => reserveAllowed(guest, 2, { termsHash: 'terms', creditMicros: 2 }), /credit_limit/);
});

test('operator posting rejects execution-enabled environments and raw-cost files before opening a database', async () => {
  const env = { PROBE_STAGING: '1', PAID_RECONCILIATION_ENABLED: '1',
    PAID_INFRA_ENABLED: '0', PAID_WORKER_ENABLED: '0' };
  await assert.rejects(reconcileCommand({ ...env, PAID_WORKER_ENABLED: '1' }, [randomUUID()]), /allocation_posting_disabled/);
  await assert.rejects(reconcileCommand({ ...env, RENDER: '1', RENDER_SERVICE_NAME: 'probe' }, [randomUUID()]), /allocation_posting_disabled/);
  await assert.rejects(reconcileCommand(env, ['verified-usage.json']), /saved_allocation_uuid_required/);
});
