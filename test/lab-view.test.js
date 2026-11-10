'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { readBody } = require('../lib/request');
const { createLabViewHandler, createMemoryStore, createPgStore, validateReport } = require('../lib/routes/lab-view');

const SECRET = 'x'.repeat(40);
const PASSWORD = 'correct horse';

async function withServer(options, fn) {
  const handler = createLabViewHandler({ readBody, getClientIp: () => '203.0.113.9', uploadSecret: SECRET, password: PASSWORD, enabled: true, ...options });
  const server = http.createServer((req, res) => handler(new URL(req.url, 'http://x').pathname, req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise(resolve => server.close(resolve)); }
}
const basic = password => `Basic ${Buffer.from(`anyone:${password}`).toString('base64')}`;
const report = (overrides = {}) => ({
  schemaVersion: 1,
  generatedAt: '2026-11-09T10:40:00Z',
  run: { startedAt: '2026-11-09T10-00-00-000Z', status: 'passed', ok: true, steps: [{ name: 'full-campaign', ok: true, exitCode: 0, seconds: 200 }] },
  campaign: { accuracy: 0.9858, coverage: 0.843, falsePositive: 0, falseNegative: 13 },
  canary: 'All clear <script>alert(1)</script>',
  ...overrides,
});

test('lab view is inert when disabled or without a password', async () => {
  for (const options of [{ enabled: false }, { password: '' }, { password: undefined }]) {
    await withServer(options, async base => {
      assert.equal((await fetch(`${base}/lab`, { headers: { authorization: basic(PASSWORD) } })).status, 404);
      assert.equal((await fetch(`${base}/api/staging-lab-report`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify(report()) })).status, 404);
    });
  }
});

test('upload requires the staging bearer key and a valid report', async () => {
  const store = createMemoryStore();
  await withServer({ store }, async base => {
    const post = (auth, body) => fetch(`${base}/api/staging-lab-report`, { method: 'POST', headers: { authorization: auth }, body });
    assert.equal((await post('Bearer wrong', JSON.stringify(report()))).status, 401);
    assert.equal((await post(basic(PASSWORD), JSON.stringify(report()))).status, 401, 'view password cannot upload');
    assert.equal((await post(`Bearer ${SECRET}`, '{nope')).status, 400);
    assert.equal((await post(`Bearer ${SECRET}`, JSON.stringify({ schemaVersion: 2, generatedAt: 'x' }))).status, 400);
    assert.equal((await post(`Bearer ${SECRET}`, JSON.stringify(report({ canary: 'x'.repeat(300 * 1024) })))).status, 413);
    assert.equal((await post(`Bearer ${SECRET}`, JSON.stringify(report()))).status, 200);
    assert.equal((await (await post(`Bearer ${SECRET}`, JSON.stringify(report()))).json()).stored, 'memory');
    assert.equal((await fetch(`${base}/api/staging-lab-report`)).status, 405);
  });
  assert.equal((await store.latest(5)).length, 2);
});

test('page requires only the password and escapes report content', async () => {
  const store = createMemoryStore();
  await store.save(report());
  await withServer({ store }, async base => {
    const anonymous = await fetch(`${base}/lab`);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate'), /^Basic /);
    assert.equal((await fetch(`${base}/lab`, { headers: { authorization: basic('wrong') } })).status, 401);
    assert.equal((await fetch(`${base}/lab`, { headers: { authorization: `Bearer ${SECRET}` } })).status, 401, 'upload key cannot view');
    const ok = await fetch(`${base}/lab`, { headers: { authorization: `Basic ${Buffer.from(`:${PASSWORD}`).toString('base64')}` } });
    assert.equal(ok.status, 200, 'blank username works');
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.match(ok.headers.get('x-robots-tag'), /noindex/);
    const html = await ok.text();
    assert.match(html, /98\.58%/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
  });
});

test('repeated wrong passwords are rate limited', async () => {
  await withServer({}, async base => {
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/lab`, { headers: { authorization: basic(`bad${i}`) } })).status, 401);
    assert.equal((await fetch(`${base}/lab`, { headers: { authorization: basic(PASSWORD) } })).status, 429);
  });
});

test('empty store renders a placeholder', async () => {
  await withServer({}, async base => {
    const html = await (await fetch(`${base}/lab`, { headers: { authorization: basic(PASSWORD) } })).text();
    assert.match(html, /No nightly report has been uploaded yet/);
  });
});

test('postgres store creates its own schema and falls back to memory when reads fail', async () => {
  const queries = [];
  let failReads = false;
  const pool = { query: async (sql, params) => {
    queries.push(sql.replace(/\s+/g, ' ').trim());
    if (/^SELECT/.test(sql) && failReads) throw new Error('down');
    if (/^SELECT/.test(sql)) return { rows: [{ report: { generatedAt: 'x' }, received_at: '2026-11-09T00:00:00Z' }] };
    return { rows: [] };
  } };
  const store = createPgStore(() => pool);
  assert.equal(store.kind, 'database');
  await store.save(report());
  assert.ok(queries.some(q => q === 'CREATE SCHEMA IF NOT EXISTS probe_lab'));
  assert.ok(queries.some(q => q.startsWith('INSERT INTO probe_lab.reports')));
  assert.ok(!queries.some(q => /probe_billing/.test(q)));
  assert.equal((await store.latest(5))[0].report.generatedAt, 'x');
  failReads = true;
  assert.equal((await store.latest(5))[0].report.generatedAt, report().generatedAt, 'memory fallback');
});

test('validateReport rejects non-objects and bad dates', () => {
  assert.ok(validateReport(null));
  assert.ok(validateReport([]));
  assert.ok(validateReport({ schemaVersion: 1, generatedAt: 'not a date' }));
  assert.ok(validateReport({ schemaVersion: 1, generatedAt: '2026-11-09T00:00:00Z', canary: 5 }));
  assert.equal(validateReport(report()), null);
});
