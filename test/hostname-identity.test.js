'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { redirectRetainsProfileIdentity } = require('../server');
const catalog = require('../sites.json');

test('hostname-label sources keep identity on their own host only', () => {
  const start = 'https://radiohead.bandcamp.com/';
  assert.equal(redirectRetainsProfileIdentity(start, 'https://radiohead.bandcamp.com/album/live-2003', 'radiohead'), true);
  assert.equal(redirectRetainsProfileIdentity(start, 'https://other.bandcamp.com/album/x', 'radiohead'), false);
  assert.equal(redirectRetainsProfileIdentity(start, 'https://bandcamp.com/signup?new_domain=radiohead', 'radiohead'), false);
  // A bare domain whose first label happens to equal the username is not a profile host.
  assert.equal(redirectRetainsProfileIdentity('https://alice.com/u/1', 'https://alice.com/home', 'alice'), false);
  // Path-based sources are unchanged: a different user's path still loses identity.
  assert.equal(redirectRetainsProfileIdentity('https://example.com/u/alice', 'https://example.com/u/bob', 'alice'), false);
});

test('Bandcamp checks the artist page, treating its signup redirect as absence', () => {
  const site = catalog.find(entry => entry.name === 'Bandcamp' && !entry.defunct);
  assert.equal(site.apiUrl, undefined, 'the RSS feed returned 404 for every artist');
  assert.equal(site.url, 'https://{}.bandcamp.com/');
  assert.equal(site.authRedirectMeansNotFound, true);
});
