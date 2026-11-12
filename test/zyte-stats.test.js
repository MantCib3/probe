'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fetchStats, parseWindow, saveStats } = require('../lib/billing/zyte-stats');
const { argumentsFrom, sumDecimals } = require('../scripts/zyte-stats-import');

const window = {
  startTime: '2026-11-09T07:30:00Z',
  endTime: '2026-11-09T07:31:00Z',
};
const row = (domain, total) => ({
  billed_traffic_bytes: 0,
  cost_microusd_avg: '133.00',
  cost_microusd_p80: '133.00',
  cost_microusd_total: total,
  domain,
  organization_id: 1053513,
  request_count: 2,
  response_time_sec_avg: '0.75',
  response_time_sec_p80: '1.05',
  status_codes: [{ code: 200, count: 2 }],
});
const page = (number, results, total = results.length) => ({
  page: number, page_size: 500, results, total_result_count: total,
});

test('Stats API parser accepts strict UTC windows and rejects invalid or oversized ranges', () => {
  assert.deepEqual(parseWindow(window.startTime, window.endTime), {
    startTime: '2026-11-09T07:30:00.000Z',
    endTime: '2026-11-09T07:31:00.000Z',
  });
  assert.throws(() => parseWindow('2026-11-09T07:30:00-08:00', window.endTime), /ending in Z/);
  assert.throws(() => parseWindow('2026-02-31T07:30:00Z', window.endTime), /timestamp is invalid/);
  assert.throws(() => parseWindow(window.endTime, window.startTime), /positive/);
  assert.throws(() => parseWindow('2026-10-01T00:00:00Z', '2026-11-02T00:00:00Z'), /31 days/);
});

test('imports paginated per-domain USD micro-cost aggregates and preserves raw API evidence', async () => {
  const calls = [];
  const responses = [
    page(1, [row('hackerone.com', '266.00')], 2),
    page(2, [row('tellonym.me', '266.00')], 2),
  ];
  const stats = await fetchStats({
    organizationId: 1053513, ...window, apiKey: 'secret-key',
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return Response.json(responses[calls.length - 1]);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, 'https://zyte-api-stats.zyte.com/api/stats');
  assert.equal(calls[0].url.searchParams.get('start_time'), '2026-11-09T07:30:00.000Z');
  assert.equal(calls[1].url.searchParams.get('page'), '2');
  assert.equal(calls[0].url.searchParams.get('groupby_domain'), 'true');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, `Basic ${Buffer.from('secret-key:').toString('base64')}`);
  assert.equal(stats.pageCount, 2);
  assert.equal(stats.domains.length, 2);
  assert.deepEqual(stats.domains.map(item => item.costMicrousdTotal), ['266.00', '266.00']);
  assert.equal(stats.response.pages[0].results[0].response_time_sec_avg, '0.75');
  assert.deepEqual(stats.response.pages[0].results[0].status_codes, [{ code: 200, count: 2 }]);
});

test('rejects malformed, cross-organization, duplicate, and incomplete API aggregates', async () => {
  const fetchWith = payload => () => Promise.resolve(Response.json(payload));
  await assert.rejects(fetchStats({ organizationId: 1053513, ...window, apiKey: 'k', fetchImpl: fetchWith(page(1, [{ ...row('hackerone.com', '1'), organization_id: 1 }])) }), /organization or domain/);
  await assert.rejects(fetchStats({ organizationId: 1053513, ...window, apiKey: 'k', fetchImpl: fetchWith(page(1, [row('hackerone.com', '1.000000001')])) }), /cost_microusd_total/);
  let pageNumber = 0;
  await assert.rejects(fetchStats({ organizationId: 1053513, ...window, apiKey: 'k', fetchImpl: () => {
    pageNumber++;
    return Promise.resolve(Response.json(page(pageNumber, pageNumber === 1 ? [row('hackerone.com', '1')] : [], 2)));
  } }), /pagination is incomplete/);
  await assert.rejects(fetchStats({ organizationId: 1053513, ...window, apiKey: 'k', fetchImpl: fetchWith(page(1, [row('hackerone.com', '1'), row('HACKERONE.COM', '1')])) }), /duplicate domain/);
  await assert.rejects(fetchStats({ organizationId: 1053513, ...window, apiKey: 'k', fetchImpl: async () => new Response('', { status: 403 }) }), /HTTP 403/);
});

test('persists immutable supplier aggregates idempotently and never writes customer billing tables', async () => {
  const records = [];
  const statements = [];
  const client = {
    async query(sql, values) {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      if (sql.includes('SELECT id, snapshot_sha256')) {
        const found = records.filter(record => record.organizationId === values[0] &&
          record.startTime === values[1] && record.endTime === values[2]);
        return { rows: found.map(record => ({ id: record.id, snapshot_sha256: record.hash })), rowCount: found.length };
      }
      if (sql.startsWith('INSERT INTO probe_billing.zyte_stats_imports')) {
        const found = records.find(record => record.organizationId === values[1] &&
          record.startTime === values[2] && record.endTime === values[3]);
        if (found) return { rows: [], rowCount: 0 };
        records.push({ id: values[0], organizationId: values[1], startTime: values[2], endTime: values[3], hash: values[4] });
        return { rows: [{ id: values[0] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const stats = {
    organizationId: 1053513, ...window, totalResultCount: 1, pageCount: 1,
    response: { pages: [page(1, [row('hackerone.com', '266.00')])] },
    domains: [{ domain: 'hackerone.com', requestCount: 2, costMicrousdTotal: '266.00', costMicrousdAvg: '133.00', costMicrousdP80: '133.00' }],
  };
  const first = await saveStats(pool, stats);
  const repeated = await saveStats(pool, stats);
  assert.equal(first.duplicate, false);
  assert.equal(repeated.duplicate, true);
  assert.equal(first.id, repeated.id);
  assert.equal(statements.filter(sql => sql.startsWith('INSERT INTO probe_billing.zyte_stats_domains')).length, 1);
  assert.ok(statements.every(sql => !/probe_billing\.(?:guests|jobs|ledger|collections)/.test(sql)));
  await assert.rejects(saveStats(pool, { ...stats, response: { ...stats.response, results: [row('hackerone.com', '267.00')] } }), /different Stats API snapshot/);
});

test('supplier-stats migration has no customer or job references', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'billing', '004-zyte-stats-evidence.sql'), 'utf8');
  assert.match(sql, /cost_microusd_total numeric\(30, 8\)/);
  assert.match(sql, /REFERENCES probe_billing\.zyte_stats_imports/);
  assert.doesNotMatch(sql, /guest_id|job_id|supplier_micros|probe_billing\.ledger|probe_billing\.jobs/i);
});

test('CLI argument validation and exact summary arithmetic reject imprecise billing numbers', () => {
  assert.deepEqual(argumentsFrom([
    '--organization-id', '1053513', '--start-time', window.startTime, '--end-time', window.endTime,
  ]), { organizationId: 1053513, ...parseWindow(window.startTime, window.endTime) });
  assert.throws(() => argumentsFrom(['--organization-id', '1', '--start-time', window.startTime]), /Usage:/);
  assert.equal(sumDecimals(['266.00', '266.00', '0.00000001']), '532.00000001');
});
