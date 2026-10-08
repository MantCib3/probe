'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const cheerio = require('cheerio');
const { cards, template, STYLE, BRAND, originalBrand } = require('../social/render-cards');
const png = require('../social/png-pixels');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file));
const hash = data => createHash('sha256').update(data).digest('hex');
const originalSlugs = [
  'probe-blog', 'probe-roadmap', 'profile-details-pilot', 'checking-the-checks',
  'improving-accuracy-without-guessing', 'measuring-username-search-accuracy',
  'maintaining-a-source-catalog', 'what-your-username-doesnt-hide', 'why-probe-abstains',
];

test('reproducible renderer includes every original and new social card exactly once', () => {
  const files = fs.readdirSync(path.join(root, 'social')).filter(file => file.endsWith('.png')).sort();
  assert.equal(cards.length, 11);
  assert.equal(new Set(cards.map(card => card.slug)).size, cards.length);
  assert.deepEqual(files, cards.map(card => `${card.slug}.png`).sort());
  for (const slug of originalSlugs) assert.ok(cards.some(card => card.slug === slug), slug);
});

test('brand reference retains original raster pixels, not a re-typeset approximation', () => {
  const reference = png.decode(read('social/assets/original-brand.png'));
  assert.equal(reference.width, 130);
  assert.equal(reference.height, 40);
  assert.equal(hash(reference.pixels), 'e5012788289fe44b196b1b56b4100125ca5dc03017026c892285459bcdd3f3ed');
  assert.deepEqual(png.decode(png.encode(reference)), reference);
  for (const card of cards) {
    const image = png.decode(read(`social/${card.slug}.png`));
    assert.equal(image.width, STYLE.width);
    assert.equal(image.height, STYLE.height);
    const brand = png.crop(image, BRAND.x, BRAND.y, BRAND.width, BRAND.height);
    assert.deepEqual(brand.pixels, originalBrand(card.accent).pixels, `${card.slug}: original wordmark and exact marker geometry`);
    for (const [x, referenceX] of [[1000, 0], [992, 24]]) {
      assert.deepEqual(
        image.pixels.subarray((55 * image.width + x) * 4, (55 * image.width + x) * 4 + 4),
        reference.pixels.subarray((5 * reference.width + referenceX) * 4, (5 * reference.width + referenceX) * 4 + 4),
        `${card.slug}: original paper/grid continues seamlessly around the brand`,
      );
    }
    for (const [x, y] of [[0, 0], [1199, 0], [0, 629], [1199, 629], [5, 315], [600, 5]]) {
      assert.deepEqual([...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)], [17, 17, 17, 255], `${card.slug}: border`);
    }
  }
});

test('every rendered card passes shared typography, geometry and overflow checks against its current source', () => {
  const checks = JSON.parse(read('social/previews/layout-checks.json'));
  assert.deepEqual(checks.map(check => check.slug), cards.map(card => card.slug));
  for (const card of cards) {
    const check = checks.find(item => item.slug === card.slug);
    assert.deepEqual(check.overflow, [], card.slug);
    assert.deepEqual(check.headline, { fontSize: '72px', fontWeight: '700', lineHeight: '61.92px' });
    assert.deepEqual(check.deck, { fontSize: '29px', fontWeight: '400', lineHeight: '34.8px' });
    assert.deepEqual(check.kicker, { fontSize: '20px', fontWeight: '700', lineHeight: 'normal' });
    assert.deepEqual(check.brand, { x: BRAND.x, y: BRAND.y });
    assert.deepEqual(check.stats, { x: 830, y: 501, width: 300, height: 76 });
    assert.equal(check.sourceSha256, hash(template(card)), `${card.slug}: rerender after source changes`);
    assert.equal(check.imageSha256, hash(read(`social/${card.slug}.png`)), `${card.slug}: output matches checked render`);
  }
});

test('all card owners use one new cache version consistently across OG, Twitter and structured data', () => {
  for (const card of cards) {
    const file = card.slug === 'probe-blog' ? 'blog/index.html' : card.slug === 'probe-roadmap' ? 'roadmap.html' : `blog/${card.slug}.html`;
    const $ = cheerio.load(read(file).toString());
    const image = `https://usernameprobe.com/social/${card.slug}.png?v=7`;
    for (const selector of ['meta[property="og:image"]', 'meta[property="og:image:secure_url"]', 'meta[name="twitter:image"]']) assert.equal($(selector).attr('content'), image, `${file}: ${selector}`);
    const structured = JSON.parse($('script[type="application/ld+json"]').text());
    if (structured.image) assert.equal(structured.image, image);
  }
});

test('historical measurements are preserved and identified as historical on their cards', () => {
  const bySlug = Object.fromEntries(cards.map(card => [card.slug, card]));
  for (const [slug, metric, firstStat, secondStat] of [
    ['checking-the-checks', '98.69%', '95.87%', '0'],
    ['improving-accuracy-without-guessing', '96.38%', '75.92%', '972'],
    ['measuring-username-search-accuracy', '95.34%', '72.44%', '947'],
    ['why-probe-abstains', '0', '648', '49'],
  ]) {
    assert.equal(bySlug[slug].metric, metric);
    assert.equal(bySlug[slug].stats[0][0], firstStat);
    assert.equal(bySlug[slug].stats[1][0], secondStat);
    assert.match(bySlug[slug].foot, /^Historical campaign ·/);
  }
  assert.equal(bySlug['profile-details-pilot'].metric, '132');
  assert.match(bySlug['profile-details-pilot'].foot, /3 Oct 2026/);
  assert.equal(bySlug['reading-an-accuracy-snapshot'].stats[0][0], '129');
});
