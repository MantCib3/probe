'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const sites = JSON.parse(read('sites.json'));
const active = Object.values(sites).filter(site => !site.defunct);
const total = active.length;
const manual = active.filter(site => site.undetectable).length;
const automatic = total - manual;

// Every place the live site states the current source count. Historical
// campaign write-ups intentionally keep the counts that were true at the time.
const references = {
  'index.html': [`across ${total} functional`, `<span id="siteCount">${total}</span>`, `<strong id="heroCount">${total}</strong>`],
  'script.js': [`el.textContent = '${total}';`],
  'script.min.js': [`textContent="${total}"`],
  'llms.txt': [`across ${total} functional`, `Maintaining ${total} sources`, `${automatic} automatic checks and ${manual} manual-only`, `coverage is ${total} sources`],
  'package.json': [`across ${total} functional`],
  'roadmap.html': [`${total} active sources: ${automatic} automatic checks and ${manual} deliberate`],
  'blog/index.html': [`with ${total} active sources`, `its ${total} functional`, `Maintaining ${total} Active Sources`, `<strong>${total}</strong>`],
  'blog/maintaining-a-source-catalog.html': [
    `Maintaining ${total} Active Sources`,
    `maintains ${total} functional`,
    `<strong>${total}</strong><span>functional`,
    `<strong>${automatic}</strong><span>automatic`,
    `<strong>${manual}</strong><span>manual`,
    `currently has ${automatic} automatic sources and ${manual} that must be opened manually, for ${total} functional`,
  ],
};

describe('published source counts', () => {
  for (const [file, expected] of Object.entries(references)) {
    test(`${file} matches sites.json (${total} total, ${automatic} automatic, ${manual} manual)`, () => {
      const content = read(file);
      for (const snippet of expected) assert.ok(content.includes(snippet), `${file} is missing "${snippet}"`);
    });
  }
});
