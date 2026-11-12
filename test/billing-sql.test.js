'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { Store } = require('../lib/billing/store');
const { CONSENT_VERSION } = require('../lib/billing/config');
const { saveStats } = require('../lib/billing/zyte-stats');
const { POLICY, saveAllocation } = require('../lib/billing/usage-allocation');
const { postAllocation } = require('../lib/billing/allocation-posting');

const hash = value => createHash('sha256').update(value).digest('hex');
const pricing = { mode: 'http', ipType: 'automatic',
  features: ['httpResponseBody', 'httpResponseHeaders', 'customHttpRequestHeaders'] };

test('embedded PostgreSQL executes migration, legacy freeze and exact allocation posting SQL', { timeout: 300000 }, async t => {
  const db = new PGlite();
  t.after(() => db.close());
  const client = {
    release() {},
    async query(sql, values) {
      const result = await db.query(sql, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  const pool = { query: client.query, async connect() { return client; } };
  const directory = path.join(__dirname, '..', 'migrations', 'billing');
  const migrations = (await fs.readdir(directory)).filter(file => /^\d+.*\.sql$/.test(file)).sort();
  for (const file of migrations.slice(0, -1)) await db.exec(await fs.readFile(path.join(directory, file), 'utf8'));
  const legacy = randomUUID();
  const oldJob = randomUUID();
  await db.query(`INSERT INTO probe_billing.guests(id,token_hash,csrf_hash,debt_micros)
    VALUES($1,$2,$2,12345)`, [legacy, hash(legacy)]);
  await db.query(`INSERT INTO probe_billing.jobs
    (id,guest_id,request_key,source,rate,terms_hash,reservation_micros,state)
    VALUES($1,$2,$1,'LegacyFixture','{}',$3,1,'reconcile')`, [oldJob, legacy, hash('old terms')]);
  await db.query("INSERT INTO probe_billing.attempts(id,job_id,state) VALUES($1,$1,'uncertain')", [oldJob]);
  await db.exec(await fs.readFile(path.join(directory, migrations.at(-1)), 'utf8'));

  await t.test('legacy AUD values are preserved and frozen at database level', async () => {
    const row = (await db.query('SELECT * FROM probe_billing.guests WHERE id=$1', [legacy])).rows[0];
    assert.equal(row.currency, 'aud');
    assert.equal(row.debt_micros, 12345);
    for (const sql of [
      "UPDATE probe_billing.guests SET currency='usd' WHERE id=$1",
      'UPDATE probe_billing.guests SET debt_micros=0 WHERE id=$1',
      'DELETE FROM probe_billing.guests WHERE id=$1',
    ]) await assert.rejects(db.query(sql, [legacy]), /legacy_currency_frozen/);
    await assert.rejects(db.query("UPDATE probe_billing.attempts SET state='response' WHERE job_id=$1", [oldJob]), /legacy_currency_frozen/);
    await assert.rejects(db.query(`INSERT INTO probe_billing.jobs
      (id,guest_id,request_key,source,rate,terms_hash,reservation_micros,state)
      VALUES($1,$2,$1,'CrossCurrency','{}',$3,1,'queued')`, [randomUUID(), legacy, hash('terms')]), /foreign key/);
  });

  const owner = await new Store(pool).createGuest(hash(randomUUID()), hash(randomUUID()));
  const terms = hash('usd terms');
  await db.query(`UPDATE probe_billing.guests SET state='active',consent_version=$2,terms_hash=$3,
    consent_at=now(),customer_id='cus_sql_fixture',payment_method_id='pm_sql_fixture',reserved_micros=6
    WHERE id=$1`, [owner, CONSENT_VERSION, terms]);
  const jobs = [];
  for (let i = 0; i < 3; i++) {
    const id = randomUUID();
    const providerReference = (i + 1).toString(16).padStart(32, '0');
    jobs.push({ id, providerReference });
    await db.query(`INSERT INTO probe_billing.jobs
      (id,guest_id,request_key,source,rate,terms_hash,reservation_micros,state,result)
      VALUES($1,$2,$1,'SQLFixture',$3::jsonb,$4,2,'reconcile','{"status":"unknown"}')`,
    [id, owner, JSON.stringify({ supplierMicros: 2, marginMicros: 0 }), terms]);
    await db.query(`INSERT INTO probe_billing.attempts
      (id,job_id,state,provider_status,target_status,provider_ref,dispatched_at,completed_at,dispatch_evidence)
      VALUES($1,$1,'response',200,404,$2,now(),now(),$3::jsonb)`,
    [id, providerReference, JSON.stringify({ domain: 'example.com', pricing })]);
  }
  const startTime = '2026-11-09T07:30:00Z', endTime = '2026-11-09T07:31:00Z';
  const imported = await saveStats(pool, {
    organizationId: 1053513, startTime, endTime, totalResultCount: 1, pageCount: 1,
    response: { pages: [{ results: [{ domain: 'example.com', status_codes: [{ code: 200, count: 3 }] }] }] },
    domains: [{ domain: 'example.com', requestCount: 3, costMicrousdTotal: '1', costMicrousdAvg: '0.33333333', costMicrousdP80: '0.33333333' }],
  });
  const allocated = await saveAllocation(pool, imported.id, {
    schemaVersion: 1, policy: POLICY, organizationId: 1053513, startTime, endTime,
    evidenceReference: 'embedded-postgres-fixture', windowMembershipVerified: true, pricingConditionsVerified: true,
    costBasis: 'pre-credit', costBasisVerified: true,
    requests: jobs.map(job => ({ providerReference: job.providerReference, domain: 'example.com',
      supplierTimestamp: '2026-11-09T07:30:10Z', providerStatus: 200, purpose: 'customer',
      pricing, currency: 'usd', guestId: owner, jobId: job.id, result: 'unknown' })),
  });

  await t.test('a later invalid attempt rolls back all earlier debt, remainder, job and ledger updates', async () => {
    await db.query("UPDATE probe_billing.attempts SET state='uncertain' WHERE job_id=$1", [jobs[2].id]);
    await assert.rejects(postAllocation(pool, allocated.id), /allocation_customer_evidence_mismatch/);
    const row = (await db.query('SELECT * FROM probe_billing.guests WHERE id=$1', [owner])).rows[0];
    assert.equal(row.debt_micros, 0);
    assert.equal(row.reserved_micros, 6);
    assert.equal(row.remainder_numerator, '0');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM probe_billing.usage_allocation_postings')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM probe_billing.ledger')).rows[0].n, 0);
    await db.query("UPDATE probe_billing.attempts SET state='response' WHERE job_id=$1", [jobs[2].id]);
  });

  await t.test('JSONB evidence, zero-whole-micro usage, carry and replay use real constraints and transactions', async () => {
    const result = await postAllocation(pool, allocated.id);
    assert.equal(result.supplierWholeMicros, '1');
    const row = (await db.query('SELECT * FROM probe_billing.guests WHERE id=$1', [owner])).rows[0];
    assert.equal(row.currency, 'usd');
    assert.equal(row.debt_micros, 1);
    assert.equal(row.reserved_micros, 0);
    assert.equal(row.remainder_numerator, '0');
    const ledger = (await db.query('SELECT * FROM probe_billing.ledger ORDER BY id')).rows;
    assert.deepEqual(ledger.map(entry => entry.micros), [0, 0, 1]);
    assert.ok(ledger.every(entry => entry.kind === 'usage'));
    assert.equal((await postAllocation(pool, allocated.id)).duplicate, true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM probe_billing.ledger')).rows[0].n, 3);
    const temporary = await new Store(pool).createGuest(hash(randomUUID()), hash(randomUUID()));
    await db.query('DELETE FROM probe_billing.guests WHERE id=$1', [temporary]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM probe_billing.guests WHERE id=$1', [temporary])).rows[0].n, 0);
  });
});
