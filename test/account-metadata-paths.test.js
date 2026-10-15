'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const metadata = require('../profile-metadata');

const restore = t => t.after(() => metadata.setHints(JSON.parse(require('node:fs').readFileSync(require.resolve('../metadata-hints.json'), 'utf8'))));
const rules = fields => Object.fromEntries(Object.keys(fields).map(field => [field, [{ schema: 'account_json' }]]));
const extract = (accountObject, username, value, pageUrl = 'https://x.example/u') => {
  metadata.setHints({ sites: { X: { accountObject, fields: rules(accountObject.fields) } } });
  return metadata.extractProfile({ name: 'X', url: 'https://x.example/{}' }, username, JSON.stringify(value), 'application/json', pageUrl);
};

test('username-keyed maps resolve only one exact key and respect privacy flags', t => {
  restore(t);
  const rule = { path: ['entities', 'user', '{username}'], identityKey: 'username', skipWhenTrue: 'profileUI.isLocked',
    requireTrue: { bio: 'profileUI.showAbout', location: 'profileUI.showLocation' },
    fields: { name: 'name', bio: 'about', location: 'location', links: ['website', 'githubProfile'] } };
  const user = (flags, extra = {}) => ({ entities: { user: { alice: {   username: 'alice', name: 'Alice Smith', about: 'Teacher', location: 'Earth', website: '', githubProfile: 'https://github.com/alice', profileUI: flags, ...extra } } } });
  assert.deepEqual(extract(rule, 'Alice', user({ showAbout: true, showLocation: false })),
  { name: 'Alice Smith', bio: 'Teacher', links: ['https://github.com/alice'] });
  assert.equal(extract(rule, 'alice', user({ isLocked: true, showAbout: true, showLocation: true })), null, 'locked profiles yield nothing');
  assert.equal(extract(rule, 'bob', user({ showAbout: true })), null);
  const ambiguous = { entities: { user: { alice: { username: 'alice', name: 'A' }, ALICE: { username: 'ALICE', name: 'B' } } } };
  assert.equal(extract(rule, 'alice', ambiguous), null, 'case-colliding keys abstain');
});

test('nested key paths read only the selected account', t => {
  restore(t);
  const rule = { path: ['data', 'User'], identityKey: 'name', fields: { picture: 'avatar.large', joined: 'registered.unixtime', bio: 'summaries.0.content' } };
  assert.deepEqual(extract(rule, 'alice', { data: { User: { name: 'alice', avatar: { large: 'https://cdn.example/a.png' }, registered: { unixtime: '1609459200' }, summaries: [{ content: 'Hello there' }] } } }),
    { picture: 'https://cdn.example/a.png', bio: 'Hello there', joined: '2021-01-01' });
  assert.equal(extract(rule, 'alice', { data: { User: null } }), null);
  assert.equal(extract(rule, 'alice', { data: { User: { name: 'bob', avatar: { large: 'https://cdn.example/b.png' } } } }), null);
});

test('MediaWiki identity normalisation accepts underscores and first-letter case only', t => {
  restore(t);
  const rule = { path: ['query', 'users'], identityKey: 'name', identityNormalization: 'mediawiki', fields: { joined: 'registration' } };
  const body = { query: { users: [{ name: 'Drew Dietsch', registration: '2016-06-18T04:58:08Z' }] } };
  assert.deepEqual(extract(rule, 'Drew_Dietsch', body), { joined: '2016-06-18' });
  assert.deepEqual(extract(rule, 'drew_Dietsch', body), { joined: '2016-06-18' });
  assert.equal(extract(rule, 'drew_dietsch', body), null, 'later characters stay case-sensitive');
  assert.equal(extract(rule, 'Someone', { query: { users: [{ name: 'Someone', missing: '' }] } }), null);
});

test('unsafe or malformed rules are rejected rather than partially applied', t => {
  restore(t);
  for (const bad of [
    { path: [], identityKey: 'u', fields: { name: '__proto__.x' } },
    { path: [], identityKey: 'u', fields: { bio: ['a', 'b'] } },
    { path: [], identityKey: 'u', fields: { name: 'n' }, requireTrue: { name: 'constructor' } },
    { path: [], identityKey: 'u', fields: { name: 'n' }, identityNormalization: 'loose' },
  ]) assert.equal(extract(bad, 'alice', { u: 'alice', n: 'Alice' }), null);
});

test('reviewed-unreliable picture fields are not extracted for freeCodeCamp or Duolingo', () => {
  const hints = JSON.parse(require('node:fs').readFileSync(require.resolve('../metadata-hints.json'), 'utf8')).sites;
  assert.equal(hints.freeCodeCamp.fields.picture, undefined);
  assert.equal(hints.freeCodeCamp.accountObject.fields.picture, undefined);
  assert.equal(hints.Duolingo.fields.picture, undefined);
});
