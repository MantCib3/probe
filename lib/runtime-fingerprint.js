'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Runtime code identity reported as LAB_RUNTIME_FINGERPRINT.classifierSha256:
// sha256 over the concatenated bytes of server.js and every lib/**/*.js file,
// ordered by POSIX relative path (default string sort, so lib/... precedes
// server.js). The accuracy lab recomputes this value for its parity check.
function runtimeCodeFiles(rootDir) {
  const files = ['server.js'];
  (function walk(relDir) {
    for (const entry of fs.readdirSync(path.join(rootDir, relDir), { withFileTypes: true })) {
      const relPath = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) walk(relPath);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relPath);
    }
  })('lib');
  return files.sort();
}

function runtimeCodeSha256(rootDir) {
  const hash = crypto.createHash('sha256');
  for (const file of runtimeCodeFiles(rootDir)) hash.update(fs.readFileSync(path.join(rootDir, file)));
  return hash.digest('hex');
}

module.exports = { runtimeCodeFiles, runtimeCodeSha256 };
