'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const adapter = require('../source-request-adapter');
const catalog = require('../sites.json');

test('the empty predicate tests only emptiness and is the only root-level predicate', () => {
  const site = name => catalog.find(entry => entry.name === name && !entry.defunct);
  const osu = adapter.withCredential(site('osu!'), { OSU_API_KEY: 'k' }).requestAdapter;
  assert.deepEqual(adapter.classifyJsonResponse(osu, '[]'), { status: 'not_found', reason: 'adapter_json_negative' });
  assert.deepEqual(adapter.classifyJsonResponse(osu, '[{"user_id":"2","username":"peppy"}]'), { status: 'found', reason: 'adapter_json_positive' });
  // An invalid key or error object must abstain, never read as "missing".
  assert.equal(adapter.classifyJsonResponse(osu, '{"error":"Please provide a valid API key."}').status, 'unknown');
  assert.equal(adapter.classifyJsonResponse(osu, '{}').status, 'not_found', 'an empty object is also empty');
  const base = { name: 'Root', url: 'https://x/{}', requestAdapter: { method: 'GET', response: { json: { positive: { path: '', op: 'exists' } } } } };
  assert.throws(() => adapter.validateCatalog([base]), /non-root/);
});

test('osu! and Trakt keys stay inert until configured and are scoped to their API hosts', () => {
  for (const [name, env, host] of [['osu!', 'OSU_API_KEY', 'osu.ppy.sh'], ['Trakt.tv', 'TRAKT_CLIENT_ID', 'api.trakt.tv']]) {
    const site = catalog.find(entry => entry.name === name && !entry.defunct);
    assert.equal(site.credential.env, env);
    assert.equal(site.credential.host, host);
    assert.equal(adapter.withCredential(site, {}), site, `${name} without a key keeps its unkeyed definition`);
    const keyed = adapter.withCredential(site, { [env]: 'secret' });
    assert.equal(new URL(keyed.apiUrl.replace('{}', 'x')).hostname, host);
  }
  assert.equal(catalog.find(entry => entry.name === 'Trakt.tv').credential.header, 'trakt-api-key');
});
