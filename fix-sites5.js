'use strict';
/**
 * fix-sites5.js — comprehensive detection upgrade
 *
 * Sources: WhatsMyName (wmn-data.json), Sherlock, InstantUsername analysis
 *
 * Changes:
 *  A) requiresAuth sites → remove flag, use CF Worker + body message detection
 *  B) cfProxy sites → add proper positiveMsg/errorMsg from WMN data
 *  C) Normal HTTP sites → add positiveMsg/errorMsg to prevent false 'unknown'
 *  D) API upgrades → switch several sites to their JSON API endpoints
 *  E) New site: X/Twitter via username_available.json
 */

const fs   = require('fs');
const path = require('path');
const f    = path.join(__dirname, 'sites.json');
let   s    = JSON.parse(fs.readFileSync(f, 'utf8'));

function g(name)    { return s.find(x => x.name === name); }
function upd(name, changes) {
  const site = g(name);
  if (!site) { console.log('NOT FOUND:', name); return; }
  Object.assign(site, changes);
  // Clean up stale flags where appropriate
  if (changes.requiresAuth === false || changes.requiresAuth === undefined) {
    delete site.requiresAuth;
  }
  console.log('✓', name);
}

/* ═══════════════════════════════════════════════════════════════════
   A) AUTH-REQUIRED → remove flag, enable body-detection via CF Worker
   Server HTTP will get 403 → client CF Worker retry → body matching
   ═══════════════════════════════════════════════════════════════════ */

// TikTok — oEmbed API (CORS-enabled, works directly from browser!)
upd('TikTok', {
  requiresAuth: undefined,
  cors: true,
  checkUrl: 'https://www.tiktok.com/oembed?url=https://www.tiktok.com/@{}',
  checkMethod: 'message',
  positiveMsg: '"author_url":',
  errorMsg: '"code":400',
});

// Snapchat — fix URL (snapchat.com/@ not /add/), add body detection
upd('Snapchat', {
  requiresAuth: undefined,
  url: 'https://www.snapchat.com/@{}',
  checkUrl: 'https://www.snapchat.com/@{}',
  checkMethod: 'message',
  positiveMsg: 'is on Snapchat!',
  errorMsg: 'NOT_FOUND',
});

// Threads — fix domain (.com not .net), add body detection
upd('Threads', {
  requiresAuth: undefined,
  url: 'https://www.threads.com/@{}',
  checkUrl: 'https://www.threads.com/@{}',
  checkMethod: 'message',
  positiveMsg: '"username":',
  errorMsg: 'Page Not Found',
});

// Pinterest — add body detection (profile page works from CF edge)
upd('Pinterest', {
  requiresAuth: undefined,
  checkMethod: 'message',
  positiveMsg: '- Profile | Pinterest',
  errorMsg: 'id="home-main-title"',
});

// Instagram — add body detection (residential IP or CF edge sometimes gets through)
upd('Instagram', {
  requiresAuth: undefined,
  checkMethod: 'message',
  positiveMsg: 'Posts - See Instagram photos and videos from',
  errorMsg: '"routePath":null',
});

// Facebook — add body detection
upd('Facebook', {
  requiresAuth: undefined,
  checkMethod: 'message',
  positiveMsg: '__isProfile',
  errorMsg: '<title>Facebook</title>',
});

// LinkedIn — keep requiresAuth (no reliable free API, very aggressive blocking)
// g('LinkedIn') stays as is

/* ═══════════════════════════════════════════════════════════════════
   B) API UPGRADES — switch to JSON API endpoints
   ═══════════════════════════════════════════════════════════════════ */

// Imgur → public API (CORS-enabled with client_id)
upd('Imgur', {
  checkUrl: 'https://api.imgur.com/account/v1/accounts/{}?client_id=546c25a59c58ad7',
  checkMethod: 'message',
  cors: true,
  positiveMsg: '"username":',
  errorMsg: '"code":"404"',
});

// Wattpad → public REST API (CORS-enabled)
upd('Wattpad', {
  checkUrl: 'https://www.wattpad.com/api/v3/users/{}',
  checkMethod: 'message',
  cors: true,
  positiveMsg: '"username":',
  errorMsg: '"error_code":',
});

// Kick → public API v2 (CORS-enabled)
upd('Kick', {
  checkUrl: 'https://kick.com/api/v2/channels/{}',
  checkMethod: 'message',
  cors: true,
  positiveMsg: '"id"',
  errorMsg: 'Not Found',
});

// SourceForge → REST API
upd('SourceForge', {
  checkUrl: 'https://sourceforge.net/rest/u/{}/profile',
  checkMethod: 'message',
  positiveMsg: '"username":',
  errorMsg: 'message-image-404',
});

// Buy Me a Coffee → username check API (CORS-enabled)
upd('Buy Me a Coffee', {
  checkUrl: 'https://app.buymeacoffee.com/api/v1/check_availability?username={}',
  checkMethod: 'message',
  cors: true,
  cfProxy: undefined,
  positiveMsg: '"available":false',
  errorMsg: '"available":true',
});

