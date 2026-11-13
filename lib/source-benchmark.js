'use strict';

const { randomUUID } = require('node:crypto');
const { transaction } = require('./billing/db');
const { problem } = require('./billing/store');
const { trialAllowed } = require('./billing/supplier-trial');
const { execute, targetFor } = require('./billing/zyte');
const { normalizeResult } = require('./classifier');
const { probeWithDeadline } = require('./probe-engine');
const usernameRules = require('../username-rules');
const { isValidUsername } = require('./validation');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LIMITS = { direct: 2000, http: 1000, browser: 100 };
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function exact(value, required, optional = []) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function validateManifest(manifest, sites, commit, fingerprint) {
  if (!exact(manifest, ['schemaVersion', 'runId', 'commit', 'catalogSha256', 'sources', 'limits']) ||
      manifest.schemaVersion !== 1 || typeof manifest.runId !== 'string' || !UUID.test(manifest.runId) ||
      typeof manifest.commit !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.commit) ||
      typeof manifest.catalogSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.catalogSha256) ||
      !exact(manifest.limits, Object.keys(MAX_LIMITS)) ||
      Object.entries(MAX_LIMITS).some(([lane, max]) => !Number.isInteger(manifest.limits[lane]) || manifest.limits[lane] < 0 || manifest.limits[lane] > max) ||
      !Array.isArray(manifest.sources) || !manifest.sources.length || manifest.sources.length > 300) {
    throw problem('invalid_benchmark_manifest', 400);
  }
  if (manifest.commit !== commit || manifest.catalogSha256 !== fingerprint.catalogSha256) throw problem('benchmark_deployment_mismatch', 409);
  const seen = new Set();
  for (const source of manifest.sources) {
    if (!exact(source, ['site', 'controls']) || typeof source.site !== 'string' ||
        !Array.isArray(source.controls) || !source.controls.length || source.controls.length > 3 ||
        seen.has(source.site.toLowerCase())) throw problem('invalid_benchmark_source', 400);
    seen.add(source.site.toLowerCase());
    const site = sites.find(site => site.name === source.site && !site.defunct && !site.undetectable && !site.manual);
    if (!site) throw problem('invalid_benchmark_source', 400);
    const controls = new Set();
    for (const control of source.controls) {
      if (!exact(control, ['username', 'expected']) || typeof control.username !== 'string' ||
          !isValidUsername(control.username) || usernameRules.incompatibleReason(site, control.username) ||
          !['found', 'not_found'].includes(control.expected) || controls.has(control.username.toLowerCase())) {
        throw problem('invalid_benchmark_control', 400);
      }
      controls.add(control.username.toLowerCase());
    }
  }
  return manifest;
}

