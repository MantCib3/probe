'use strict';

// `npm run check` helper: syntax-checks every lib/**/*.js module.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { runtimeCodeFiles } = require('../lib/runtime-fingerprint');

const root = path.join(__dirname, '..');
const files = runtimeCodeFiles(root).filter(file => file.startsWith('lib/'));
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}
if (failed) {
  console.error(`${failed} lib file(s) failed syntax check`);
  process.exit(1);
}
