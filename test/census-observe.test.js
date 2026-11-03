'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyLocation, observe, registrableDomain } = require('../tools/census-observe');

const fake = (status, text, headers = {}) => async () => {
  const real = new Response(text, { headers });
  return { status, headers: real.headers, body: real.body };
};

test('registrable domains handle common two-level suffixes', () => {
  assert.equal(registrableDomain('old.reddit.com'), 'reddit.com');
  assert.equal(registrableDomain('api.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('skeb.jp'), 'skeb.jp');
});

test('redirect targets are classified without trusting the source', () => {
  const from = 'https://www.example.com/user/alice';
  assert.equal(classifyLocation('/accounts/login/?next=/user/alice', from, 'alice'), 'login');
  assert.equal(classifyLocation('https://example.com/', from, 'alice'), 'home');
  assert.equal(classifyLocation('/.within.website/?redir=x', from, 'alice'), 'challenge');
  assert.equal(classifyLocation('/account-deleted', from, 'alice'), 'not_found_page');
  assert.equal(classifyLocation('https://au.example.com/user/alice', from, 'alice'), 'same_identity');
  assert.equal(classifyLocation('https://elsewhere.net/x', from, 'alice'), 'offsite');
  assert.equal(classifyLocation(null, from, 'alice'), null);
});

test('anti-bot vendors are fingerprinted from status, headers and markers', async () => {
  const cases = [
    [fake(403, '<title>Just a moment...</title>', { 'cf-mitigated': 'challenge' }), 'cloudflare_challenge'],
    [fake(403, '<title>Attention Required! | Cloudflare</title>'), 'cloudflare_block'],
    [fake(403, '<script src="https://geo.captcha-delivery.com/x"></script>'), 'datadome'],
    [fake(403, '<title>It needs a human touch</title><div id="px-captcha">'), 'perimeterx'],
    [fake(202, '<script>window.gokuProps={}</script>', { 'x-amzn-waf-action': 'challenge' }), 'aws_waf'],
    [fake(999, ''), 'linkedin_999'],
    [fake(429, 'slow down', { 'retry-after': '60' }), 'rate_limited'],
    [fake(403, 'nope', { server: 'cloudflare' }), 'cloudflare_403'],
    [fake(200, '<title>alice - Example</title>'), null],
  ];
  for (const [fetchImpl, vendor] of cases) {
    assert.equal((await observe({ url: 'https://example.com/alice', username: 'alice', fetchImpl })).vendor, vendor);
  }
});

test('observations carry structured signals and never the body', async () => {
  const html = '<html><head><title>Alice (alice) | Example</title><link rel="canonical" href="https://example.com/alice">' +
    '<meta property="og:title" content="Alice"><script type="application/ld+json">{"@type":"ProfilePage"}</script></head><body>secret alice</body></html>';
  const result = await observe({ url: 'https://example.com/alice', username: 'Alice', fetchImpl: fake(200, html, { 'content-type': 'text/html' }) });
  assert.equal(result.status, 200);
  assert.equal(result.usernameInTitle, true);
  assert.equal(result.usernameInCanonical, true);
  assert.deepEqual(result.jsonLdTypes, ['ProfilePage']);
  assert.ok(result.usernameMentions >= 3);
  assert.ok(!JSON.stringify(result).includes('secret'));
  const json = await observe({ url: 'https://example.com/api/alice', username: 'alice', fetchImpl: fake(200, '{"user":{"login":"alice"}}', { 'content-type': 'application/json' }) });
  assert.equal(json.json.usernameValue, true);
  const empty = await observe({ url: 'https://example.com/api/x', username: 'x', fetchImpl: fake(200, '{"data":null}', { 'content-type': 'application/json' }) });
  assert.equal(empty.json.emptyish, true);
  const failed = await observe({ url: 'https://example.com/x', username: 'x', fetchImpl: async () => { throw new Error('boom'); } });
  assert.equal(failed.status, 0);
});