// Roblox → validation API (CORS-enabled)
upd('Roblox', {
  checkUrl: 'https://auth.roblox.com/v1/usernames/validate?username={}&birthday=2019-12-31T23:00:00.000Z',
  checkMethod: 'message',
  cors: true,
  positiveMsg: 'Username is already in use',
  errorMsg: 'Username is valid',
});

// Gamespot → AJAX activity endpoint (JSON response)
upd('Gamespot', {
  url: 'https://www.gamespot.com/profile/{}/summary/',
  checkUrl: 'https://www.gamespot.com/profile/{}/summary/activity/?ajax',
  checkMethod: 'message',
  positiveMsg: '"success":true',
  errorMsg: '"success":false',
});

// Scribd → search API
upd('Scribd', {
  checkUrl: 'https://www.scribd.com/search/query?query={}&verbatim=true',
  checkMethod: 'message',
  positiveMsg: '"compilationId":"',
  errorMsg: '"compilationId":null',
});

/* ═══════════════════════════════════════════════════════════════════
   C) cfProxy SITES — add proper positiveMsg/errorMsg from WMN
   ═══════════════════════════════════════════════════════════════════ */

// Patreon — body contains embedded JSON
upd('Patreon', {
  checkMethod: 'message',
  positiveMsg: 'full_name":',
  errorMsg: 'errorCode": 404,',
});

// Quora
upd('Quora', {
  checkMethod: 'message',
  positiveMsg: 'Credentials',
  errorMsg: 'Page Not Found',
});

// Etsy — fix URL to /people/{} (shop URL doesn't work for all users)
upd('Etsy', {
  url: 'https://www.etsy.com/people/{}',
  checkUrl: 'https://www.etsy.com/people/{}',
  checkMethod: 'message',
  positiveMsg: 'favorite items - Etsy</title>',
  errorMsg: 'Sorry, the member you are looking for does not exist',
});

// eBay
upd('eBay', {
  checkMethod: 'message',
  positiveMsg: 'on eBay</title>',
  errorMsg: 'The User ID you entered was not found',
});

// VSCO
upd('VSCO', {
  checkMethod: 'message',
  positiveMsg: 'permaSubdomain',
  errorMsg: '"error":"site_not_found"}',
});

// Redbubble — fix URL to /people/{}/shop
upd('Redbubble', {
  url: 'https://www.redbubble.com/people/{}/shop',
  checkUrl: 'https://www.redbubble.com/people/{}/shop',
  checkMethod: 'message',
  positiveMsg: 'Shop | Redbubble',
  errorMsg: 'This is a lost cause.',
});

// Poshmark
upd('Poshmark', {
  checkMethod: 'message',
  positiveMsg: 'is using Poshmark to sell items from their closet.',
  errorMsg: 'Page not found - Poshmark',
});

// Depop — fix errorMsg to WMN's exact string
upd('Depop', {
  checkMethod: 'message',
  positiveMsg: "s Shop - Depop",
  errorMsg: "Sorry, that page doesn't exist",
});

// Slideshare
upd('Slideshare', {
  checkMethod: 'message',
  positiveMsg: 'data-testid="report-button"',
  errorMsg: 'id="username-available"',
});

// Udemy — already has errorMsg, add positiveMsg
upd('Udemy', {
  checkMethod: 'message',
  positiveMsg: '| Udemy</title>',
  errorMsg: 'Online Courses - Learn Anything, On Your Schedule | Udemy',
});

// ProductHunt
upd('ProductHunt', {
  checkMethod: 'message',
  positiveMsg: "s profile on Product Hunt",
  errorMsg: 'Product Hunt - All newest Products',
});

// Genius — fix to artist URL
upd('Genius', {
  url: 'https://genius.com/artists/{}',
  checkUrl: 'https://genius.com/artists/{}',
  checkMethod: 'message',
  positiveMsg: 'class="profile_header"',
  errorMsg: 'class="render_404"',
});

// BIGO Live — fix positiveMsg
upd('BIGO Live', {
  checkMethod: 'message',
  positiveMsg: 'userInfo:{nickName',
  errorMsg: 'userInfo:{}',
});

// Unsplash — add message detection
upd('Unsplash', {
  checkMethod: 'message',
  positiveMsg: 'photographer',
  errorMsg: 'noindex',
});

// Wellfound / AngelList
upd('Wellfound', {
  checkMethod: 'message',
  positiveMsg: 'angellist',
  errorMsg: 'Page Not Found',
});

// Fiverr — already has cfProxy, add message detection
upd('Fiverr', {
  checkMethod: 'message',
  positiveMsg: '"profile_image"',
  errorMsg: 'Page Not Found',
});

// Upwork
upd('Upwork', {
  checkMethod: 'message',
  positiveMsg: 'og:type" content="profile"',
  errorMsg: 'Page Not Found',
});

// Society6
upd('Society6', {
  checkMethod: 'message',
  positiveMsg: 'Society6 Artist</title>',
  errorMsg: 'Page not found',
});

