'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sites = require('../sites.json');
const { classify } = require('../lib/classifier');

for (const name of ['Tellonym', 'HackerOne', '247CTF']) {
  const site = sites.find(item => item.name === name);
  const check = (status, body = '', headers = {}) => classify(site, 'alice',
    site.url.replace('{}', 'alice'), status, headers, body, 'http');
  test(`${name}: restored detection preserves positive, missing and challenge outcomes`, () => {
    assert.ok(!site.undetectable);
    assert.equal(check(200, `<html><head><title>alice</title></head><body>${site.positiveMsg}alice</body></html>`).status, 'found');
    assert.equal(check(404, 'Not found').status, 'not_found');
    assert.equal(check(403, 'Cloudflare challenge').status, 'blocked');
    assert.equal(check(200, '<title>Just a moment</title>window._cf_chl_opt').status, 'blocked');
    assert.notEqual(check(200, '<title>Generic page</title>alice').status, 'found');
  });
}

test('known unreliable sources stay manual rather than misclassify challenges or reflected names', () => {
  for (const name of ['Spotify', 'Anime-Planet', 'Playstation Network', 'TF2 Backpack Examiner']) {
    assert.equal(sites.find(item => item.name === name).undetectable, true, name);
  }
});
