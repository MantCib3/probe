/**
 * fix-sites6.js — Fix major social platforms: X, Instagram, LinkedIn, Facebook
 *
 * Changes:
 *  X (Twitter)   — switch to publish.twitter.com/oembed (CORS, 200/404 clean)
 *  Instagram     — use web_profile_info API via cfProxy (200/404 clean)
 *  LinkedIn      — remove requiresAuth, cfProxy with Googlebot UA in worker
 *  Facebook      — add cfProxy for CF edge attempt
 */
const fs = require('fs');
const path = require('path');

const f = path.join(__dirname, 'sites.json');
const s = JSON.parse(fs.readFileSync(f, 'utf8'));

let changed = 0;

s.forEach(site => {
  // ------------------------------------------------------------------ X (Twitter)
  if (site.name === 'X (Twitter)') {
    // publish.twitter.com/oembed is CORS-enabled, returns JSON 200 for existing
    // users and 404 for non-existing — ideal for client-side cors check
    site.checkUrl = 'https://publish.twitter.com/oembed?url=https://x.com/{}';
    site.checkMethod = 'message';
    site.cors = true;
    site.positiveMsg = '"author_name":';
    site.errorMsg = '"errors":[';
    // Clean up old/stale fields
    delete site.apiUrl;
    delete site.undetectable;
    delete site.crawlerUA;
    delete site.cfProxy;
    delete site.requiresAuth;
    changed++;
    console.log('✓ X (Twitter) updated to oEmbed cors check');
  }

  // ------------------------------------------------------------------ Instagram
  if (site.name === 'Instagram') {
    // web_profile_info API: 200 with {"data":{"user":{...}}} for existing users,
    // 404 for non-existing. CF Worker injects X-IG-App-ID header automatically.
    site.checkUrl = 'https://www.instagram.com/api/v1/users/web_profile_info/?username={}';
    site.checkMethod = 'status_code';
    site.cfProxy = true;
    site.positiveMsg = '"username":';   // backup body confirmation
    delete site.undetectable;
    delete site.crawlerUA;
    delete site.cors;
    delete site.requiresAuth;
    changed++;
    console.log('✓ Instagram updated to web_profile_info API via cfProxy');
  }

  // ------------------------------------------------------------------ LinkedIn
  if (site.name === 'LinkedIn') {
    // Googlebot UA from CF edge: existing user → 200 with "public_profile_v3_desktop",
    // missing user → 999 with JS-redirect page containing "window.onload"
    // The CF Worker will inject Googlebot UA for linkedin.com domains.
    site.checkUrl = 'https://www.linkedin.com/in/{}/';
    site.checkMethod = 'message';
    site.cfProxy = true;
    site.positiveMsg = 'public_profile_v3_desktop';
    site.errorMsg = 'window.onload';
    delete site.requiresAuth;
    delete site.undetectable;
    delete site.crawlerUA;
    delete site.cors;
    changed++;
    console.log('✓ LinkedIn updated: removed requiresAuth, added cfProxy + Googlebot UA (in worker)');
  }

  // ------------------------------------------------------------------ Facebook
  if (site.name === 'Facebook') {
    // Route through CF Worker for edge IP attempt.
    // positiveMsg "__isProfile" is present on real profile pages from residential/edge IPs.
    site.cfProxy = true;
    delete site.undetectable;
    delete site.crawlerUA;
    delete site.cors;
    delete site.requiresAuth;
    changed++;
    console.log('✓ Facebook updated: added cfProxy');
  }
});

fs.writeFileSync(f, JSON.stringify(s, null, 2), { encoding: 'utf8' });
console.log(`\nDone. ${changed} sites updated.`);
console.log('Stats:', {
  total: s.length,
  cors: s.filter(x => x.cors).length,
  cfProxy: s.filter(x => x.cfProxy).length,
  requiresAuth: s.filter(x => x.requiresAuth).length,
});
