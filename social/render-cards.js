'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const png = require('./png-pixels');
const brandPath = path.join(__dirname, 'assets', 'original-brand.png');
const brandRaster = require('node:fs').readFileSync(brandPath);
const BRAND = Object.freeze({ x: 1000, y: 50, width: 130, height: 40, markerX: 120, markerY: 15, markerSize: 10 });
const STYLE = Object.freeze({
  width: 1200, height: 630, border: 10, grid: 32, headline: 72,
  paper: '#f7f5ed', ink: '#111', green: '#3ecf9e', yellow: '#ffca3a',
  blue: '#4c6fff', purple: '#8b5cf6', red: '#dc5e41', pilot: '#7aa7ff', lime: '#cdf040',
});

const cards = [
  {
    slug: 'probe-blog', kicker: 'FIELD NOTES', accent: STYLE.lime,
    title: 'THE<br>PROBE<br>LOG',
    deck: 'How PROBE measures results, handles<br>uncertainty, and keeps sources useful.',
    metric: '322', metricLabel: 'ACTIVE SOURCES',
    foot: 'usernameprobe.com/blog',
    stats: [['265', 'AUTOMATIC'], ['57', 'MANUAL ONLY']],
  },
  {
    slug: 'probe-roadmap', kicker: 'BUILD IN PUBLIC', accent: STYLE.yellow,
    title: 'THE ROAD<br>AHEAD',
    deck: 'What is working now,<br>and what comes next.',
    side: '<div class="timeline"><div><i class="green"></i><strong>Shipped</strong><span>Core search + live evidence</span></div><div><i class="amber"></i><strong>Pilot</strong><span>Public profile details</span></div><div><i class="paper"></i><strong>Next</strong><span>Source health + reliability</span></div></div>',
    foot: 'usernameprobe.com/roadmap',
    stats: [['Now', 'SHIPPED'], ['Next', 'PLANNED']],
  },
  {
    slug: 'profile-details-pilot', kicker: 'PILOT FEATURE', accent: STYLE.pilot,
    title: 'PROFILE<br>DETAILS,<br>CAREFULLY',
    deck: 'Pictures, names, and bios on found<br>results, proven before they are shown.',
    metric: '132', metricLabel: 'SOURCES WITH RULES',
    foot: 'Pilot write-up · 3 Oct 2026',
    stats: [['0', 'CONTROL LEAKS'], ['0', 'DETAILS STORED']],
  },
  {
    slug: 'checking-the-checks', kicker: 'ACCURACY UPDATE', accent: STYLE.green,
    title: 'CHECKING<br>THE<br>CHECKS',
    deck: 'Stale labels, moved endpoints,<br>and an honest denominator.',
    metric: '98.69%', metricLabel: 'DECISION ACCURACY',
    foot: 'Historical campaign · 2 Oct 2026',
    stats: [['95.87%', 'RECALL'], ['0', 'OBSERVED FALSE MATCHES']],
  },
  {
    slug: 'improving-accuracy-without-guessing', kicker: 'ACCURACY UPDATE', accent: STYLE.blue,
    title: 'ACCURACY<br>WITHOUT<br>GUESSING',
    deck: 'More clear answers. Better recall.<br>Zero observed false matches.',
    metric: '96.38%', metricLabel: 'DECISION ACCURACY',
    foot: 'Historical campaign · 28 Sep 2026',
    stats: [['75.92%', 'COVERAGE'], ['972', 'CONTROLS']],
  },
  {
    slug: 'measuring-username-search-accuracy', kicker: 'METHODOLOGY', accent: STYLE.blue,
    title: 'MEASURING<br>SEARCH<br>ACCURACY',
    deck: 'What 947 known examples reveal about<br>accuracy, coverage, and uncertainty.',
    metric: '95.34%', metricLabel: 'DECISION ACCURACY',
    foot: 'Historical campaign · 19 Sep 2026',
    stats: [['72.44%', 'COVERAGE'], ['947', 'CONTROLS']],
  },
  {
    slug: 'maintaining-a-source-catalog', kicker: 'KEEPING SOURCES CURRENT', accent: STYLE.yellow,
    title: 'MAINTAINING<br>322 ACTIVE<br>SOURCES',
    deck: 'Automatic checks and manual links,<br>tested as platforms change.',
    metric: '322', metricLabel: 'ACTIVE SOURCES',
    foot: 'usernameprobe.com/blog/maintaining-a-source-catalog',
    stats: [['265', 'AUTOMATIC'], ['57', 'MANUAL ONLY']],
  },
  {
    slug: 'what-your-username-doesnt-hide', kicker: 'PRIVACY', accent: STYLE.purple,
    title: 'WHAT YOUR<br>USERNAME<br>DOESN’T HIDE',
    deck: 'The clues you did not type on purpose<br>can still connect separate accounts.',
    metric: '3', metricLabel: 'HIDDEN SIGNAL LAYERS',
    foot: 'Privacy notes · 28 Sep 2026',
    stats: [['Signal', 'NOT PROOF'], ['Context', 'MATTERS']],
  },
  {
    slug: 'why-probe-abstains', kicker: 'DETECTION', accent: STYLE.red,
    title: 'UNKNOWN<br>IS AN<br>ANSWER',
    deck: 'A blocked or unclear page should<br>never become a confident guess.',
    metric: '0', metricLabel: 'OBSERVED FALSE MATCHES',
    foot: 'Historical campaign · 19 Sep 2026',
    stats: [['648', 'MISSING CONTROLS'], ['49', 'MANUAL ONLY']],
  },
  {
    slug: 'when-a-profile-field-stays-empty', kicker: 'READING RESULTS', accent: STYLE.yellow,
    title: 'WHEN A PROFILE<br>FIELD STAYS<br>EMPTY',
    deck: 'A blank bio is not<br>a missing account.',
    side: '<div class="panel"><strong class="words">LESS<br>DETAIL</strong><span>NOT MORE GUESSING</span></div>',
    foot: 'usernameprobe.com/blog',
    stats: [['Evidence', 'ACCOUNT VERDICT'], ['Context', 'PROFILE FIELDS']],
  },
  {
    slug: 'reading-an-accuracy-snapshot', kicker: 'MEASUREMENT NOTES', accent: STYLE.green,
    title: 'READING AN<br>ACCURACY<br>SNAPSHOT',
    deck: 'Keep the date, denominator,<br>and caveat together.',
    side: '<div class="panel"><strong class="ratio">620 / 772</strong><span>DECISIONS / CHECKS</span></div><p class="note">Saved campaign · 7 Oct 2026<br>265 automatic sources</p>',
    foot: 'Campaign diagnostics, not a future-search guarantee.',
    stats: [['129', 'CALIBRATION-ELIGIBLE'], ['152', 'ABSTENTIONS']],
  },
];

