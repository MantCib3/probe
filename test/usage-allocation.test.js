'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { POLICY, allocateUsage, saveAllocation } = require('../lib/billing/usage-allocation');

const pricing = { mode: 'http', ipType: 'automatic',
  features: ['httpResponseBody', 'httpResponseHeaders', 'customHttpRequestHeaders'] };
function fixture() {
  const snapshot = {
    organizationId: 1053513, startTime: '2026-11-09T07:30:00Z', endTime: '2026-11-09T07:31:00Z',
    domains: [
      { domain: 'hackerone.com', requestCount: 2, costMicrousdTotal: '266.00', statusCodes: [{ code: 200, count: 2 }] },
      { domain: 'tellonym.me', requestCount: 2, costMicrousdTotal: '266.00', statusCodes: [{ code: 200, count: 2 }] },
    ],
  };
  const manifest = {
    schemaVersion: 1, policy: POLICY, organizationId: snapshot.organizationId,
    startTime: snapshot.startTime, endTime: snapshot.endTime,
    evidenceReference: 'operator-dashboard-membership-2026-11-09',
    windowMembershipVerified: true, pricingConditionsVerified: true,
    requests: [
      { providerReference: '307b39bbb3f8418bf271a8d7d81ce4c1', domain: 'hackerone.com', supplierTimestamp: '2026-11-09T07:30:05.507Z', providerStatus: 200, purpose: 'test', pricing },
      { providerReference: '089c9a46b30de316fb9426f948276a6c', domain: 'hackerone.com', supplierTimestamp: '2026-11-09T07:30:07.846Z', providerStatus: 200, purpose: 'test', pricing },
      { providerReference: 'e1a7b966f0f33e8db8c101942f149779', domain: 'tellonym.me', supplierTimestamp: '2026-11-09T07:30:09.559Z', providerStatus: 200, purpose: 'test', pricing },
      { providerReference: 'dad53365fffa63076d291e50d0edf2f6', domain: 'tellonym.me', supplierTimestamp: '2026-11-09T07:30:14.204Z', providerStatus: 200, purpose: 'test', pricing },
    ],
  };
  return { snapshot, manifest };
}
function customer(request) {
  Object.assign(request, { purpose: 'customer', currency: 'usd', guestId: randomUUID(), jobId: randomUUID(), result: 'unknown' });
}
function equalSum(a, b, total) {
  assert.equal(BigInt(a.numerator) * BigInt(b.denominator) * BigInt(total.denominator) +
    BigInt(b.numerator) * BigInt(a.denominator) * BigInt(total.denominator),
  BigInt(total.numerator) * BigInt(a.denominator) * BigInt(b.denominator));
}

test('confirmed four-request batch allocates exactly 133 USD millionths each, all absorbed by PROBE', () => {
  const { snapshot, manifest } = fixture();
  const plan = allocateUsage(snapshot, manifest);
  assert.equal(plan.state, 'evidence_only');
  assert.equal(plan.currency, 'usd');
  assert.equal(plan.shares.length, 4);
  for (const share of plan.shares) {
    assert.deepEqual(share.allocatedMicrousd, { numerator: '133', denominator: '1' });
    assert.equal(share.disposition, 'probe_absorbed');
  }
  for (const total of plan.totals) {
    assert.deepEqual(total.customerCandidateMicrousd, { numerator: '0', denominator: '1' });
    assert.deepEqual(total.probeAbsorbedMicrousd, total.totalMicrousd);
  }
  assert.equal(plan.customerLedgerWrites, 0);
});

test('PROBE test, duplicate and error shares are not redistributed to customers', () => {
  for (const purpose of ['test', 'duplicate', 'probe_error', 'provider_error', 'uncertain']) {
    const { snapshot, manifest } = fixture();
    customer(manifest.requests[0]);
    manifest.requests[1].purpose = purpose;
    const plan = allocateUsage(snapshot, manifest);
    const domain = plan.totals.find(row => row.domain === 'hackerone.com');
    assert.deepEqual(domain.customerCandidateMicrousd, { numerator: '133', denominator: '1' });
    assert.deepEqual(domain.probeAbsorbedMicrousd, { numerator: '133', denominator: '1' });
    equalSum(domain.customerCandidateMicrousd, domain.probeAbsorbedMicrousd, domain.totalMicrousd);
  }
});

test('fractional micro-costs remain exact fractions; no per-request rounding up', () => {
  const { snapshot, manifest } = fixture();
  snapshot.domains = [{ domain: 'hackerone.com', requestCount: 3, costMicrousdTotal: '1.00000001', statusCodes: [{ code: 200, count: 3 }] }];
  manifest.requests = manifest.requests.slice(0, 2);
  manifest.requests.push({ ...manifest.requests[0], providerReference: 'f'.repeat(32) });
  customer(manifest.requests[0]);
  const plan = allocateUsage(snapshot, manifest);
  assert.deepEqual(plan.shares[0].allocatedMicrousd, { numerator: '100000001', denominator: '300000000' });
  equalSum(plan.totals[0].customerCandidateMicrousd, plan.totals[0].probeAbsorbedMicrousd, plan.totals[0].totalMicrousd);
});

