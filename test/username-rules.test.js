'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { incompatibleReason, validateCatalog } = require('../username-rules');
const { probeWithDeadline, usernamePreflight, classify, planUsernameScan } = require('../server');
const catalog = require('../sites.json');

const source = {
  name: 'Example',
  category: 'social',
  url: 'https://example.test/{}',
  usernameRule: { pattern: '^[a-z0-9_]{1,15}$', description: 'Letters, digits or underscores, at most 15 characters.',
    source: 'https://example.test/help' },
};

test('unknown sources are not rejected by category-based guesses', () => {
  assert.equal(incompatibleReason({ name: 'Unknown', category: 'social' }, 'a b'), null);
  assert.equal(usernamePreflight({ name: 'Unknown', url: 'https://example.test/{}' }, 'a-b.c'), null);
});

test('rules accept mixed case and reject incompatible characters and lengths', () => {
  for (const name of ['John', '_alice', 'a'.repeat(15)]) assert.equal(incompatibleReason(source, name), null);
  for (const name of ['john.smith', 'john-smith', 'a'.repeat(16), 'alice\n']) {
    assert.equal(incompatibleReason(source, name), source.usernameRule.description);
  }
  const result = usernamePreflight(source, 'john.smith');
  assert.equal(result.status, 'skipped');
  assert.equal(result.statusCode, 0);
  assert.equal(result.detectionMethod, 'format_check');
  assert.equal(result.evidence.method, 'format_check');
  assert.equal(result.formatReason, source.usernameRule.description);
  assert.deepEqual(result.reasonCodes, ['username_format_incompatible']);
});

test('malformed catalog restrictions fail explicitly', () => {
  assert.throws(() => validateCatalog([{ ...source, usernameRule: { ...source.usernameRule, pattern: '[' } }]),
    /Invalid username rule/);
  assert.throws(() => validateCatalog([{ ...source, usernameRule: { ...source.usernameRule, pattern: '^[$' } }]),
    /Invalid regular expression/);
});

test('the scan separates all incompatible sources before scheduling requests', () => {
  const unknown = { name: 'Unknown', category: 'social', url: 'https://example.test/{}' };
  const plan = planUsernameScan([source, unknown], 'john.smith');
  assert.equal(plan.total, 2);
  assert.deepEqual(plan.queue, [unknown]);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].name, source.name);
  const allSkipped = planUsernameScan([source], 'john.smith');
  assert.equal(allSkipped.queue.length, 0);
  assert.equal(allSkipped.total, allSkipped.skipped.length);
});

test('catalog rules preserve legacy and special account formats instead of applying registration limits', () => {
  const valid = {
    'GitHub': ['john_enterprise', 'SHORTCODE_admin', 'a', 'a'.repeat(39)],
    'X (Twitter)': ['x', 'a'.repeat(15)],
    'GitLab': ['a', 'john.smith', '_legacy'],
    'Reddit': ['a', 'john-smith', 'a'.repeat(30)],
    'PyPI': ['a', 'john.smith', 'john__smith', 'a'.repeat(50)],
    'Snapchat': ['john1', 'john.smith', 'john-smith'],
    'Telegram': ['x', 'john_smith'],
    'Mastodon': ['john_smith'],
    'Dev.to': ['1john', 'john-smith'],
    'RubyGems.org': ['john_smith'],
    'Lobste.rs': ['john-smith'],
    'WordPress.com (Public)': ['1john', 'john-smith', 'legacy_name'],
  };
  for (const [name, users] of Object.entries(valid)) {
    const site = catalog.find(site => site.name === name);
    assert.ok(site.usernameRule, name);
    for (const user of users) assert.equal(incompatibleReason(site, user), null, `${name}: ${user}`);
  }
  for (const name of ['Roblox', 'Twitch', 'YouTube', 'WordPress.org', 'WordPress.org (Forums)']) {
    const site = catalog.find(site => site.name === name);
    assert.equal(site.usernameRule, undefined, `${name}: no registration-only or mismatched-identifier rules`);
  }
});

test('hostname-label sources reject dots while allowing hyphens and legacy underscores', () => {
  for (const site of catalog.filter(site => site.usernameRule?.source.includes('rfc1123'))) {
    assert.equal(incompatibleReason(site, 'john-smith'), null, site.name);
    assert.equal(incompatibleReason(site, 'john_smith'), null, site.name);
    assert.ok(incompatibleReason(site, 'john.smith'), site.name);
  }
});

test('incompatible usernames send no requests and never enter browser or archive fallback', async t => {
  let requests = 0;
  const upstream = http.createServer((req, res) => { requests++; res.end('john.smith'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const url = `http://127.0.0.1:${upstream.address().port}/{}`;
  const result = await probeWithDeadline({ ...source, url, requiresAuth: true, allowBrowserFallback: true },
    'john.smith', 1000).promise;
  assert.equal(result.status, 'skipped');
  assert.equal(requests, 0);
  assert.equal(result.profile, undefined);
});

test('compatible usernames still use the existing network probe', async t => {
  let requests = 0;
  const upstream = http.createServer((req, res) => { requests++; res.end('<h1>John</h1>'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const url = `http://127.0.0.1:${upstream.address().port}/{}`;
  const result = await probeWithDeadline({ ...source, url }, 'John', 10000).promise;
  assert.equal(result.status, 'found');
  assert.equal(requests, 1);
  assert.equal(result.detectionMethod, 'http');
});

test('WordPress Forums requires a profile page, not a signup availability response', () => {
  const wordpress = catalog.find(site => site.name === 'WordPress.org (Forums)');
  assert.equal(wordpress.url, 'https://wordpress.org/support/users/{}/');
  for (const body of [
    '{"available":false,"error":"Usernames can only contain lowercase letters (a-z) and numbers."}',
    '{"available":true}',
    '{"available":false,"error":"That username is already in use."}',
    '<p>The username john does not exist.</p>',
    '<p>That username is not possible.</p>',
    '<p>john</p>',
  ]) {
    assert.equal(classify(wordpress, 'john', wordpress.url, 200, {}, body).status, 'unknown');
  }
  assert.equal(classify(wordpress, 'john', wordpress.url, 200, {},
    '<title>john&#039;s Profile &#124; WordPress.org</title>').status, 'found');
  assert.equal(classify(wordpress, 'pabcdef0123456789', wordpress.url, 404, {}, '').status, 'not_found');
  assert.equal(classify(wordpress, 'john', wordpress.url, 403, {}, '').status, 'blocked');
});
