'use strict';

const { randomUUID } = require('node:crypto');
const { transaction } = require('./db');
const { integer, CONSENT_VERSION, MAX_MICROS } = require('./config');

function problem(code, status = 409) {
  const error = new Error(code);
  error.publicCode = code;
  error.status = status;
  return error;
}
async function lockGuest(client, id) {
  const row = (await client.query('SELECT * FROM probe_billing.guests WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!row) throw problem('session_required', 401);
  return row;
}
function authorized(guest, config) {
  return guest.state === 'active' && guest.consent_version === CONSENT_VERSION &&
    guest.terms_hash === config.termsHash && guest.payment_method_id && guest.customer_id &&
    new Date(guest.expires_at).getTime() > Date.now();
}
function reserveAllowed(guest, amount, config) {
  if (!authorized(guest, config)) throw problem('consent_or_payment_required', 403);
  const exposure = BigInt(guest.debt_micros) + BigInt(guest.reserved_micros) + BigInt(amount);
  if (exposure + BigInt(guest.paid_micros) > BigInt(MAX_MICROS)) throw problem('ledger_limit');
  if (exposure > BigInt(config.creditMicros)) throw problem('credit_limit');
  if (guest.cap_micros !== null && exposure + BigInt(guest.paid_micros) > BigInt(guest.cap_micros)) throw problem('customer_cap');
}
function centsForDebt(debt, minimumCents) {
  const cents = BigInt(debt) / 10000n;
  return cents >= BigInt(minimumCents) ? Number(cents) : 0;
}
class Store {
  constructor(pool) { this.pool = pool; }
  async createGuest(tokenHash, csrfHash) {
    const id = randomUUID();
    await this.pool.query('INSERT INTO probe_billing.guests(id,token_hash,csrf_hash) VALUES($1,$2,$3)', [id, tokenHash, csrfHash]);
    return id;
  }
  async authenticate(hash) {
    return (await this.pool.query('SELECT * FROM probe_billing.guests WHERE token_hash=$1 AND expires_at>now()', [hash])).rows[0];
  }
  async status(id) {
    // One consistent transaction snapshot, with guest lock preventing inconsistent debt/job reads.
    return transaction(this.pool, async client => {
      const guest = await lockGuest(client, id);
      const jobs = (await client.query(`SELECT id,source,state,result,reservation_micros,created_at
        FROM probe_billing.jobs WHERE guest_id=$1 ORDER BY created_at DESC LIMIT 50`, [id])).rows;
      const usage = (await client.query(`SELECT kind,micros,supplier_micros,created_at
        FROM probe_billing.ledger WHERE guest_id=$1 ORDER BY id DESC LIMIT 50`, [id])).rows;
      return { state: guest.state, capMicros: guest.cap_micros,
        debtMicros: guest.debt_micros, reservedMicros: guest.reserved_micros,
        paidMicros: guest.paid_micros, termsHash: guest.terms_hash, jobs, usage };
    });
  }
  async revoke(id) {
    return transaction(this.pool, async client => {
      await lockGuest(client, id);
      await client.query("UPDATE probe_billing.guests SET state='revoked' WHERE id=$1", [id]);
      const cancelled = await client.query(`UPDATE probe_billing.jobs SET state='cancelled'
        WHERE guest_id=$1 AND state='queued' RETURNING reservation_micros`, [id]);
      const amount = cancelled.rows.reduce((sum, row) => sum + BigInt(row.reservation_micros), 0n);
      await client.query('UPDATE probe_billing.guests SET reserved_micros=reserved_micros-$2 WHERE id=$1', [id, amount.toString()]);
    });
  }
  async cap(id, amount) {
    if (amount !== null) {
      try { integer(amount, 0); }
      catch (_) { throw problem('invalid_cap', 400); }
    }
    return transaction(this.pool, async client => {
      const guest = await lockGuest(client, id);
      if (amount !== null && BigInt(amount) < BigInt(guest.debt_micros) + BigInt(guest.reserved_micros) + BigInt(guest.paid_micros)) {
        throw problem('cap_below_committed_spend');
      }
      await client.query('UPDATE probe_billing.guests SET cap_micros=$2 WHERE id=$1', [id, amount]);
    });
  }
  async prepareSetup(id, config) {
    return transaction(this.pool, async client => {
      const guest = await lockGuest(client, id);
      if (guest.state === 'revoked' || guest.state === 'action_required') throw problem('spending_suspended', 403);
      const open = (await client.query(`SELECT * FROM probe_billing.setups WHERE guest_id=$1
        AND state IN ('pending','creating','ready','uncertain') ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
      if (open) {
        if (open.terms_hash !== config.termsHash) throw problem('setup_terms_changed');
        if (open.state === 'ready' && Date.now() - new Date(open.created_at).getTime() < 23 * 3600000) return open;
        throw problem('setup_pending_operator_review');
      }
      if (guest.state === 'active' && guest.terms_hash === config.termsHash) throw problem('already_authorized');
      const setupId = randomUUID();
      return (await client.query(`INSERT INTO probe_billing.setups
        (id,guest_id,state,consent_version,terms_hash,customer_id) VALUES($1,$2,'creating',$3,$4,$5) RETURNING *`,
      [setupId, id, config.consentVersion, config.termsHash, guest.customer_id])).rows[0];
    });
  }
  async setupCustomer(setupId, customerId) {
    await this.pool.query('UPDATE probe_billing.setups SET customer_id=$2 WHERE id=$1 AND state IN (\'creating\',\'uncertain\')', [setupId, customerId]);
  }
  async setupReady(setupId, checkout) {
    await this.pool.query(`UPDATE probe_billing.setups SET state='ready',checkout_id=$2,checkout_url=$3
      WHERE id=$1 AND state IN ('creating','uncertain')`, [setupId, checkout.id, checkout.url]);
  }
  async setupUncertain(setupId) {
    await this.pool.query("UPDATE probe_billing.setups SET state='uncertain' WHERE id=$1 AND state='creating'", [setupId]);
  }
  async setupForCheckout(setupId) {
    return (await this.pool.query('SELECT * FROM probe_billing.setups WHERE id=$1', [setupId])).rows[0];
  }
  async confirmSetup(event, checkout, intent, method) {
    return transaction(this.pool, async client => {
      const found = (await client.query('SELECT guest_id FROM probe_billing.setups WHERE id=$1', [checkout.metadata.probe_setup])).rows[0];
      if (!found) throw problem('unowned_checkout', 400);
      const guest = await lockGuest(client, found.guest_id);
      const setup = (await client.query('SELECT * FROM probe_billing.setups WHERE id=$1 FOR UPDATE', [checkout.metadata.probe_setup])).rows[0];
      if (setup.customer_id !== checkout.customer || (setup.checkout_id && setup.checkout_id !== checkout.id) ||
          intent.customer !== setup.customer_id || method.customer !== setup.customer_id ||
          checkout.metadata.probe_guest !== guest.id || intent.metadata.probe_setup !== setup.id ||
          intent.metadata.probe_guest !== guest.id || intent.metadata.probe_terms !== setup.terms_hash ||
          !setup.consent_at) throw problem('setup_ownership_mismatch', 400);
      const inserted = await client.query(`INSERT INTO probe_billing.payment_events(id,event_type,object_id)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [event.id, event.type, checkout.id]);
      if (!inserted.rowCount || setup.state === 'confirmed') return;
      await client.query(`UPDATE probe_billing.setups SET state='confirmed',checkout_id=$2,
        setup_intent_id=$3,checkout_url=NULL WHERE id=$1`, [setup.id, checkout.id, intent.id]);
      // Revocation/payment-failure is terminal for new spending, even when an older webhook arrives later.
      await client.query(`UPDATE probe_billing.guests SET customer_id=$2,payment_method_id=$3,
        consent_version=$4,terms_hash=$5,consent_at=$6,
        state=CASE WHEN state IN ('revoked','action_required') THEN state ELSE 'active' END
        WHERE id=$1`, [guest.id, setup.customer_id, method.id, setup.consent_version, setup.terms_hash, setup.consent_at]);
    });
  }
  async expireSetup(event, checkout) {
    return transaction(this.pool, async client => {
      const found = (await client.query('SELECT guest_id FROM probe_billing.setups WHERE id=$1', [checkout.metadata.probe_setup])).rows[0];
      if (!found) throw problem('unowned_checkout', 400);
      await lockGuest(client, found.guest_id);
      const setup = (await client.query('SELECT * FROM probe_billing.setups WHERE id=$1 FOR UPDATE', [checkout.metadata.probe_setup])).rows[0];
      if (setup.customer_id !== checkout.customer || checkout.metadata.probe_guest !== setup.guest_id ||
          (setup.checkout_id && setup.checkout_id !== checkout.id)) throw problem('setup_ownership_mismatch', 400);
      await client.query(`INSERT INTO probe_billing.payment_events(id,event_type,object_id)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [event.id, event.type, checkout.id]);
      await client.query(`UPDATE probe_billing.setups SET state='expired',checkout_url=NULL
        WHERE id=$1 AND state IN ('pending','creating','ready','uncertain')`, [setup.id]);
    });
  }
  async enqueue(id, requestKey, site, username, target, rate, config) {
    return transaction(this.pool, async client => {
      const guest = await lockGuest(client, id);
      const previous = (await client.query('SELECT id,source,username FROM probe_billing.jobs WHERE guest_id=$1 AND request_key=$2', [id, requestKey])).rows[0];
      if (previous) {
        if (previous.source !== site.name || previous.username !== username) throw problem('idempotency_conflict');
        return previous.id;
      }
      const recent = (await client.query(`SELECT id FROM probe_billing.jobs WHERE guest_id=$1
        AND source=$2 AND username=$3 AND terms_hash=$4 AND created_at>now()-interval '5 minutes'
        AND state IN ('queued','leased','reconcile','settled','absorbed') ORDER BY created_at DESC LIMIT 1`,
      [id, site.name, username, config.termsHash])).rows[0];
      if (recent) throw problem('recent_paid_check_exists');
      reserveAllowed(guest, rate.maximumMicros, config);
      const jobs = await client.query(`SELECT count(*)::int AS count FROM probe_billing.jobs
        WHERE guest_id=$1 AND state IN ('queued','leased','reconcile')`, [id]);
      if (jobs.rows[0].count >= 10) throw problem('queue_limit', 429);
      const jobId = randomUUID();
      await client.query(`INSERT INTO probe_billing.jobs
        (id,guest_id,request_key,source,username,target_url,rate,terms_hash,reservation_micros,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued')`,
      [jobId, id, requestKey, site.name, username, target, JSON.stringify(rate), config.termsHash, rate.maximumMicros]);
      await client.query('UPDATE probe_billing.guests SET reserved_micros=reserved_micros+$2 WHERE id=$1', [id, rate.maximumMicros]);
      return jobId;
    });
  }
  async claimJob(config) {
    // Lock ordering everywhere: guest, then jobs/attempts/collections. SKIP LOCKED permits multiple workers.
    return transaction(this.pool, async client => {
      const guest = (await client.query(`SELECT g.* FROM probe_billing.guests g
        WHERE EXISTS(SELECT 1 FROM probe_billing.jobs j WHERE j.guest_id=g.id AND j.state='queued')
        ORDER BY g.created_at FOR UPDATE OF g SKIP LOCKED LIMIT 1`)).rows[0];
      if (!guest) return null;
      const job = (await client.query(`SELECT * FROM probe_billing.jobs WHERE guest_id=$1 AND state='queued'
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [guest.id])).rows[0];
      if (!authorized(guest, config) || job.terms_hash !== config.termsHash) {
        await client.query("UPDATE probe_billing.jobs SET state='cancelled' WHERE id=$1", [job.id]);
        await client.query('UPDATE probe_billing.guests SET reserved_micros=reserved_micros-$2 WHERE id=$1', [guest.id, job.reservation_micros]);
        return null;
      }
      const leaseId = randomUUID();
      await client.query(`UPDATE probe_billing.jobs SET state='leased',lease_id=$2,
        lease_until=now()+interval '2 minutes' WHERE id=$1`, [job.id, leaseId]);
      const attemptId = randomUUID();
      await client.query("INSERT INTO probe_billing.attempts(id,job_id,state) VALUES($1,$2,'started')", [attemptId, job.id]);
      return { ...job, lease_id: leaseId, attempt_id: attemptId };
    });
  }
  async finishJob(job, outcome) {
    return transaction(this.pool, async client => {
      await lockGuest(client, job.guest_id);
      const current = (await client.query('SELECT * FROM probe_billing.jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
      if (current.lease_id !== job.lease_id || !['leased','reconcile'].includes(current.state)) throw problem('lease_lost');
      await client.query(`UPDATE probe_billing.attempts SET state=$2,provider_status=$3,
        target_status=$4,provider_ref=$5,completed_at=now() WHERE job_id=$1`,
      [job.id, outcome.state, outcome.providerStatus || null, outcome.targetStatus || null, outcome.providerRef || null]);
      if (outcome.state === 'probe_error') {
        await client.query(`INSERT INTO probe_billing.ledger(guest_id,job_id,kind,micros,supplier_micros,evidence_reference)
          VALUES($1,$2,'absorbed',0,0,'local_pre_provider_guard')`, [job.guest_id, job.id]);
        await client.query('UPDATE probe_billing.guests SET reserved_micros=reserved_micros-$2 WHERE id=$1',
          [job.guest_id, job.reservation_micros]);
        await client.query("UPDATE probe_billing.jobs SET state='absorbed',result=$2,lease_until=NULL WHERE id=$1",
          [job.id, JSON.stringify(outcome.result)]);
        return;
      }
      await client.query("UPDATE probe_billing.jobs SET state='reconcile',result=$2,lease_until=NULL WHERE id=$1",
        [job.id, JSON.stringify(outcome.result || { status: 'unknown', reasonCodes: ['provider_outcome_uncertain'] })]);
    });
  }
  async authorizeAttempt(job, config) {
    return transaction(this.pool, async client => {
      const guest = await lockGuest(client, job.guest_id);
      const current = (await client.query('SELECT * FROM probe_billing.jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
      if (!current || !authorized(guest, config) || current.state !== 'leased' || current.lease_id !== job.lease_id ||
          new Date(current.lease_until).getTime() <= Date.now() || current.terms_hash !== config.termsHash) {
        throw problem('attempt_not_authorized', 403);
      }
      const dispatched = await client.query(`UPDATE probe_billing.attempts SET state='dispatched'
        WHERE job_id=$1 AND id=$2 AND state='started' RETURNING id`, [job.id, job.attempt_id]);
      if (!dispatched.rowCount) throw problem('attempt_already_dispatched', 403);
    });
  }
  async recover() {
    // Never reissue an attempt that might have reached Zyte. Its reservation remains held.
    const expired = await this.pool.query(`SELECT DISTINCT guest_id FROM probe_billing.jobs
      WHERE state='leased' AND lease_until<now()`);
    for (const { guest_id: id } of expired.rows) {
      await transaction(this.pool, async client => {
        await lockGuest(client, id);
        const rows = await client.query(`UPDATE probe_billing.jobs SET state='reconcile',lease_until=NULL
          WHERE guest_id=$1 AND state='leased' AND lease_until<now() RETURNING id`, [id]);
        for (const job of rows.rows) await client.query(`UPDATE probe_billing.attempts SET state='uncertain'
          WHERE job_id=$1 AND state IN ('started','dispatched')`, [job.id]);
      });
    }
    await this.pool.query(`UPDATE probe_billing.jobs SET username=NULL,target_url=NULL,result=NULL
      WHERE created_at<now()-interval '7 days' AND state IN ('settled','absorbed','cancelled')
      AND (username IS NOT NULL OR target_url IS NOT NULL OR result IS NOT NULL)`);
  }
  async reconcile(input) {
    integer(input.supplierMicros, 0);
    if (!/^[0-9a-f-]{36}$/i.test(input.jobId || '') || typeof input.evidenceReference !== 'string' ||
        input.evidenceReference.length < 8 || input.evidenceReference.length > 256 ||
        typeof input.providerReference !== 'string' || !input.providerReference ||
        input.providerReference.length > 256 || input.authoritative !== true ||
        !['billed','not_billed','probe_error'].includes(input.disposition)) throw problem('authoritative_evidence_required', 400);
    return transaction(this.pool, async client => {
      const found = (await client.query('SELECT guest_id FROM probe_billing.jobs WHERE id=$1', [input.jobId])).rows[0];
      if (!found) throw problem('unknown_job', 404);
      const guest = await lockGuest(client, found.guest_id);
      const job = (await client.query('SELECT * FROM probe_billing.jobs WHERE id=$1 FOR UPDATE', [input.jobId])).rows[0];
      const prior = (await client.query('SELECT * FROM probe_billing.ledger WHERE job_id=$1', [job.id])).rows[0];
      if (prior) {
        if (Number(prior.supplier_micros) !== input.supplierMicros || prior.evidence_reference !== input.evidenceReference) throw problem('reconciliation_conflict');
        return;
      }
      const attempt = (await client.query('SELECT * FROM probe_billing.attempts WHERE job_id=$1 FOR UPDATE', [job.id])).rows[0];
      if (job.state !== 'reconcile' || !attempt) throw problem('job_not_reconcilable');
      if (attempt.provider_ref && attempt.provider_ref !== input.providerReference) throw problem('provider_reference_mismatch');
      if (input.disposition === 'billed' && attempt.state === 'response' && !attempt.provider_ref) {
        throw problem('supplier_reference_unverified');
      }
      // Never transfer provider failures, unknown outcomes or PROBE defects to a guest.
      const chargeable = input.disposition === 'billed' && attempt.state === 'response' &&
        attempt.provider_status === 200 && attempt.target_status && job.result &&
        !job.result.reasonCodes?.includes('paid_integrity_guard') && input.supplierMicros > 0;
      if (chargeable && input.supplierMicros > job.rate.supplierMicros) throw problem('supplier_rate_exceeded');
      if (input.disposition === 'not_billed' && input.supplierMicros !== 0) throw problem('invalid_unbilled_amount');
      const amount = chargeable ? input.supplierMicros + job.rate.marginMicros : 0;
      if (amount > Number(job.reservation_micros)) throw problem('reservation_exceeded');
      if (chargeable && !guest.consent_at) throw problem('missing_consent', 403);
      await client.query(`INSERT INTO probe_billing.ledger
        (guest_id,job_id,kind,micros,supplier_micros,evidence_reference) VALUES($1,$2,$3,$4,$5,$6)`,
      [guest.id, job.id, amount ? 'usage' : 'absorbed', amount, input.supplierMicros, input.evidenceReference]);
      await client.query(`UPDATE probe_billing.guests SET reserved_micros=reserved_micros-$2,
        debt_micros=debt_micros+$3 WHERE id=$1`, [guest.id, job.reservation_micros, amount]);
      await client.query('UPDATE probe_billing.jobs SET state=$2 WHERE id=$1', [job.id, amount ? 'settled' : 'absorbed']);
      await client.query('UPDATE probe_billing.attempts SET provider_ref=$2 WHERE job_id=$1', [job.id, input.providerReference]);
    });
  }
  async claimCollection(config) {
    return transaction(this.pool, async client => {
      const guest = (await client.query(`SELECT g.* FROM probe_billing.guests g
        WHERE g.debt_micros >= $1 AND g.state <> 'action_required' AND g.consent_at IS NOT NULL
        AND g.customer_id IS NOT NULL AND g.payment_method_id IS NOT NULL
        AND (g.debt_micros >= $2 OR g.last_collection_at <= now()-interval '1 day')
        AND NOT EXISTS(SELECT 1 FROM probe_billing.collections c WHERE c.guest_id=g.id
          AND c.state IN ('claimed','pending','uncertain','failed'))
        ORDER BY g.last_collection_at FOR UPDATE OF g SKIP LOCKED LIMIT 1`,
      [config.minimumCents * 10000, config.thresholdMicros])).rows[0];
      if (!guest) return null;
      const amount = centsForDebt(guest.debt_micros, config.minimumCents);
      const id = randomUUID();
      await client.query(`INSERT INTO probe_billing.collections(id,guest_id,amount_cents,state)
        VALUES($1,$2,$3,'claimed')`, [id, guest.id, amount]);
      return { id, guest_id: guest.id, amount_cents: amount, customer_id: guest.customer_id,
        payment_method_id: guest.payment_method_id, created_at: new Date() };
    });
  }
  async openCollections() {
    return (await this.pool.query(`SELECT c.*,g.customer_id,g.payment_method_id FROM probe_billing.collections c
      JOIN probe_billing.guests g ON g.id=c.guest_id WHERE c.state IN ('claimed','pending','uncertain')
      ORDER BY c.created_at LIMIT 20`)).rows;
  }
  async paymentResult(collectionId, intent, event = null) {
    return transaction(this.pool, async client => {
      const found = (await client.query('SELECT guest_id FROM probe_billing.collections WHERE id=$1', [collectionId])).rows[0];
      if (!found) throw problem('unknown_collection', 400);
      const guest = await lockGuest(client, found.guest_id);
      const collection = (await client.query('SELECT * FROM probe_billing.collections WHERE id=$1 FOR UPDATE', [collectionId])).rows[0];
      if (intent.livemode !== false || intent.currency !== 'aud' || intent.customer !== guest.customer_id ||
          Number(collection.amount_cents) !== intent.amount || intent.metadata?.probe_collection !== collection.id ||
          intent.metadata?.probe_guest !== guest.id || intent.payment_method !== guest.payment_method_id ||
          (collection.payment_intent_id && collection.payment_intent_id !== intent.id)) throw problem('payment_ownership_mismatch', 400);
      if (event) {
        const inserted = await client.query(`INSERT INTO probe_billing.payment_events(id,event_type,object_id)
          VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [event.id, event.type, intent.id]);
        if (!inserted.rowCount) return;
      }
      if (collection.state === 'succeeded') return;
      if (intent.status === 'succeeded') {
        if (intent.amount_received !== intent.amount) throw problem('payment_amount_mismatch', 400);
        const micros = BigInt(collection.amount_cents) * 10000n;
        await client.query(`INSERT INTO probe_billing.ledger(guest_id,collection_id,kind,micros)
          VALUES($1,$2,'payment',$3)`, [guest.id, collection.id, (-micros).toString()]);
        await client.query(`UPDATE probe_billing.guests SET debt_micros=debt_micros-$2,
          paid_micros=paid_micros+$2,last_collection_at=now() WHERE id=$1`, [guest.id, micros.toString()]);
        await client.query(`UPDATE probe_billing.collections SET state='succeeded',payment_intent_id=$2,
          completed_at=now() WHERE id=$1`, [collection.id, intent.id]);
      } else if (['requires_payment_method','requires_action','canceled'].includes(intent.status)) {
        await client.query("UPDATE probe_billing.guests SET state=CASE WHEN state='revoked' THEN state ELSE 'action_required' END WHERE id=$1", [guest.id]);
        await client.query("UPDATE probe_billing.collections SET state='failed',payment_intent_id=$2 WHERE id=$1", [collection.id, intent.id]);
      } else {
        // A late processing event must not undo a failed/succeeded event.
        await client.query(`UPDATE probe_billing.collections SET state='pending',payment_intent_id=$2
          WHERE id=$1 AND state IN ('claimed','pending','uncertain')`, [collection.id, intent.id]);
      }
    });
  }
  async collectionUncertain(id) {
    await this.pool.query("UPDATE probe_billing.collections SET state='uncertain' WHERE id=$1 AND state='claimed'", [id]);
  }
  async freezeCollection(id) {
    return transaction(this.pool, async client => {
      const found = (await client.query('SELECT guest_id FROM probe_billing.collections WHERE id=$1', [id])).rows[0];
      if (!found) return;
      await lockGuest(client, found.guest_id);
      await client.query("UPDATE probe_billing.guests SET state=CASE WHEN state='revoked' THEN state ELSE 'action_required' END WHERE id=$1", [found.guest_id]);
      await client.query("UPDATE probe_billing.collections SET state='uncertain' WHERE id=$1 AND state IN ('claimed','pending','uncertain')", [id]);
    });
  }
}
module.exports = { Store, problem, authorized, reserveAllowed, centsForDebt };
