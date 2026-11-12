'use strict';

const { transaction } = require('./db');
const { CONSENT_VERSION, MAX_MICROS, integer } = require('./config');
const { POLICY, fraction, pricingClass, allocationDigest } = require('./usage-allocation');
const { problem } = require('./store');

function carryShare(share, remainder) {
  for (const value of [share, remainder]) {
    if (!value || !/^\d{1,1000}$/.test(value.numerator) || !/^[1-9]\d{0,999}$/.test(value.denominator)) {
      throw problem('invalid_allocation_fraction');
    }
  }
  const priorN = BigInt(remainder.numerator), priorD = BigInt(remainder.denominator);
  if (priorN >= priorD) throw problem('invalid_allocation_remainder');
  const denominator = BigInt(share.denominator) * priorD;
  const numerator = BigInt(share.numerator) * priorD + priorN * BigInt(share.denominator);
  const next = fraction(numerator % denominator, denominator);
  if (next.numerator.length > 1000 || next.denominator.length > 1000) throw problem('allocation_precision_limit');
  return { wholeMicros: numerator / denominator, remainder: next };
}

function verifyCustomer(share, guest, job, attempt) {
  if (!guest || !job || !attempt || guest.currency !== 'usd' || job.currency !== 'usd' ||
      job.guest_id !== share.guestId || guest.id !== share.guestId || job.id !== share.jobId ||
      job.state !== 'reconcile' || guest.consent_version !== CONSENT_VERSION || !guest.consent_at ||
      !guest.terms_hash || guest.terms_hash !== job.terms_hash ||
      !attempt.dispatched_at || !attempt.completed_at || attempt.state !== 'response' ||
      attempt.provider_status !== 200 || attempt.provider_ref?.toLowerCase() !== share.providerReference ||
      !Number.isInteger(attempt.target_status) || attempt.target_status < 100 || attempt.target_status > 599 ||
      job.result?.status !== share.result ||
      job.result?.reasonCodes?.some(code => ['paid_integrity_guard', 'provider_outcome_uncertain', 'provider_http_failure'].includes(code)) ||
      attempt.dispatch_evidence?.domain !== share.domain ||
      pricingClass(attempt.dispatch_evidence?.pricing) !== pricingClass(share.pricing)) {
    throw problem('allocation_customer_evidence_mismatch');
  }
  const supplierCap = integer(job.rate?.supplierMicros);
  const margin = integer(job.rate?.marginMicros, 0);
  if (BigInt(share.allocatedMicrousd.numerator) > BigInt(supplierCap) * BigInt(share.allocatedMicrousd.denominator)) {
    throw problem('supplier_rate_exceeded');
  }
  return margin;
}

