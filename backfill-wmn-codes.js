'use strict';
/**
 * backfill-wmn-codes.js — One-time migration: the initial merge-wmn-all.js
 * run carried over e_string/m_string (as checkMethod:'message' + positiveMsg/
 * errorMsg) but dropped e_code/m_code entirely. WhatsMyName's real algorithm
 * uses BOTH the HTTP status code and the string together to decide found vs
 * not-found, so sites.json entries that came from wmn-data.json need
 * `expectedStatus` (e_code) and `notFoundStatus` (m_code) added to match.
 *
 * Matches sites.json entries to wmn-data.json entries by name (case-
 * insensitive) and only touches entries that don't already have
 * expectedStatus/notFoundStatus set (so hand-tuned pre-existing entries are
 * left alone). Run with: node backfill-wmn-codes.js
 */
const fs = require('fs');
const path = require('path');
const dir = __dirname;

const wmn = JSON.parse(fs.readFileSync(path.join(dir, 'wmn-data.json'), 'utf8'));
const sites = JSON.parse(fs.readFileSync(path.join(dir, 'sites.json'), 'utf8'));
const wmnSites = wmn.sites || wmn;

const wmnByName = new Map();
for (const s of wmnSites) {
  wmnByName.set(String(s.name).trim().toLowerCase(), s);
}

let updated = 0, skippedNoMatch = 0, skippedAlreadySet = 0;

for (const site of sites) {
  if (site.expectedStatus !== undefined || site.notFoundStatus !== undefined) {
    skippedAlreadySet++;
    continue;
  }
  const wmnEntry = wmnByName.get(String(site.name).trim().toLowerCase());
  if (!wmnEntry) { skippedNoMatch++; continue; }
  const eCode = Number(wmnEntry.e_code);
  const mCode = Number(wmnEntry.m_code);
  if (Number.isFinite(eCode)) site.expectedStatus = eCode;
  if (Number.isFinite(mCode) && mCode !== eCode) site.notFoundStatus = mCode;
  updated++;
}

fs.writeFileSync(path.join(dir, 'sites.json'), JSON.stringify(sites, null, 2), 'utf8');

console.log('sites.json total entries:  ', sites.length);
console.log('Updated with e_code/m_code:', updated);
console.log('Skipped (already set):     ', skippedAlreadySet);
console.log('Skipped (no WMN match):    ', skippedNoMatch);