function template(card) {
  const side = card.side || `<div class="panel"><strong>${card.metric}</strong><span>${card.metricLabel}</span></div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px}
    body{border:${STYLE.border}px solid ${STYLE.ink};background-color:${STYLE.paper};background-image:linear-gradient(#0000000e 1px,transparent 1px),linear-gradient(90deg,#0000000e 1px,transparent 1px);background-size:${STYLE.grid}px ${STYLE.grid}px;background-origin:border-box;color:${STYLE.ink};font-family:Arial,Helvetica,sans-serif}
    .card{position:relative;height:610px;padding:55px 60px}
    .kicker{display:inline-block;margin:0;background:#111;color:white;padding:8px 15px;font-size:20px;font-weight:700;letter-spacing:.3px}
    .brand{position:absolute;left:990px;top:40px;width:130px;height:40px}.brand img{display:block;width:130px;height:40px}.brand:after{content:"";position:absolute;left:120px;top:15px;width:10px;height:10px;background:${card.accent}}
    h1{position:absolute;top:126px;left:60px;margin:0;font-size:${STYLE.headline}px;line-height:.86;letter-spacing:-3px;font-weight:700;width:715px}
    .deck{position:absolute;top:366px;left:60px;margin:0;font-size:29px;line-height:1.2}
    .side{position:absolute;right:60px;top:142px;width:300px}
    .panel{height:194px;border:4px solid #111;box-shadow:10px 10px #111;background:${card.accent};padding:44px 28px 15px}
    .panel strong{display:block;font-size:64px;line-height:1;font-weight:700;white-space:nowrap}.panel .words{font-size:47px;line-height:.95}.panel .ratio{font-size:43px;letter-spacing:-1px}
    .panel span{display:block;margin-top:21px;font-size:16px;font-weight:700;letter-spacing:1px;line-height:1.2}.panel:has(.words){padding-top:24px}.panel:has(.words) span{margin-top:16px}
    .note{font-size:16px;line-height:1.45;margin-top:28px;color:#444}
    .stats{position:absolute;right:60px;top:491px;width:300px;height:76px;display:flex;gap:12px}
    .stat{border-top:5px solid #111;flex:1;min-width:0;padding-top:7px}.stat strong{display:block;font-size:31px;line-height:1.15}.stat span{display:block;font-size:11px;line-height:1.2;font-weight:700;margin-top:3px}
    .foot{position:absolute;bottom:29px;left:60px;font-size:14px;color:#555;margin:0}
    .timeline{position:relative;margin-left:4px;padding:0 0 0 35px;border-left:4px solid #111}
    .timeline>div{position:relative;padding:0 0 33px}.timeline>div:last-child{padding-bottom:4px}
    .timeline i{position:absolute;left:-49px;top:3px;width:24px;height:24px;border:4px solid #111;border-radius:50%}
    .green{background:${STYLE.green}}.amber{background:${STYLE.yellow}}.paper{background:${STYLE.paper}}
    .timeline strong{display:block;font-size:30px;line-height:1.15}.timeline span{display:block;font-size:17px;line-height:1.35;margin-top:8px}
  </style></head><body><main class="card"><p class="kicker">${card.kicker}</p><div class="brand"><img alt="PROBE" src="data:image/png;base64,${brandRaster.toString('base64')}"></div><h1>${card.title}</h1><p class="deck">${card.deck}</p><div class="side">${side}</div><div class="stats">${card.stats.map(([value, label]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join('')}</div><p class="foot">${card.foot}</p></main></body></html>`;
}

