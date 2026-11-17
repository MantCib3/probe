'use strict';

// Single command to keep every published source count in sync with sites.json.
// Run after adding/removing/retiring a source:  node scripts/sync-counts.js
// CI / pre-commit check (no writes):             node scripts/sync-counts.js --check
//
// Only the exact tokens that test/source-count.test.js validates are rewritten.
// Deliberately historical write-ups (e.g. the blog alt-text that records the
// counts true at publish time) are never touched.

const fs = require('node:fs');
const path = require('node:path');

const root = process.env.SYNC_ROOT || path.join(__dirname, '..');
const checkOnly = process.argv.includes('--check');

const sites = JSON.parse(fs.readFileSync(path.join(root, 'sites.json'), 'utf8')).filter(site => !site.defunct);
const manual = sites.filter(site => site.undetectable).length;
const total = sites.length;
const automatic = total - manual;

// [file, [[regex, replacement], ...]]. Each regex matches exactly one published
// token (with the number as plain \d+) so running this is safe and idempotent.
const rules = [
  ['index.html', [
    [/across \d+ functional/g, `across ${total} functional`],
    [/<span id="siteCount">\d+<\/span>/g, `<span id="siteCount">${total}</span>`],
    [/<strong id="heroCount">\d+<\/strong>/g, `<strong id="heroCount">${total}</strong>`],
  ]],
  ['script.js', [[/el\.textContent = '\d+';/g, `el.textContent = '${total}';`]]],
  ['script.min.js', [[/textContent="\d+"/g, `textContent="${total}"`]]],
  ['package.json', [[/across \d+ functional/g, `across ${total} functional`]]],
  ['llms.txt', [
    [/across \d+ functional/g, `across ${total} functional`],
    [/Maintaining \d+ sources/g, `Maintaining ${total} sources`],
    [/\d+ automatic checks and \d+ manual-only/g, `${automatic} automatic checks and ${manual} manual-only`],
    [/coverage is \d+ sources/g, `coverage is ${total} sources`],
  ]],
  ['roadmap.html', [
    [/\d+ active sources: \d+ automatic checks and \d+ deliberate/g, `${total} active sources: ${automatic} automatic checks and ${manual} deliberate`],
  ]],
  ['blog/index.html', [
    [/with \d+ active sources/g, `with ${total} active sources`],
    [/its \d+ functional/g, `its ${total} functional`],
    [/Maintaining \d+ Active Sources/g, `Maintaining ${total} Active Sources`],
    // Only the hero metric <strong>N</strong> immediately before this span.
    [/<strong>\d+<\/strong>(?=\s*<span>active sources we regularly check)/g, `<strong>${total}</strong>`],
  ]],
  ['blog/maintaining-a-source-catalog.html', [
    [/Maintaining \d+ Active Sources/g, `Maintaining ${total} Active Sources`],
    [/maintains \d+ functional/g, `maintains ${total} functional`],
    [/<strong>\d+<\/strong><span>functional/g, `<strong>${total}</strong><span>functional`],
    [/<strong>\d+<\/strong><span>automatic/g, `<strong>${automatic}</strong><span>automatic`],
    [/<strong>\d+<\/strong><span>manual/g, `<strong>${manual}</strong><span>manual`],
    [/currently has \d+ automatic sources and \d+ that must be opened manually, for \d+ functional/g,
      `currently has ${automatic} automatic sources and ${manual} that must be opened manually, for ${total} functional`],
  ]],
];

const changed = [];
for (const [file, replacements] of rules) {
  const filePath = path.join(root, file);
  const original = fs.readFileSync(filePath, 'utf8');
  let updated = original;
  for (const [find, to] of replacements) updated = updated.replace(find, to);
  if (updated !== original) {
    changed.push(file);
    if (!checkOnly) fs.writeFileSync(filePath, updated);
  }
}

if (checkOnly) {
  if (changed.length) {
    console.error(`Source counts out of date (${total}/${automatic}/${manual}) in: ${changed.join(', ')}. Run: node scripts/sync-counts.js`);
    process.exit(1);
  }
  console.log(`Source counts in sync: ${total} total, ${automatic} automatic, ${manual} manual.`);
} else {
  console.log(changed.length
    ? `Updated counts (${total} total / ${automatic} automatic / ${manual} manual) in: ${changed.join(', ')}`
    : `Counts already in sync: ${total}/${automatic}/${manual}.`);
}