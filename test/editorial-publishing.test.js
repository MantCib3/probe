'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const cheerio = require('cheerio');

const root = path.join(__dirname, '..');
const slugs = ['when-a-profile-field-stays-empty', 'reading-an-accuracy-snapshot'];
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('new articles have consistent SEO, discovery links and local assets', () => {
  const index = cheerio.load(read('blog/index.html'));
  const blog = JSON.parse(index('script[type="application/ld+json"]').text());
  for (const slug of slugs) {
    const canonical = `https://usernameprobe.com/blog/${slug}`;
    const $ = cheerio.load(read(`blog/${slug}.html`));
    const structured = JSON.parse($('script[type="application/ld+json"]').text());
    assert.equal($('link[rel="canonical"]').attr('href'), canonical);
    assert.equal($('meta[property="og:url"]').attr('content'), canonical);
    assert.equal(structured.url, canonical);
    assert.equal(structured.mainEntityOfPage, canonical);
    assert.equal(structured.headline, $('h1').text());
    assert.equal(structured.datePublished, '2026-10-07');
    const image = `https://usernameprobe.com/social/${slug}.png?v=7`;
    for (const selector of ['meta[property="og:image"]', 'meta[property="og:image:secure_url"]', 'meta[name="twitter:image"]']) {
      assert.equal($(selector).attr('content'), image);
    }
    assert.equal(structured.image, image);
    assert.ok($('meta[property="og:image:alt"]').attr('content'));
    assert.ok($('meta[name="twitter:image:alt"]').attr('content'));
    assert.equal(index(`.post-row[href="/blog/${slug}"]`).length, 1);
    assert.ok(blog.blogPost.some(post => post.url === canonical));
    assert.ok(read('sitemap.xml').includes(`<loc>${canonical}</loc>`));
    assert.ok(read('llms.txt').includes(canonical));
    assert.ok(read('social/captions.txt').includes(canonical));
    for (const element of $('link[href^="/"],script[src^="/"]').toArray()) {
      const asset = $(element).attr('href') || $(element).attr('src');
      assert.ok(fs.existsSync(path.join(root, asset.split('?')[0])), asset);
    }
    const netlify = read('netlify.toml');
    assert.ok(netlify.includes(`from = "/blog/${slug}.html"\n  to = "/blog/${slug}"\n  status = 301`));
    assert.ok(netlify.includes(`from = "/blog/${slug}"\n  to = "/blog/${slug}.html"\n  status = 200`));
  }
});

test('cards have 1200 by 630 PNG dimensions and roadmap cache metadata is updated', () => {
  for (const slug of ['probe-roadmap', ...slugs]) {
    const png = fs.readFileSync(path.join(root, 'social', `${slug}.png`));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
  }
  const $ = cheerio.load(read('roadmap.html'));
  assert.equal($('meta[property="og:image"]').attr('content'), 'https://usernameprobe.com/social/probe-roadmap.png?v=7');
  assert.equal($('meta[name="twitter:image"]').attr('content'), $('meta[property="og:image"]').attr('content'));
  const source = read('social/render-cards.js');
  assert.ok(source.includes('class="timeline"'));
  assert.ok(!source.includes('ROADMAP STAGES'));
  assert.ok(source.includes('original-brand.png'));
  assert.ok(source.includes('font-size:${STYLE.headline}px;line-height:.86;letter-spacing:-3px;font-weight:700'));
});

test('snapshot and captions preserve diagnostic limitations and correct arithmetic', () => {
  const article = cheerio.load(read('blog/reading-an-accuracy-snapshot.html'))('.article-copy').text();
  for (const value of ['772', '265', '620', '152', '129', '643', '99', '30', '98.71%', '80.31%']) assert.ok(article.includes(value), value);
  assert.equal(((186 + 426) / 620 * 100).toFixed(2), '98.71');
  assert.equal((620 / 772 * 100).toFixed(2), '80.31');
  assert.ok(article.includes('No new campaign was run'));
  assert.ok(article.includes('not a guarantee for future searches'));
  assert.ok(article.includes('definitive held-out accuracy estimate'));
  assert.ok(read('social/captions.txt').includes('Only 129 rows were calibration-eligible'));
});

test('new clean routes, legacy redirects and PNGs are delivered by the local server', async t => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: { ...process.env, PORT: '0', RENDER: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  let output = '';
  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Preview failed to start: ${output}`)), 120000);
    const fail = error => { clearTimeout(timeout); reject(error); };
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`Preview exited ${code}: ${output}`)));
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  for (const slug of slugs) {
    for (const method of ['GET', 'HEAD']) {
      const page = await fetch(`${origin}/blog/${slug}`, { method });
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /^text\/html/);
      assert.match(page.headers.get('cache-control'), /no-store/);
      if (method === 'GET') assert.ok((await page.text()).includes(`https://usernameprobe.com/blog/${slug}`));
      const legacy = await fetch(`${origin}/blog/${slug}.html`, { method, redirect: 'manual' });
      assert.equal(legacy.status, 301);
      assert.equal(legacy.headers.get('location'), `/blog/${slug}`);
    }
  }
  for (const slug of ['probe-roadmap', ...slugs]) {
    const image = await fetch(`${origin}/social/${slug}.png?v=3`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.ok((await image.arrayBuffer()).byteLength > 1000);
  }
  const generator = await fetch(`${origin}/social/render-cards.js`);
  assert.equal(generator.status, 404);
});