function originalBrand(accent) {
  const image = png.decode(brandRaster);
  const color = Buffer.from(accent.slice(1), 'hex');
  for (let y = BRAND.markerY; y < BRAND.markerY + BRAND.markerSize; y++) {
    for (let x = BRAND.markerX; x < BRAND.markerX + BRAND.markerSize; x++) {
      color.copy(image.pixels, (y * image.width + x) * 4);
    }
  }
  return image;
}

async function render() {
  const layouts = [];
  const work = path.join(__dirname, '..', '.social-render-work');
  await fs.mkdir(work, { recursive: true });
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = process.env.TMP = work;
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(work, 'profile'), {
      headless: true, viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1, downloadsPath: work, tracesDir: work,
    });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    for (const card of cards) {
      await page.setContent(template(card));
      await page.locator('.brand img').evaluate(image => image.decode());
      const layout = await page.evaluate(() => {
        const elements = [...document.querySelectorAll('.kicker,h1,.deck,.side,.stats,.foot,.panel,.panel strong,.panel span,.stat,.stat strong,.stat span,.timeline strong,.timeline span')];
        const overflow = elements.filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.left < 10 || rect.top < 10 || rect.right > 1190 || rect.bottom > 620 || el.scrollWidth > el.clientWidth + 1 || (el.matches('.panel,.stats,.side') && el.scrollHeight > el.clientHeight + 1);
        }).map(el => el.className || el.tagName);
        const headline = document.querySelector('h1').getBoundingClientRect();
        const deck = document.querySelector('.deck').getBoundingClientRect();
        const side = document.querySelector('.side').getBoundingClientRect();
        const stats = document.querySelector('.stats').getBoundingClientRect();
        if (headline.bottom > deck.top || headline.right > side.left || side.bottom > stats.top - 12) overflow.push('overlapping content regions');
        const styles = selector => {
          const s = getComputedStyle(document.querySelector(selector));
          return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight };
        };
        return { overflow, headline: styles('h1'), deck: styles('.deck'), kicker: styles('.kicker'), stats: { x: stats.x, y: stats.y, width: stats.width, height: stats.height }, brand: { x: document.querySelector('.brand').getBoundingClientRect().x, y: document.querySelector('.brand').getBoundingClientRect().y } };
      });
      if (layout.overflow.length) throw new Error(`Card content overflows: ${card.slug}: ${layout.overflow.join(', ')}`);
      const output = png.decode(await page.screenshot());
      png.paste(output, originalBrand(card.accent), BRAND.x, BRAND.y);
      const encoded = png.encode(output);
      await fs.writeFile(path.join(__dirname, `${card.slug}.png`), encoded);
      layouts.push({
        slug: card.slug, ...layout,
        sourceSha256: createHash('sha256').update(template(card)).digest('hex'),
        imageSha256: createHash('sha256').update(encoded).digest('hex'),
      });
      console.log(`Rendered ${card.slug}.png (1200 × 630)`);
    }
    await fs.mkdir(path.join(__dirname, 'previews'), { recursive: true });
    await fs.writeFile(path.join(__dirname, 'previews', 'layout-checks.json'), `${JSON.stringify(layouts, null, 2)}\n`);
    const previews = await Promise.all(cards.map(async card => ({
      slug: card.slug, data: (await fs.readFile(path.join(__dirname, `${card.slug}.png`))).toString('base64'),
    })));
    await page.setViewportSize({ width: 1200, height: 960 });
    await page.setContent(`<html><head><style>*{box-sizing:border-box}body{margin:0;background:#ddd;display:grid;grid-template-columns:repeat(3,400px);font:14px Arial}figure{margin:0;height:240px}img{display:block;width:400px;height:210px}figcaption{height:30px;padding:8px;font-size:12px}</style></head><body>${previews.map(item => `<figure><img src="data:image/png;base64,${item.data}"><figcaption>${item.slug}</figcaption></figure>`).join('')}</body></html>`);
    await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await page.screenshot({ path: path.join(__dirname, 'previews', 'contact-sheet.png') });
  } finally {
    if (context) await context.close();
    for (const key of ['TEMP', 'TMP']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(work, { recursive: true, force: true });
  }
}

if (require.main === module) render().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { cards, template, STYLE, BRAND, originalBrand };
