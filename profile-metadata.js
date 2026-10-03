'use strict';

/*
 * Profile metadata for confirmed "found" results.
 *
 * Reads only the page the scan already fetched (no extra requests) and maps
 * standard schemas (Open Graph, Twitter cards, JSON-LD, microdata, embedded
 * app state, JSON API bodies) onto a fixed set of card fields. Which schema
 * is trusted per source comes from metadata-hints.json, which the accuracy
 * lab generates by comparing real accounts against random controls. Sources
 * without hints get nothing: the failure mode is "less detail", never
 * "wrong detail". Nothing here is stored.
 */

const fs = require('fs');
const path = require('path');

let cheerio = null;
const loadCheerio = () => (cheerio = cheerio || require('cheerio'));

const FIELDS = ['picture', 'name', 'bio', 'location', 'links', 'joined', 'followers'];
const HEAD_SCHEMAS = new Set(['open_graph', 'twitter_card', 'meta', 'html_title']);
const MAX_EXTENDED_BYTES = 524288;
const LIMITS = { name: 80, bio: 280, location: 80 };
const DEFAULT_IMAGE_PATTERN = /(^|[\/_.-])(logo|default|placeholder|favicon|apple-touch|no[-_]?avatar|blank|missing|og[-_]?image|og[-_]?default|share[-_]?image|social[-_]?(card|image|share))([\/_.-]|$)/i;

/* ── Field helpers ─────────────────────────────────────────────────── */

const clean = value => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text : null;
};

const KEY_MAP = {
  picture: ['avatar', 'avatarurl', 'avatarurlhttps', 'avatarlarger', 'avatarmedium', 'avatarthumb', 'avatarlarge', 'avatarfull', 'avatarimage', 'avatarimageurl', 'profileimage', 'profileimageurl', 'profileimageurlhttps', 'profilepicurl', 'profilepicurlhd', 'profilepicture', 'profilephoto', 'photo', 'photourl', 'picture', 'pictureurl', 'image', 'imageurl', 'icon', 'iconimg', 'iconurl', 'userpic', 'thumbnail', 'thumbnailurl'],
  name: ['displayname', 'fullname', 'realname', 'name', 'nickname', 'nick', 'screenname', 'publicname', 'title'],
  bio: ['bio', 'biography', 'description', 'about', 'aboutme', 'summary', 'signature', 'tagline', 'headline', 'publicdescription', 'status', 'intro', 'profiledescription', 'shortbio', 'blurb'],
  location: ['location', 'city', 'country', 'region', 'locality', 'hometown', 'place'],
  links: ['website', 'websiteurl', 'blog', 'homepage', 'homepageurl', 'links', 'externalurl', 'sameas', 'socials'],
  joined: ['createdat', 'created', 'createdutc', 'createdon', 'creationdate', 'datecreated', 'joined', 'joinedat', 'joindate', 'joinedon', 'registered', 'registeredat', 'registrationdate', 'membersince', 'signupdate', 'memberdate'],
  followers: ['followers', 'followerscount', 'followercount', 'numfollowers', 'followerstotal', 'subscribers', 'subscriberscount', 'subscribercount', 'fans', 'fanscount', 'watchers'],
};
const KEY_LOOKUP = {};
for (const [field, keys] of Object.entries(KEY_MAP)) keys.forEach(k => { if (!KEY_LOOKUP[k]) KEY_LOOKUP[k] = field; });
const USERNAME_KEYS = new Set(['username', 'login', 'screenname', 'handle', 'slug', 'username', 'nickname', 'uniqueid', 'acct', 'preferredusername', 'name', 'user', 'account', 'accountname', 'profilename', 'vanity', 'customurl', 'urlkey', 'userslug', 'nick']);
const normKey = key => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

function scalarFor(field, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = clean(value);
    if (!text) return null;
    if (field === 'followers' && !/^\d[\d,.\s]*[kKmM]?$/.test(text)) return null;
    if (field === 'picture' && !/^(https?:)?\/\/|^\//.test(text)) return null;
    return text;
  }
  if (Array.isArray(value)) {
    if (field === 'links') {
      const list = value.map(v => (typeof v === 'string' ? v : v && (v.url || v.href || v.link))).filter(v => typeof v === 'string' && /^https?:/.test(v));
      return list.length ? list.slice(0, 5).join(' | ') : null;
    }
    return null;
  }
  if (typeof value === 'object') {
    if (field === 'picture') return scalarFor(field, value.url || value.src || value.large || value.medium || value.original || value.href || (Array.isArray(value.urlList) && value.urlList[0]) || (Array.isArray(value.url_list) && value.url_list[0]));
    if (field === 'location') return scalarFor(field, value.name || value.city || value.addressLocality || value.country);
    if (field === 'followers') return scalarFor(field, value.count || value.total || value.totalCount);
  }
  return null;
}

function mapObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const field = KEY_LOOKUP[normKey(key)];
    if (!field || out[field]) continue;
    const scalar = scalarFor(field, value);
    if (scalar) out[field] = { value: scalar, key };
  }
  return out;
}

/* Finds the object most likely describing the requested user: it must carry
 * the username under a username-like key, ranked by mappable field count. */
function findUserObject(root, username) {
  const target = username.toLowerCase();
  let best = null;
  let visited = 0;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 14 || visited > 60000) return;
    visited++;
    if (Array.isArray(node)) { node.slice(0, 200).forEach(child => walk(child, depth + 1)); return; }
    const hasUsername = Object.entries(node).some(([k, v]) => typeof v === 'string' && v.toLowerCase().replace(/^@/, '') === target && USERNAME_KEYS.has(normKey(k)));
    if (hasUsername) {
      const mapped = mapObject(node);
      const score = Object.keys(mapped).length;
      if (!best || score > best.score) best = { score, mapped };
    }
    for (const child of Object.values(node)) if (child && typeof child === 'object') walk(child, depth + 1);
  };
  walk(root, 0);
  return best;
}

/* ── Schema extractors ─────────────────────────────────────────────── */

function isSelfLink(link, siteHost) {
  try {
    const host = new URL(link).hostname.replace(/^www\./, '');
    return host === siteHost || host.endsWith(`.${siteHost}`) || /^api\./.test(host);
  } catch (_) { return true; }
}

