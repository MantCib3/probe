'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { runtimeCodeSha256 } = require('../lib/runtime-fingerprint');

test('deployment verification saves matching runtime evidence and fails mismatched hashes or exposed private routes', { timeout: 120000 }, async t => {
  const root = path.join(__dirname, '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-deploy-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(root, 'sites.json'));
  const classifierSha256 = runtimeCodeSha256(root);
  const commit = 'a'.repeat(40);
  for (const mode of ['matching', 'wrong-runtime', 'exposed-private-route']) {
    const server = http.createServer((req, res) => {
      if (req.url === '/version.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ commit, catalogSha256: crypto.createHash('sha256').update(source).digest('hex'),
          classifierSha256: mode === 'wrong-runtime' ? 'wrong' : classifierSha256,
          sources: { active: JSON.parse(source).filter(site => !site.defunct).length }, node: process.version }));
      }
      res.writeHead(req.url.startsWith('/api/') && mode !== 'exposed-private-route' ? 401 : 200);
      res.end('');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const file = path.join(directory, `${mode}.json`);
      const child = spawn(process.execPath, [path.join(root, 'scripts', 'verify-deploy.js'),
        `http://127.0.0.1:${server.address().port}`, commit, '--timeout-min', '0.1', '--report', file],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const exit = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(exit, mode === 'matching' ? 0 : 1, output);
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(Number.isFinite(Date.parse(report.generatedAt)));
      assert.equal(report.commit, commit);
      assert.match(report.catalogSha256, /^[a-f0-9]{64}$/);
      assert.equal(report.status, mode === 'matching' ? 'completed' : 'failed');
      if (mode === 'matching') assert.equal(report.classifierSha256, classifierSha256);
      else assert.ok(report.failures.length);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
