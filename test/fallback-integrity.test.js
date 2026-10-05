'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { hasIntegrityAbstention } = require('../server');

test('strict redirect, challenge, authentication, and predicate ambiguity is not fallback evidence', () => {
  const integrityReasons = [
    'redirect_location_missing',
    'redirect_location_invalid',
    'redirect_hop_limit',
    'redirect_requires_follow',
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

test('ordinary unknowns retain the existing browser and archive fallback path', () => {
  assert.equal(hasIntegrityAbstention({ status: 'unknown', reasonCodes: ['inconclusive_result'] }), false);
  assert.equal(hasIntegrityAbstention({ status: 'unknown', reasonCodes: ['body_guard_no_username_match'] }), false);
  assert.equal(hasIntegrityAbstention({ status: 'unknown', reasonCodes: [] }), false);
});