function extractAll(body, contentType, username, siteHost = '') {
  const schemas = {};
  const put = (schema, field, value, detail) => {
    let text = scalarFor(field, value);
    if (text && field === 'links') {
      text = text.split(' | ').filter(link => !isSelfLink(link, siteHost)).join(' | ') || null;
    }
    if (!text) return;
    schemas[schema] = schemas[schema] || {};
    if (!schemas[schema][field]) schemas[schema][field] = { value: text, ...(detail ? { detail } : {}) };
  };

  const trimmed = body.trimStart();
  if (/json/i.test(contentType) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed);
      const user = findUserObject(json, username);
      const mapped = user ? user.mapped : (json && typeof json === 'object' && !Array.isArray(json) ? mapObject(json.data && typeof json.data === 'object' ? json.data : json) : {});
      for (const [field, entry] of Object.entries(mapped)) put('json_api', field, entry.value, entry.key);
      return { schemas, signals: { isJson: true, userObjectMatched: Boolean(user) } };
    } catch (_) { /* fall through to HTML */ }
  }

  const $ = loadCheerio().load(body);
  const meta = name => clean($(`meta[property="${name}"]`).attr('content')) || clean($(`meta[name="${name}"]`).attr('content'));

  put('open_graph', 'picture', meta('og:image') || meta('og:image:url') || meta('og:image:secure_url'));
  put('open_graph', 'name', meta('og:title'));
  put('open_graph', 'bio', meta('og:description'));
  const first = meta('profile:first_name');
  const last = meta('profile:last_name');
  if (first || last) put('open_graph', 'name', [first, last].filter(Boolean).join(' '), 'profile:first/last_name');
  const ogType = meta('og:type');
  const profileUsername = meta('profile:username');

  put('twitter_card', 'picture', meta('twitter:image') || meta('twitter:image:src'));
  put('twitter_card', 'name', meta('twitter:title'));
  put('twitter_card', 'bio', meta('twitter:description'));

  put('meta', 'bio', meta('description'));
  put('meta', 'name', meta('author'));
  put('html_title', 'name', $('title').first().text());

  const relMe = $('a[rel~="me"], link[rel~="me"]').map((_, el) => $(el).attr('href')).get().filter(h => /^https?:/.test(h || ''));
  if (relMe.length) put('link_rel', 'links', relMe);
  put('link_rel', 'picture', $('link[rel="image_src"]').attr('href'));

  // JSON-LD: Person / ProfilePage.mainEntity / Organization
  const ldTypes = new Set();
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text()); } catch (_) { return; }
    const nodes = [];
    const collect = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(collect); return; }
      if (node['@graph']) collect(node['@graph']);
      nodes.push(node);
      if (node.mainEntity) collect(node.mainEntity);
      if (node.author && typeof node.author === 'object') collect(node.author);
    };
    collect(data);
    for (const node of nodes) {
      const types = [].concat(node['@type'] || []).map(String);
      types.forEach(t => ldTypes.add(t));
      if (!types.some(t => /^(Person|Organization|ProfilePage)$/.test(t))) continue;
      if (types.includes('ProfilePage') && !node.name && !node.description) continue;
      put('json_ld', 'name', node.name || node.alternateName, types.join(','));
      put('json_ld', 'bio', node.description);
      put('json_ld', 'picture', node.image || node.logo);
      put('json_ld', 'location', node.homeLocation || node.address || node.location);
      put('json_ld', 'links', [].concat(node.sameAs || [], node.url || []));
      put('json_ld', 'joined', node.dateCreated || node.foundingDate);
      const stats = [].concat(node.interactionStatistic || []);
      const followers = stats.find(s => /Follow|Subscribe/i.test(JSON.stringify(s.interactionType || '')));
      if (followers) put('json_ld', 'followers', followers.userInteractionCount);
    }
  });

  // Microdata Person
  $('[itemscope][itemtype*="schema.org/Person"]').first().each((_, scope) => {
    const prop = name => {
      const el = $(scope).find(`[itemprop="${name}"]`).first();
      return el.length ? clean(el.attr('content') || el.attr('src') || el.attr('href') || el.text()) : null;
    };
    put('microdata', 'name', prop('name'));
    put('microdata', 'bio', prop('description'));
    put('microdata', 'picture', prop('image'));
    put('microdata', 'location', prop('homeLocation') || prop('address'));
  });

  // Embedded app state that parses as plain JSON
  const embeddedSources = [];
  $('script#__NEXT_DATA__, script[type="application/json"], script#__UNIVERSAL_DATA_FOR_REHYDRATION__, script#__NUXT_DATA__').each((_, el) => {
    const id = $(el).attr('id') || $(el).attr('data-target') || 'application/json';
    try { embeddedSources.push({ id, json: JSON.parse($(el).contents().text()) }); } catch (_) { /* ignore */ }
  });
  let embeddedMatched = null;
  for (const source of embeddedSources) {
    const user = findUserObject(source.json, username);
    if (user && (!embeddedMatched || user.score > embeddedMatched.score)) embeddedMatched = { ...user, id: source.id };
  }
  if (embeddedMatched) for (const [field, entry] of Object.entries(embeddedMatched.mapped)) put('embedded_json', field, entry.value, `${embeddedMatched.id}:${entry.key}`);

  const html = body;
  const signals = {
    isJson: false,
    ogType,
    profileUsername,
    jsonLdTypes: [...ldTypes],
    embeddedStateIds: embeddedSources.map(s => s.id),
    embeddedUserMatched: Boolean(embeddedMatched),
    oembed: $('link[type="application/json+oembed"]').attr('href') || null,
    unparsedStateMarkers: ['__INITIAL_STATE__', '__APOLLO_STATE__', '__PRELOADED_STATE__', '__NUXT__', 'window.__data', '__remixContext', 'self.__next_f'].filter(m => html.includes(m)),
    usernameInBody: html.toLowerCase().includes(username.toLowerCase()),
    scriptCount: $('script').length,
    textLength: clean($('body').text())?.length || 0,
  };
  return { schemas, signals };
}

/* ── Hints ─────────────────────────────────────────────────────────── */

const HINTS_PATH = path.join(__dirname, 'metadata-hints.json');
let hints = { sites: {} };
try {
  hints = JSON.parse(fs.readFileSync(HINTS_PATH, 'utf8'));
  if (!hints || typeof hints.sites !== 'object') hints = { sites: {} };
} catch (_) { /* no hints → no metadata */ }

function setHints(next) { hints = next && typeof next.sites === 'object' ? next : { sites: {} }; }
function hintFor(site) { return (site && hints.sites[site.name]) || null; }

