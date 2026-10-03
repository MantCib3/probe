'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const metadata = require('../profile-metadata');
const { probeWithDeadline } = require('../server');

const SITE = { name: 'Example', category: 'test', url: 'https://example.com/u/{}' };
const ogPage = tags => `<html><head><title>alice</title>${tags}</head><body>alice</body></html>`;

function withHints(t, sites) {
  metadata.setHints({ sites });
  t.after(() => metadata.setHints(JSON.parse(require('node:fs').readFileSync(require.resolve('../metadata-hints.json'), 'utf8'))));
}

test('no hint for a source means no profile', t => {
  withHints(t, {});
  assert.equal(metadata.extractProfile(SITE, 'alice', ogPage('<meta property="og:title" content="Alice Smith">'), 'text/html', SITE.url), null);
});

test('template, brand suffix, placeholders and entities are cleaned', t => {
  withHints(t, {
    Example: {
      fields: {
        name: [{ schema: 'open_graph', prefix: '', suffix: ' on Example ({u})' }],
        bio: [{ schema: 'meta' }],
      },
    },
  });
  const page = ogPage('<meta property="og:title" content="Alice Smith on Example (alice)"><meta name="description" content="I like &amp;#x2F; tea">');
  assert.deepEqual(metadata.extractProfile(SITE, 'alice', page, 'text/html', 'https://example.com/u/alice'), {
    name: 'Alice Smith',
    bio: 'I like / tea',
  });

  withHints(t, { Example: { fields: { name: [{ schema: 'open_graph' }] } } });
  const branded = ogPage('<meta property="og:title" content="Alice Smith - Example">');
  assert.deepEqual(metadata.extractProfile(SITE, 'alice', branded, 'text/html', SITE.url), { name: 'Alice Smith' });
  for (const junk of ['Private', 'alice', 'Example']) {
    const page2 = ogPage(`<meta property="og:title" content="${junk}">`);
    assert.equal(metadata.extractProfile(SITE, 'alice', page2, 'text/html', SITE.url), null, junk);
  }
});

test('template mismatch drops the value instead of guessing', t => {
  withHints(t, { Example: { fields: { name: [{ schema: 'open_graph', prefix: 'Profile of ', suffix: '' }] } } });
  const page = ogPage('<meta property="og:title" content="Sign up to see more">');
  assert.equal(metadata.extractProfile(SITE, 'alice', page, 'text/html', SITE.url), null);
});

test('pictures must be https, non-default and not rejected', t => {
  withHints(t, {
    Example: {
      fields: { picture: [{ schema: 'open_graph' }] },
      rejectValues: { picture: ['https://cdn.example.com/a/generic.png'] },
    },
  });
  const pic = url => metadata.extractProfile(SITE, 'alice', ogPage(`<meta property="og:image" content="${url}">`), 'text/html', SITE.url);
  assert.deepEqual(pic('/avatars/alice.jpg'), { picture: 'https://example.com/avatars/alice.jpg' });
  assert.deepEqual(pic('http://cdn.example.com/alice.jpg'), { picture: 'https://cdn.example.com/alice.jpg' });
  assert.equal(pic('https://cdn.example.com/static/default-avatar.png'), null);
  assert.equal(pic('https://cdn.example.com/a/generic.png'), null);
  assert.equal(pic('javascript:alert(1)'), null);
  assert.equal(pic('data:image/png;base64,AAAA'), null);
});

test('rejected control values, numeric and username bios are dropped', t => {
  withHints(t, { Example: { fields: { bio: [{ schema: 'meta' }] }, rejectValues: { bio: ['Join Example today'] } } });
  const bio = text => metadata.extractProfile(SITE, 'alice', ogPage(`<meta name="description" content="${text}">`), 'text/html', SITE.url);
  assert.equal(bio('Join Example today'), null);
  assert.equal(bio('304'), null);
  assert.equal(bio('@alice'), null);
  assert.deepEqual(bio('Painter & potter'), { bio: 'Painter & potter' });
});

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

test('a found result keeps reading past 32 KB to reach profile tags', async t => {
  const filler = `<meta name="filler" content="${'x'.repeat(40000)}">`;
  const port = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(ogPage(`${filler}<meta property="og:title" content="Alice Smith"><meta property="og:image" content="https://cdn.example.com/alice.jpg">`));
  });
  const site = { name: 'Local', category: 'test', url: `http://127.0.0.1:${port}/u/{}` };
  withHints(t, { Local: { fields: { name: [{ schema: 'open_graph' }], picture: [{ schema: 'open_graph' }] }, headOnly: true, maxBytes: 131072 } });

  const result = await probeWithDeadline(site, 'alice', 5000).promise;
  assert.equal(result.status, 'found');
  assert.deepEqual(result.profile, { picture: 'https://cdn.example.com/alice.jpg', name: 'Alice Smith' });
});

test('a not-found result never reads past the classification window or gets a profile', async t => {
  let written = 0;
  const port = await serve(t, (req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.write(`<html><head><meta property="og:title" content="Alice Smith"></head><body>`);
    const chunk = 'y'.repeat(16384);
    const timer = setInterval(() => { written += chunk.length; res.write(chunk); }, 5);
    res.on('close', () => clearInterval(timer));
  });
  const site = { name: 'Local', category: 'test', url: `http://127.0.0.1:${port}/u/{}` };
  withHints(t, { Local: { fields: { name: [{ schema: 'open_graph' }] }, maxBytes: 524288 } });

  const result = await probeWithDeadline(site, 'alice', 4000).promise;
  assert.equal(result.status, 'not_found');
  assert.equal(result.profile, undefined);
  assert.ok(written < 400000, `upstream wrote ${written} bytes before the probe closed`);
});
