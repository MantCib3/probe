'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

async function startUpstream(t) {
  const upstream = http.createServer((req, res) => setTimeout(() => { res.writeHead(404); res.end(); }, 700));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  return upstream.address().port;
}

async function startProbe(t, upstreamPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-scan-'));
  const catalog = path.join(dir, 'sites.json');
  fs.writeFileSync(catalog, JSON.stringify([{ name: 'Local', category: 'test', url: `http://127.0.0.1:${upstreamPort}/u/{}`, checkMethod: 'status_code' }]));
  const env = { ...process.env, PORT: '0', NODE_ENV: 'test', RENDER: '', PROBE_SITES_PATH: catalog, MAX_ACTIVE_SCANS: '1', TURNSTILE_SECRET: '' };
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 60000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
  });
}

// Streams one scan, resolving with its events; `until` may stop early.
function scan(base, username, { signal, until } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(`${base}/api/check?username=${username}`, res => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));
          events.push(event);
          if (until && until(event)) { req.destroy(); return resolve(events); }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', error => (signal?.aborted || error.code === 'ECONNRESET' ? resolve(events) : reject(error)));
    signal?.addEventListener('abort', () => req.destroy(), { once: true });
  });
}

test('public scans queue beyond capacity, release on cancel, and enforce the hourly cap', async t => {
  const base = await startProbe(t, await startUpstream(t));

  const first = scan(base, 'alice');
  await new Promise(resolve => setTimeout(resolve, 150));
  const second = await scan(base, 'bob');
  const firstEvents = await first;
  assert.equal(firstEvents.at(-1).type, 'done');
  assert.equal(second[0].type, 'queued');
  assert.equal(second[0].position, 1);
  assert.deepEqual(second.filter(e => e.type !== 'result').map(e => e.type), ['queued', 'start', 'done']);

  const holder = scan(base, 'carol');
  await new Promise(resolve => setTimeout(resolve, 150));
  const queued = await scan(base, 'dave', { until: event => event.type === 'queued' });
  assert.equal(queued[0].type, 'queued', 'cancelled while waiting');
  await holder;
  const afterCancel = await scan(base, 'erin');
  assert.equal(afterCancel[0].type, 'start', 'a cancelled waiter does not leak capacity');

  // Five scans so far (the cancelled waiter consumed its slot); five more are allowed.
  for (let i = 0; i < 5; i++) assert.equal((await scan(base, `user${i}`)).at(-1).type, 'done');
  const limited = await scan(base, 'zed');
  assert.equal(limited[0].type, 'error');
  assert.equal(limited[0].code, 429);
});
