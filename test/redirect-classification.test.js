'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { probe } = require('../server');

test('redirects without reliable direct evidence abstain instead of becoming found', async t => {
  let loopRequests = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/missing-location') {
      res.writeHead(302);
      res.end();
    } else if (req.url === '/malformed-location') {
      res.writeHead(302, { location: 'http://[' });
      res.end();
    } else if (req.url === '/malformed-whitespace-location') {
      res.writeHead(302, { location: '/invalid location' });
      res.end();
    } else if (req.url === '/loop') {
      loopRequests++;
      res.writeHead(302, { location: '/loop' });
      res.end();
    } else if (req.url === '/login') {
      res.writeHead(302, { location: '/login?next=/alice' });
      res.end();
    } else if (req.url === '/configured-not-found') {
      res.writeHead(302, { location: '/login' });
      res.end();
    } else if (req.url === '/truncated-positive') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('x'.repeat(40000));
    } else if (req.url === '/interrupted-positive') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '100' });
      res.flushHeaders();
      res.write('partial response');
      setTimeout(() => res.socket.destroy(), 250);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const check = (path, overrides = {}) => probe({
    name: path,
    category: 'test',
    url: `${baseUrl}${path}`,
    ...overrides,
  }, 'alice');

  const missingLocation = await check('/missing-location');
  assert.equal(missingLocation.status, 'unknown');
  assert.deepEqual(missingLocation.reasonCodes, ['redirect_location_missing']);

  const malformedLocation = await check('/malformed-location');
  assert.equal(malformedLocation.status, 'unknown');
  assert.deepEqual(malformedLocation.reasonCodes, ['redirect_location_invalid']);

  const malformedWhitespaceLocation = await check('/malformed-whitespace-location');
  assert.equal(malformedWhitespaceLocation.status, 'unknown');
  assert.deepEqual(malformedWhitespaceLocation.reasonCodes, ['redirect_location_invalid']);

  const exhausted = await check('/loop');
  assert.equal(exhausted.status, 'unknown');
  assert.deepEqual(exhausted.reasonCodes, ['redirect_hop_limit']);
  assert.equal(loopRequests, 4);

  const auth = await check('/login');
  assert.equal(auth.status, 'unknown');
  assert.deepEqual(auth.reasonCodes, ['redirect_auth_login']);

  const configuredNotFound = await check('/configured-not-found', { notFoundStatus: 302 });
  assert.equal(configuredNotFound.status, 'not_found');
  assert.deepEqual(configuredNotFound.reasonCodes, ['site_specific_not_found_status']);

  const truncated = await check('/truncated-positive', { positiveMsg: 'PROFILE_MARKER' });
  assert.equal(truncated.status, 'unknown');
  assert.deepEqual(truncated.reasonCodes, ['site_positive_message_missing_incomplete_body']);

  const interrupted = await check('/interrupted-positive', { positiveMsg: 'PROFILE_MARKER' });
  assert.equal(interrupted.status, 'unknown');
  assert.deepEqual(interrupted.reasonCodes, ['site_positive_message_missing_incomplete_body']);
});