/* How much of the response the scan should read for this source. The first
 * MAX_BODY bytes still drive classification; extra bytes are only read once
 * the result is already "found", and reading stops at </head> when every
 * trusted schema lives in the head. */
function readPlan(site) {
  const hint = hintFor(site);
  if (!hint || !hint.maxBytes) return null;
  return { maxBytes: Math.min(hint.maxBytes, MAX_EXTENDED_BYTES), headOnly: Boolean(hint.headOnly) };
}

/* ── Value finalisation ────────────────────────────────────────────── */

const stripTags = text => text.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const fromCodePoint = n => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
const decodeEntities = text => text
  .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d{1,7});/g, (_, dec) => fromCodePoint(Number(dec)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => NAMED_ENTITIES[name]);
const PLACEHOLDER_NAMES = new Set(['private', 'anonymous', 'user', 'unknown', 'null', 'undefined', 'n/a']);

function applyTemplate(value, rule, username) {
  if (rule.prefix === undefined && rule.suffix === undefined) return value;
  const prefix = (rule.prefix || '').replace(/\{u\}/g, username);
  const suffix = (rule.suffix || '').replace(/\{u\}/g, username);
  const lower = value.toLowerCase();
  if (!lower.startsWith(prefix.toLowerCase()) || !lower.endsWith(suffix.toLowerCase())) return null;
  if (value.length <= prefix.length + suffix.length) return null;
  return value.slice(prefix.length, value.length - suffix.length);
}

function cleanName(value, username, site) {
  const u = escapeRegExp(username);
  let name = value
    .replace(new RegExp(`\\s*[(\\[]\\s*@?${u}\\s*[)\\]]`, 'ig'), '')
    .replace(new RegExp(`(^|\\s)@${u}(?=\\s|$)`, 'ig'), ' ')
    .replace(/^[\s|·:\-–—,]+|[\s|·:\-–—,]+$/g, '')
    .trim();
  for (const brand of siteBrands(site)) {
    name = name.replace(new RegExp(`\\s+[|·:\\-–—]\\s*${escapeRegExp(brand)}\\s*$`, 'i'), '').trim();
  }
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower === username.toLowerCase() || PLACEHOLDER_NAMES.has(lower)) return null;
  if (siteBrands(site).some(brand => lower === brand.toLowerCase())) return null;
  return truncate(name, LIMITS.name);
}

// Trailing " - CNET" / " | OK" style brand suffixes: the catalog name and the
// first label of the site's host.
function siteBrands(site) {
  if (!site) return [];
  const brands = new Set([String(site.name || '').trim()]);
  const host = hostOf(site);
  if (host) brands.add(host.split('.')[0]);
  return [...brands].filter(brand => brand.length >= 2);
}

function absoluteHttps(raw, pageUrl) {
  let url;
  try { url = new URL(raw, pageUrl); } catch (_) { return null; }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.href.length > 2048) return null;
  return url.href;
}

function normaliseDate(raw) {
  const text = String(raw).trim();
  let date;
  if (/^\d{9,13}$/.test(text)) {
    const n = Number(text);
    date = new Date(text.length <= 10 ? n * 1000 : n);
  } else {
    date = new Date(text);
  }
  const t = date.getTime();
  if (!Number.isFinite(t) || t < Date.UTC(1995, 0, 1) || t > Date.now() + 86400000) return null;
  return date.toISOString().slice(0, 10);
}

