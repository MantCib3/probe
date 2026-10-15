'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const metadata = require('../profile-metadata');
const { withProfile } = require('../server');

const site = name => ({ name, url: 'https://example.com/{}' });
const extract = (name, username, value) =>
  metadata.extractProfile(site(name), username, JSON.stringify(value), 'application/json', `https://example.com/${username}`);

test('GitHub extracts reviewed root fields, including bio and explicit website', () => {
  assert.deepEqual(extract('GitHub', 'alice', {
    login: 'alice', name: 'Alice Smith', bio: 'Builds useful things', blog: 'https://alice.example/',
    avatar_url: 'https://cdn.example/alice.png', followers: 0, created_at: '2020-01-01T00:00:00Z',
    recommended: { login: 'alice', name: 'Wrong richer object', bio: 'Wrong', location: 'Wrong' },
  }), {
    picture: 'https://cdn.example/alice.png', name: 'Alice Smith', bio: 'Builds useful things',
    links: ['https://alice.example/'], joined: '2020-01-01', followers: 0,
  });
});

test('GitHub mismatch, generic data and nested matching recommendations cannot yield fields', () => {
  for (const value of [
    { login: 'bob', name: 'Bob', bio: 'Someone else', recommended: { login: 'alice', name: 'Alice Smith' } },
    { name: 'Alice Smith', bio: 'No identity' },
    { data: { login: 'alice', name: 'Alice Smith' } },
    null,
  ]) assert.equal(extract('GitHub', 'alice', value), null);
});

test('GitHub missing fields stay absent and relative websites are not invented', () => {
  assert.equal(extract('GitHub', 'alice', { login: 'alice', name: null, blog: 'alice.example' }), null);
  assert.deepEqual(extract('GitHub', 'ALICE', { login: 'alice', bio: 'Public bio' }), { bio: 'Public bio' });
});

test('GitLab selects one exact array account, not a richer recommended user', () => {
  assert.deepEqual(extract('GitLab', 'alice', [
    { username: 'bob', name: 'Bob Smith', avatar_url: 'https://cdn.example/bob.png' },
    { username: 'alice', name: 'Alice Smith', recommended: { username: 'alice', name: 'Wrong' } },
  ]), { name: 'Alice Smith' });
  assert.equal(extract('GitLab', 'alice', [{ username: 'bob', name: 'Bob Smith' }]), null);
  assert.equal(extract('GitLab', 'alice', [
    { username: 'alice', name: 'Alice Smith' }, { username: 'alice', name: 'Conflicting Alice' },
  ]), null);
  assert.equal(extract('GitLab', 'alice', []), null);
});

test('Hacker News requires the exact case-sensitive root id and reads only its about links', () => {
  assert.deepEqual(extract('Hacker News', 'alice', {
    id: 'alice', about: 'Maker <a href="https://alice.example/">website</a> <a href="javascript:alert(1)">bad</a>',
    created: 1609459200, recommendations: { id: 'alice', about: '<a href="https://wrong.example/">wrong</a>' },
  }), { bio: 'Maker website bad', links: ['https://alice.example/'], joined: '2021-01-01' });
  assert.equal(extract('Hacker News', 'Alice', { id: 'alice', about: 'Wrong case' }), null);
  assert.equal(extract('Hacker News', 'alice', { id: 'bob', about: 'Other user', child: { id: 'alice', about: 'Nested' } }), null);
});

test('metadata identity failure does not downgrade a confirmed existence verdict', () => {
  const found = { status: 'found', statusCode: 200, reasonCodes: ['fixture'], url: 'https://github.com/alice' };
  const result = withProfile(found, site('GitHub'), 'alice', '{"login":"bob","bio":"Not Alice"}', 'application/json');
  assert.equal(result.status, 'found');
  assert.equal(result.profile, undefined);
});
