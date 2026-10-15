'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { probeWithDeadline } = require('../server');
const catalog = require('../sites.json');

test('HN query selects bounded profile keys and preserves three positive and three missing decisions', async t => {
  const site = catalog.find(candidate => candidate.name === 'Hacker News');
  const endpoint = new URL(site.apiUrl.replace('{}', 'pg'));
  assert.equal(endpoint.origin, 'https://hacker-news.firebaseio.com');
  assert.equal(endpoint.pathname, '/v0/user/pg.json');
  assert.equal(endpoint.searchParams.get('orderBy'), '"$key"');
  assert.equal(endpoint.searchParams.get('startAt'), '"about"');
  assert.equal(endpoint.searchParams.get('endAt'), '"id"');
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    assert.equal(url.search, endpoint.search);
    const username = url.pathname.split('/').pop().replace(/\.json$/, '');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Connection', 'close');
    if (username.startsWith('absent')) return res.end('{}');
    res.end(JSON.stringify({ about: 'Account bio', created: 1609459200, id: username }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const fixture = { ...site, url: `${base}/user?id={}`, apiUrl: `${base}/v0/user/{}.json${endpoint.search}` };
  for (const username of ['account1', 'account2', 'account3', 'absent1', 'absent2', 'absent3']) {
    const result = await probeWithDeadline(fixture, username, 15000).promise;
    assert.equal(result.status, username.startsWith('absent') ? 'not_found' : 'found', JSON.stringify(result));
    assert.deepEqual(result.profile, username.startsWith('absent') ? undefined : { bio: 'Account bio', joined: '2021-01-01' });
  }
});
