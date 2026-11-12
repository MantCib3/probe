'use strict';

const crypto = require('node:crypto');
const { transaction } = require('./db');
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const STATS_URL = 'https://zyte-api-stats.zyte.com/api/stats';
const PAGE_SIZE = 500;
const MAX_PAGES = 100;
const MAX_WINDOW_MS = 31 * 86400000;

async function readJson(response, limit) {
  if (!response.body) throw new Error('Zyte Stats API returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('Zyte Stats API response exceeded the import size limit.');
    }
    chunks.push(Buffer.from(value));
  }
  try { return { payload: JSON.parse(Buffer.concat(chunks).toString('utf8')), size }; }
  catch { throw new Error('Zyte Stats API returned invalid JSON.'); }
}

function parseWindow(startTime, endTime) {
  const parse = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) {
      throw new Error('Stats window timestamps must be ISO UTC strings ending in Z.');
    }
    const time = Date.parse(value);
    const [whole, fraction] = value.slice(0, -1).split('.');
    const expected = `${whole}.${(fraction || '').padEnd(3, '0')}Z`;
    if (!Number.isFinite(time) || new Date(time).toISOString() !== expected) {
      throw new Error('Stats window timestamp is invalid.');
    }
    return expected;
  };
  const start = parse(startTime);
  const end = parse(endTime);
  const duration = Date.parse(end) - Date.parse(start);
  if (duration <= 0 || duration > MAX_WINDOW_MS) throw new Error('Stats window must be positive and no longer than 31 days.');
  return { startTime: start, endTime: end };
}

function positiveInteger(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`Stats response has invalid ${name}.`);
  return value;
}

function decimal(value, name) {
  if (typeof value !== 'string' || !/^\d{1,22}(?:\.\d{1,8})?$/.test(value)) {
    throw new Error(`Stats response has invalid ${name}.`);
  }
  return value;
}

function validatePage(payload, { organizationId, page }) {
  if (!payload || !Number.isSafeInteger(payload.page) || payload.page !== page ||
      !Number.isSafeInteger(payload.page_size) || payload.page_size < 1 ||
      !Number.isSafeInteger(payload.total_result_count) || payload.total_result_count < 0 ||
      !Array.isArray(payload.results)) throw new Error('Stats API returned an invalid page shape.');
  const results = payload.results.map(row => {
    if (!row || row.organization_id !== organizationId ||
        typeof row.domain !== 'string' || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(row.domain)) {
      throw new Error('Stats API returned an invalid organization or domain.');
    }
    positiveInteger(row.request_count, 'request_count', true);
    decimal(row.cost_microusd_total, 'cost_microusd_total');
    decimal(row.cost_microusd_avg, 'cost_microusd_avg');
    decimal(row.cost_microusd_p80, 'cost_microusd_p80');
    if (row.status_codes !== undefined && (!Array.isArray(row.status_codes) ||
        row.status_codes.some(item => !item || !Number.isSafeInteger(item.code) || item.code < 100 || item.code > 599 ||
          !Number.isSafeInteger(item.count) || item.count < 0))) {
      throw new Error('Stats API returned invalid status-code aggregates.');
    }
    return {
      domain: row.domain.toLowerCase(),
      requestCount: row.request_count,
      costMicrousdTotal: row.cost_microusd_total,
      costMicrousdAvg: row.cost_microusd_avg,
      costMicrousdP80: row.cost_microusd_p80,
    };
  });
  return { totalResultCount: payload.total_result_count, pageSize: payload.page_size, results };
}

async function fetchStats({ organizationId, startTime, endTime, apiKey, fetchImpl = fetch }) {
  positiveInteger(organizationId, 'organization_id');
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('ZYTE_STATS_API_KEY is required.');
  const window = parseWindow(startTime, endTime);
  const domains = [];
  const rawPages = [];
  let totalResultCount = null;
  let pageCount = 0;
  let totalBytes = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(STATS_URL);
    url.search = new URLSearchParams({
      organization_id: String(organizationId),
      start_time: window.startTime,
      end_time: window.endTime,
      groupby_domain: 'true',
      page: String(page),
      page_size: String(PAGE_SIZE),
    });
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` },
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Zyte Stats API request failed with HTTP ${response.status}.`);
    }
    const remaining = MAX_TOTAL_BYTES - totalBytes;
    const { payload, size } = await readJson(response, Math.min(MAX_PAGE_BYTES, remaining));
    totalBytes += size;
    const validated = validatePage(payload, { organizationId, page });
    if (totalResultCount === null) totalResultCount = validated.totalResultCount;
    if (validated.totalResultCount !== totalResultCount || validated.pageSize !== PAGE_SIZE) {
      throw new Error('Zyte Stats API pagination changed during import.');
    }
    if (!validated.results.length && domains.length < totalResultCount) {
      throw new Error('Zyte Stats API pagination is incomplete.');
    }
    pageCount++;
    domains.push(...validated.results);
    rawPages.push(payload);
    if (domains.length >= totalResultCount) {
      if (domains.length !== totalResultCount) throw new Error('Zyte Stats API returned excess result rows.');
      break;
    }
  }
  if (totalResultCount === null || domains.length !== totalResultCount) throw new Error('Zyte Stats API result limit exceeded or pagination incomplete.');
  const uniqueDomains = new Set(domains.map(row => row.domain));
  if (uniqueDomains.size !== domains.length) throw new Error('Zyte Stats API returned duplicate domain aggregates.');
  return {
    organizationId,
    ...window,
    totalResultCount,
    pageCount,
    response: { pages: rawPages },
    domains,
  };
}

async function saveStats(pool, stats) {
  const snapshot = JSON.stringify(stats.response);
  const snapshotSha256 = crypto.createHash('sha256').update(snapshot).digest('hex');
  return transaction(pool, async client => {
    const id = crypto.randomUUID();
    const inserted = await client.query(`INSERT INTO probe_billing.zyte_stats_imports
      (id, organization_id, start_time, end_time, snapshot_sha256, total_result_count, page_count, response)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT (organization_id, start_time, end_time) DO NOTHING RETURNING id`,
    [id, stats.organizationId, stats.startTime, stats.endTime, snapshotSha256,
      stats.totalResultCount, stats.pageCount, snapshot]);
    if (!inserted.rowCount) {
      const prior = await client.query(`SELECT id, snapshot_sha256 FROM probe_billing.zyte_stats_imports
        WHERE organization_id=$1 AND start_time=$2 AND end_time=$3 FOR UPDATE`,
      [stats.organizationId, stats.startTime, stats.endTime]);
      if (prior.rows[0]?.snapshot_sha256 === snapshotSha256) {
        return { id: prior.rows[0].id, duplicate: true, domainCount: stats.domains.length };
      }
      throw new Error('A different Stats API snapshot already exists for this organization and time window; review it before importing again.');
    }
    for (const row of stats.domains) {
      await client.query(`INSERT INTO probe_billing.zyte_stats_domains
        (import_id, domain, request_count, cost_microusd_total, cost_microusd_avg, cost_microusd_p80)
        VALUES($1,$2,$3,$4::numeric,$5::numeric,$6::numeric)`,
      [id, row.domain, row.requestCount, row.costMicrousdTotal, row.costMicrousdAvg, row.costMicrousdP80]);
    }
    return { id, duplicate: false, domainCount: stats.domains.length };
  });
}

module.exports = { fetchStats, parseWindow, saveStats, validatePage, STATS_URL, PAGE_SIZE, MAX_PAGES };
