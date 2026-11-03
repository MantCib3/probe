'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const metadata = require('../profile-metadata');

const site = { name: 'X', url: 'https://x.test/{}' };
const run = (hint, body, username = 'alice') => metadata.extractWith(hint, site, username, body, 'text/html');

test('embedded app state is read from a script element or a JS assignment, identity-bound', () => {
  const fields = { name: 'displayName', followers: 'stats.followers', accountId: 'id' };
  const rules = { name: [{ schema: 'account_json' }], followers: [{ schema: 'account_json' }], accountId: [{ schema: 'account_json' }] };
  const state = { props: { user: { handle: 'alice', displayName: 'Alice Smith', id: 'u_1', stats: { followers: 1200 } } } };
  const fromScript = { accountObject: { source: { script: 'script#__NEXT_DATA__' }, path: ['props', 'user'], identityKey: 'handle', fields }, fields: rules };
  assert.deepEqual(run(fromScript, `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script>`), { name: 'Alice Smith', followers: 1200, accountId: 'u_1' });
  const fromAssignment = { ...fromScript, accountObject: { ...fromScript.accountObject, source: { assignment: 'window.__INITIAL_STATE__' } } };
  assert.deepEqual(run(fromAssignment, `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};var x={};</script>`), { name: 'Alice Smith', followers: 1200, accountId: 'u_1' });
  const encoded = `<script>window.__INITIAL_STATE__ = JSON.parse(${JSON.stringify(JSON.stringify(state))});</script>`;
  assert.deepEqual(run(fromAssignment, encoded), { name: 'Alice Smith', followers: 1200, accountId: 'u_1' });
  assert.equal(run(fromAssignment, encoded, 'bob'), null, 'a different account object never leaks');
  assert.equal(run(fromAssignment, '<p>no state</p>'), null);
});

test('page rules need the username in the identity element and read selector, attribute and pattern', () => {
  const hint = { page: {
    identity: { selector: '.handle', pattern: '@?([\\w.-]+)' },
    fields: {
      name: { selector: 'h1.name' }, picture: { selector: 'img.avatar', attr: 'src' },
      followers: { selector: '.stats li', pattern: '([\\d.,]+[KkMm]?)\\s+followers' },
      joined: { selector: '.joined', pattern: 'Joined (.+)' }, verified: { selector: '.badge-verified', present: true },
      links: { selector: '.links a', attr: 'href', all: true },
    } },
    fields: Object.fromEntries(['name', 'picture', 'followers', 'joined', 'verified', 'links'].map(f => [f, [{ schema: 'page_dom' }]])) };
  const page = handle => `<div class="handle">@${handle}</div><h1 class="name">Alice A</h1><img class="avatar" src="https://cdn.x.test/a.jpg">
    <ul class="stats"><li>1.2K followers</li></ul><span class="joined">Joined March 2019</span><i class="badge-verified"></i>
    <div class="links"><a href="https://alice.dev">site</a><a href="/local">x</a></div>`;
  assert.deepEqual(run(hint, page('alice')), { picture: 'https://cdn.x.test/a.jpg', name: 'Alice A', links: ['https://alice.dev/'], joined: '2019-03-01', followers: 1200, verified: true });
  assert.equal(run(hint, page('someoneelse')), null, 'identity mismatch yields nothing');
  assert.equal(run(hint, '<h1 class="name">Sign in</h1>'), null, 'no identity element yields nothing');
});

test('invalid page and source rules are rejected', () => {
  assert.throws(() => metadata.validatePageRule({ fields: {} }), /Invalid page/);
  assert.throws(() => metadata.validatePageRule({ identity: { selector: '.h' }, fields: { followers: { selector: '.f', pattern: '(' } } }), /Invalid page/);
  assert.throws(() => metadata.validatePageRule({ identity: { selector: '.h' }, fields: { name: { selector: '.n', present: true } } }), /Invalid page/);
  const bad = { accountObject: { source: { assignment: 'a;alert(1)' }, path: [], identityKey: 'login', fields: { name: 'name' } }, fields: { name: [{ schema: 'account_json' }] } };
  assert.equal(run(bad, '<script>a;alert(1) = {"login":"alice","name":"A"}</script>'), null);
});
