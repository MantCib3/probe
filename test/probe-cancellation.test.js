'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { probeWithDeadline } = require('../server');

test('a probe deadline closes its active HTTP request', async t => {
  let requestClosed;
  const closed = new Promise(resolve => { requestClosed = resolve; });
  const upstream = http.createServer((req, res) => {
    req.on('close', requestClosed);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const { port } = upstream.address();
  const activeProbe = probeWithDeadline({
    name: 'Delayed source',
    category: 'test',
    url: `http://127.0.0.1:${port}/user/{}`,
  }, 'alice', 250);

  const result = await activeProbe.promise;
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream request remained open')), 1000)),
  ]);

  assert.equal(result.status, 'timeout');
  assert.equal(result.statusCode, 0);
  assert.deepEqual(result.reasonCodes, ['probe_timeout']);
});

test('a host-based profile follows a protocol redirect instead of treating the root as missing', async t => {
  const upstream = http.createServer((req, res) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      res.writeHead(301, { location: `http://127.0.0.1:${upstream.address().port}/` });
      res.end();
      return;
    }
    res.end('alice');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const { port } = upstream.address();
  let requestCount = 0;
  upstream.removeAllListeners('request');
  upstream.on('request', (req, res) => {
    requestCount++;
    if (requestCount === 1) {
      res.writeHead(301, { location: `http://127.0.0.1:${port}/` });
      res.end();
      return;
    }
    res.end('alice');
  });

  const result = await probeWithDeadline({
    name: 'Host profile',
    category: 'test',
    url: `http://127.0.0.1:${port}/`,
  }, 'alice', 3000).promise;

  assert.equal(result.status, 'found');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.reasonCodes, ['body_guard_username_match']);
});