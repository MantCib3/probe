'use strict';
/**
 * merge-wmn-all.js — Merge the ENTIRE WhatsMyName (wmn-data.json) source list
 * into sites.json, skipping any source that duplicates an existing entry
 * (matched by name or by domain) and any source that has no {account}
 * placeholder in its check URL (those need a POST body, which our simple
 * GET-based probe doesn't support).
 *
 * Run with: node merge-wmn-all.js
 */
const fs = require('fs');
const path = require('path');
const dir = __dirname;

const wmn = JSON.parse(fs.readFileSync(path.join(dir, 'wmn-data.json'), 'utf8'));
const sites = JSON.parse(fs.readFileSync(path.join(dir, 'sites.json'), 'utf8'));
const wmnSites = wmn.sites || wmn;

const CAT_MAP = {
  social: 'social', dating: 'social',
  tech: 'developer', coding: 'developer',
  gaming: 'gaming',
  music: 'content', video: 'content', images: 'content', art: 'content', news: 'content', blog: 'content',
  business: 'professional',
  shopping: 'shopping',
  hobby: 'misc', finance: 'misc', political: 'misc', health: 'misc', archived: 'misc', misc: 'misc',
  'xx NSFW xx': 'misc',
};

function domainOf(url) {
  try {
    return String(url).replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase();
  } catch (_) { return ''; }
}

function convert(s) {
  const url = s.uri_check.replace(/\{account\}/g, '{}');
  const domain = domainOf(url);
  const entry = {
    name: s.name,
    url,
    urlMain: 'https://' + domain,
    category: CAT_MAP[s.cat] || 'misc',
  };
  const hasM = s.m_string && String(s.m_string).trim();
  const hasE = s.e_string && String(s.e_string).trim();
  if (hasM) { entry.checkMethod = 'message'; entry.errorMsg = String(s.m_string).trim(); }
  else if (hasE) { entry.checkMethod = 'message'; entry.positiveMsg = String(s.e_string).trim(); }
  else { entry.checkMethod = 'status_code'; }
  // Carry over WMN's own found/not-found status codes so /api/verify can
  // replicate WMN's real found = (code===e_code [&& e_string in body]) /
  // not_found = (code===m_code) dual-signal check instead of guessing from
  // status 200 alone.
  const eCode = Number(s.e_code);
  const mCode = Number(s.m_code);
  if (Number.isFinite(eCode)) entry.expectedStatus = eCode;
  if (Number.isFinite(mCode) && mCode !== eCode) entry.notFoundStatus = mCode;
  const prot = s.protection || [];
  if (prot.includes('cloudflare') || prot.includes('ddos-guard') || prot.includes('cloudfront')) {
    entry.undetectable = true;
  }
  return entry;
}

const existingNames = new Set(sites.map(s => s.name.trim().toLowerCase()));
const existingDomains = new Set(sites.map(s => domainOf(s.url)));

let skippedName = 0, skippedDomain = 0, skippedNoAccount = 0;
const toAdd = [];

for (const s of wmnSites) {
  if (!s.uri_check || !s.uri_check.includes('{account}')) { skippedNoAccount++; continue; }
  const nameKey = String(s.name).trim().toLowerCase();
  if (existingNames.has(nameKey)) { skippedName++; continue; }
  const dom = domainOf(s.uri_check);
  if (existingDomains.has(dom)) { skippedDomain++; continue; }
  toAdd.push(s);
  existingNames.add(nameKey);
  existingDomains.add(dom);
}

const newEntries = toAdd.map(convert);
const updated = [...sites, ...newEntries];
fs.writeFileSync(path.join(dir, 'sites.json'), JSON.stringify(updated, null, 2), 'utf8');

console.log('WMN total sources:      ', wmnSites.length);
console.log('Skipped (name dupe):    ', skippedName);
console.log('Skipped (domain dupe):  ', skippedDomain);
console.log('Skipped (no {account}): ', skippedNoAccount);
console.log('Added:                  ', newEntries.length);
console.log('sites.json total now:   ', updated.length);
console.log('sites.json active now:  ', updated.filter(s => !s.defunct).length);
