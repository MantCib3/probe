'use strict';
const fs = require('fs');
const f = require('path').join(__dirname, 'sites.json');
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
const g = n => s.find(x => x.name === n);

// ── Auth-required sites: server can never determine these ──────────────
// Mark so server skips immediately, UI shows "🔒 login required"
const requiresAuth = [
  'Instagram','Facebook','Threads','LinkedIn','Pinterest','Snapchat',
  'Twitter','X','TikTok',
];
requiresAuth.forEach(n => {
  const x = g(n);
  if (x) x.requiresAuth = true;
});

// ── Sites whose API endpoint has open CORS ─────────────────────────────
// Browser can fetch these directly from residential IP to bypass datacenter blocks
const corsApis = [
  // Already have apiUrl pointing to CORS-enabled endpoints
  'GitHub','Reddit','Codeberg','Bitbucket','Wikipedia','Keybase',
  'Vimeo','SoundCloud','DeviantArt','Medium','Steam','Hackernoon',
  'Tumblr','Bandcamp','Substack',
  // Sites whose URL IS already an API with CORS
  'Hacker News','Codeforces','GitLab','Gravatar','npm','PyPI',
  'lichess.org','Chess.com','Monkeytype','TETR.IO','Wakatime',
  'TryHackMe','Moxfield','Tellonym','YouNow','Steemit',
  'BoardGameGeek','TruckersMP','FACEIT','Discogs','Mixcloud',
  'Trello','RubyGems.org','Scratch','Game Jolt','devRant',
  'Bugcrowd','CodeSandbox','HackerRank','GeeksForGeeks',
  'Habbo.com','MCUUID (Minecraft)','AniList','Zepeto',
  'Gettr','Playstation Network','smule','DOTAFire','Quizlet',
  'Apex Legends','Fortnite Tracker','lichess.org','pokemonshowdown',
  'Speedrun.com','speedrun','Mod DB','Truth Social',
  'Docker Hub (User)','Docker Hub',
];
corsApis.forEach(n => {
  const x = g(n);
  if (x) x.cors = true;
});

fs.writeFileSync(f, JSON.stringify(s, null, 2), { encoding: 'utf8' });
const authCount = s.filter(x => x.requiresAuth).length;
const corsCount = s.filter(x => x.cors).length;
console.log(`requiresAuth: ${authCount}  cors: ${corsCount}`);
