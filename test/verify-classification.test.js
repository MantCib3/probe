'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { classifyVerifyResponse, LAB_RUNTIME_FINGERPRINT } = require('../server');

const url = 'https://example.test/users/alice';

function verify(overrides = {}) {
  return classifyVerifyResponse({
    url,
    checkMethod: 'message',
    positiveMsg: 'PROFILE_MARKER',
    errorMsg: 'MISSING_MARKER',
    notFoundStatus: 404,
    expectedStatus: 200,
    status: 200,
    body: 'PROFILE_MARKER',
    redirects: [],
    redirectError: null,
    redirectHopLimitReached: false,
    complete: true,
    ...overrides,
  });
}

test('proxy verification gives challenge and auth redirects precedence over positive response markers', () => {
  const challenge = verify({
    redirects: [{ status: 302, location: '/cdn-cgi/challenge', fromUrl: url }],
  });
  assert.equal(challenge.status, 'blocked');
  assert.deepEqual(challenge.reasonCodes, ['redirect_bot_challenge']);

  const auth = verify({
    redirects: [{ status: 302, location: '/login?next=/users/alice', fromUrl: url }],
  });
  assert.equal(auth.status, 'unknown');
  assert.deepEqual(auth.reasonCodes, ['redirect_auth_login']);
});

test('proxy verification preserves configured missing status and rejects unresolved redirects', () => {
  const missing = verify({
    status: 302,
    redirects: [{ status: 302, location: '/login', fromUrl: url }],
    notFoundStatus: 302,
  });
  assert.equal(missing.status, 'not_found');
  assert.deepEqual(missing.reasonCodes, ['site_specific_not_found_status']);

  const invalid = verify({ redirectError: 'redirect_location_invalid' });
  assert.equal(invalid.status, 'unknown');
  assert.deepEqual(invalid.reasonCodes, ['redirect_location_invalid']);

  const exhausted = verify({ status: 302, redirectHopLimitReached: true });
  assert.equal(exhausted.status, 'unknown');
  assert.deepEqual(exhausted.reasonCodes, ['redirect_hop_limit']);
});

test('proxy verification abstains on source marker ambiguity and incomplete positive bodies', () => {
  const conflict = verify({ body: 'PROFILE_MARKER MISSING_MARKER' });
  assert.equal(conflict.status, 'unknown');
  assert.deepEqual(conflict.reasonCodes, ['site_marker_conflict']);

  const truncated = verify({ body: 'partial', complete: false });
  assert.equal(truncated.status, 'unknown');
  assert.deepEqual(truncated.reasonCodes, ['site_positive_message_missing_incomplete_body']);
});

test('proxy verification preserves ordinary followed redirects and expected status evidence', () => {
  const redirected = verify({
    redirects: [{ status: 301, location: 'https://example.test/users/alice', fromUrl: 'http://example.test/users/alice' }],
  });
  assert.equal(redirected.status, 'found');
  assert.deepEqual(redirected.reasonCodes, ['site_expected_status']);
});

test('lab runtime fingerprint includes the source request adapter implementation', () => {
  const modulePath = path.join(__dirname, '..', 'source-request-adapter.js');
  const expected = crypto.createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex');
  assert.equal(LAB_RUNTIME_FINGERPRINT.sourceRequestAdapterSha256, expected);
});
