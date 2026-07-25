'use strict';
const fs = require('fs');
const f  = require('path').join(__dirname, 'sites.json');
const s  = JSON.parse(fs.readFileSync(f, 'utf8'));
const g  = n => s.find(x => x.name === n);

// ── Sites that work fine via normal HTTP ─────────────────────────────
// WhatsMyName / Sherlock hit these with plain HTTP + browser headers and
// get correct 200/404 responses.  We wrongly marked them cfProxy which
// caused the server to skip HTTP entirely, sending them to the CF Worker
// which returned 403/challenge → showed as BLOCKED.
//
// Fix: remove cfProxy + undetectable so the server does a real HTTP check.
const httpOk = [
  'CodePen','Kaggle','Hashnode','SourceForge','Newgrounds',
  'PSN Profiles','Kick','Rumble','Trakt.tv','Ko-fi',
  'Dribbble','ArtStation','Imgur','Lemmy','Slashdot',
  'Letterboxd','Untappd','ArmorGames','JSFiddle',
  'PCPartPicker','LibraryThing','KnowYourMeme','Destructoid',
  'Anime-Planet','weheartit','solo.to','AtCoder',
  'SteamGifts','Gamespot','Threadless','Wattpad',
  'Spotify',
  // These were already cfProxy=false but still undetectable:
  'PSN Profiles','Ask.fm',
];

httpOk.forEach(n => {
  const x = g(n);
  if (!x) { console.log('SKIP (not found):', n); return; }
  delete x.cfProxy;
  delete x.undetectable;
});

// Sporcle is named differently — find by URL pattern
const sporcle = s.find(x => x.url && x.url.includes('sporcle'));
if (sporcle) { delete sporcle.cfProxy; delete sporcle.undetectable; console.log('Fixed Sporcle:', sporcle.name); }

const hiber = s.find(x => x.url && x.url.includes('hiberworld'));
if (hiber)   { delete hiber.cfProxy;  delete hiber.undetectable;  console.log('Fixed Hiberworld:', hiber.name); }

fs.writeFileSync(f, JSON.stringify(s, null, 2), { encoding: 'utf8' });

const cfProxyCount   = s.filter(x => x.cfProxy).length;
const undetectable   = s.filter(x => x.undetectable).length;
const requiresAuth   = s.filter(x => x.requiresAuth).length;
const cors           = s.filter(x => x.cors).length;
console.log(`cfProxy=${cfProxyCount}  undetectable=${undetectable}  requiresAuth=${requiresAuth}  cors=${cors}`);