async function initialize(pool) {
  // No memory fallback: reservations and authorization must survive process loss.
  await transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(724196390)');
    await client.query('CREATE SCHEMA IF NOT EXISTS probe_lab');
    await client.query(`CREATE TABLE IF NOT EXISTS probe_lab.benchmark_guard (
      id integer PRIMARY KEY CHECK(id=1))`);
    await client.query('INSERT INTO probe_lab.benchmark_guard(id) VALUES(1) ON CONFLICT DO NOTHING');
    await client.query(`CREATE TABLE IF NOT EXISTS probe_lab.benchmark_runs (
      id uuid PRIMARY KEY, manifest jsonb NOT NULL, fingerprint jsonb NOT NULL, region text,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL DEFAULT (now()+interval '72 hours'),
      supplier_stopped boolean NOT NULL DEFAULT false)`);
    await client.query('ALTER TABLE probe_lab.benchmark_runs ADD COLUMN IF NOT EXISTS region text');
    await client.query(`CREATE TABLE IF NOT EXISTS probe_lab.benchmark_attempts (
      sequence bigserial UNIQUE, id uuid PRIMARY KEY,
      run_id uuid NOT NULL REFERENCES probe_lab.benchmark_runs(id),
      site text NOT NULL, username text NOT NULL, mode text NOT NULL, pass integer NOT NULL,
      state text NOT NULL DEFAULT 'started', created_at timestamptz NOT NULL DEFAULT now(),
      dispatched_at timestamptz, completed_at timestamptz,
      outcome jsonb, duration_ms integer, dispatch_evidence jsonb,
      UNIQUE(run_id,site,username,mode,pass))`);
  });
}
function attemptView(row, run) {
  return { id: row.id, site: row.site, username: row.username, mode: row.mode, pass: row.pass,
    state: row.state, startedAt: row.created_at, dispatchedAt: row.dispatched_at,
    checkedAt: row.completed_at, result: row.outcome?.result || null,
    durationMs: row.duration_ms, providerStatus: row.outcome?.providerStatus ?? null,
    providerRef: row.outcome?.providerRef ?? null, targetStatus: row.outcome?.targetStatus ?? null,
    costVerified: false, cost: null, runtimeFingerprint: run.fingerprint, commit: run.manifest.commit };
}
function createSourceBenchmark(options) {
  const { pool, sites, runtimeFingerprint, commit } = options;
  const env = options.env || process.env;
  const executeImpl = options.execute || execute;
  const direct = options.direct || probeWithDeadline;
  const hourlyLimit = Math.min(600, Math.max(1, Number(options.hourlyLimit) || 600));
  let ready;
  async function locked(action) {
    return transaction(pool, async client => {
      await client.query('SELECT id FROM probe_lab.benchmark_guard WHERE id=1 FOR UPDATE');
      return action(client);
    });
  }
  function identity(run) {
    if (!run) throw problem('benchmark_run_not_found', 404);
    validateManifest(run.manifest, sites, commit, runtimeFingerprint);
    if (canonical(run.fingerprint) !== canonical(runtimeFingerprint)) throw problem('benchmark_runtime_mismatch', 409);
    if (new Date(run.expires_at).getTime() <= Date.now()) throw problem('benchmark_run_expired', 410);
    return run;
  }
  async function load(client, id) {
    return identity((await client.query('SELECT * FROM probe_lab.benchmark_runs WHERE id=$1 FOR UPDATE', [id])).rows[0]);
  }
  async function page(client, run, offset = 0) {
    const rows = (await client.query(`SELECT * FROM probe_lab.benchmark_attempts
      WHERE run_id=$1 ORDER BY sequence OFFSET $2 LIMIT 101`, [run.id, offset])).rows;
    const counts = (await client.query(`SELECT mode,count(*)::integer AS count FROM probe_lab.benchmark_attempts
      WHERE run_id=$1 GROUP BY mode`, [run.id])).rows;
    return { run: { id: run.id, manifest: run.manifest, runtimeFingerprint: run.fingerprint,
      createdAt: run.created_at, expiresAt: run.expires_at, region: run.region, limits: run.manifest.limits,
      reserved: Object.fromEntries(counts.map(row => [row.mode, row.count])), supplierStopped: run.supplier_stopped,
      paidExecutionEnabled: false, customerCharges: 0 },
    attempts: rows.slice(0, 100).map(row => attemptView(row, run)),
    nextOffset: rows.length > 100 ? offset + 100 : null };
  }
  return async function benchmark(input) {
    if (!trialAllowed(env)) throw problem('benchmark_spending_gates_required', 403);
    if (!pool) throw problem('benchmark_database_required', 503);
    if (!input || !['start', 'status', 'observe'].includes(input.action)) throw problem('invalid_benchmark_action', 400);
    if (input.action === 'start') {
      if (!exact(input, ['action', 'manifest'])) throw problem('invalid_benchmark_input', 400);
      validateManifest(input.manifest, sites, commit, runtimeFingerprint);
    } else {
      const required = input.action === 'status' ? ['action', 'runId'] : ['action', 'runId', 'site', 'username', 'mode', 'pass'];
      if (!exact(input, required, input.action === 'status' ? ['offset'] : []) ||
          typeof input.runId !== 'string' || !UUID.test(input.runId) ||
          (input.action === 'status' && input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) ||
          (input.action === 'observe' && (typeof input.site !== 'string' || typeof input.username !== 'string' ||
            !Object.hasOwn(MAX_LIMITS, input.mode) || ![1, 2, 3].includes(input.pass)))) throw problem('invalid_benchmark_input', 400);
    }
    ready ||= initialize(pool).catch(error => { ready = null; throw error; });
    await ready;
    if (input.action === 'start') return locked(async client => {
      let run = (await client.query('SELECT * FROM probe_lab.benchmark_runs WHERE id=$1 FOR UPDATE', [input.manifest.runId])).rows[0];
      if (run) {
        identity(run);
        if (canonical(run.manifest) !== canonical(input.manifest)) throw problem('benchmark_manifest_conflict', 409);
      } else {
        if ((await client.query('SELECT id FROM probe_lab.benchmark_runs WHERE expires_at>now() LIMIT 1')).rows.length) throw problem('benchmark_run_in_progress', 409);
        run = (await client.query(`INSERT INTO probe_lab.benchmark_runs(id,manifest,fingerprint,region)
          VALUES($1,$2::jsonb,$3::jsonb,$4) RETURNING *`,
        [input.manifest.runId, JSON.stringify(input.manifest), JSON.stringify(runtimeFingerprint),
          options.region || env.RENDER_REGION || null])).rows[0];
      }
      return page(client, run);
    });
    if (input.action === 'status') return locked(async client => page(client, await load(client, input.runId), input.offset || 0));
    const reservation = await locked(async client => {
      const run = await load(client, input.runId);
      const source = run.manifest.sources.find(source => source.site === input.site);
      if (!source?.controls.some(control => control.username === input.username)) throw problem('benchmark_control_mismatch', 409);
      const previous = (await client.query(`SELECT * FROM probe_lab.benchmark_attempts
        WHERE run_id=$1 AND site=$2 AND username=$3 AND mode=$4 AND pass=$5`,
      [run.id, input.site, input.username, input.mode, input.pass])).rows[0];
      if (previous) return { run, attempt: previous, replay: true };
      if (input.mode !== 'direct' && run.supplier_stopped) throw problem('benchmark_supplier_stopped', 409);
      const site = sites.find(site => site.name === input.site);
      let job;
      if (input.mode !== 'direct') {
        const rate = { mode: input.mode, hosts: [new URL(site.url.replaceAll('{}', input.username)).hostname] };
        job = { source: site.name, username: input.username, rate, target_url: targetFor(site, input.username, rate) };
      }
      const count = (await client.query(`SELECT count(*)::integer AS count FROM probe_lab.benchmark_attempts
        WHERE run_id=$1 AND mode=$2`, [run.id, input.mode])).rows[0].count;
      if (count >= run.manifest.limits[input.mode]) throw problem('benchmark_lane_limit', 429);
      const quota = (await client.query(`SELECT
        count(*) FILTER(WHERE a.created_at>now()-interval '1 hour')::integer AS hourly,
        count(*) FILTER(WHERE a.state IN ('started','dispatched') AND r.expires_at>now())::integer AS active
        FROM probe_lab.benchmark_attempts a JOIN probe_lab.benchmark_runs r ON r.id=a.run_id`)).rows[0];
      if (quota.hourly >= hourlyLimit || quota.active >= 2) throw problem('benchmark_rate_limited', 429);
      const attempt = (await client.query(`INSERT INTO probe_lab.benchmark_attempts(id,run_id,site,username,mode,pass)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), run.id, input.site, input.username, input.mode, input.pass])).rows[0];
      return { run, attempt, site, job };
    });
    const { run, attempt, site, job } = reservation;
    if (reservation.replay) return { attempt: attemptView(attempt, run), runtimeFingerprint };
    const authorize = async evidence => locked(async client => {
      if (!trialAllowed(env)) throw problem('benchmark_spending_gates_required', 403);
      const current = await load(client, run.id);
      if (input.mode !== 'direct' && current.supplier_stopped) throw problem('benchmark_supplier_stopped', 409);
      const updated = await client.query(`UPDATE probe_lab.benchmark_attempts
        SET state='dispatched',dispatched_at=now(),dispatch_evidence=$2::jsonb
        WHERE id=$1 AND state='started' RETURNING id`, [attempt.id, evidence ? JSON.stringify(evidence) : null]);
      if (updated.rowCount !== 1) throw problem('benchmark_already_dispatched', 409);
    });
    const started = Date.now();
    let outcome;
    try {
      if (input.mode === 'direct') {
        await authorize();
        const result = await direct(site, input.username, 15000).promise;
        outcome = { state: ['error', 'timeout'].includes(result.status) ? 'probe_error' : 'response', result };
      } else {
        outcome = await executeImpl({ ...job, attempt_id: attempt.id }, site, env.ZYTE_API_KEY, undefined, undefined, authorize);
      }
    } catch (_) {
      console.error('[source-benchmark] attempt failed; outcome uncertain, no automatic retry.');
      outcome = { state: input.mode === 'direct' ? 'probe_error' : 'uncertain',
        result: { status: input.mode === 'direct' ? 'error' : 'unknown',
          reasonCodes: [input.mode === 'direct' ? 'request_error' : 'provider_outcome_uncertain'] } };
    }
    // Engine results contain extracted profile fields, not fetched bodies or credentials.
    outcome.result = normalizeResult(outcome.result);
    const saved = await locked(async client => {
      if ([400, 401, 403, 422, 429].includes(outcome.providerStatus)) {
        await client.query('UPDATE probe_lab.benchmark_runs SET supplier_stopped=true WHERE id=$1', [run.id]);
      }
      return (await client.query(`UPDATE probe_lab.benchmark_attempts
        SET state=$2,outcome=$3::jsonb,duration_ms=$4,completed_at=now() WHERE id=$1 RETURNING *`,
      [attempt.id, outcome.state, JSON.stringify(outcome), Date.now() - started])).rows[0];
    });
    return { attempt: attemptView(saved, run), runtimeFingerprint };
  };
}

module.exports = { createSourceBenchmark, validateManifest, initialize, MAX_LIMITS };
