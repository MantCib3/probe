'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const test = require('node:test');

test('static routes expose only required frontend bundles, not source scripts or maps', async t => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', RENDER: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  let output = '';
  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Preview failed to start: ${output}`)), 30000);
    const fail = error => { clearTimeout(timeout); reject(error); };
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`Preview exited ${code}: ${output}`)));
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
  });
  for (const route of [
    '/script.js', '/script.js?v=17', '/%73cript.js', '/SCRIPT.JS', '/roadmap.js',
    '/server.js', '/worker.js', '/build-assets.js', '/source-request-adapter.js',
    '/script.min.js.map', '/test/card-rendering.test.js',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(`${origin}${route}`, { method });
      assert.equal(response.status, 404, `${method} ${route}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      await response.text();
    }
  }
  for (const route of ['/', '/roadmap', '/script.min.js?v=17', '/roadmap.min.js?v=4', '/styles.min.css', '/sites.json']) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 200, route);
    await response.text();
  }
});
