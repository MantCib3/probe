'use strict';

const crypto = require('crypto');

/*
 * Staging-only nightly lab report viewer.
 *   POST /api/staging-lab-report  Bearer STAGING_PROBE_KEY, JSON body (nightly upload)
 *   GET  /lab                     HTTP Basic auth; any username, LAB_VIEW_PASSWORD
 * Both answer 404 unless enabled (PROBE_STAGING=1 and LAB_VIEW_PASSWORD set).
 */

const MAX_UPLOAD_BYTES = 256 * 1024;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const HISTORY = 14;

const digest = value => crypto.createHash('sha256').update(String(value)).digest();
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const pct = value => (num(value) === null ? 'n/a' : `${(value * 100).toFixed(2)}%`);
const text = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');

function validateReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Report must be a JSON object.';
  if (input.schemaVersion !== 1) return 'Unsupported schemaVersion.';
  if (typeof input.generatedAt !== 'string' || !Number.isFinite(Date.parse(input.generatedAt))) return 'generatedAt must be an ISO date.';
  if (input.run !== undefined && (typeof input.run !== 'object' || input.run === null)) return 'run must be an object.';
  if (input.canary !== undefined && typeof input.canary !== 'string') return 'canary must be text.';
  return null;
}

function createMemoryStore() {
  const reports = [];
  return {
    kind: 'memory',
    async save(report) {
      reports.unshift({ report, receivedAt: new Date().toISOString() });
      reports.length = Math.min(reports.length, 30);
    },
    async latest(limit) { return reports.slice(0, limit); },
  };
}

// Postgres store in its own schema (never touches probe_billing). Falls back
// to the last in-memory report if the database is unavailable.
function createPgStore(createPool) {
  let pool;
  let ready;
  const memory = createMemoryStore();
  const connect = () => {
    pool ||= createPool();
    ready ||= (async () => {
      await pool.query('CREATE SCHEMA IF NOT EXISTS probe_lab');
      await pool.query(`CREATE TABLE IF NOT EXISTS probe_lab.reports (
        id bigserial PRIMARY KEY,
        received_at timestamptz NOT NULL DEFAULT now(),
        report jsonb NOT NULL)`);
    })().catch(error => { ready = null; throw error; });
    return ready;
  };
  return {
    kind: 'database',
    async save(report) {
      await memory.save(report);
      await connect();
      await pool.query('INSERT INTO probe_lab.reports (report) VALUES ($1::jsonb)', [JSON.stringify(report)]);
      await pool.query('DELETE FROM probe_lab.reports WHERE id NOT IN (SELECT id FROM probe_lab.reports ORDER BY id DESC LIMIT 60)');
    },
    async latest(limit) {
      try {
        await connect();
        const { rows } = await pool.query('SELECT report, received_at FROM probe_lab.reports ORDER BY id DESC LIMIT $1', [limit]);
        return rows.map(row => ({ report: row.report, receivedAt: new Date(row.received_at).toISOString() }));
      } catch (_) {
        console.error('[lab-view] database read failed; showing in-memory reports only.');
        return memory.latest(limit);
      }
    },
  };
}

function statusLabel(run) {
  const status = text(run?.status, 40);
  if (status) return status;
  return run?.ok === true ? 'passed' : run?.ok === false ? 'failed' : 'unknown';
}