/* ═══════════════════════════════════════════════════════════════════
   D) NORMAL HTTP SITES — add message detection to eliminate 'unknown'
   ═══════════════════════════════════════════════════════════════════ */

upd('CodePen', {
  checkMethod: 'message',
  positiveMsg: 'property="og:url"',
  errorMsg: 'data-test-id="text-404"',
});

upd('Kaggle', {
  checkMethod: 'message',
  positiveMsg: 'property="og:username"',
  errorMsg: 'Kaggle: Your Home for Data Science</title>',
});

upd('Letterboxd', {
  checkMethod: 'message',
  positiveMsg: "'s profile on Letterboxd",
  errorMsg: "Sorry, we can't find the page you've requested.",
});

// Trakt.tv
const trakt = s.find(x => x.name === 'Trakt.tv');
if (trakt) {
  trakt.checkMethod = 'message';
  trakt.positiveMsg = 's profile - Trakt';
  trakt.errorMsg = "The page you were looking for doesn't exist";
  console.log('✓ Trakt.tv');
}

upd('Ko-fi', {
  checkMethod: 'message',
  positiveMsg: 'id="profile-header"',
  errorMsg: '<title>Object moved</title>',
});

upd('Untappd', {
  checkMethod: 'message',
  positiveMsg: 'class="cont user_profile"',
  errorMsg: 'class="search_404"',
});

upd('AtCoder', {
  checkMethod: 'message',
  positiveMsg: '<h3>Contest Status</h3>',
  errorMsg: '>404 Page Not Found</h1>',
});

upd('KnowYourMeme', {
  checkMethod: 'message',
  positiveMsg: 'Contributions',
  errorMsg: '404, File Not Found!',
});

upd('weheartit', {
  checkMethod: 'message',
  positiveMsg: ' on We Heart It</title>',
  errorMsg: ' (404)</title>',
});

upd('SteamGifts', {
  checkMethod: 'message',
  positiveMsg: '"identifier":',
  errorMsg: 'Page not found',
});

upd('Spotify', {
  checkMethod: 'message',
  positiveMsg: 'content="profile"',
  errorMsg: 'Page not found',
});

upd('Dribbble', {
  checkMethod: 'message',
  positiveMsg: ' | Dribbble',
  errorMsg: '(404)</title>',
});

upd('ArtStation', {
  checkMethod: 'message',
  positiveMsg: 'Portfolio',
  errorMsg: 'Page not found',
});

upd('Lemmy', {
  checkMethod: 'message',
  positiveMsg: '"actor_id":',
  errorMsg: 'Page Not Found',
});

upd('Slashdot', {
  checkMethod: 'message',
  positiveMsg: 'class="user-bio"',
  errorMsg: 'Page Not Found',
});

upd('Imgur', { checkMethod: 'message' }); // already updated above

upd('solo.to', {
  checkMethod: 'message',
  positiveMsg: 'solo.to',
  errorMsg: 'Page not found',
});

upd('ArmorGames', {
  checkMethod: 'message',
  positiveMsg: 'Armor Games Profile',
  errorMsg: "We couldn't find the page",
});

upd('AtCoder', {
  checkMethod: 'message',
  positiveMsg: '<h3>Contest Status</h3>',
  errorMsg: '>404 Page Not Found</h1>',
});

upd('Newgrounds', {
  checkMethod: 'message',
  positiveMsg: 'Newgrounds Profile',
  errorMsg: 'Account Not Found',
});

upd('Hashnode', {
  checkMethod: 'message',
  positiveMsg: '"id":',
  errorMsg: '"user":null',
});

/* ═══════════════════════════════════════════════════════════════════
   E) ADD NEW SITES
   ═══════════════════════════════════════════════════════════════════ */

// X (Twitter) — username availability check API
if (!g('X')) {
  s.push({
    name: 'X',
    category: 'social',
    url: 'https://x.com/{}',
    checkUrl: 'https://api.x.com/i/users/username_available.json?username={}',
    checkMethod: 'message',
    cors: false,  // CORS uncertain, route through CF Worker
    positiveMsg: '"reason":"taken"',
    errorMsg: '"reason":"available"',
  });
  console.log('✓ X (added new)');
}

/* ═══════════════════════════════════════════════════════════════════
   F) CLEANUP — remove defunct requiresAuth where flag was deleted
   ═══════════════════════════════════════════════════════════════════ */
// Delete undefined keys left by Object.assign
s = s.map(site => {
  const clean = {};
  for (const [k, v] of Object.entries(site)) {
    if (v !== undefined) clean[k] = v;
  }
  return clean;
});

fs.writeFileSync(f, JSON.stringify(s, null, 2), { encoding: 'utf8' });

const authCount  = s.filter(x => x.requiresAuth).length;
const corsCount  = s.filter(x => x.cors).length;
const cfCount    = s.filter(x => x.cfProxy).length;
const msgCount   = s.filter(x => x.positiveMsg || x.errorMsg).length;
console.log(`\nrequiresAuth=${authCount}  cors=${corsCount}  cfProxy=${cfCount}  hasMessageDetection=${msgCount}  total=${s.length}`);
