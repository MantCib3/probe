'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { probeWithDeadline } = require('../server');
const catalog = require('../sites.json');
const adapter = require('../source-request-adapter');

test('Codeberg identifies PROBE honestly while preserving positive, missing and challenge handling', async t => {
  const site = catalog.find(candidate => candidate.name === 'Codeberg');
  adapter.validateCatalog([site]);
  assert.equal(site.apiUrl, 'https://codeberg.org/api/v1/users/{}');
  assert.equal(site.requestAdapter.headers['User-Agent'], 'PROBE/1.0 (+https://usernameprobe.com)');
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers['user-agent'], site.requestAdapter.headers['User-Agent']);
    const username = req.url.split('/').pop();
    if (username === 'challenge') {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      return res.end('<title>Access denied</title>');
    }
    res.setHeader('Content-Type', 'application/json');
    if (username.startsWith('absent')) {
      res.writeHead(404);
      return res.end('{"message":"user does not exist"}');
    }
    res.end(JSON.stringify({ id: 42, login: username, username, full_name: 'Fixture Account' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const fixture = { ...site, url: `${base}/{}`, apiUrl: `${base}/api/v1/users/{}` };
  for (const username of ['account1', 'account2', 'account3', 'absent1', 'absent2', 'absent3', 'challenge']) {
    const result = await probeWithDeadline(fixture, username, 5000).promise;
    assert.equal(result.status, username === 'challenge' ? 'blocked' : username.startsWith('absent') ? 'not_found' : 'found', username);
    assert.deepEqual(result.profile, username.startsWith('account') ? { name: 'Fixture Account' } : undefined, username);
  }
});