function renderPage(entries) {
  const latest = entries[0];
  const style = `body{font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#1d2330;background:#f7f8fa}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}table{border-collapse:collapse;width:100%;background:#fff}
td,th{border:1px solid #d9dde5;padding:.35rem .6rem;text-align:left;vertical-align:top}th{background:#eef1f6}
.ok{color:#1a7f37;font-weight:600}.bad{color:#b42318;font-weight:600}.warn{color:#9a6700;font-weight:600}
pre{white-space:pre-wrap;background:#fff;border:1px solid #d9dde5;padding:1rem;font-size:13px}.muted{color:#667085}`;
  const cls = status => (['passed', 'completed'].includes(status) ? 'ok' : status === 'failed' ? 'bad' : 'warn');
  let body;
  if (!latest) {
    body = '<p>No nightly report has been uploaded yet.</p>';
  } else {
    const r = latest.report;
    const run = r.run || {};
    const c = r.campaign || {};
    const status = statusLabel(run);
    const steps = Array.isArray(run.steps) ? run.steps.slice(0, 40) : [];
    const stepRows = steps.map(step => {
      const state = text(step.status, 20) || (step.skipped ? 'skipped' : step.ok ? (step.warning ? 'degraded' : 'completed') : 'failed');
      const css = state === 'skipped' ? 'muted' : cls(state);
      return `<tr><td>${escapeHtml(text(step.name, 80))}</td><td class="${css}">${escapeHtml(state)}</td><td>${escapeHtml(num(step.exitCode) ?? '')}</td><td>${escapeHtml(num(step.seconds) ?? '')}</td><td>${escapeHtml(text(step.skipped || step.note, 200))}</td></tr>`;
    }).join('');
    const metric = (label, value) => `<tr><th>${label}</th><td>${escapeHtml(value)}</td></tr>`;
    body = `<p>Nightly run <strong>${escapeHtml(text(run.startedAt || r.generatedAt, 40))}</strong> — <span class="${cls(status)}">${escapeHtml(status)}</span>
<span class="muted">(uploaded ${escapeHtml(latest.receivedAt)})</span></p>
<h2>Full-catalog campaign</h2><table>
${metric('Report generated', text(c.generatedAt, 40) || 'n/a')}
${metric('App commit', text(c.provenance?.git?.commit, 64) || 'unavailable')}
${metric('Catalog hash', text(c.provenance?.inputs?.catalogSha256, 64) || 'unavailable')}
${metric('Classifier hash', text(c.provenance?.inputs?.classifierSha256, 64) || 'unavailable')}
${metric('Oldest reviewed evidence', text(c.evidenceAge?.oldestReviewedAt, 40) || 'unavailable')}
${metric('Maximum evidence age at measurement (days)', num(c.evidenceAge?.maximumAgeDays) ?? 'unavailable')}
${metric('Undated evidence rows', num(c.evidenceAge?.undatedRows) ?? 'unavailable')}
${metric('Alert delivery', text(run.alertDelivery?.status, 20) || 'unavailable')}
${metric('Alert delivery note', text(run.alertDelivery?.reason, 200) || '')}
${metric('Accuracy among decisions', pct(c.accuracy))}
${metric('Coverage', pct(c.coverage))}
${metric('False positives / false negatives', `${num(c.falsePositive) ?? 'n/a'} / ${num(c.falseNegative) ?? 'n/a'}`)}
${metric('Automatic sources (fully verified)', `${num(c.sources) ?? 'n/a'} (${num(c.fullyVerifiedSources) ?? 'n/a'})`)}
${metric('Calibration rows / held-out test rows', `${num(c.calibrationRows) ?? 'n/a'} / ${num(c.testRows) ?? 'n/a'}`)}
${metric('Request errors', num(c.requestErrors) ?? 'n/a')}
${metric('Review queue (pending / disagreements / reviewed)', `${num(r.review?.pending) ?? 'n/a'} / ${num(r.review?.disagreements) ?? 'n/a'} / ${num(r.review?.reviewed) ?? 'n/a'}`)}
</table>
<h2>Steps</h2><table><tr><th>Step</th><th>Result</th><th>Exit</th><th>Seconds</th><th>Note</th></tr>${stepRows}</table>
<h2>Canary</h2><pre>${escapeHtml(text(r.canary, 64 * 1024)) || 'No canary text.'}</pre>`;
    const reportTime = Date.parse(c.generatedAt || r.generatedAt);
    if (!Number.isFinite(reportTime) || Date.now() - reportTime > 36 * 3600000) {
      body = '<p class="bad">STALE OR UNDATED REPORT: not current system verification.</p>' + body;
    }
  }
  const history = entries.map(entry => {
    const run = entry.report.run || {};
    const status = statusLabel(run);
    return `<tr><td>${escapeHtml(text(run.startedAt || entry.report.generatedAt, 40))}</td><td class="${cls(status)}">${escapeHtml(status)}</td><td>${pct(entry.report.campaign?.accuracy)}</td><td>${pct(entry.report.campaign?.coverage)}</td></tr>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>PROBE lab — nightly</title><style>${style}</style></head><body>
<h1>PROBE source-accuracy lab — nightly results</h1>${body}
${history ? `<h2>Recent nights</h2><table><tr><th>Run</th><th>Status</th><th>Accuracy</th><th>Coverage</th></tr>${history}</table>` : ''}
</body></html>`;
}

function createLabViewHandler(options) {
  const { enabled, password, uploadSecret, readBody, getClientIp } = options;
  const store = options.store || createMemoryStore();
  const now = options.now || Date.now;
  const active = Boolean(enabled && typeof password === 'string' && password.length > 0 &&
    typeof uploadSecret === 'string' && Buffer.byteLength(uploadSecret) >= 32);
  const expectedPassword = digest(password || '');
  const expectedUpload = digest(uploadSecret || '');
  const failures = new Map();

  const limited = ip => {
    const entry = failures.get(ip);
    if (!entry) return false;
    if (now() - entry.started > FAILURE_WINDOW_MS) { failures.delete(ip); return false; }
    return entry.count >= MAX_FAILURES;
  };
  const recordFailure = ip => {
    if (failures.size > 5000) failures.clear();
    const entry = failures.get(ip);
    if (!entry || now() - entry.started > FAILURE_WINDOW_MS) failures.set(ip, { count: 1, started: now() });
    else entry.count++;
  };

  return async function handleLabView(pathname, req, res) {
    const send = (status, type, payload, headers = {}) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...headers });
      res.end(req.method === 'HEAD' ? undefined : payload);
    };
    const json = (status, payload, headers) => send(status, 'application/json', JSON.stringify(payload), headers);
    if (!active) return json(404, { ok: false, error: 'Not found.' });
    const ip = getClientIp(req);

    if (pathname === '/api/staging-lab-report') {
      if (req.method !== 'POST') return json(405, { ok: false, error: 'POST required.' }, { Allow: 'POST' });
      if (limited(ip)) return json(429, { ok: false, error: 'Too many failed attempts.' }, { 'Retry-After': '900' });
      const authorization = req.headers.authorization || '';
      if (!authorization.startsWith('Bearer ') || !crypto.timingSafeEqual(expectedUpload, digest(authorization.slice(7)))) {
        recordFailure(ip);
        return json(401, { ok: false, error: 'Authentication required.' });
      }
      let report;
      try {
        req.setTimeout(15000, () => req.destroy());
        report = JSON.parse(await readBody(req, MAX_UPLOAD_BYTES));
      } catch (error) {
        return json(error.code === 'BODY_TOO_LARGE' ? 413 : 400, { ok: false, error: 'Invalid report body.' });
      } finally {
        req.setTimeout(0);
      }
      const problem = validateReport(report);
      if (problem) return json(400, { ok: false, error: problem });
      try {
        await store.save(report);
        return json(200, { ok: true, stored: store.kind || 'database' });
      } catch (_) {
        console.error('[lab-view] database write failed; report kept in memory only.');
        return json(202, { ok: true, stored: 'memory' });
      }
    }

    if (pathname === '/lab') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'Method Not Allowed', { Allow: 'GET, HEAD' });
      if (limited(ip)) return send(429, 'text/plain', 'Too many failed attempts. Try again later.', { 'Retry-After': '900' });
      const authorization = req.headers.authorization || '';
      let supplied = null;
      if (authorization.startsWith('Basic ')) {
        const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon >= 0) supplied = decoded.slice(colon + 1);
      }
      if (supplied === null || !crypto.timingSafeEqual(expectedPassword, digest(supplied))) {
        if (supplied !== null) recordFailure(ip);
        return send(401, 'text/plain', 'Password required.', { 'WWW-Authenticate': 'Basic realm="PROBE lab", charset="UTF-8"' });
      }
      return send(200, 'text/html; charset=utf-8', renderPage(await store.latest(HISTORY)));
    }

    return json(404, { ok: false, error: 'Not found.' });
  };
}

module.exports = { createLabViewHandler, createMemoryStore, createPgStore, renderPage, validateReport, LAB_VIEW_PATHS: ['/lab', '/api/staging-lab-report'] };