function normaliseCount(raw) {
  const text = String(raw).replace(/[,\s]/g, '');
  const m = text.match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function finalise(field, raw, rule, ctx) {
  const reject = new Set((ctx.hint.rejectValues && ctx.hint.rejectValues[field]) || []);
  if (reject.has(raw)) return null;
  let value = stripTags(decodeEntities(String(raw)));
  if (!value || reject.has(value)) return null;
  if (field === 'name' || field === 'bio' || field === 'location') {
    value = applyTemplate(value, rule, ctx.username);
    if (!value) return null;
    value = value.trim();
  }
  switch (field) {
    case 'name': return cleanName(value, ctx.username, ctx.site);
    case 'bio': {
      const lower = value.toLowerCase().replace(/^@/, '');
      if (value.length < 2 || lower === ctx.username.toLowerCase() || /^\d+$/.test(value)) return null;
      return truncate(value, LIMITS.bio);
    }
    case 'location': return truncate(value, LIMITS.location);
    case 'picture': {
      const url = absoluteHttps(String(raw).trim(), ctx.pageUrl);
      if (!url || reject.has(url)) return null;
      let pathname = '';
      try { pathname = new URL(url).pathname; } catch (_) { return null; }
      return DEFAULT_IMAGE_PATTERN.test(pathname) ? null : url;
    }
    case 'links': {
      const list = String(raw).split(' | ')
        .map(link => absoluteHttps(decodeEntities(link.trim()), ctx.pageUrl))
        .filter(link => link && link.indexOf('://') === link.lastIndexOf('://'));
      return list.length ? [...new Set(list)].slice(0, 5) : null;
    }
    case 'joined': return normaliseDate(raw);
    case 'followers': return normaliseCount(raw);
    default: return null;
  }
}

function headSlice(body) {
  const end = body.search(/<\/head\s*>/i);
  return end > 0 ? body.slice(0, end + 7) : body;
}

/* Returns { picture?, name?, bio?, location?, links?, joined?, followers? }
 * or null. Only call for results already classified as found. */
function extractProfile(site, username, body, contentType, pageUrl) {
  return extractWith(hintFor(site), site, username, body, contentType, pageUrl);
}

/* The follow-up GET for fields the scan page cannot supply, or null when the
 * source has none or the scan already filled every field it would add. */
function followUpPlan(site, username, profile) {
  const hint = hintFor(site);
  const followUp = hint && hint.followUp;
  if (!followUp || !followUp.fields || typeof followUp.url !== 'string') return null;
  if (!Object.keys(followUp.fields).some(field => !profile || profile[field] === undefined)) return null;
  let url;
  try { url = new URL(followUp.url.replace(/\{\}/g, encodeURIComponent(username))); } catch (_) { return null; }
  if (url.protocol !== 'https:') return null;
  return {
    url: url.href,
    maxBytes: Math.min(followUp.maxBytes || MAX_EXTENDED_BYTES, MAX_EXTENDED_BYTES),
    headOnly: Boolean(followUp.headOnly),
  };
}

/* Fills fields missing from the scan-page profile using the follow-up
 * response. A response that never mentions the username (a login wall or a
 * generic landing page) contributes nothing. */
function mergeFollowUp(site, username, profile, body, contentType, pageUrl) {
  const hint = hintFor(site);
  if (!hint || !hint.followUp || !body || !body.toLowerCase().includes(username.toLowerCase())) return profile;
  const extra = extractWith(hint.followUp, site, username, body, contentType, pageUrl);
  if (!extra) return profile;
  const merged = { ...(profile || {}) };
  for (const field of FIELDS) {
    if (merged[field] === undefined && extra[field] !== undefined) merged[field] = extra[field];
  }
  if (merged.bio && merged.name && merged.bio === merged.name) delete merged.bio;
  const ordered = {};
  FIELDS.forEach(field => { if (merged[field] !== undefined) ordered[field] = merged[field]; });
  return Object.keys(ordered).length ? ordered : null;
}

function extractWith(hint, site, username, body, contentType, pageUrl) {
  if (!hint || !hint.fields || !Object.keys(hint.fields).length || !body) return null;
  const source = hint.headOnly ? headSlice(body) : body;
  let schemas;
  try {
    schemas = extractAll(source, contentType || '', username, hostOf(site)).schemas;
  } catch (_) {
    return null;
  }
  const ctx = { site, username, hint, pageUrl: pageUrl || site.url.replace(/\{\}/g, encodeURIComponent(username)) };
  const profile = {};
  for (const field of FIELDS) {
    const rules = hint.fields[field];
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      const raw = schemas[rule.schema] && schemas[rule.schema][field] && schemas[rule.schema][field].value;
      if (!raw) continue;
      const value = finalise(field, raw, rule, ctx);
      if (value !== null && value !== undefined) { profile[field] = value; break; }
    }
  }
  if (profile.bio && profile.name && profile.bio === profile.name) delete profile.bio;
  return Object.keys(profile).length ? profile : null;
}

function hostOf(site) {
  try { return new URL(String(site.url).replace(/\{\}/g, 'x')).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

module.exports = {
  FIELDS,
  HEAD_SCHEMAS,
  MAX_EXTENDED_BYTES,
  extractAll,
  extractProfile,
  findUserObject,
  followUpPlan,
  hintFor,
  mapObject,
  mergeFollowUp,
  readPlan,
  setHints,
};
