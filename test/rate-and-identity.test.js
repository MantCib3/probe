'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const server = require('../server');
const adapter = require('../source-request-adapter');

test('scan slots are reserved synchronously, capped, and refundable', () => {
  const ip = `203.0.113.${Math.floor(Math.random() * 200)}`;
  for (let i = 0; i < server.RATE_LIMIT_MAX; i++) assert.equal(server.reserveScanSlot(ip), true);
  assert.equal(server.reserveScanSlot(ip), false, 'parallel requests cannot exceed the cap before Turnstile resolves');
  server.refundScanSlot(ip);
  assert.equal(server.reserveScanSlot(ip), true);
  assert.equal(server.reserveScanSlot(ip), false);
});

test('global capacity queues in order, honours cancellation and bounds the queue', async () => {
  const held = [];
  for (let i = 0; i < server.MAX_ACTIVE_SCANS; i++) {
    const slot = server.acquireScanCapacity(() => assert.fail('should not queue'));
    assert.equal(await slot.ready, true);
    held.push(slot);
  }
  const positions = [];
  const first = server.acquireScanCapacity(position => positions.push(position));
  const cancelled = server.acquireScanCapacity(position => positions.push(position));
  const third = server.acquireScanCapacity(position => positions.push(position));
  assert.deepEqual(positions, [1, 2, 3]);
  cancelled.cancel();
  assert.equal(await cancelled.ready, false);
  server.releaseScanCapacity();
  assert.equal(await first.ready, true);
  server.releaseScanCapacity();
  assert.equal(await third.ready, true);
  const extra = [];
  for (let i = 0; i < server.MAX_QUEUED_SCANS; i++) extra.push(server.acquireScanCapacity(() => {}));
  assert.equal(server.acquireScanCapacity(() => {}), null, 'queue is bounded');
  extra.forEach(slot => slot.cancel());
  for (let i = 0; i < server.MAX_ACTIVE_SCANS; i++) server.releaseScanCapacity();
  const after = server.acquireScanCapacity(() => assert.fail('capacity was not restored'));
  assert.equal(await after.ready, true);
  server.releaseScanCapacity();
});

test('repeated blocks cool a source down; a decision clears it; abstentions do not count', () => {
  const site = { name: `Cooldown${Math.random()}`, category: 'test', url: 'https://example.com/{}' };
  for (let i = 1; i < server.SOURCE_COOLDOWN_THRESHOLD; i++) {
    server.recordSourceHealth(site, { status: 'blocked' });
    server.recordSourceHealth(site, { status: 'unknown' });
    assert.equal(server.sourceCooldownResult(site, 'alice'), null);
  }
  server.recordSourceHealth(site, { status: 'blocked' });
  const cooled = server.sourceCooldownResult(site, 'alice');
  assert.equal(cooled.status, 'blocked');
  assert.deepEqual(cooled.reasonCodes, ['source_cooldown']);
  assert.equal(cooled.url, 'https://example.com/alice');
  server.recordSourceHealth(site, { status: 'not_found' });
  assert.equal(server.sourceCooldownResult(site, 'alice'), null);
});

test('long Retry-After values are detected instead of capped into an early retry', () => {
  assert.equal(server.requestedRetryDelayMs({}), 0);
  assert.equal(server.requestedRetryDelayMs({ 'retry-after': '2' }), 2000);
  assert.equal(server.requestedRetryDelayMs({ 'retry-after': '120' }), 120000);
  assert.ok(server.requestedRetryDelayMs({ 'retry-after': new Date(Date.now() + 60000).toUTCString() }) > 5000);
});

test('honest user agents drop browser-only client hints; browser defaults keep them', () => {
  const parsed = new URL('https://example.com/u/alice');
  const honest = server.makeReqOptions(parsed, null, new Map(), null, { method: 'GET', headers: { 'user-agent': adapter.HONEST_USER_AGENT } });
  const names = Object.keys(honest.headers).map(name => name.toLowerCase());
  assert.equal(honest.headers['user-agent'], adapter.HONEST_USER_AGENT);
  assert.ok(!names.some(name => name.startsWith('sec-ch-ua') || name.startsWith('sec-fetch-') || name === 'upgrade-insecure-requests'));
  const browser = server.makeReqOptions(parsed, null, new Map(), null);
  assert.ok(Object.keys(browser.headers).includes('sec-ch-ua'));
});

test('credentials are validated, environment-only and limited to their HTTPS host', () => {
  const base = { name: 'Cred', url: 'https://example.com/{}', apiUrl: 'https://api.example.com/users/{}' };
  const good = { ...base, credential: { env: 'EXAMPLE_TOKEN', host: 'api.example.com', header: 'authorization', scheme: 'Bearer' } };
  adapter.validateCatalog([good]);
  for (const credential of [
    { env: 'lower', host: 'api.example.com', header: 'authorization' },
    { env: 'EXAMPLE_TOKEN', host: 'other.example.com', header: 'authorization' },
    { env: 'EXAMPLE_TOKEN', host: 'api.example.com', header: 'cookie' },
    { env: 'EXAMPLE_TOKEN', host: 'api.example.com', header: 'authorization', query: 'key' },
    { env: 'EXAMPLE_TOKEN', host: 'api.example.com', value: 'inline-secret', header: 'authorization' },
    { env: 'EXAMPLE_TOKEN', host: 'api.example.com', header: 'authorization', overrides: { url: 'https://evil.example/{}' } },
  ]) assert.throws(() => adapter.validateCatalog([{ ...base, credential }]), /credential/);
  assert.equal(adapter.withCredential(good, {}), good, 'missing key leaves the source unchanged');
  const resolved = adapter.withCredential(good, { EXAMPLE_TOKEN: 'secret-value' });
  assert.equal(resolved.resolvedCredential.value, 'secret-value');
  const config = { method: 'GET', headers: {} };
  Object.defineProperty(config, 'credential', { value: resolved.resolvedCredential, enumerable: false });
  assert.equal(server.makeReqOptions(new URL('https://api.example.com/users/a'), null, new Map(), null, config).headers.authorization, 'Bearer secret-value');
  assert.equal(server.makeReqOptions(new URL('https://cdn.example.com/a'), null, new Map(), null, config).headers.authorization, undefined);
  assert.equal(server.makeReqOptions(new URL('http://api.example.com/users/a'), null, new Map(), null, config).headers.authorization, undefined);
  assert.equal(JSON.stringify(config), JSON.stringify({ method: 'GET', headers: {} }), 'credential is not serialisable with the request');
});

test('credentials are never sent over plain HTTP and never appear in results', async t => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ url: req.url, authorization: req.headers.authorization || null });
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const port = upstream.address().port;
  const site = { name: 'CredLocal', category: 'test', url: `http://127.0.0.1:${port}/{}`, checkMethod: 'status_code',
    credential: { env: 'LOCAL_TOKEN', host: '127.0.0.1', header: 'authorization', scheme: 'Bearer' } };
  process.env.LOCAL_TOKEN = 'never-sent-over-http';
  t.after(() => { delete process.env.LOCAL_TOKEN; });
  const result = await server.probeWithDeadline(site, 'alice', 5000).promise;
  assert.equal(received[0].authorization, null, 'plain HTTP never receives credentials');
  assert.ok(!JSON.stringify(result).includes('never-sent-over-http'));
});
