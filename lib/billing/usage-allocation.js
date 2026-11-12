'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { transaction } = require('./db');
const { parseWindow } = require('./zyte-stats');

const POLICY = 'domain-window-equal-share-usd-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURPOSES = new Set(['customer', 'test', 'duplicate', 'probe_error', 'provider_error', 'uncertain']);

function invalid(message) { throw new Error(`Usage allocation: ${message}`); }
function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}
function fraction(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) invalid('invalid nonnegative fraction.');
  const divisor = gcd(numerator, denominator);
  return { numerator: String(numerator / divisor), denominator: String(denominator / divisor) };
}
function microUsd(value) {
  if (typeof value !== 'string' || !/^\d{1,22}(?:\.\d{1,8})?$/.test(value)) invalid('invalid supplier USD total.');
  const [whole, decimal = ''] = value.split('.');
  return BigInt(whole) * 100000000n + BigInt(decimal.padEnd(8, '0'));
}
function pricingClass(pricing) {
  if (!pricing || Object.keys(pricing).sort().join(',') !== 'features,ipType,mode' ||
      pricing.mode !== 'http' || !['automatic', 'datacenter', 'residential'].includes(pricing.ipType) ||
      !Array.isArray(pricing.features) || pricing.features.length !== 3 ||
      [...pricing.features].sort().join(',') !== 'customHttpRequestHeaders,httpResponseBody,httpResponseHeaders') {
    invalid('unsupported pricing conditions; only the verified HTTP feature set is supported.');
  }
  return JSON.stringify({ mode: pricing.mode, ipType: pricing.ipType, features: [...pricing.features].sort() });
}
function fields(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key));
}
function allocationDigest(plan) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
}

function allocateUsage(snapshot, manifest) {
  if (!snapshot || !Number.isSafeInteger(snapshot.organizationId) || snapshot.organizationId < 1 ||
      !Array.isArray(snapshot.domains)) invalid('invalid imported snapshot.');
  const window = parseWindow(snapshot.startTime, snapshot.endTime);
  if (!fields(manifest, ['schemaVersion', 'policy', 'organizationId', 'startTime', 'endTime',
    'windowMembershipVerified', 'pricingConditionsVerified', 'costBasis', 'costBasisVerified', 'evidenceReference', 'requests']) ||
      manifest.schemaVersion !== 1 || manifest.policy !== POLICY ||
      manifest.organizationId !== snapshot.organizationId ||
      manifest.windowMembershipVerified !== true || manifest.pricingConditionsVerified !== true ||
      typeof manifest.evidenceReference !== 'string' || manifest.evidenceReference.trim().length < 8 ||
      manifest.evidenceReference.length > 256 || !Array.isArray(manifest.requests)) {
    invalid('a complete operator-verified membership and pricing manifest is required.');
  }
  const manifestWindow = parseWindow(manifest.startTime, manifest.endTime);
  if (manifestWindow.startTime !== window.startTime || manifestWindow.endTime !== window.endTime) invalid('window mismatch.');
  const domains = new Map();
  for (const row of snapshot.domains) {
    if (!row || typeof row.domain !== 'string' || !Number.isSafeInteger(row.requestCount) ||
        row.requestCount <= 0 || domains.has(row.domain)) invalid('invalid or duplicate domain aggregate.');
    domains.set(row.domain, row);
  }
  const references = new Set();
  const jobs = new Set();
  const requests = manifest.requests.map(request => {
    if (!fields(request, ['providerReference', 'domain', 'supplierTimestamp', 'providerStatus', 'purpose',
      'pricing', 'currency', 'guestId', 'jobId', 'result']) ||
        !/^[a-f0-9]{32}$/i.test(request.providerReference || '') ||
        references.has(request.providerReference.toLowerCase()) || !domains.has(request.domain) ||
        !PURPOSES.has(request.purpose) || !Number.isInteger(request.providerStatus) ||
        request.providerStatus < 100 || request.providerStatus > 599) invalid('invalid, duplicate, or unmatched request.');
    references.add(request.providerReference.toLowerCase());
    const timestamp = parseWindow(request.supplierTimestamp, window.endTime).startTime;
    if (timestamp < window.startTime) invalid('request lies outside the supplier reporting window.');
    const customer = request.purpose === 'customer';
    if (customer) {
      if (request.providerStatus !== 200 || !['found', 'not_found', 'unknown', 'blocked'].includes(request.result) ||
          request.currency !== 'usd' || !UUID.test(request.guestId || '') || !UUID.test(request.jobId || '') ||
          jobs.has(request.jobId.toLowerCase())) invalid('customer usage needs unique USD ownership and a successful supplier response.');
      jobs.add(request.jobId.toLowerCase());
    } else if (request.guestId !== undefined || request.jobId !== undefined || request.currency !== undefined) {
      invalid('PROBE-absorbed requests must not carry customer ownership.');
    }
    return {
      providerReference: request.providerReference.toLowerCase(),
      domain: request.domain,
      supplierTimestamp: timestamp,
      providerStatus: request.providerStatus,
      purpose: request.purpose,
      pricingClass: pricingClass(request.pricing),
      ...(customer ? { guestId: request.guestId.toLowerCase(), jobId: request.jobId.toLowerCase(), result: request.result } : {}),
    };
  }).sort((a, b) => a.providerReference.localeCompare(b.providerReference));

  const shares = [];
  const totals = [];
  for (const [domain, row] of [...domains].sort(([a], [b]) => a.localeCompare(b))) {
    const members = requests.filter(request => request.domain === domain);
    if (members.length !== row.requestCount) invalid('supplier/local request counts do not match.');
    if (new Set(members.map(request => request.pricingClass)).size !== 1) invalid('mixed pricing conditions in one domain/window.');
    // Check supplier status totals as well as the total request count.
    if (!Array.isArray(row.statusCodes) || !row.statusCodes.length) invalid('supplier status-code evidence is required.');
    const expected = new Map();
    for (const status of row.statusCodes) {
      if (!Number.isInteger(status.code) || status.code < 100 || status.code > 599 ||
          !Number.isSafeInteger(status.count) || status.count <= 0 || expected.has(status.code)) invalid('invalid supplier status totals.');
      expected.set(status.code, status.count);
    }
    const actual = new Map();
    for (const member of members) actual.set(member.providerStatus, (actual.get(member.providerStatus) || 0) + 1);
    if (expected.size !== actual.size || [...expected].some(([code, count]) => actual.get(code) !== count)) invalid('supplier status counts do not match.');
    const units = microUsd(row.costMicrousdTotal);
    const denominator = 100000000n * BigInt(members.length);
    const customerCount = members.filter(member => member.purpose === 'customer').length;
    totals.push({
      domain,
      requestCount: members.length,
      totalMicrousd: fraction(units, 100000000n),
      customerCandidateMicrousd: fraction(units * BigInt(customerCount), denominator),
      probeAbsorbedMicrousd: fraction(units * BigInt(members.length - customerCount), denominator),
    });
    for (const member of members) {
      const { pricingClass: pricing, ...identity } = member;
      shares.push({
        ...identity,
        pricing: JSON.parse(pricing),
        disposition: member.purpose === 'customer' ? 'customer_candidate' : 'probe_absorbed',
        allocatedMicrousd: fraction(units, denominator),
      });
    }
  }
  return {
    schemaVersion: 1, policy: POLICY, currency: 'usd',
    costBasis: manifest.costBasis, costBasisVerified: manifest.costBasisVerified === true,
    organizationId: snapshot.organizationId, ...window,
    evidenceReference: manifest.evidenceReference,
    state: 'evidence_only', customerLedgerWrites: 0, paymentRequests: 0,
    totals, shares: shares.sort((a, b) => a.providerReference.localeCompare(b.providerReference)),
  };
}

