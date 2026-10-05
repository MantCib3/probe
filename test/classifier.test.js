'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { classify, makeClassifiedResult, normalizeResult } = require('../server');

const username = 'alice';
const url = 'https://example.test/alice';

function site(overrides = {}) {
  return { name: 'Example', category: 'social', ...overrides };
}

function classifyCase({ source = site(), statusCode = 200, headers = {}, body = '', method = 'http', bodyIncomplete = false }) {
  return classify(source, username, url, statusCode, headers, body, method, bodyIncomplete);
}

describe('classify', () => {
  const cases = [
    {
      name: 'abstains on a generic authentication redirect',
      input: { statusCode: 302, headers: { location: '/login?next=/alice' } },
      expected: ['unknown', 'redirect_auth_login', 0.3],
    },
    {
      name: 'treats a challenge redirect as blocked',
      input: { statusCode: 302, headers: { location: '/cdn-cgi/challenge' } },
      expected: ['blocked', 'redirect_bot_challenge', 0.9],
    },
    {
      name: 'abstains on an unresolved redirect',
      input: { statusCode: 301, headers: { location: '/users/alice' } },
      expected: ['unknown', 'redirect_requires_follow', 0.3],
    },
    {
      name: 'abstains on a redirect with no Location',
      input: { statusCode: 302 },
      expected: ['unknown', 'redirect_location_missing', 0.3],
    },
    {
      name: 'allows validated source-specific auth redirects to mean found',
      input: { source: site({ authRedirectMeansFound: true }), statusCode: 302, headers: { location: '/login' } },
      expected: ['found', 'site_auth_redirect_found', 0.92],
    },
    {
      name: 'allows explicit source-specific auth redirect absence semantics',
      input: { source: site({ authRedirectMeansNotFound: true }), statusCode: 302, headers: { location: '/login' } },
      expected: ['not_found', 'site_auth_redirect_not_found', 0.92],
    },
    {
      name: 'preserves configured not-found evidence before redirect classification',
      input: { source: site({ notFoundStatus: 302 }), statusCode: 302, headers: { location: '/login' } },
      expected: ['not_found', 'site_specific_not_found_status', 0.94],
    },
    {
      name: 'treats 404 as not found',
      input: { statusCode: 404 },
      expected: ['not_found', 'http_404', 0.98],
    },
    {
      name: 'treats 410 as not found',
      input: { statusCode: 410 },
      expected: ['not_found', 'http_410', 0.98],
    },
    {
      name: 'treats generic access failures as blocked',
      input: { statusCode: 403 },
      expected: ['blocked', 'blocked_http_403', 0.9],
    },
    {
      name: 'treats an AWS WAF challenge header as blocked',
      input: { statusCode: 202, headers: { 'x-amzn-waf-action': 'challenge' } },
      expected: ['blocked', 'blocked_aws_waf_challenge', 0.9],
    },
    {
      name: 'treats an AWS WAF challenge body on status 202 as blocked',
      input: { statusCode: 202, body: '<script src="https://token.awswaf.com/challenge.js"></script>' },
      expected: ['blocked', 'blocked_aws_waf_challenge', 0.9],
    },
    {
      name: 'honors the StreamLabs 401 not-found status before generic blocking',
      input: { source: site({ name: 'StreamLabs', notFoundStatus: 401 }), statusCode: 401 },
      expected: ['not_found', 'site_specific_not_found_status', 0.94],
    },
    {
      name: 'uses a non-blocked site-specific not-found status',
      input: { source: site({ notFoundStatus: 400 }), statusCode: 400 },
      expected: ['not_found', 'site_specific_not_found_status', 0.94],
    },
    {
      name: 'recognizes a configured positive message',
      input: { source: site({ positiveMsg: 'Profile owner' }), body: '<p>Profile owner: alice</p>' },
      expected: ['found', 'site_positive_message', 0.9],
    },
    {
      name: 'treats a missing configured positive message as not found',
      input: { source: site({ positiveMsg: 'Profile owner' }), body: '<p>Directory</p>' },
      expected: ['not_found', 'site_positive_message', 0.9],
    },
    {
      name: 'honors explicit unknown semantics for a missing positive message',
      input: { source: site({ positiveMsg: 'Profile owner', positiveMissingStatus: 'unknown' }), body: '<p>Directory</p>' },
      expected: ['unknown', 'site_positive_message_missing', 0.3],
    },
    {
      name: 'abstains when a truncated detection body lacks its positive marker',
      input: { source: site({ positiveMsg: 'Profile owner' }), body: '<p>Directory</p>', bodyIncomplete: true },
      expected: ['unknown', 'site_positive_message_missing_incomplete_body', 0.3],
    },
    {
      name: 'recognizes a configured error message',
      input: { source: site({ errorMsg: 'No such member' }), body: '<p>No such member</p>' },
      expected: ['not_found', 'site_error_message', 0.92],
    },
    {
      name: 'abstains when positive and negative source markers conflict',
      input: { source: site({ positiveMsg: 'Profile owner', errorMsg: 'No such member' }), body: 'Profile owner; No such member' },
      expected: ['unknown', 'site_marker_conflict', 0.3],
    },
    {
      name: 'recognizes a blocked title',
      input: { body: '<title>Just a moment</title>' },
      expected: ['blocked', 'title_blocked_pattern', 0.9],
    },
    {
      name: 'challenge interstitial evidence takes precedence over a positive marker',
      input: { source: site({ positiveMsg: 'Profile owner' }), body: '<title>Just a moment</title><p>Profile owner</p>' },
      expected: ['blocked', 'title_blocked_pattern', 0.9],
    },
    {
      name: 'challenge body evidence takes precedence over a positive marker',
      input: { source: site({ positiveMsg: 'Profile owner' }), body: '<p>Checking if the site connection is secure. Profile owner</p>' },
      expected: ['blocked', 'body_blocked_pattern', 0.9],
    },
    {
      name: 'authentication interstitial evidence takes precedence over a positive marker',
      input: { source: site({ positiveMsg: 'Profile owner' }), body: '<p>Authentication required. Profile owner</p>' },
      expected: ['unknown', 'body_authentication_required', 0.3],
    },
    {
      name: 'rate-limit evidence takes precedence over a positive marker',
      input: { source: site({ positiveMsg: 'Profile owner' }), body: '<p>Too many requests. Profile owner</p>' },
      expected: ['blocked', 'body_rate_limited', 0.9],
    },
    {
      name: 'uses only configured JSON evidence for adapter responses',
      input: {
        source: site({
          requestAdapter: {
            method: 'GET',
            response: { json: { positive: { path: '/id', op: 'exists' } } },
          },
        }),
        body: '{"username":"alice"}',
      },
      expected: ['unknown', 'adapter_json_inconclusive', 0.3],
    },
    {
      name: 'does not treat an embedded captcha widget as a challenge interstitial',
      input: { body: '<script src="https://www.google.com/recaptcha/api.js"></script><h1>alice</h1>' },
      expected: ['found', 'body_guard_username_match', 0.74],
    },
    {
      name: 'does not treat a Cloudflare Ray ID footer alone as a challenge interstitial',
      input: { body: '<p>alice</p><footer>Ray ID: 12345</footer>' },
      expected: ['found', 'body_guard_username_match', 0.74],
    },
    {
      name: 'recognizes a deleted account body',
      input: { body: '<p>This account has been suspended</p>' },
      expected: ['deleted', 'body_deleted_pattern', 0.86],
    },
    {
      name: 'requires the username when usernameInBody is enabled',
      input: { source: site({ usernameInBody: true }), body: '<p>Different profile</p>' },
      expected: ['not_found', 'username_missing_in_body', 0.85],
    },
    {
      name: 'uses the generic body guard for a username match',
      input: { body: '<h1>Alice</h1>' },
      expected: ['found', 'body_guard_username_match', 0.74],
    },
    {
      name: 'abstains when a generic 200 response lacks the username',
      input: { body: '<h1>Generic landing page</h1>' },
      expected: ['unknown', 'body_guard_no_username_match', 0.35],
    },
    {
      name: 'allows a source to abstain on an ambiguous 200 response',
      input: { source: site({ abstainOn200: true }), body: '<h1>Alice</h1>' },
      expected: ['unknown', 'site_200_abstention', 0.3],
    },
    {
      name: 'accepts a 200 response when body checks are explicitly skipped',
      input: { source: site({ skipBodyCheck: true }), body: '<h1>Profile</h1>' },
      expected: ['found', 'skip_body_check_enabled', 0.68],
    },
    {
      name: 'abstains on an unhandled status',
      input: { statusCode: 418 },
      expected: ['unknown', 'unhandled_status_418', 0.3],
    },
  ];

  for (const entry of cases) {
    test(entry.name, () => {
      const result = classifyCase(entry.input);
      const [status, reason, confidence] = entry.expected;

      assert.equal(result.status, status);
      assert.deepEqual(result.reasonCodes, [reason]);
      assert.equal(result.confidence, confidence);
      assert.equal(result.evidence.method, entry.input.method || 'http');
      assert.equal(result.evidence.statusCode, entry.input.statusCode ?? 200);
      assert.equal(result.evidence.reasons, result.reasonCodes);
      assert.match(result.evidence.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(result.evidence.bodyHash, /^[a-f0-9]{64}$/);
    });
  }
});

describe('classification result helpers', () => {
  test('makeClassifiedResult keeps additional result details', () => {
    const result = makeClassifiedResult(
      { name: 'Example', detectionMethod: 'browser', statusCode: 200, bodyHash: 'abc' },
      'found',
      ['browser_match'],
      0.88,
      { displayName: 'Alice' }
    );

    assert.equal(result.displayName, 'Alice');
    assert.deepEqual(result.evidence, {
      checkedAt: result.evidence.checkedAt,
      method: 'browser',
      statusCode: 200,
      bodyHash: 'abc',
      reasons: ['browser_match'],
    });
  });

  test('normalizeResult supplies evidence and conservative timeout defaults', () => {
    const result = normalizeResult({ name: 'Example', status: 'timeout', statusCode: 0 });

    assert.equal(result.confidence, 0.12);
    assert.deepEqual(result.reasonCodes, ['request_timeout']);
    assert.equal(result.evidence.method, 'http');
    assert.equal(result.evidence.statusCode, 0);
    assert.equal(result.evidence.bodyHash, null);
  });

  test('normalizeResult preserves a complete classified result', () => {
    const original = classifyCase({ body: '<p>alice</p>' });
    assert.equal(normalizeResult(original), original);
  });
});