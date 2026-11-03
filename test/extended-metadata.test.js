'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const metadata = require('../profile-metadata');

test('extended fields are extracted from an identity-bound JSON account object', t => {
  const accountObject = { path: ['user'], identityKey: 'login', fields: {
    followers: 'followers', following: 'following', posts: 'public_repos', verified: 'verified',
    accountId: 'id', lastActive: 'last_seen', contactEmail: 'email' } };
  metadata.setHints({ sites: { X: { accountObject, fields: Object.fromEntries(Object.keys(accountObject.fields).map(f => [f, [{ schema: 'account_json' }]])) } } });
  t.after(() => metadata.setHints(null));
  const body = JSON.stringify({ user: { login: 'alice', followers: 12, following: 3, public_repos: 40, verified: true,
    id: 583231, last_seen: '2026-10-30T12:00:00Z', email: 'Alice@Example.com' } });
  const profile = metadata.extractProfile({ name: 'X', url: 'https://x.test/{}' }, 'alice', body, 'application/json');
  assert.deepEqual(profile, { followers: 12, following: 3, posts: 40, verified: true, accountId: '583231', lastActive: '2026-10-30', contactEmail: 'alice@example.com' });
});

test('extended fields reject unsafe or meaningless values', t => {
  const accountObject = { path: ['user'], identityKey: 'login', fields: { verified: 'verified', accountId: 'id', contactEmail: 'email', following: 'following' } };
  metadata.setHints({ sites: { X: { accountObject, fields: Object.fromEntries(Object.keys(accountObject.fields).map(f => [f, [{ schema: 'account_json' }]])) } } });
  t.after(() => metadata.setHints(null));
  const body = JSON.stringify({ user: { login: 'alice', verified: 'no', id: 'a b<script>', email: 'not-an-email', following: 'many' } });
  assert.equal(metadata.extractProfile({ name: 'X', url: 'https://x.test/{}' }, 'alice', body, 'application/json'), null);
  assert.ok(metadata.FIELDS.includes('contactEmail') && metadata.FIELDS.length === 13);
});