async function saveAllocation(pool, importId, manifest) {
  if (!UUID.test(importId || '')) invalid('invalid import ID.');
  return transaction(pool, async client => {
    const imported = (await client.query('SELECT * FROM probe_billing.zyte_stats_imports WHERE id=$1', [importId])).rows[0];
    if (!imported) invalid('unknown Stats import.');
    // Serialize membership claims across all windows for the same organization.
    await client.query('SELECT pg_advisory_xact_lock(724196385, hashtext($1))', [String(imported.organization_id)]);
    const rows = (await client.query('SELECT * FROM probe_billing.zyte_stats_domains WHERE import_id=$1', [importId])).rows;
    const rawRows = imported.response.pages.flatMap(page => page.results);
    const plan = allocateUsage({
      organizationId: Number(imported.organization_id),
      startTime: new Date(imported.start_time).toISOString(),
      endTime: new Date(imported.end_time).toISOString(),
      domains: rows.map(row => ({
        domain: row.domain, requestCount: Number(row.request_count),
        costMicrousdTotal: row.cost_microusd_total,
        statusCodes: rawRows.find(raw => raw.domain.toLowerCase() === row.domain)?.status_codes,
      })),
    }, manifest);
    const digest = allocationDigest(plan);
    const previous = (await client.query('SELECT id, sha256 FROM probe_billing.usage_allocations WHERE import_id=$1', [importId])).rows[0];
    if (previous) {
      if (previous.sha256 !== digest) invalid('conflicting allocation evidence for the imported window.');
      return { id: previous.id, duplicate: true, plan };
    }
    const used = await client.query(`SELECT provider_ref FROM probe_billing.usage_allocation_requests
      WHERE organization_id=$1 AND provider_ref=ANY($2::text[])`,
    [plan.organizationId, plan.shares.map(share => share.providerReference)]);
    if (used.rowCount) invalid('a supplier request was already allocated in another window.');
    const id = randomUUID();
    await client.query(`INSERT INTO probe_billing.usage_allocations(id,import_id,sha256,manifest,plan)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`, [id, importId, digest, JSON.stringify(manifest), JSON.stringify(plan)]);
    for (const share of plan.shares) {
      await client.query(`INSERT INTO probe_billing.usage_allocation_requests
        (organization_id,provider_ref,allocation_id) VALUES($1,$2,$3)`,
      [plan.organizationId, share.providerReference, id]);
    }
    return { id, duplicate: false, plan };
  });
}

module.exports = { POLICY, allocateUsage, saveAllocation, fraction, pricingClass, allocationDigest };
