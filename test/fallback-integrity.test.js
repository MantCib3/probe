'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const https = require('node:https');
const { hasIntegrityAbstention, probeWithDeadline } = require('../server');

test('strict redirect, challenge, authentication, and predicate ambiguity is not fallback evidence', () => {
  const integrityReasons = [
    'redirect_location_missing',
    'redirect_location_invalid',
    'redirect_hop_limit',
    'redirect_requires_follow',
    'redirect_profile_identity_lost',
    'redirect_auth_login',
    'redirect_bot_challenge',
    'cloudflare_or_challenge_detected',
    'title_blocked_pattern',
    'body_blocked_pattern',
    'body_authentication_required',
    'body_rate_limited',
    'site_marker_conflict',
    'site_positive_message_missing',
    'site_positive_message_missing_incomplete_body',
    'adapter_predicate_conflict',
    'adapter_json_inconclusive',
    'adapter_json_invalid',
    'adapter_head_status_unexpected',
  ];
  for (const reason of integrityReasons) {
    assert.equal(hasIntegrityAbstention({ status: 'unknown', reasonCodes: [reason] }), true, reason);
  }
});

test('ordinary unknowns remain eligible for reviewed browser fallback', () => {
  assert.equal(hasIntegrityAbstention({ status: 'unknown', reasonCodes: ['inconclusive_result'] }), false);
  assert.equal(hasIntegrityAbstention({ status: 'unknown', reasonCodes: ['body_guard_no_username_match'] }), false);
  assert.equal(hasIntegrityAbstention({ status: 'unknown', reasonCodes: [] }), false);
});

test('an inconclusive live response never requests archive history or becomes found', async t => {
  const upstream = http.createServer((req, res) => res.end('Generic landing page'));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const archive = t.mock.method(https, 'get', () => {
    throw new Error('Live detection must not request historical archive evidence');
  });
  const result = await probeWithDeadline({
    name: 'Unresolved public profile',
    category: 'test',
    url: `http://127.0.0.1:${upstream.address().port}/users/{}`,
  }, 'alice', 3000).promise;
  assert.equal(result.status, 'unknown');
  assert.equal(archive.mock.callCount(), 0);
  assert.equal(result.profile, undefined);
});