async function postAllocation(pool, allocationId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(allocationId || '')) {
    throw problem('invalid_allocation_id', 400);
  }
  return transaction(pool, async client => {
    const stored = (await client.query('SELECT * FROM probe_billing.usage_allocations WHERE id=$1 FOR UPDATE', [allocationId])).rows[0];
    if (!stored) throw problem('unknown_allocation', 404);
    const plan = stored.plan;
    if (plan.currency !== 'usd' || plan.policy !== POLICY || plan.state !== 'evidence_only' ||
        allocationDigest(plan) !== stored.sha256) {
      throw problem('allocation_evidence_corrupt');
    }
    const prior = (await client.query('SELECT receipt FROM probe_billing.usage_allocation_batches WHERE allocation_id=$1', [allocationId])).rows[0];
    if (prior) return { ...prior.receipt, duplicate: true };
    const candidates = plan.shares.filter(share => share.disposition === 'customer_candidate');
    if (candidates.length && (plan.costBasis !== 'pre-credit' || plan.costBasisVerified !== true)) {
      throw problem('allocation_precredit_evidence_required');
    }
    const absorbed = [];
    for (const share of plan.shares.filter(share => share.disposition === 'probe_absorbed')) {
      const matches = (await client.query(`SELECT j.id,j.guest_id FROM probe_billing.attempts a
        JOIN probe_billing.jobs j ON j.id=a.job_id
        WHERE lower(a.provider_ref)=$1 AND j.currency='usd'`, [share.providerReference])).rows;
      if (matches.length > 1) throw problem('allocation_ambiguous_provider_reference');
      if (matches.length) absorbed.push({ share, ...matches[0] });
    }
    const guests = new Map();
    for (const id of [...new Set([...candidates.map(share => share.guestId), ...absorbed.map(job => job.guest_id)])].sort()) {
      const guest = (await client.query('SELECT * FROM probe_billing.guests WHERE id=$1 FOR UPDATE', [id])).rows[0];
      guests.set(id, guest);
    }
    let ledgerWrites = 0;
    let supplierMicros = 0n;
    let marginMicros = 0n;
    for (const share of candidates) {
      const guest = guests.get(share.guestId);
      const job = (await client.query('SELECT * FROM probe_billing.jobs WHERE id=$1 FOR UPDATE', [share.jobId])).rows[0];
      const attempt = (await client.query('SELECT * FROM probe_billing.attempts WHERE job_id=$1 FOR UPDATE', [share.jobId])).rows[0];
      const margin = verifyCustomer(share, guest, job, attempt);
      const carried = carryShare(share.allocatedMicrousd, {
        numerator: guest.remainder_numerator, denominator: guest.remainder_denominator,
      });
      const amount = carried.wholeMicros + BigInt(margin);
      const reserved = BigInt(guest.reserved_micros) - BigInt(job.reservation_micros);
      const debt = BigInt(guest.debt_micros) + amount;
      const committed = debt + reserved + BigInt(guest.paid_micros);
      if (reserved < 0n || amount > BigInt(job.reservation_micros)) throw problem('reservation_exceeded');
      if (committed > BigInt(MAX_MICROS) ||
          (committed === BigInt(MAX_MICROS) && carried.remainder.numerator !== '0')) throw problem('ledger_limit');
      if (guest.cap_micros !== null && (committed > BigInt(guest.cap_micros) ||
          (committed === BigInt(guest.cap_micros) && carried.remainder.numerator !== '0'))) throw problem('customer_cap');
      await client.query(`INSERT INTO probe_billing.usage_allocation_postings
        (organization_id,provider_ref,guest_id,job_id,supplier_micros,margin_micros)
        VALUES($1,$2,$3,$4,$5,$6)`,
      [plan.organizationId, share.providerReference, guest.id, job.id, carried.wholeMicros.toString(), margin]);
      await client.query(`INSERT INTO probe_billing.ledger
          (guest_id,job_id,kind,micros,supplier_micros,evidence_reference) VALUES($1,$2,'usage',$3,$4,$5)`,
        [guest.id, job.id, amount.toString(), carried.wholeMicros.toString(), `allocation:${allocationId}`]);
      ledgerWrites++;
      await client.query(`UPDATE probe_billing.guests SET reserved_micros=$2,debt_micros=$3,
        remainder_numerator=$4,remainder_denominator=$5 WHERE id=$1`,
      [guest.id, reserved.toString(), debt.toString(), carried.remainder.numerator, carried.remainder.denominator]);
      await client.query("UPDATE probe_billing.jobs SET state='settled' WHERE id=$1", [job.id]);
      Object.assign(guest, { reserved_micros: reserved.toString(), debt_micros: debt.toString(),
        remainder_numerator: carried.remainder.numerator, remainder_denominator: carried.remainder.denominator });
      supplierMicros += carried.wholeMicros;
      marginMicros += BigInt(margin);
    }
    for (const found of absorbed) {
      const guest = guests.get(found.guest_id);
      const job = (await client.query('SELECT * FROM probe_billing.jobs WHERE id=$1 FOR UPDATE', [found.id])).rows[0];
      const attempt = (await client.query('SELECT * FROM probe_billing.attempts WHERE job_id=$1 FOR UPDATE', [found.id])).rows[0];
      if (!guest || guest.currency !== 'usd' || !job || job.currency !== 'usd' ||
          job.state !== 'reconcile' || job.guest_id !== guest.id ||
          attempt?.provider_ref?.toLowerCase() !== found.share.providerReference ||
          attempt.dispatch_evidence?.domain !== found.share.domain) throw problem('allocation_absorption_mismatch');
      const reserved = BigInt(guest.reserved_micros) - BigInt(job.reservation_micros);
      if (reserved < 0n) throw problem('reservation_exceeded');
      await client.query(`INSERT INTO probe_billing.usage_allocation_postings
        (organization_id,provider_ref,guest_id,job_id,supplier_micros,margin_micros)
        VALUES($1,$2,$3,$4,0,0)`, [plan.organizationId, found.share.providerReference, guest.id, job.id]);
      await client.query(`INSERT INTO probe_billing.ledger
        (guest_id,job_id,kind,micros,supplier_micros,evidence_reference) VALUES($1,$2,'absorbed',0,0,$3)`,
      [guest.id, job.id, `allocation:${allocationId}`]);
      await client.query('UPDATE probe_billing.guests SET reserved_micros=$2 WHERE id=$1', [guest.id, reserved.toString()]);
      await client.query("UPDATE probe_billing.jobs SET state='absorbed' WHERE id=$1", [job.id]);
      guest.reserved_micros = reserved.toString();
      ledgerWrites++;
    }
    const receipt = { allocationId, currency: 'usd', policy: POLICY, state: 'posted',
      customerRequests: candidates.length, probeAbsorbedRequests: plan.shares.length - candidates.length,
      supplierWholeMicros: supplierMicros.toString(), marginMicros: marginMicros.toString(),
      customerLedgerWrites: ledgerWrites, fractionalUsageCarried: true, paymentRequests: 0, providerExtractionRequests: 0 };
    await client.query(`INSERT INTO probe_billing.usage_allocation_batches(allocation_id,receipt)
      VALUES($1,$2::jsonb)`, [allocationId, JSON.stringify(receipt)]);
    return { ...receipt, duplicate: false };
  });
}

module.exports = { carryShare, verifyCustomer, postAllocation };
