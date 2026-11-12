'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { probeWithDeadline } = require('../server');
const { validateCatalog } = require('../source-request-adapter');
const { MAX_BODY, PROBE_DEADLINE_MS } = require('../lib/config');

// /u/<name> redirects to an ID-based page whose markup names its owner.
async function idRedirectServer(t, pages) {
  const server = http.createServer((req, res) => {
    const match = req.url.match(/^\/u\/([a-z0-9]+)$/);
    if (match) {
      if (!pages[match[1]]) {
        res.writeHead(302, { location: '/' });
        return res.end();
      }
      res.writeHead(302, { location: `/id/${match[1].length}` });
      return res.end();
    }
    const id = req.url.match(/^\/id\/(\d+)$/);
    const owner = id && Object.keys(pages).find(name => String(name.length) === id[1]);
    if (owner) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(pages[owner]);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

const marker = '<meta property="profile:username" content="{}">';
const source = (port, extra = {}) => ({
  name: 'ID redirect source', category: 'test', url: `http://127.0.0.1:${port}/u/{}`, ...extra,
});

test('a reviewed identity marker keeps a found verdict after an ID-based redirect', async t => {
  const port = await idRedirectServer(t, { alice: '<meta property="profile:username" content="alice"><h1>alice</h1>' });
  const result = await probeWithDeadline(source(port, { redirectIdentityMarker: marker }), 'alice', PROBE_DEADLINE_MS).promise;
  assert.equal(result.status, 'found');
  assert.deepEqual(result.reasonCodes, ['body_guard_username_match', 'site_redirect_identity_marker']);
  assert.deepEqual(result.evidence.reasons, result.reasonCodes);
});

test('the identity marker is matched case-insensitively against the requested name', async t => {
  const port = await idRedirectServer(t, { alice: '<META property="profile:username" content="Alice"><h1>Alice</h1>' });
  const result = await probeWithDeadline(source(port, { redirectIdentityMarker: marker }), 'alice', PROBE_DEADLINE_MS).promise;
  assert.equal(result.status, 'found');
});

test('without a configured marker the ID-based redirect still abstains', async t => {
  const port = await idRedirectServer(t, { alice: '<meta property="profile:username" content="alice"><h1>alice</h1>' });
  const result = await probeWithDeadline(source(port), 'alice', PROBE_DEADLINE_MS).promise;
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.reasonCodes, ['redirect_profile_identity_lost']);
});

test('a destination that names a different owner still abstains', async t => {
  const port = await idRedirectServer(t, { alice: '<meta property="profile:username" content="alicea"><p>friend of alice</p>' });
  const result = await probeWithDeadline(source(port, { redirectIdentityMarker: marker }), 'alice', PROBE_DEADLINE_MS).promise;
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.reasonCodes, ['redirect_profile_identity_lost']);
});

test('a marker beyond the classification window does not prove identity', async t => {
  const page = `<h1>alice</h1>${' '.repeat(MAX_BODY + 1024)}<meta property="profile:username" content="alice">`;
  const port = await idRedirectServer(t, { alice: page });
  const result = await probeWithDeadline(source(port, { redirectIdentityMarker: marker }), 'alice', PROBE_DEADLINE_MS).promise;
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.reasonCodes, ['redirect_profile_identity_lost']);
});

test('a redirect to the site root is not_found with an explicit reason code', async t => {
  const port = await idRedirectServer(t, {});
  const result = await probeWithDeadline(source(port), 'nobody', PROBE_DEADLINE_MS).promise;
  assert.equal(result.status, 'not_found');
  assert.deepEqual(result.reasonCodes, ['redirect_to_site_root']);
});

test('catalog validation only accepts specific identity markers', () => {
  const site = redirectIdentityMarker => ({ name: 'Marker', url: 'https://example.test/{}', redirectIdentityMarker });
  assert.doesNotThrow(() => validateCatalog([site(marker)]));
  for (const bad of ['{}', 'id="{}"', 'content="{}" and "{}"', 'no placeholder here', 42]) {
    assert.throws(() => validateCatalog([site(bad)]), /redirectIdentityMarker/, String(bad));
  }
});
