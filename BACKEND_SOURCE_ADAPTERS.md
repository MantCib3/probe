# Backend source request adapters

Source-specific request behavior is declared on an individual `sites.json`
entry under `requestAdapter`. The adapter changes only how the existing
`apiUrl`, `checkUrl`, or profile `url` is requested; those URL fields and the
user-facing profile URL keep their current roles.

```json
{
  "requestAdapter": {
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    "bodyTemplate": "{\"username\":\"{{username}}\"}",
    "response": {
      "json": {
        "positive": { "path": "/profile/id", "op": "exists" },
        "negative": { "path": "/error/code", "op": "equals", "value": "NOT_FOUND" }
      }
    }
  }
}
```

Supported methods are `GET`, `HEAD`, and `POST`. A `POST` requires a body
template containing `{{username}}`; usernames are validated before the
placeholder is substituted. `GET` and `HEAD` cannot have a body. Adapters
support static per-source headers but reject credential, secret, cookie,
host, content-length, and hop-by-hop headers, header-value injection, and
obvious embedded credentials. Do not put secrets in this file.
`HEAD` requires `response.expectedStatus` (an integer HTTP status 100–599);
only that exact status is positive evidence, and any other non-error status
abstains.

JSON response predicates use RFC 6901 JSON Pointers and one of `exists`,
`equals`, `truthy`, or `falsey`. `equals` requires a JSON `value`; other
operators do not accept one. A positive match means `found`, a negative match
means `not_found`, both matching means `unknown`, and neither matching (or an
invalid/truncated JSON body) means `unknown`. There is no implicit positive
or negative default.

The server validates adapter shapes at startup. Add an adapter only after
reviewing that source's request contract and positive/negative evidence; do
not use it as an arbitrary URL, browser, proxy, or credential mechanism.
Existing retry, cancellation, host pacing, and response-size budgets remain
in effect.

Authentication redirects are ambiguous by default and return `unknown`.
Only a validated per-source `authRedirectMeansFound: true` or the explicit
`authRedirectMeansNotFound: true` opts into a different interpretation.

## Frontend explanation reason codes

The frontend may label these backend reasons directly; an unlisted reason
can keep the existing generic underscore-to-space fallback:

| Reason code | Meaning |
| --- | --- |
| `redirect_location_missing` | Redirect had no usable `Location` header. |
| `redirect_location_invalid` | Redirect destination was malformed or unsafe. |
| `redirect_hop_limit` | Redirect chain exceeded the server hop budget. |
| `redirect_requires_follow` | Redirect could not be treated as profile evidence. |
| `redirect_auth_login` | Authentication redirect is ambiguous by default. |
| `redirect_bot_challenge` | Redirect points to a challenge interstitial. |
| `body_authentication_required` | Response body requires authentication. |
| `body_rate_limited` | Response body explicitly reports rate limiting. |
| `site_marker_conflict` | The source's positive and negative markers both matched. |
| `site_expected_status` | Response matched the configured expected HTTP success status. |
| `site_expected_status_missing` | Response did not match the configured expected HTTP status. |
| `site_positive_message_missing` | Configured positive evidence is absent; source opted to abstain. |
| `site_positive_message_missing_incomplete_body` | Positive evidence was absent from a truncated response. |
| `adapter_json_positive` | Configured JSON positive predicate matched. |
| `adapter_json_negative` | Configured JSON negative predicate matched. |
| `adapter_predicate_conflict` | Configured positive and negative JSON predicates both matched. |
| `adapter_json_inconclusive` | Neither configured JSON predicate matched. |
| `adapter_json_invalid` | Adapter response could not be parsed as JSON. |
| `adapter_head_expected_status` | HEAD response matched its configured success status. |
| `adapter_head_status_unexpected` | HEAD response did not match its configured success status. |

Redirect, challenge, auth, source-marker, and JSON-predicate ambiguity reasons
are integrity abstentions: they do not enter browser or archive fallback, so
archived HTTP 200 history cannot relabel the current result as `found`.
Ordinary unknown reasons retain the existing fallback behavior.

The local accuracy-lab runtime fingerprint includes the SHA-256 of
`source-request-adapter.js` as `sourceRequestAdapterSha256`.
