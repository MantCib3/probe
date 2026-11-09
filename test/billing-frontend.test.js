'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('offline browser: paid checkbox never spends implicitly, meter and explicit job are integrated', async t => {
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) {
    if (/Executable doesn't exist/.test(error.message)) { t.skip('Existing Playwright browser is unavailable; no installation requested.'); return; }
    throw error;
  }
  t.after(() => browser.close());
  const page = await browser.newPage();
  const origin = 'https://staging.example.test';
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  const prefix = source.split('/* ── Constants')[0] +
    "\nfunction validateUsername(value) { return /^[a-z]+$/.test(value) ? null : 'Invalid username'; }\nasync function acquireTurnstileToken() { return 'fixture-token'; }\n";
  const calls = [];
  let enabled = false;
  const config = { enabled: false, reason: 'Sandbox disabled', consentVersion: 'fixture-v1',
    consentText: 'Provider-billable inconclusive checks count; PROBE errors are absorbed.', termsHash: 'a'.repeat(64),
    creditMicros: 1000000, thresholdMicros: 500000, minimumCents: 1,
    rates: [{ source: 'Fixture', mode: 'http', supplierMicros: 2000, marginMicros: 1000, maximumMicros: 3000 }] };
  let jobs = [];
  // Every request, including apparent provider/navigation URLs, is intercepted locally.
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html,
      headers: { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" } });
    if (url.pathname === '/script.min.js') return route.fulfill({ contentType: 'application/javascript', body: prefix });
    if (!url.pathname.startsWith('/api/paid/')) return route.fulfill({ status: 404, body: '' });
    const endpoint = url.pathname.split('/').pop();
    calls.push({ endpoint, method: request.method(), body: request.postDataJSON(), headers: request.headers() });
    if (endpoint === 'config') return route.fulfill({ json: { ...config, enabled } });
    if (endpoint === 'status') return route.fulfill({ json: { state: 'active', termsHash: config.termsHash,
      csrf: 'b'.repeat(64), debtMicros: '2000', reservedMicros: '3000', paidMicros: '10000', capMicros: null,
      jobs, usage: [] } });
    if (endpoint === 'jobs') {
      jobs = [{ source: 'Fixture', state: 'reconcile', reservation_micros: '3000',
        result: { status: 'unknown', reasonCodes: ['<script>unsafe</script>'] } }];
      return route.fulfill({ status: 202, json: { id: 'fixture-job' } });
    }
    return route.fulfill({ status: 400, json: { error: 'unexpected_test_action' } });
  });
  await page.goto(origin);
  await page.locator('#paid').evaluate(element => { element.open = true; });
  await page.waitForFunction(() => document.getElementById('paidStatus').textContent === 'Sandbox disabled');
  assert.equal(await page.locator('#paidOptIn').isChecked(), false);
  assert.equal(await page.locator('#paidOptIn').isDisabled(), true);
  assert.deepEqual(calls.map(call => call.endpoint), ['config']);
  enabled = true;
  await page.reload();
  await page.locator('#paid').evaluate(element => { element.open = true; });
  await page.waitForFunction(() => document.getElementById('paidMeter').textContent.includes('Confirmed debt'));
  assert.equal(await page.locator('#paidRun').isDisabled(), true);
  await page.locator('#paidOptIn').check();
  assert.equal(await page.locator('#paidRun').isEnabled(), true);
  assert.equal(calls.some(call => call.endpoint === 'setup' || call.endpoint === 'jobs'), false);
  await page.locator('#usernameInput').fill('alice');
  await page.locator('#paidRun').click();
  await page.waitForFunction(() => document.getElementById('paidJobs').textContent.includes('unknown'));
  const jobCalls = calls.filter(call => call.endpoint === 'jobs');
  assert.equal(jobCalls.length, 1);
  assert.equal(jobCalls[0].method, 'POST');
  assert.equal(jobCalls[0].body.username, 'alice');
  assert.equal(jobCalls[0].headers['x-probe-csrf'], 'b'.repeat(64));
  assert.equal(await page.locator('#paidJobs script').count(), 0);
  assert.equal(await page.locator('#resultsGrid').textContent(), '');
  assert.match(await page.locator('#paidMeter').textContent(), /AUD 0\.002000/);
  assert.equal(calls.some(call => call.endpoint === 'setup'), false);
});
