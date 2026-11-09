'use strict';

const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Store } = require('../lib/billing/store');
const { CONSENT_VERSION } = require('../lib/billing/config');
const { transaction } = require('../lib/billing/db');
const { checkDatabase } = require('./billing-check');
const { migrate } = require('./billing-migrate');

async function checkRecovery(pool) {
  const database = await checkDatabase(pool);
  const guard = await pool.connect();
  let locked = false;
  try {
    locked = (await guard.query('SELECT pg_try_advisory_lock(724196385) AS locked')).rows[0].locked;
    if (!locked) throw new Error('Recovery check already running.');
    const migrations = await migrate(pool);
    return { database, migrations, ...await runRecoveryFixtures(pool), providerRequests: 0, paymentRequests: 0 };
  } finally {
    try {
      if (locked) await guard.query('SELECT pg_advisory_unlock(724196385)');
    } finally { guard.release(true); }
  }
}
async function runRecoveryFixtures(pool) {
  const ids = [randomUUID(), randomUUID()];
  const events = ids.flatMap(id => [`evt_recovery_${id}`, `evt_recovery_duplicate_${id}`]);
  const termsHash = createHash('sha256').update(`recovery-fixture-${ids[0]}`).digest('hex');
  const config = { consentVersion: CONSENT_VERSION, termsHash, minimumCents: 1 };
  const store = new Store(pool);
  const checks = [];
  const makePayment = recovery => {
    const metadata = { probe_guest: recovery.guest_id, probe_recovery: recovery.id,
      probe_collection: recovery.collection_id, probe_terms: recovery.terms_hash };
    const checkout = { id: `cs_recovery_${recovery.id}`, customer: recovery.customer_id, metadata,
      amount_total: Number(recovery.amount_cents), livemode: false, mode: 'payment', status: 'complete',
      payment_status: 'paid', currency: 'aud', payment_intent: `pi_recovery_${recovery.id}` };
    const intent = { id: `pi_recovery_${recovery.id}`, livemode: false, status: 'succeeded', currency: 'aud',
      customer: recovery.customer_id, amount: Number(recovery.amount_cents), amount_received: Number(recovery.amount_cents),
      payment_method: `pm_recovery_${recovery.id}`, setup_future_usage: 'off_session', metadata };
    const method = { id: intent.payment_method, customer: recovery.customer_id, livemode: false, type: 'card' };
    return { checkout, intent, method };
  };
  try {
    for (const [index, id] of ids.entries()) {
      await pool.query(`INSERT INTO probe_billing.guests(id,token_hash,csrf_hash,state,customer_id,payment_method_id,
        consent_version,terms_hash,consent_at,debt_micros,cap_micros)
        VALUES($1,$2,$3,$4,$5,$6,$7,$3,now(),1000007,0)`,
      [id, createHash('sha256').update(id).digest('hex'), termsHash,
        index === 0 ? 'action_required' : 'revoked', `cus_recovery_${id}`, `pm_old_${id}`, CONSENT_VERSION]);
      await pool.query(`INSERT INTO probe_billing.collections(id,guest_id,amount_cents,state,payment_intent_id,payment_method_id)
        VALUES($1,$2,100,'failed',$3,$4)`, [randomUUID(), id, `pi_old_${id}`, `pm_old_${id}`]);
    }
    const attempts = await Promise.allSettled([store.prepareRecovery(ids[0], config), store.prepareRecovery(ids[0], config)]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(attempts.find(result => result.status === 'rejected').reason.message, /pending_operator_review/);
    const recovery = attempts.find(result => result.status === 'fulfilled').value;
    checks.push('one durable checkout owner under concurrent recovery requests');
    await assert.rejects(store.prepareSetup(ids[0], config, true), /recovery_pending/);
    const payment = makePayment(recovery);
    await store.recoveryReady(recovery.id, { id: payment.checkout.id, url: 'https://checkout.stripe.com/c/pay/fixture#retained' });
    const replay = await store.prepareRecovery(ids[0], config);
    assert.equal(replay.id, recovery.id);
    assert.equal(replay.checkout_url, 'https://checkout.stripe.com/c/pay/fixture#retained');
    checks.push('ready recovery is reused and card replacement cannot race it');
    await assert.rejects(store.resume(ids[0], config), /recovery_not_complete/);
    for (const override of [{ customer: 'cus_foreign' }, { amount_total: 101 },
      { metadata: { ...payment.checkout.metadata, probe_terms: 'b'.repeat(64) } }]) {
      await assert.rejects(store.confirmRecovery({ id: events[0], type: 'checkout.session.completed' },
        { ...payment.checkout, ...override }, payment.intent, payment.method), /ownership_mismatch/);
    }
    checks.push('foreign customer, wrong amount and altered terms cannot settle debt');
    await store.confirmRecovery({ id: events[0], type: 'checkout.session.completed' },
      payment.checkout, payment.intent, payment.method);
    await store.confirmRecovery({ id: events[1], type: 'checkout.session.completed' },
      payment.checkout, payment.intent, payment.method);
    await store.paymentResult(recovery.collection_id, payment.intent);
    const status = await store.status(ids[0]);
    assert.equal(status.debtMicros, '7');
    assert.equal(status.paidMicros, '1000000');
    assert.equal(status.state, 'action_required');
    assert.equal(status.capMicros, '0');
    const ledger = await pool.query('SELECT count(*)::int AS count FROM probe_billing.ledger WHERE guest_id=$1', [ids[0]]);
    assert.equal(ledger.rows[0].count, 1);
    checks.push('verified settlement and duplicate events create one payment ledger entry without auto-resume');
    await store.paymentResult(recovery.collection_id, {
      ...payment.intent, id: recovery.prior_payment_intent_id, status: 'canceled', payment_method: `pm_old_${ids[0]}`,
    });
    await assert.rejects(store.paymentResult(recovery.collection_id, {
      ...payment.intent, id: recovery.prior_payment_intent_id, payment_method: `pm_old_${ids[0]}`,
    }), /ownership_mismatch/);
    checks.push('canceled superseded payment is acknowledged but cannot replace the settled intent');
    await pool.query('UPDATE probe_billing.guests SET reserved_micros=1 WHERE id=$1', [ids[0]]);
    await assert.rejects(store.resume(ids[0], config), /recovery_not_complete/);
    await pool.query('UPDATE probe_billing.guests SET reserved_micros=0 WHERE id=$1', [ids[0]]);
    await store.resume(ids[0], { ...config, termsHash: 'b'.repeat(64) });
    const resumed = await store.status(ids[0]);
    assert.equal(resumed.state, 'active');
    assert.equal(resumed.termsHash, 'b'.repeat(64));
    assert.equal(resumed.debtMicros, '7');
    assert.equal(resumed.capMicros, '0');
    checks.push('explicit resume preserves cap and sub-cent debt and refuses pending usage');
    const revoked = await store.prepareRecovery(ids[1], config);
    const revokedPayment = makePayment(revoked);
    await store.confirmRecovery({ id: events[2], type: 'checkout.session.completed' },
      revokedPayment.checkout, revokedPayment.intent, revokedPayment.method);
    assert.equal((await store.status(ids[1])).state, 'revoked');
    await assert.rejects(store.resume(ids[1], config), /spending_suspended/);
    checks.push('revoked guest can settle debt but cannot resume');
    // Collection ownership retains the old card even if a replacement setup later changes the guest's card.
    await pool.query("UPDATE probe_billing.guests SET state='action_required',debt_micros=1000000 WHERE id=$1", [ids[0]]);
    const oldMethod = payment.intent.payment_method;
    const collectionId = randomUUID();
    await pool.query(`INSERT INTO probe_billing.collections(id,guest_id,amount_cents,state,payment_intent_id,payment_method_id)
      VALUES($1,$2,100,'failed',$3,$4)`, [collectionId, ids[0], `pi_snapshot_${ids[0]}`, oldMethod]);
    await pool.query('UPDATE probe_billing.guests SET payment_method_id=$2 WHERE id=$1', [ids[0], 'pm_replaced']);
    await store.paymentResult(collectionId, { ...payment.intent, id: `pi_snapshot_${ids[0]}`,
      payment_method: oldMethod, metadata: { probe_collection: collectionId, probe_guest: ids[0] } });
    assert.equal((await store.status(ids[0])).debtMicros, '0');
    checks.push('old owned collection still reconciles correctly after card replacement');
  } finally {
    await transaction(pool, async client => {
      await client.query('DELETE FROM probe_billing.payment_events WHERE id=ANY($1::text[])', [events]);
      await client.query('DELETE FROM probe_billing.ledger WHERE guest_id=ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM probe_billing.recoveries WHERE guest_id=ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM probe_billing.collections WHERE guest_id=ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM probe_billing.setups WHERE guest_id=ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM probe_billing.guests WHERE id=ANY($1::uuid[])', [ids]);
    });
    const remaining = await pool.query(`SELECT id FROM probe_billing.guests WHERE id=ANY($1::uuid[])
      UNION ALL SELECT guest_id AS id FROM probe_billing.recoveries WHERE guest_id=ANY($1::uuid[])
      UNION ALL SELECT guest_id AS id FROM probe_billing.collections WHERE guest_id=ANY($1::uuid[])
      UNION ALL SELECT guest_id AS id FROM probe_billing.ledger WHERE guest_id=ANY($1::uuid[])`, [ids]);
    assert.equal(remaining.rowCount, 0, 'Recovery fixture cleanup must be complete.');
  }
  return { checks, fixturesRemoved: true };
}
module.exports = { checkRecovery, runRecoveryFixtures };
