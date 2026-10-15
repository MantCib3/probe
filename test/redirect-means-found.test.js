'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { probeWithDeadline } = require('../server');
const adapter = require('../source-request-adapter');

test('redirectMeansFound is opt-in, validated, and still yields to challenge and auth redirects', async t => {
  assert.throws(() => adapter.validateCatalog([{ name: 'Bad', url: 'https://x/{}', redirectMeansFound: 'yes' }]), /boolean/);
  const upstream = http.createServer((req, res) => {
    const name = req.url.slice(1);
    if (name === 'moved') { res.writeHead(301, { Location: 'https://custom-domain.example/' }); return res.end(); }
    if (name === 'challenged') { res.writeHead(302, { Location: '/cdn-cgi/challenge/x' }); return res.end(); }
    if (name === 'login') { res.writeHead(302, { Location: '/login?next=/login' }); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const base = { name: 'Pub', category: 'test', url: `http://127.0.0.1:${upstream.address().port}/{}`, checkMethod: 'status_code', notFoundStatus: 404 };
  const check = async (site, name) => (await probeWithDeadline(site, name, 5000).promise);

  const plain = await check(base, 'moved');
  assert.notEqual(plain.status, 'found', 'without the flag a cross-host redirect never becomes found');
  const flagged = { ...base, redirectMeansFound: true };
  const moved = await check(flagged, 'moved');
  assert.equal(moved.status, 'found');
  assert.deepEqual(moved.reasonCodes, ['site_redirect_found']);
  assert.equal((await check(flagged, 'missing')).status, 'not_found');
  assert.equal((await check(flagged, 'challenged')).status, 'blocked');
  assert.equal((await check(flagged, 'login')).status, 'unknown');
});
