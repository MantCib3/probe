'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isPrivateHost } = require('../server');
const { validateCatalog } = require('../source-request-adapter');

test('SSRF guard blocks IP literals that skip DNS lookup, in every spelling', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', '0.0.0.0', '10.1.2.3', '169.254.169.254', '[::1]', '::1',
    '[::ffff:127.0.0.1]', '[fe80::1]', 'localhost', 'localhost.', 'a.localhost', 'printer.local', '']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['93.184.216.34', 'example.com', '[2606:4700::1111]']) assert.equal(isPrivateHost(host), false, host);
  assert.equal(isPrivateHost(new URL('http://2130706434/').hostname), true, 'decimal IPv4 normalises to 127.0.0.2');
});

test('catalog rejects borrowed crawler identities', () => {
  assert.throws(() => validateCatalog([{ name: 'X', url: 'https://x.test/{}', crawlerUA: 'googlebot' }]), /crawlerUA/);
});

test('the live catalog presents no crawler identity', () => {
  const sites = require('../sites.json').filter(site => !site.defunct);
  assert.deepEqual(sites.filter(site => site.crawlerUA !== undefined).map(site => site.name), []);
});
