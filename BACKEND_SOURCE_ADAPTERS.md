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

## Request identity

Sources may set an honest `User-Agent` of `PROBE/1.0 (+https://usernameprobe.com)`
through their adapter headers. A non-browser User-Agent automatically drops
browser-only client hints (`sec-ch-ua*`, `Sec-Fetch-*`,
`Upgrade-Insecure-Requests`) so the request is internally consistent. Crawler
impersonation (`crawlerUA`, e.g. Googlebot) is no longer used by any active
source; do not reintroduce it. Adopt honest headers per source only after a
hosted A/B shows the change produces correct decisions on existing and missing
controls (run from the private staging repository).

## Environment credentials

`credential` lets a source use an official keyed API without putting secrets in
the catalog. It names an uppercase environment variable, the single HTTPS host
allowed to receive it, and either a header (`authorization` or `x-api-key`,
optional `Bearer`/`token` scheme) or a query parameter. `overrides` may swap in
the keyed endpoint, adapter and markers, and its target must be HTTPS on that
same host. The credential is attached only when the request host and scheme
match, so redirects elsewhere and plain HTTP never receive it; it is not
serialised into results. Without the variable, the source behaves exactly as
its unkeyed definition. GitHub uses `GITHUB_TOKEN`; Last.fm uses
`LASTFM_API_KEY` with `user.getInfo`.

## Platform terms before automation

Before making a source automatic, check its terms of use, API terms and
`robots.txt` for the exact endpoint. Do not automate an endpoint whose terms
prohibit programmatic access or whose path is disallowed for all user agents;
keep it manual with a dated `caveat` instead. A 2026-10-15 review led to:

- **Kept:** AniList (free under its commercial threshold; ~30 req/min limit),
  Docker Hub (documented API within published limits), Codeberg/Forgejo,
  Liberapay, Fandom (MediaWiki API), freeCodeCamp, Slideshare, Snapchat.
- **Manual again:** Figma and Tellonym (terms prohibit automated access),
  eToro (`/api/` disallowed), Pr0gramm (no public terms; anti-bot community),
  HackerOne (no public lookup API; terms unclear), Spotify (web pages are for
  personal non-commercial use; the official Web API would need credentials).
- **Conditions:** GitHub tokens should belong to a dedicated machine account.
  Last.fm's API is non-commercial and public use needs Last.fm's written
  approval; do not set `LASTFM_API_KEY` in production until approved, and add
  the required attribution when it is.

## Public scan capacity and source cooldown

Scan rate slots are reserved before Turnstile and refunded on failure.
At most `MAX_ACTIVE_SCANS` (default 4) public scans run at once; up to 20 more
wait in a FIFO queue and receive `queued` events, and further scans get a 503.
A source with three consecutive `blocked` results is skipped for ten minutes in
public scans and reported as `blocked` with `source_cooldown`; any decision
clears it. Lab probes bypass cooldown so measurements stay real.
A `Retry-After` longer than five seconds is honoured by not retrying in-scan.

## Frontend explanation reason codes

The frontend may label these backend reasons directly; an unlisted reason
can keep the existing generic underscore-to-space fallback:

| Reason code | Meaning |
| --- | --- |
| `redirect_location_missing` | Redirect had no usable `Location` header. |
| `redirect_location_invalid` | Redirect destination was malformed or unsafe. |
| `redirect_hop_limit` | Redirect chain exceeded the server hop budget. |
| `redirect_requires_follow` | Redirect could not be treated as profile evidence. |
| `redirect_profile_identity_lost` | Followed destination no longer identifies the requested profile. |
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
are integrity abstentions: they do not enter browser fallback. Followed
positive responses must preserve the profile host and either the original
path/query or an exact username path segment/query value. Protocol, `www`,
and trailing-slash canonicalization remain supported. A renamed or unrelated
destination without that evidence abstains.

Automatic live checks no longer query the Wayback Machine or promote archived
HTTP 200 responses to `found`. Historical captures do not verify current
account existence. Ordinary unknown reasons remain eligible for configured
browser fallback; manual archive research remains separate.

The local accuracy-lab runtime fingerprint includes the SHA-256 of
`source-request-adapter.js` as `sourceRequestAdapterSha256`.
