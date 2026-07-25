#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'sites.json');
const sites = JSON.parse(fs.readFileSync(filePath, 'utf8'));
let patched = 0;

function patch(name, changes, deletions = []) {
  const s = sites.find(x => x.name === name);
  if (!s) { console.log('NOT FOUND:', name); return; }
  Object.assign(s, changes);
  deletions.forEach(k => delete s[k]);
  patched++;
  console.log('PATCHED:', name);
}

// 1. Hackernoon: broken NextJS build-hash URL -> real profile page
patch('Hackernoon', {
  url: 'https://hackernoon.com/u/{}',
  checkMethod: 'status_code',
  allowBrowserFallback: true,
  undetectable: false
}, ['errorMsg']);

// 2. Steemit: missing {} placeholder, add positiveMsg for found users
patch('Steemit', {
  url: 'https://signup.steemit.com/api/check_username?username={}',
  positiveMsg: '"success":false'
});

// 3. Anime-Planet: wrong endpoint (no {}), switch to profile page
patch('Anime-Planet', {
  url: 'https://www.anime-planet.com/users/{}',
  urlMain: 'https://www.anime-planet.com/users/',
  checkMethod: 'status_code'
}, ['errorMsg']);

// 4. Codeberg: checkMethod mismatch (status_code ignores errorMsg body)
patch('Codeberg', { checkMethod: 'message' });

// 5. Quizlet: add positiveMsg so taken usernames are detected as found
patch('Quizlet', { positiveMsg: '"success":false' });

// 6. eBay: body with no errorMsg -> status_code + allowBrowserFallback
patch('eBay', {
  checkMethod: 'status_code',
  notFoundStatus: 404,
  allowBrowserFallback: true
}, ['errorMsg']);

// 7. smule: fix malformed errorMsg (missing opening quote on code key)
patch('smule', { errorMsg: '"code":' });

// 8. Rumble: returns 404 for missing channels, add fallback + notFoundStatus
patch('Rumble', { allowBrowserFallback: true, notFoundStatus: 404 });

// 9. Add allowBrowserFallback to sites that may be CF-blocked from server IP
['JSFiddle', 'Diablo', 'DOTAFire', 'Blogspot', 'solo.to', 'Docker Hub (User)'].forEach(n => {
  patch(n, { allowBrowserFallback: true });
});

// 10. Add notFoundStatus:404 as backup for Mastodon/API sites
['Truth Social', 'Moxfield', 'Medium', 'Reddit', 'Depop', 'Genius'].forEach(n => {
  patch(n, { notFoundStatus: 404 });
});

fs.writeFileSync(filePath, JSON.stringify(sites, null, 2));
console.log('\nTotal patched:', patched, '| Active sites:', sites.filter(s => !s.defunct).length);
