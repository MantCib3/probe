'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { CONSENT_TEXT, CONSENT_VERSION } = require('../lib/billing/config');

test('offline browser: paid checkbox never spends implicitly, meter and explicit job are integrated', { timeout: 180000 }, async t => {
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) {
    if (/Executable doesn't exist/.test(error.message)) { t.skip('Existing Playwright browser is unavailable; no installation requested.'); return; }
    throw error;
  }
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const origin = 'https://staging.example.test';
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  const prefix = source.split('/* ── Constants')[0] +
    "\nfunction validateUsername(value) { return /^[a-z]+$/.test(value) ? null : 'Invalid username'; }\nasync function acquireTurnstileToken() { return 'fixture-token'; }\n";
  const calls = [];
  let enabled = false;
  const config = { enabled: false, reason: 'Sandbox disabled', consentVersion: CONSENT_VERSION,
    consentText: CONSENT_TEXT, termsHash: 'a'.repeat(64),
    creditMicros: 1000000, thresholdMicros: 500000, minimumCents: 50,
    rates: [{ source: 'Fixture', mode: 'http', supplierMicros: 2000, marginMicros: 1000, maximumMicros: 3000 }] };
  let jobs = [];
  let guestState = 'active';
  let debtMicros = '2000';
  let reservedMicros = '3000';
  let collections = [];
  let recovery = null;
  let sessionAvailable = true;
  let legacy = false;
  let recoveryCodeConfigured = false;
  const recoveryCode = 'q'.repeat(43);
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
    if (endpoint === 'status' && legacy) return route.fulfill({ status: 409, json: { error: 'legacy_currency_frozen' } });
    if (endpoint === 'status' && !sessionAvailable) return route.fulfill({ status: 401, json: { error: 'session_required' } });
    if (endpoint === 'status') return route.fulfill({ json: { state: guestState, termsHash: config.termsHash,
      csrf: 'b'.repeat(64), debtMicros, reservedMicros, paidMicros: '10000', capMicros: null,
      jobs, usage: [], collections, recovery, recoveryCodeConfigured,
      currency: 'usd', remainder: { numerator: '1', denominator: '3' } } });
    if (endpoint === 'session') {
      sessionAvailable = true;
      recoveryCodeConfigured = true;
      guestState = 'new';
      return route.fulfill({ json: { csrf: 'b'.repeat(64), recoveryCode } });
    }
    if (endpoint === 'recovery-code') {
      recoveryCodeConfigured = true;
      return route.fulfill({ json: { recoveryCode } });
    }
    if (endpoint === 'restore-session') {
      sessionAvailable = true;
      return route.fulfill({ json: { csrf: 'b'.repeat(64), restored: true, authorized: false } });
    }
    if (endpoint === 'setup') return route.fulfill({ json: { url: 'https://foreign.test/not-stripe', authorized: false } });
    if (endpoint === 'recovery') return route.fulfill({ json: { url: 'https://foreign.test/not-stripe', authorized: false } });
    if (endpoint === 'resume') {
      guestState = 'active';
      return route.fulfill({ json: { state: 'active' } });
    }
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
  assert.match(await page.locator('#paidRates').textContent(), /Fixture \(http, supplier-selected IP\)/);
  assert.match(await page.locator('#paidTerms').textContent(), /before promotional credits, allocated equally/);
  assert.match(await page.locator('#paidMeter').textContent(), /1\/3 of one USD millionth/);
  for (const ipType of ['datacenter', 'residential']) {
    config.rates[0].ipType = ipType;
    await page.reload();
    await page.locator('#paid').evaluate(element => { element.open = true; });
    await page.waitForFunction(type => document.getElementById('paidRates').textContent.includes(`${type} IP`), ipType);
    assert.match(await page.locator('#paidRates').textContent(), new RegExp(`Fixture \\(http, ${ipType} IP\\)`));
  }
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
  assert.match(await page.locator('#paidMeter').textContent(), /USD 0\.002000/);
  assert.equal(calls.some(call => call.endpoint === 'setup'), false);
  guestState = 'action_required';
  debtMicros = '1000000';
  reservedMicros = '0';
  collections = [{ state: 'failed', amount_cents: '100' }];
  await page.reload();
  await page.locator('#paid').evaluate(element => { element.open = true; });
  await page.waitForFunction(() => !document.getElementById('paidRecovery').hidden);
  assert.equal(await page.locator('#paidRun').isDisabled(), true);
  assert.equal(await page.locator('#paidSettle').isDisabled(), true);
  await page.locator('#paidRecoveryConsent').check();
  assert.equal(await page.locator('#paidSettle').isEnabled(), true);
  assert.equal(await page.locator('#paidReplace').isEnabled(), true);
  await page.locator('#paidOptIn').check();
  assert.equal(await page.locator('#paidResume').isDisabled(), true);
  await page.locator('#paidSettle').click();
  await page.waitForFunction(() => document.getElementById('paidStatus').textContent.includes('Invalid Stripe checkout URL'));
  assert.equal(page.url(), `${origin}/`);
  const settlements = calls.filter(call => call.endpoint === 'recovery');
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].body.settleDebt, true);
  assert.equal(settlements[0].body.consent, true);
  assert.equal(settlements[0].headers['x-probe-csrf'], 'b'.repeat(64));
  assert.equal(calls.some(call => call.endpoint === 'resume'), false);
  debtMicros = '7';
  collections = [];
  recovery = { state: 'confirmed', amount_cents: '100' };
  await page.reload();
  await page.locator('#paid').evaluate(element => { element.open = true; });
  await page.waitForFunction(() => document.getElementById('paidRecoveryStatus').textContent.includes('confirmed'));
  assert.equal(await page.locator('#paidRun').isDisabled(), true);
  assert.equal(await page.locator('#paidResume').isDisabled(), true);
  await page.locator('#paidOptIn').check();
  assert.equal(await page.locator('#paidResume').isEnabled(), true);
  await page.locator('#paidResume').click();
  await page.waitForFunction(() => document.getElementById('paidRecovery').hidden);
  assert.equal(await page.locator('#paidRun').isEnabled(), true);
  assert.equal(calls.filter(call => call.endpoint === 'jobs').length, 1);
  guestState = 'action_required';
  debtMicros = '490000';
  await page.reload();
  await page.locator('#paid').evaluate(element => { element.open = true; });
  await page.waitForFunction(() => document.getElementById('paidRecoveryStatus').textContent.includes('USD 0.50 minimum'));
  await page.locator('#paidRecoveryConsent').check();
  await page.locator('#paidOptIn').check();
  assert.equal(await page.locator('#paidSettle').isDisabled(), true);
  assert.equal(await page.locator('#paidResume').isDisabled(), true);
  assert.equal(await page.locator('#paidRun').isDisabled(), true);
  guestState = 'revoked';
  debtMicros = '1000000';
  await page.reload();
  await page.locator('#paid').evaluate(element => { element.open = true; });
  await page.waitForFunction(() => !document.getElementById('paidRecovery').hidden);
  await page.locator('#paidRecoveryConsent').check();
  await page.locator('#paidOptIn').check();
  assert.equal(await page.locator('#paidSettle').isEnabled(), true);
  assert.equal(await page.locator('#paidReplace').isDisabled(), true);
  assert.equal(await page.locator('#paidResume').isDisabled(), true);
  await page.locator('#paidSessionHelp').evaluate(element => { element.open = true; });
  assert.equal(await page.locator('#paidCreateCode').isDisabled(), true);
  await page.locator('#paidCodeReplaceConsent').check();
  await page.locator('#paidCreateCode').click();
  await page.waitForFunction(() => !document.getElementById('paidCodeOutput').hidden);
  assert.equal(await page.locator('#paidNewCode').inputValue(), recoveryCode);
  assert.equal(await page.locator('#paidNewCode').getAttribute('type'), 'password');
  await page.locator('#paidRevealCode').click();
  assert.equal(await page.locator('#paidNewCode').getAttribute('type'), 'text');
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  assert.equal(calls.filter(call => call.endpoint === 'recovery-code').length, 1);
  assert.equal(await page.locator('#paidRestoreSession').isDisabled(), true);
  sessionAvailable = false;
  await page.reload();
  await page.locator('#paid').evaluate(element => { element.open = true; });
  await page.waitForFunction(() => document.getElementById('paidSessionStatus').textContent.includes('Session missing'));
  assert.equal(await page.locator('#paidNewCode').inputValue(), '');
  await page.locator('#paidRestoreCode').fill(recoveryCode);
  await page.locator('#paidRestoreSession').click();
  await page.waitForFunction(() => document.getElementById('paidSessionStatus').textContent.includes('Billing session restored'));
  assert.equal(await page.locator('#paidRestoreCode').inputValue(), '');
  assert.equal(await page.locator('#paidOptIn').isChecked(), false);
  assert.equal(await page.locator('#paidResume').isDisabled(), true);
  const restoreCall = calls.find(call => call.endpoint === 'restore-session');
  assert.equal(restoreCall.body.restore, true);
  assert.equal(restoreCall.body.recoveryCode, recoveryCode);
  assert.equal(restoreCall.body.cfToken, 'fixture-token');
  assert.equal(page.url().includes(recoveryCode), false);
  assert.equal(calls.filter(call => call.endpoint === 'jobs').length, 1);
  // A new session must save its one-time displayed code before leaving for payment setup.
  sessionAvailable = false;
  guestState = 'new';
  debtMicros = '0';
  await page.reload();
  await page.locator('#paid').evaluate(element => { element.open = true; });
  await page.waitForFunction(() => document.getElementById('paidSessionStatus').textContent.includes('Session missing'));
  await page.locator('#paidCodeReplaceConsent').check();
  await page.locator('#paidCreateCode').click();
  await page.waitForFunction(() => !document.getElementById('paidCodeOutput').hidden);
  await page.locator('#paidRefresh').click();
  await page.waitForFunction(() => document.getElementById('paidStatus').textContent.includes('Sandbox: new'));
  await page.locator('#paidOptIn').check();
  await page.locator('#paidSetup').click();
  await page.waitForFunction(() => document.getElementById('paidStatus').textContent.includes('Save your private recovery code'));
  assert.equal(calls.some(call => call.endpoint === 'setup'), false);
  await page.locator('#paidCodeSaved').check();
  await page.locator('#paidSetup').click();
  await page.waitForFunction(() => document.getElementById('paidStatus').textContent.includes('Invalid Stripe checkout URL'));
  assert.equal(calls.filter(call => call.endpoint === 'setup').length, 1);
  legacy = true;
  await page.reload();
  await page.locator('#paid').evaluate(element => { element.open = true; });
  await page.waitForFunction(() => document.getElementById('paidStatus').textContent.includes('frozen AUD session'));
  assert.equal(await page.locator('#paidOptIn').isDisabled(), true);
  assert.equal(await page.locator('#paidControls').isHidden(), true);
});