test('missing, extra, duplicated, foreign and out-of-window members hold allocation', () => {
  for (const change of [
    m => m.requests.pop(),
    m => m.requests.push({ ...m.requests[0], providerReference: 'f'.repeat(32) }),
    m => { m.requests[1].providerReference = m.requests[0].providerReference; },
    m => { m.requests[0].domain = 'foreign.example'; },
    m => { m.requests[0].supplierTimestamp = '2026-11-09T07:29:59Z'; },
    m => { m.requests[0].supplierTimestamp = '2026-11-09T07:31:00Z'; },
    m => { m.organizationId = 99; },
    m => { m.windowMembershipVerified = false; },
    m => { m.pricingConditionsVerified = false; },
    m => { m.requests[0].email = 'unneeded@example.test'; },
  ]) {
    const { snapshot, manifest } = fixture();
    change(manifest);
    assert.throws(() => allocateUsage(snapshot, manifest));
  }
});

test('mixed HTTP conditions and unsupported browser/features hold the domain batch', () => {
  for (const patched of [
    { ...pricing, mode: 'browser' },
    { ...pricing, ipType: 'residential' },
    { ...pricing, features: ['httpResponseBody'] },
    { ...pricing, extendedGeolocation: true },
  ]) {
    const { snapshot, manifest } = fixture();
    manifest.requests[0].pricing = patched;
    assert.throws(() => allocateUsage(snapshot, manifest), /pricing conditions/);
  }
});

test('status mismatches, missing USD ownership and repeated customer jobs cannot allocate', () => {
  const { snapshot, manifest } = fixture();
  manifest.requests[0].providerStatus = 500;
  assert.throws(() => allocateUsage(snapshot, manifest), /status counts/);
  manifest.requests[0].providerStatus = 200;
  customer(manifest.requests[0]);
  manifest.requests[0].currency = 'aud';
  assert.throws(() => allocateUsage(snapshot, manifest), /USD ownership/);
  manifest.requests[0].currency = 'usd';
  customer(manifest.requests[1]);
  manifest.requests[1].jobId = manifest.requests[0].jobId;
  assert.throws(() => allocateUsage(snapshot, manifest), /unique USD ownership/);
});

test('ordering changes do not change canonical allocation evidence', () => {
  const { snapshot, manifest } = fixture();
  const first = allocateUsage(snapshot, manifest);
  manifest.requests.reverse();
  snapshot.domains.reverse();
  manifest.requests[0].pricing = { ...pricing, features: [...pricing.features].reverse() };
  assert.deepEqual(allocateUsage(snapshot, manifest), first);
});

test('saved allocation is idempotent, rejects overlapping request reuse and never posts ledger amounts', async () => {
  const { snapshot, manifest } = fixture();
  const importId = randomUUID();
  const statements = [];
  let previous;
  let used = false;
  const client = {
    release() {},
    async query(sql, args) {
      statements.push(sql);
      if (sql.startsWith('SELECT * FROM probe_billing.zyte_stats_imports')) return { rows: [{
        organization_id: snapshot.organizationId, start_time: snapshot.startTime, end_time: snapshot.endTime,
        response: { pages: [{ results: snapshot.domains.map(row => ({ domain: row.domain, status_codes: row.statusCodes })) }] },
      }] };
      if (sql.startsWith('SELECT * FROM probe_billing.zyte_stats_domains')) return { rows: snapshot.domains.map(row => ({
        domain: row.domain, request_count: row.requestCount, cost_microusd_total: row.costMicrousdTotal,
      })) };
      if (sql.startsWith('SELECT id, sha256')) return { rows: previous ? [previous] : [] };
      if (sql.startsWith('SELECT provider_ref')) return { rows: [], rowCount: used ? 1 : 0 };
      if (sql.startsWith('INSERT INTO probe_billing.usage_allocations')) previous = { id: args[0], sha256: args[2] };
      return { rows: [], rowCount: 1 };
    },
  };
  const pool = { connect: async () => client };
  const first = await saveAllocation(pool, importId, manifest);
  assert.equal(first.duplicate, false);
  const repeated = await saveAllocation(pool, importId, manifest);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.id, first.id);
  const insertCount = statements.filter(sql => sql.startsWith('INSERT INTO probe_billing.usage_allocations')).length;
  assert.equal(insertCount, 1);
  await assert.rejects(saveAllocation(pool, importId, { ...manifest, evidenceReference: 'conflicting-evidence' }), /conflicting/);
  previous = undefined;
  used = true;
  await assert.rejects(saveAllocation(pool, randomUUID(), manifest), /another window/);
  assert.ok(statements.every(sql => !/probe_billing\.(guests|jobs|ledger|collections)\b/.test(sql)));
  assert.equal(statements.at(-1), 'ROLLBACK');
});
