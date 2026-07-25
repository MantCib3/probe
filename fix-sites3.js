'use strict';
const fs = require('fs');
const f = require('path').join(__dirname, 'sites.json');
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
const g = n => s.find(x => x.name === n);

// ── Also require-auth ──────────────────────────────────────────────────
['Twitter','X'].forEach(n => { const x = g(n); if (x) x.requiresAuth = true; });

// ── CF-proxy sites: browser will fetch via CF Worker ──────────────────
// These are undetectable from datacenter IPs (CF Enterprise blocking).
// Server already short-circuits most (undetectable:true). We just add
// cfProxy:true so the SSE result tells the client to use the CF Worker.
//
// Don't mark sites that already have cors:true (those use direct fetch).
const cfProxySites = [
  // Already undetectable — just add cfProxy flag
  'CodePen','Kaggle','Hashnode','Newgrounds','Kick','Trakt.tv',
  'Patreon','ArtStation','Imgur','Spotify','Giphy','Quora','Lemmy',
  'Slashdot','Wellfound','Fiverr','Upwork','Etsy','Threadless',
  'Poshmark','Slideshare','Scribd','Letterboxd','Genius','VSCO',
  'Anime-Planet','Gamespot','ArmorGames','Dribbble',
  // CF-blocked but NOT yet undetectable — also mark undetectable to skip server attempt
  'Redbubble','Tripadvisor','Society6','Depop','Untappd','eBay',
  'SteamGifts','JSFiddle','Sporcle','Udemy','Hiberworld',
  'Ko-fi','weheartit','solo.to','Destructoid','Fandom',
  'Rumble','Unsplash','ProductHunt','Wattpad','ResearchGate',
  'LibraryThing','BIGO Live','AtCoder','Buy Me a Coffee',
  'KnowYourMeme','PCPartPicker','SourceForge',
];

cfProxySites.forEach(n => {
  const x = g(n);
  if (!x) { console.log('NOT FOUND:', n); return; }
  // Don't override cors:true sites — they use direct CORS fetch
  if (x.cors) return;
  x.cfProxy = true;
  // Ensure server skips the HTTP attempt (saves timeout)
  if (!x.undetectable) x.undetectable = true;
});

fs.writeFileSync(f, JSON.stringify(s, null, 2), { encoding: 'utf8' });
const authCount = s.filter(x => x.requiresAuth).length;
const corsCount = s.filter(x => x.cors).length;
const cfCount   = s.filter(x => x.cfProxy).length;
console.log(`requiresAuth: ${authCount}  cors: ${corsCount}  cfProxy: ${cfCount}`);
console.log('Sites total:', s.length);
