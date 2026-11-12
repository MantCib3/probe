# Accountless paid infrastructure — staging only

## Implemented, but locked

**Current USD implementation:** the operator reported completing migrations
005/006, and commit `85b716c` was pushed and verified deployed on staging.
Migration 004 and the 532-microusd Stats import were applied by the operator. New customer records,
reservations, ledger amounts, caps and Stripe presentment now use USD.
Migration 006 labels all existing financial/session records AUD and freezes
them without conversion; historical AUD Stripe acceptance below is not USD
acceptance. Use a separate browser profile for fresh USD sessions.

The equal-share policy, pre-credit consent, exact per-guest fractional carry
and atomic allocation posting are implemented. Public execution remains locked
pending the remaining supplier/customer-batch and launch gates. Keep both
`PAID_MONEY_PATH_VERIFIED=0` and `PAID_USD_MONEY_PATH_VERIFIED=0`. An old AUD
verification setting alone cannot enable the new money path. No new supplier
requests or payments are authorized by these code changes.

### Observed USD sandbox acceptance (2026-11-12 UTC)

The operator separately authorized these test-mode actions after deployment:

| Scenario | Verified result |
|---|---|
| Hosted USD card setup | Confirmed, active zero-cap fixture, one signed setup event |
| Synthetic USD 1.00 success | Succeeded, zero remaining debt, exactly one payment ledger entry and one signed payment event |
| Decline | `card_declined`, failed collection, USD 1.00 debt retained, zero payment ledger entries, one signed event, spending paused |
| Authentication required | `authentication_required`, failed collection, USD 1.00 debt retained, zero payment ledger entries, one signed event, spending paused |
| Lost response | Initially uncertain with no payment entry; signed webhook reconciled the succeeded USD 1.00 test payment, zero debt and exactly one payment entry; spending stayed paused |
| Hosted USD debt recovery | Existing authentication fixture's USD 1.00 debt settled; recovery confirmed, collection succeeded, zero debt, exactly one payment ledger entry and one signed payment event; guest remained `action_required` |
| Explicit USD recovery resume | Separately authorized resume changed only the fixture to `active`; zero spending cap, zero debt, USD 1.00 paid and exactly one payment entry were preserved; public execution remained disabled |
| Hosted USD card replacement | Setup confirmed with one signed setup event and a changed card; zero debt, USD 1.00 paid and exactly one existing payment entry were preserved; guest stayed `action_required`, zero cap and public execution disabled |
| Explicit USD replacement resume | Separately authorized resume returned the verified fixture to `active`; changed card, zero debt, USD 1.00 paid, exactly one existing payment entry and zero cap were preserved; public execution remained disabled |

Stripe retrieval verified test mode, USD, amount, customer, method and guest
ownership for all payment scenarios. No real money moved and no supplier
requests occurred. Public paid execution was independently verified disabled.
All listed USD Stripe sandbox acceptance paths are now verified, including
hosted recovery, replacement and their separate explicit resumes. This does
not verify customer-owned supplier allocation or authorize public paid execution.
Historical AUD results were not substituted for USD proof. The authentication
fixture is `7604ef47-7cb3-4d65-8d48-0ca2f879becd`; recover only its existing
synthetic debt, never create a second payment claim.

### Bounded customer-owned supplier acceptance

The operator authorized one campaign of **two real HTTP requests**, HackerOne
`born2hack` and missing control `prbad7f0291ab`, no retries/browser, with a
10,000-microusd (USD 0.01) supplier-share ceiling per request and zero PROBE
margin. This is a customer-ledger ceiling, **not a hard Zyte account spending
cap**. Supplier credit can be consumed; over-ceiling evidence stays held.

The private Bearer-authenticated
`POST /api/staging-billing-supplier-acceptance` endpoint accepts:

- `start`: confirmation `two-http-usd-allocation-no-retries-v1` and the existing
  signed, zero-cap USD success fixture's `guestId`. The operator-owned fixture
  accepts the new terms and reserves USD 0.02 for these two requests only.
  Its lifetime cap includes the previously paid synthetic USD 1.00.
  Fixed job UUIDs and a database advisory lock prevent restarting the campaign,
  even after interruption. Production/public worker execution remains disabled.
- `status`: same confirmation, no guest ID or other parameters. No extraction.
- `post`: same confirmation, one raw Stats API `page` and operator-verified
  `manifest`. Exactly two HackerOne requests in organization 1053513 must match
  the actual jobs, provider references, successful positive/missing outcomes,
  supplier timestamps, comparable HTTP features and pre-credit cost basis.
  Dashboard membership/pricing verification is still required: local timestamps
  or matching counts alone are not substituted for supplier evidence.

Posting reuses the normal Stats import, allocation, ledger/remainder and
idempotency code, then replays the saved allocation and compares the guest's
complete status before/after. Both jobs must be settled, reservations zero
and replay unchanged. It neither contacts Stripe nor makes another supplier
request. Public execution and both verification switches must stay off.
An interrupted or uncertain dispatch is held for review, never reissued.

Operators can verify the deployed client-to-pooler TLS connection via
`GET /api/staging-billing-health` with the existing staging Bearer key.
It is staging-only, performs a read-only check, returns no credentials, makes
no Stripe/Zyte calls and is limited to one check per 30 seconds.
The default health endpoint does not open database connections.

Connection and migration checks inspect the client's encrypted, authorized
TLS socket. With Supavisor, `pg_stat_ssl` describes the pooler-to-database
connection, not our client-to-pooler connection. Certificate verification
remains mandatory; it is not disabled to accommodate the pooler.

This checkout includes a private PostgreSQL guest ledger, budget reservations,
durable leased jobs, Zyte adapter, Stripe-hosted card setup, signed webhooks,
authoritative usage reconciliation and daily/threshold test collection. The
optional panel beside the free search is off by default; paid results stay
separate and never overwrite free evidence.

The private schema through migration 004 has been migrated on staging and the
deployed read-only connection check passed with verified client TLS. Historical
AUD sandbox payments and the four-request supplier trial are recorded below;
they are not new USD acceptance. Render secrets are not locally available.
One batch is measured, not universal future launch rates. Keep `PAID_INFRA_ENABLED=0`
and `PAID_WORKER_ENABLED=0`. This is not an approved production money path.
`PAID_MONEY_PATH_VERIFIED` is an additional unresolved acceptance gate, not a
default activation. A missing/invalid setting locks public setup, execution and
payment webhooks. Only the isolated, zero-cap operator setup acceptance
exception documented below admits its own signed setup webhooks while locked.
The web process never starts a worker or makes startup provider calls.

## Private environment

Configure **probe-staging only**, never the production service:

- `PROBE_STAGING=1`
- When `RENDER` is set, the runtime also requires Render's
  `RENDER_SERVICE_NAME=probe-staging`; other services cannot enable these paths.
- `PAID_INFRA_ENABLED=0`
- `PAID_WORKER_ENABLED=0`
- `PAID_MONEY_PATH_VERIFIED=0`
- `PAID_USD_MONEY_PATH_VERIFIED=0` (fresh USD acceptance required)
- `PAID_BROWSER_ENABLED=0` (separate default-off browser isolation gate)
- `PAID_RECONCILIATION_ENABLED=0`
- `PAID_ORIGIN`: exact HTTPS browser origin, no trailing slash/path, e.g.
  the actual staging custom domain. Never infer it from request Host headers.
- `DATABASE_URL`: Supabase **session** pooler URI (normally port 5432);
  percent-encode private credentials. No Supabase Auth or public Data API.
- `DATABASE_CA_CERT_PATH` if Node needs the official Supabase CA chain, mounted
  as a secret file. All operator/runtime pools require verified TLS; URI SSL
  overrides are stripped. Never use `rejectUnauthorized: false`.
- `STRIPE_SECRET_KEY`: `sk_test_...` only. Live/publishable keys cannot enable.
- `STRIPE_WEBHOOK_SECRET`: endpoint-specific `whsec_...`.
- `ZYTE_API_KEY`: private supplier key.
- Existing `TURNSTILE_SECRET`, `TURNSTILE_HOSTNAMES`: must include the exact
  paid-origin hostname. Paid session issuance reuses the existing widget and
  server verification with action `paid`, plus bounded IP rate limiting.
- `PAID_RATE_CONFIG_PATH`: private, operator-measured JSON rate card. If inside
  this checkout, it **must** be beneath `billing-private\`, which is ignored by
  Git and denied by GET/HEAD static serving. Render secret-file paths outside
  the web root are also supported. Never put rates/evidence in public JSON.

Secrets must never be pasted into chat, logs, browser code or this document.
Driver/provider errors are sanitized rather than echoing connection details.

## Migration and validation, with separate authorization

After an operator separately authorizes staging database writes:

```powershell
Set-Location C:\dev\probe\probe-staging
.\scripts\billing-local.ps1 -Action Migrate `
  -CaCertificatePath "$env:USERPROFILE\Downloads\prod-ca-2021.crt"
```

The local helper prompts for an explicit staging-project confirmation and
secure database credentials. It first verifies the connection read-only, then
requires staging, `PAID_INFRA_ENABLED=0`, PostgreSQL 14+ and TLS for migration.
The migration takes a transaction-scoped advisory lock, verifies the immutable
SHA-256 of previously applied versioned SQL, and atomically applies new
migrations. Never edit an applied migration: add another version. The
digest uses canonical LF endings. Legacy Windows CRLF digests are accepted
only for otherwise byte-identical SQL; migration history is not rewritten.
All substantive changes still fail checksum validation. The
`probe_billing` schema is private, with no PUBLIC/anon/authenticated schema
access; use a controlled dedicated database role and do not expose it through
Supabase's API. Migrations are not run on web startup.

Migration `004-zyte-stats-evidence.sql` adds private domain-aggregate evidence
tables only. To import a Zyte Stats API time window after that migration has
been separately authorized and applied, run this from the local staging
checkout:

```powershell
.\scripts\zyte-stats-import.ps1 -StartTime '2026-11-09T07:30:00Z' -EndTime '2026-11-09T07:31:00Z'
```

The helper loads the DPAPI-protected
`%LOCALAPPDATA%\PROBE\secrets\zyte-dashboard-key.clixml`, asks for an explicit
USD-evidence confirmation and staging Session-pooler credentials, then uses
read-only, paginated GET requests to the Zyte Stats API. It requires the
separate stats migration, verified PostgreSQL TLS, and
`PAID_INFRA_ENABLED=0`. Reimporting an identical snapshot is idempotent; if
the provider returns different data for an already-imported organization and
window, import stops for review instead of replacing evidence.

The imported response and exact decimal cost fields are stored only in
`probe_billing.zyte_stats_imports` and `probe_billing.zyte_stats_domains`.
These records contain organization/window/domain aggregates, have no customer
or job identifiers, and are never passed to `billing:reconcile`. The stats
endpoint's status-code aggregates describe Zyte responses, not target-site
HTTP statuses. Stats aggregation does not provide exact per-request prices.

### USD equal-share allocation policy (approved 2026-11-11)

The operator approved allocating measured domain/window totals equally across
comparable requests, rather than requiring unavailable full-precision
individual supplier prices. This supersedes the earlier exact-per-request
requirement for this allocation policy. It does not establish a universal
fixed rate: each batch uses its own imported supplier total.

`domain-window-equal-share-usd-v1` requires complete supplier-request membership,
matching request and supplier-status counts, and operator verification that the
pricing conditions are comparable. Matching counts alone do not prove membership:
an external dashboard user/test request can replace a missing local request
without changing the count. The supplier request IDs and reporting-window
membership must be checked against the dashboard. Local dispatch timestamps
are not substituted for supplier timestamps.

The initial allocator supports only the verified HTTP feature set
(`httpResponseBody`, `httpResponseHeaders`, `customHttpRequestHeaders`), with
one IP selection per domain/window. Browser or additional features, mixed
pricing conditions, missing members/status evidence, duplicate IDs and
conflicting snapshots stop allocation for review.

Each request receives an exact rational share in **USD millionths**. Customer
shares remain `customer_candidate`; PROBE's tests, duplicates, PROBE errors,
provider failures and uncertain outcomes remain `probe_absorbed`. Absorbed
shares stay with PROBE and are never redistributed to customers. Successful
supplier responses to target 404s can be customer candidates; target status is
not supplier billability. No per-request rounding is performed.

Migration `005-usage-allocation-evidence.sql` adds allocation evidence tables
and dispatch metadata to attempts. Future worker/trial dispatches retain the
domain, transport/IP selection, features, request-byte count and dispatch time
before calling Zyte, without retaining the URL, username or credentials in
that metadata. Existing attempts have null metadata; do not fabricate it.
Applying migration 005 is required before deploying the updated dispatch code.
It does not change existing AUD balances or reinterpret their currency.

An operator manifest contains:

```json
{
  "schemaVersion": 1,
  "policy": "domain-window-equal-share-usd-v1",
  "organizationId": 1053513,
  "startTime": "2026-11-09T07:30:00Z",
  "endTime": "2026-11-09T07:31:00Z",
  "windowMembershipVerified": true,
  "pricingConditionsVerified": true,
  "costBasis": "pre-credit",
  "costBasisVerified": true,
  "evidenceReference": "private-dashboard-membership-reference",
  "requests": [
    {
      "providerReference": "dad53365fffa63076d291e50d0edf2f6",
      "domain": "tellonym.me",
      "supplierTimestamp": "2026-11-09T07:30:14.204Z",
      "providerStatus": 200,
      "purpose": "test",
      "pricing": {
        "mode": "http",
        "ipType": "automatic",
        "features": ["httpResponseBody", "httpResponseHeaders", "customHttpRequestHeaders"]
      }
    }
  ]
}
```

This shows the format only: the confirmed four-request batch needs **all four
members**, not this one-row example. Do not set the verification flags before
actually checking membership, pricing conditions and the supplier's pre-credit
usage basis. A net payment or credit-adjusted total must not be relabeled as
pre-credit evidence. Customer candidates
add `currency: "usd"`, pseudonymous `guestId`, `jobId`, and `result`; other
purposes must not carry customer ownership. These are evidence labels, not
proof of current consent or permission to post debt. Save manifests under
`billing-private` or outside the web root, never include emails or credentials.

After separately authorizing and applying migration 005, an operator can save
the plan using the existing local secure credential helper:

```powershell
.\scripts\billing-local.ps1 -Action Allocate `
  -StatsImportId '8f90c4ba-cbf2-4606-868e-bac982c84d2a' `
  -AllocationManifest 'C:\private\zyte-membership.json' `
  -CaCertificatePath "$env:USERPROFILE\Downloads\prod-ca-2021.crt"
```

This requires confirmation `probe-allocation-staging`, disabled worker/spending,
and verified database TLS. Identical replays return the same allocation ID;
conflicts stop without overwriting evidence. Each supplier ID can belong to
only one saved allocation per organization, preventing double allocation
across overlapping Stats windows. Evidence inserts are atomic.

The allocation command makes **no supplier API calls, no payments, and no
customer-ledger writes**. The persisted plan remains `evidence_only`. A separate
posting transaction consumes its saved allocation UUID, not raw Stats totals.

Customer wording for the USD path must describe the rule honestly:
"Your share of measured supplier usage before promotional credits, allocated
equally across comparable requests, plus the separately disclosed PROBE margin.
All charges are in USD." This is reflected in the new consent version and
fingerprint, browser meter and Stripe setup disclosure. Fresh consent and
USD sandbox acceptance are required; old consent/proof is not reused.
The operator chose to preserve/freeze existing AUD records, not convert them.

After applying migration 006, post a saved allocation with:

```powershell
.\scripts\billing-local.ps1 -Action Post `
  -AllocationId '<allocation UUID returned by Allocate>' `
  -CaCertificatePath "$env:USERPROFILE\Downloads\prod-ca-2021.crt"
```

Confirmation is `probe-usd-post-staging`. This changes verified customer debt
but makes **no Stripe or supplier requests**. All guest locks are acquired in
UUID order. Each customer label must match the actual USD job, current USD
consent and terms hash, successful attempt, supplier ID, result, dispatch
domain and pricing features. Over-cap, missing or conflicting evidence rolls
back the entire allocation. Revocation does not erase already-incurred usage.

Posting floors only the combined exact share and that guest's prior remainder,
carries the reduced fraction forward on that same guest, adds the authorized
integer margin and releases the reservation in one transaction. Zero-whole-micro
usage is recorded as usage, not falsely marked absorbed. Replays return the
saved receipt without advancing debt or remainder twice. JSONB key reordering
does not invalidate the evidence digest.

PROBE-absorbed shares never move to customers. A matching local USD error or
uncertain job releases its reservation without customer debt or margin. Missing
supplier IDs cannot be guessed; unmatched local work stays held for review.
The confirmed four controls were operator tests, so their entire 532 microusd
stays with PROBE and cannot become customer debt. Legacy AUD records are not
modified by posting.

`billing:reconcile` now accepts **only a saved allocation UUID**. The old
arbitrary whole-cost JSON path is disabled. `Store.reconcileFixture` is limited
to explicitly synthetic accounting fixtures with execution disabled; it is
not a customer-reconciliation API.

Local tests require no secrets or remote services:

```powershell
node --test test\allocation-posting.test.js test\usage-allocation.test.js test\zyte-stats.test.js test\billing*.test.js
npm run build:assets
npm run check
```

The actual concurrency/restart/accounting test is skipped without an existing
dedicated **local TLS PostgreSQL**. To run it, privately set
`PROBE_BILLING_TEST_DATABASE_URL` to localhost/127.0.0.1/::1 and a database named
`probe_billing_test_<suffix>`. Optionally set `PROBE_BILLING_TEST_CA_PATH`. It
refuses remote hosts, uses migrations twice and deletes only its UUID-owned
fixtures. It leaves the test schema/migration history for repeatability.
Mock SQL/unit assertions do **not** prove Postgres concurrency safety.
The development-only PGlite test also executes the actual migration/trigger,
JSONB, zero-whole-micro usage, rollback and posting/replay SQL on embedded
PostgreSQL without credentials. It does not replace pooler/TLS, multi-process
concurrency or real USD Stripe acceptance.

When local PostgreSQL and Render Shell are unavailable, an authorized operator
can run the same accounting fixtures through
`POST /api/staging-billing-accounting` using the existing staging Bearer key
and exactly `{"confirmation":"uuid-owned-accounting-fixtures-v1"}`.
Unlike the health check, this **writes temporary ledger fixtures**. It requires
the exact staging service, `PAID_INFRA_ENABLED=0`, `PAID_WORKER_ENABLED=0`,
`PAID_MONEY_PATH_VERIFIED=0`, verified TLS and an already-migrated **empty guest
ledger**. A database session advisory lock excludes concurrent fixture runs
across app instances; HTTP calls are also limited to one per five minutes.
It does not migrate, change settings, send provider requests or call Stripe.
Cleanup targets only this invocation's UUID-owned records, and cleanup failure
is an explicit failed check. An interrupted run can leave fixtures behind;
subsequent runs refuse to proceed rather than deleting unfamiliar records.
This proves real database accounting behavior with simulated payment/provider
objects, **not** Stripe webhook signatures or supplier invoice linkage.
The response nests the read-only TLS preflight under `database`; the accounting
fixtures themselves are writable and are explicitly marked `fixtureWrites`.

On 2026-11-09 UTC, the hosted PostgreSQL 17 check passed all 17 accounting
checks, including concurrent cap/collection claims, duplicate/out-of-order
payment events, cent remainders, recovery without redispatch, absorbed defects/
unknown outcomes, billable inconclusive results and payment-failure suspension.
UUID-owned fixtures were removed. No Stripe/Zyte requests occurred in that run.
Keep `PAID_MONEY_PATH_VERIFIED=0`: Stripe and supplier acceptance remain open.

`GET /api/staging-billing-stripe-health`, authenticated with the staging Bearer
key and the same disabled-spending gates as accounting, performs one Stripe
account retrieval with the test key to verify AU/AUD configuration. It reports
only safe configuration flags, not account identity or credentials; it creates
no customer, setup, payment or database record and calls no supplier. Database
and Stripe readiness share the 30-second limit. Presence of a webhook secret
is **not** proof of signature delivery or successful payment acceptance.

### Isolated hosted Stripe setup acceptance

With the three spending switches still exactly `0`, a configured test key and
webhook signing secret, operators can POST to
`/api/staging-billing-stripe-setup` using the staging Bearer key and
`{"action":"start","guestId":"<operator-generated-v4-uuid>","confirmation":"stripe-test-setup-only-v1"}`.
The UUID is a durable retry key, not a public guest token. The response contains
a Stripe-hosted test setup URL. Use only a Stripe test card and fictional
details; never enter a real card. This creates a test customer/Checkout setup
and private acceptance guest with a **zero spending cap**, not a supplier job,
usage debt or charge. Public session/setup/jobs routes remain locked.
Repeat with `action:"status"` and the same UUID to inspect signed setup
confirmation; no card, customer reference or identity is returned.

While paid billing is locked, `/api/paid/webhook` admits only correctly signed
test Checkout setup events matching that acceptance terms hash, exact saved
Checkout ID, guest token hash and zero cap. It uses the normal authoritative
Stripe retrieval/ownership/confirmation path. Nonfixture events and payment
events are rejected; production cannot enable this exception.
The acceptance fixture is deliberately retained across restarts/webhook retries
until explicit cleanup after testing. An uncertain setup is not blindly
re-created. Hosted setup and signed delivery do **not** prove payment recovery
or provider billing; `PAID_MONEY_PATH_VERIFIED` must remain `0`.

The current Stripe Checkout API no longer accepts `payment_method_types` on
session creation. Setup instead uses a dedicated test-only payment method
configuration named `PROBE sandbox card-only setup v1`, leaving the account's
default configuration unchanged. The adapter creates it idempotently when
absent, turns every listed non-card method off, and verifies effective card-only
settings before creating Checkout. An altered configuration fails closed.
PaymentIntent collection uses the same verified configuration; the current
Stripe API removed `payment_method_types` for PaymentIntents as well.

### Isolated Stripe test-payment acceptance

The same authenticated operator endpoint supports
`{"action":"pay","guestId":"<v4-uuid>","scenario":"success","confirmation":"stripe-test-payments-v1"}`.
The success UUID must be the signed, hosted setup fixture. `decline`,
`authentication` and `unknown` require fresh UUIDs and fixed Stripe test
PaymentMethods, never user-supplied card information. Each scenario is durably
bound in a cancelled `StripeAcceptanceFixture` job; it is never provider work.
The attached decline scenario uses Stripe's documented
`pm_card_chargeCustomerFail`; ordinary issuer-decline test cards cannot be
attached to customers. Authentication uses `pm_card_authenticationRequired`.
These actions now seed a **synthetic USD 1.00 balance** and one collection whose ID
is the fixture UUID. This is not supplier usage or a customer invoice.
They call the normal `collect`/`paymentResult` path with test credentials only.
Repeated calls reuse that collection, PaymentIntent or original idempotency
key. Public actions, workers and provider execution remain disabled.

The `unknown` scenario deliberately discards the successful Stripe API
response once to simulate a lost response. It freezes spending, then uses the
normal signed webhook or original collection key to recover without another
payment. This is a simulated network fault against a real sandbox PaymentIntent,
not proof of every real outage case or the full 20-hour recovery window.
Use `action:"payment-status"` with the same scenario/UUID to inspect ledger,
Stripe outcome and actual signed event counts. Only fixed USD 100-cent
collections owned by zero-cap acceptance guests may pass the locked webhook
exception; all other payment events remain rejected. Fixtures/test customers
are retained for webhook retries and explicit later cleanup.

`repair-rejected` is restricted to the original success acceptance fixture
when Stripe has definitively rejected its old request key after parameter
correction (`StripeIdempotencyError`). It requires no saved PaymentIntent, no
payments, an uncertain collection and a complete customer-scoped Stripe lookup
with no matching intent. Only then is a corrected request key durably recorded.
This is not a production/unknown-outcome retry policy and cannot be used for
arbitrary collections or repeatedly change keys.

Stripe can clear a declined PaymentIntent's primary `payment_method`. Ownership
then uses its authoritative `last_payment_error.payment_method` only for
`requires_payment_method`, retaining exact saved-method matching. Missing or
foreign methods still fail. Failed-payment accounting errors freeze collection
and spending rather than leaving an active guest after an unrecorded decline.

### Observed sandbox acceptance results (2026-11-09 UTC)

Historical **AUD** proof only. None of these results verifies the new USD path.

| Check | Observed result |
|---|---|
| Hosted test-card setup | Confirmed through actual signed event and authoritative Stripe retrieval |
| AUD 1.00 test success | Stripe succeeded; debt zero; exactly one payment ledger entry |
| Attached-card decline | `card_declined`; collection failed; no payment entry; spending paused |
| Off-session authentication | `authentication_required`; collection failed; no payment entry; spending paused |
| Simulated response loss | Initially uncertain/frozen; actual signed webhook recovered the same payment; exactly one payment entry |
| Repeated collection call and operator webhook resend | Success/recovery ledger entries remained exactly one |
| Signed event delivery | Success, decline, authentication and response-loss fixtures each have an accepted payment event |

Two successful synthetic AUD 1.00 **test** payments occurred; no real funds
moved and no Zyte/supplier calls occurred. Test fixtures remain zero-cap and
spending-suspended for inspection/retries. Production was not changed.
The earlier deprecated API requests created no PaymentIntent; one-time
corrected-key repair required definitive rejection plus a complete empty
customer-scoped lookup. This is distinct from unknown-outcome recovery.

These results verify the exercised sandbox paths, not provider accounting,
the full 20-hour recovery window or a customer-facing authentication/recovery
portal. Supplier billability/rate measurement, source support, retention and
payment recovery UX remain unresolved. Keep all spending gates at `0`.

If Render has no Shell tab, use your own private VS Code PowerShell terminal:

```powershell
Set-Location C:\dev\probe\probe-staging
.\scripts\billing-local.ps1 -Action Check
.\scripts\billing-local.ps1 -Action Migrate
```

Each invocation prompts for the Supabase staging session-pooler URI with
hidden input. Prefer copying the original URI with `[YOUR-PASSWORD]` unchanged:
the helper then prompts separately for the exact project database password,
percent-encodes it and inserts it without altering Supabase's username. Do not
pre-encode the separately entered password. Completed URIs are still accepted.
The URI is not written
to the terminal while pasting: hidden input still accepts paste. Enter the
entire `postgresql://...` URI, not just the password. The database password is
the one created for the Supabase project, not an API key. Reserved password
characters must be percent-encoded without encoding the rest of the URI.
For example, `@` becomes `%40`, `#` becomes `%23`, and `%` becomes `%25`;
do not encode an already encoded password twice. Authentication errors
identify code `28P01`, while TLS and URI errors have separate sanitized
diagnostics. Do not repeatedly retry a password without checking the exact
pooler username and connection string.
The helper displays only the input character count to help identify failed
paste operations. Outer straight quotes and surrounding whitespace are
accepted; command wrappers (`psql`, `DATABASE_URL=`, `jdbc:`) and embedded
whitespace are rejected before opening a connection.

The URI is not written
to disk or command history; it exists temporarily in process memory and the
child Node process environment. The helper restores previous environment
settings afterward. Do not run with a terminal transcript/recording active,
and clear the credential from your clipboard after pasting. No Stripe or Zyte
keys are needed for these commands, and neither service is contacted.
`Migrate` requires explicit project-name confirmation and a successful
read-only TLS connection check before writing tables. This confirmation cannot
verify project identity: use the URI from `probe-billing-staging`, not production.
If Node requires Supabase's official CA chain, pass
`-CaCertificatePath C:\private\supabase-ca.crt`; never disable TLS verification.
These operator commands verify connectivity/migrations, not accounting
concurrency or payment acceptance. Share sanitized status only, never the URI.

`npm run billing:check` remains a separate, operator-authorized read-only
remote readiness check: it verifies DB TLS without Stripe/Zyte requests or
migrations. Its `billingImplemented` flag describes code presence, not
acceptance verification or activation. Do not run it without connection
authorization.

Before the operator sets `PAID_MONEY_PATH_VERIFIED=1`, require passing real
PostgreSQL tests and separately authorized Stripe sandbox acceptance (setup,
off-session authentication/failure, duplicate/out-of-order webhook and unknown
payment recovery), and approved per-source supplier/redirect/identity/billing
tests. Supplier trials still require separate authorization.
In particular, supplier browser subrequests and remote DNS resolution cannot
be fully controlled by the local SSRF guard; browser mode must remain locked
until supplier-side isolation is approved. Do not open public paid jobs based
only on unit-test success.

## Measured rate-card contract (no launch prices supplied)

The JSON object must contain:

| Field | Required value |
|---|---|
| `currency` | `"usd"` |
| `billability` | `"authoritative-reconciliation"` |
| `allocationPolicy` | `"domain-window-equal-share-usd-v1"` |
| `costBasis` | `"pre-credit"` |
| `measured` | `true`, only after an authorized measurement |
| `measurementReference` | Nonempty private reference to measured supplier evidence |
| `creditMicros` | Positive safe integer maximum outstanding debt + reservations |
| `thresholdMicros` | Integer >= 500,000 (USD 0.50) and <= credit; earlier collection threshold |
| `minimumCents` | Explicit integer >= 50, <= threshold in whole cents; may be higher for operator fee requirements |
| `sources` | Nonempty array of individually approved sources |

Each source requires `source` (exact catalog name), `mode` (`http` only for this policy),
`hosts` (exact lowercase approved public hosts, no wildcard/IP/private host),
`supplierMicros` (authorized maximum supplier USD share per attempt) and `marginMicros`
(explicit nonnegative USD margin). Reservation is their sum, <= credit limit.
The maximum is a safety ceiling, not the eventual billed price; each window
uses its own measured total. One observed batch does not establish a universal rate.
Optional `ipType` is exactly `datacenter` or `residential`; omission retains
Zyte's automatic IP selection. This choice is persisted in the rate/job and
consent fingerprint, displayed with prices and passed explicitly to Zyte.
Changing it requires renewed consent. Supplier price measurements must cover
the chosen mode/IP type; the HTTP trial did not verify explicit residential
pricing. Invalid transport values fail before dispatch.
Browser sources remain rejected by this allocation policy even if a historical
browser flag is set; additional features/pricing need a separate approved policy.
One USD = 1,000,000 micro-units; one cent = 10,000 micro-units. These are units,
not prices. No currency conversion, hidden fee, inferred billability or
invented rate is implemented. Operator-set collection minimums are a batching
floor, never an added guest fee.

Only ordinary catalog profile GETs are supported in this slice. Sources with
`checkUrl`, `apiUrl`, credentials, custom request adapters, manual or defunct
status cannot be approved by editing only the rate card. Do not mutate the
public catalog to evade this restriction. A rate/consent fingerprint change
blocks old authorization and cancels old queued work; consent must be renewed
with a verified hosted setup. Revoked or failed-payment sessions cannot be
automatically reactivated.

## Routes and hosted consent

All paid endpoints live under `/api/paid/` and are unavailable outside staging.
No CORS is enabled. Mutations require exact Origin, same-origin Fetch Metadata
when present, JSON bounded to 8 KiB, the random guest cookie and
`X-Probe-CSRF`. Only initial bot-verified guest issuance is CSRF-bootstrap
exempt. Webhooks are signed-buffer exempt, not browser-authorized.

- `GET /api/paid/config`: disabled status or disclosed rates/consent. No DB.
- `POST /api/paid/session`: `{ "cfToken": "..." }`; sets random
  `__Host-probe_paid` HttpOnly Secure SameSite=Strict cookie (30 days), stores
  only SHA-256 hashes, returns a CSRF value. No guest token goes in a URL.
- `GET /api/paid/status`: only the cookie owner's meter, latest 50 jobs and
  ledger entries, and CSRF value. No arbitrary guest-id query.
- `POST /api/paid/setup`: explicit `consent: true`, `consentVersion` and
  `termsHash` from config; returns a validated Stripe-hosted URL. Setup is
  USD, card-only and test-only. There is no charge for this setup action.
  Before a new hosted setup or new collection creation, the SDK retrieves only
  to validate the operator Stripe account's AU country/AUD default currency;
  its identity fields are neither stored nor logged.
- `POST /api/paid/cap`: `{ "capMicros": integer_or_null }`; optional lifetime
  cap includes collected usage + debt + reservations. Cannot lower below
  committed usage. The bounded operator credit limit applies without a cap.
- `POST /api/paid/jobs`: `{ "source": "...", "username": "...",
  "requestKey": "uuid" }`; the server constructs the approved catalog URL,
  reserves worst-case spend and creates one durable job transactionally.
  Reusing a key returns the same job; changing its payload conflicts.
  Identical guest/source/username checks with a different key within five
  minutes are rejected rather than creating provider duplicates.
- `POST /api/paid/revoke`: `{}`; atomically disables new spending and releases
  queued reservations. Already leased attempts are in flight and incurred
  debt remains collectible.
- `POST /api/paid/webhook`: raw, signed Stripe snapshot events, max 256 KiB.

Register the actual staging endpoint:
`https://<staging-host>/api/paid/webhook`. Subscribe to
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.expired`,
`payment_intent.succeeded`, `payment_intent.payment_failed`,
`payment_intent.requires_action`, `payment_intent.processing`,
`payment_intent.canceled`.
Use the SDK's default pinned API version shown in `node_modules\stripe`, and
configure snapshot events accordingly. Verify endpoint secrets privately.

The return to `/#paid` has no token and **does not** authorize a guest.
The signed webhook triggers authoritative Checkout/SetupIntent/PaymentMethod
retrieves and validates non-live succeeded off-session setup, consent hash
and customer/payment ownership. The same transaction deduplicates events and
preserves revocation/failure against older setup events. Duplicate or uncertain
hosted setup creation never silently creates a second setup.

## Worker, authoritative reconciliation and collection

### Authorized four-request supplier trial

The operator approved at most four Zyte HTTP requests, no browser mode or
retries. Authenticated `POST /api/staging-billing-supplier-trial` accepts exactly
`{"action":"start","confirmation":"four-http-requests-no-retries-v1"}`.
Fixed previously reviewed controls are HackerOne `born2hack`, Tellonym `jane`,
and missing control `prbad7f0291ab` on each. Catalog targets go through the
normal Zyte adapter, DNS/host guards and classifier. There are no arbitrary
URLs, headers, usernames or modes in the request.

A single immutable trial UUID and database advisory lock bound the campaign
across restarts and app instances. Four cancelled fixture jobs and attempt
records are created before any dispatch; each attempt is marked dispatched
durably before contacting Zyte. A started campaign cannot be restarted even
after interruption. Configuration/authentication/rate-limit errors stop the
remaining requests. `action:"status"` reads saved classification/status/reference
evidence without external requests. No raw bodies or extracted profile metadata
are retained. The zero-cap fixture creates no guest debt or payment.

All spending switches stay `0`. This uses the operator's supplier account/trial
credit: four requests is a request-count limit, **not** a guaranteed dollar cap.
Trial billability was subsequently verified by the USD Stats aggregate recorded
below; there is no AUD conversion for the new path. An immediate HTTP 200/request reference or
echoed attempt ID never substitutes for invoice evidence. Missing reference
linkage blocks customer-billing activation.

Observed trial on 2026-11-09 at 07:30 UTC: exactly four Zyte HTTP requests,
no retries. HackerOne `born2hack` and Tellonym `jane` returned target HTTP 200
and classified `found`; the missing control returned target HTTP 404 and
classified `not_found` on both. All four supplier responses were HTTP 200
with persisted supplier request references and matching attempt echoes.
No customer debt, Stripe calls or public activation occurred.
The trial demonstrates these two sources' positive/negative contrast, **not**
broader challenged/manual-source support, measured prices or invoice matching.
Full-precision individual supplier prices are unavailable. The approved USD
equal-share policy uses verified domain/window totals instead.

Only after measurement, acceptance verification and separate execution
authorization, set the gates explicitly, enable reconciliation, then run the
worker in a **separate controlled process**:

```powershell
npm run billing:worker -- --once
# Or, as the explicitly configured persistent staging worker:
npm run billing:worker
```

Each tick recovers expired leases, reconciles already-claimed Stripe payments,
claims a daily/threshold collection, then leases at most one paid job using
guest-row locks and `SKIP LOCKED`. There is one durable supplier attempt per
job. After DNS checks and immediately before dispatch, another guest/job
transaction verifies current consent, revocation, lease ownership and expiry,
then durably marks the attempt dispatched. A 65-second provider timeout fits
inside the two-minute lease. Expired
leases/unknown responses are never reissued: their reservations remain held
pending evidence. PROBE pre-provider guard failures release their reservation
and are recorded as absorbed.

The adapter calls only Zyte's fixed HTTPS extract endpoint, without client
URLs/headers, with local public-DNS/host guards and `followRedirect: false`.
HTTP mode supplies an honest PROBE User-Agent; browser mode supports only the
supplier's documented Referer option, not stealth/UA spoofing. Response target
URL/status/headers/body go through the existing classifier and profile
extractor; body evidence is capped at 32 KiB, total supplier JSON at 2 MiB.
Challenges, lost profile identity and incomplete evidence stay inconclusive.
The supplier itself can render resources/resolve DNS: do not treat response
URL validation as proof that remote subrequests were confined.

**A Zyte HTTP 200 is not an invoice.** A target 404 inside it is not a provider
HTTP failure. Completed positive, negative, blocked or inconclusive checks may
be charged only after authoritative supplier billing evidence is matched to
the attempt. Provider HTTP failures, uncertain outcomes and PROBE defects are
absorbed even if the supplier bills PROBE. Unknown billability never becomes
guest debt. Do not enable execution without a working authoritative
request-reference/usage reconciliation process. References may be missing in
the immediate response; the operator must match the attempt to a supplier
usage export or leave it held/absorbed, never guess.
The request carries only a pseudonymous attempt UUID in the documented
`echoData` field, and its echoed response must match. This correlation is
**not** billing proof. A successful response without a persisted supplier
request reference cannot be charged; an operator-supplied reference alone
cannot turn it into guest debt.

Use a saved USD allocation UUID after membership/pricing/pre-credit verification:

```powershell
npm run billing:reconcile -- '<saved allocation UUID>'
```

The secure helper above sets the required staging and disabled-execution gates.
This DB-only command uses exact shares and per-customer remainder, rejects
conflicting ownership/consent/rate evidence and posts atomically. Raw cost JSON
is no longer accepted. Unmatched/over-rate work stays reserved for review.

Collection claims an immutable amount/key in PostgreSQL before contacting
Stripe. Test off-session PaymentIntents use that claim's idempotency key and
customer/payment references. Whole cents are rounded **down**, never up;
fractional remainder stays as debt until a later collection reaches the
configured minimum. Only authoritative non-live `succeeded` payments book a
unique negative ledger entry. Payment failures/required authentication or
unknown outcomes suspend new jobs. Failed claims block new automatic
collection; no unattended retry of failed payments.

Unknown creation can be replayed with the *same* claim/key only within a
conservative 20-hour window; after that it freezes, because Stripe may prune
24-hour idempotency keys. If a PaymentIntent id is known, recovery retrieves
it instead. Do not clear/delete a collection, manually mark it paid, create
a replacement claim, reset a setup or re-enable a guest without authoritative
provider reconciliation. Hosted card replacement/debt recovery and explicit
resume are described below. Stale unknown Stripe creations and setup timeouts
still require operator review and remain fail-closed.

## Records and remaining blockers

No accounts, passwords, Supabase Auth, stored card/PAN/CVC, billing name or
billing email are added. Stripe-hosted flows may collect and retain identity
and payment records; literal zero-identity storage is not promised. PROBE
retains pseudonymous Stripe references, hashes, consent timestamps/version,
financial ledger and provider references. Losing the cookie does not erase
debt; it loses guest access. Do not treat this as a sustainable public
anonymous-credit fraud model without acceptance/risk review.

Terminal job input/result content is scrubbed after seven days by the worker;
financial/consent references are not automatically deleted. In-flight
reconciliation inputs remain until resolved. Configure lawful financial
retention and incident procedures before public paid use.

### Accountless hosted recovery

Recovery keeps the same opaque HttpOnly guest cookie, same-origin/CSRF checks,
current explicit consent and sandbox gates. No PROBE customer account, email
lookup, client secret or card details are introduced. Losing/expiring that
cookie can be recovered with a private recovery code as described below;
never silently create a replacement money-bearing guest.

- `POST /api/paid/replacement` saves a new card with the existing Stripe-hosted
  setup flow. The guest stays paused. It cannot run alongside an open debt
  recovery checkout.
- `POST /api/paid/recovery` additionally requires `settleDebt:true`. A durable
  private recovery record owns one fixed collection amount, customer, prior
  PaymentIntent, current terms and hosted checkout. It retrieves the old intent
  authoritatively; an already-succeeded payment is reconciled, not charged
  again. A definitively failed/action-required intent must be canceled before
  another payment can be created. Processing/missing/uncertain outcomes block
  checkout and require operator review. No blind payment retry is permitted.
- Stripe-hosted payment checkout handles card entry/authentication and saves the
  card for later off-session collection. Only authoritative paid Checkout,
  succeeded USD PaymentIntent and owned test card retrieval can settle debt.
  Checkout and early PaymentIntent events use the same atomic ledger path.
  Response loss freezes recovery; a signed success can still recover ownership.
  A signed authoritative expiry releases an abandoned checkout. Returning via
  `/#paid` or refreshing never authorizes spending.
- `POST /api/paid/resume` is a separate current-consent action. It requires a
  non-revoked paused guest, no whole-cent debt, no reservations or unresolved
  collections/setups/recovery. It preserves the lifetime cap and sub-cent debt.
  A revoked guest may pay existing debt but can never resume.
- Collection payment-method snapshots preserve ownership of old payments after
  a replacement card is saved. Known canceled superseded intents are safely
  acknowledged without adding another ledger entry.

Hosted debt amounts below the configured USD 0.50 floor are refused before checkout.
They are not forgiven or rounded up; operator resolution is required if that
balance prevents resuming. Later reconciled debt can require another fixed
checkout. Neither fees nor extra supplier use are added by recovery.

Migration `002-hosted-recovery.sql` adds private recovery records and backfills
collection payment-method snapshots without changing debt/paid/cap balances.
Apply using the existing gated migration command, or authenticated
`POST /api/staging-billing-recovery` with exactly:

```json
{"confirmation":"migrate-and-uuid-owned-recovery-fixtures-v1"}
```

That staging-only operator check requires all three spending gates exactly `0`,
verified database TLS, a bounded body and the existing bearer. It applies
checksum-verified migrations and runs twelve UUID-owned synthetic SQL checks,
then removes/verifies only those fixtures. Existing acceptance guests are
preserved. It makes zero Stripe or supplier requests. It does **not** prove a
real hosted recovery checkout/authentication by itself; the separate observed
hosted payment acceptance is recorded below.

Hosted verification on 2026-11-09 passed **8/8 real PostgreSQL 17 recovery
checks**, with verified client TLS and both migrations present. UUID-owned
fixtures were removed and cleanup verified; existing acceptance records were
preserved. There were zero Stripe/payment requests and zero supplier requests.
The initial migration check correctly stopped on the legacy Windows CRLF
digest; strict LF/CRLF-equivalent validation fixed portability without changing
the original SQL or rewriting its recorded digest. The directly related
billing/browser/operator suite passed 68 tests (one local-only database test
skipped); dedicated migration compatibility tests also passed.

The bounded hosted recovery acceptance reuses only the existing authentication
new USD fixture `7604ef47-7cb3-4d65-8d48-0ca2f879becd` and its synthetic USD 1.00 debt.
The old AUD fixture is frozen and must not be reused.
Authenticated `POST /api/staging-billing-stripe-setup` accepts exactly
`action` (`recovery-start`, `recovery-status` or `recovery-resume`), that
`guestId`, and `confirmation:"stripe-test-recovery-one-checkout-v1"`.
It cannot create another guest or another synthetic debt. Starting reuses a
ready checkout; any other existing recovery record blocks another start.
The standard recovery adapter cancels the owned failed PaymentIntent before
creating the one checkout. Use only Stripe test cards and fictional details.
The locked webhook exception admits only this zero-cap synthetic fixture's
owned USD 1.00 recovery; standard authoritative retrieval and atomic accounting
still apply. Signed success leaves spending paused; the separate operator
resume action exercises the normal resume guard with cap zero, never public
paid execution. Status reports safe state/counts only. No supplier calls occur.

On 2026-11-09 the operator completed the real Stripe-hosted recovery checkout
after receiving Stripe's documented 3DS-required test card instructions
(`4000000000003220`). The signed `payment_intent.succeeded` notification triggered
authoritative Checkout/PaymentIntent/card retrieval and confirmed recovery.
The returned acceptance status proved collection `succeeded`, debt zero,
paid AUD 1.00 and exactly one payment ledger entry, with one signed payment
event. The guest remained `action_required`: payment did not resume spending.
The separate explicit resume action then succeeded, preserving cap zero,
debt zero and the single ledger entry. Public paid config was verified disabled.
No supplier requests or real funds were involved. Checkout event count was
zero at verification; the signed payment-event recovery path was sufficient.
These safe status checks do not independently expose/verify the card's 3DS
authentication details or prove standalone card-replacement checkout acceptance.

Standalone replacement acceptance reuses that recovered zero-cap fixture.
The same authenticated endpoint accepts exactly its `guestId`,
`confirmation:"stripe-test-replacement-one-setup-v1"` and `action`
(`replacement-start`, `replacement-status`, `replacement-resume`).
Only one setup is allowed; a ready setup is reused, while confirmed/uncertain/
expired setups cannot start another. The standard replacement flow pauses
spending and requests only a SetupIntent, not a payment. Verification requires
a signed confirmed setup, a saved card different from the settled collection's
immutable card reference, unchanged zero debt/AUD 1.00 paid balance and one
payment ledger entry. Explicit resume is separate and retains cap zero.
Supplier testing is currently on hold; the requested ten-request limit is not
an authorization to dispatch without a confirmed budget or browser isolation.

On 2026-11-09 standalone replacement passed real sandbox acceptance: setup
confirmed, one signed Checkout setup event, changed saved card, guest still
paused, debt zero, paid AUD 1.00 and exactly one existing payment ledger entry.
The separate replacement resume then passed, retaining cap zero and unchanged
accounting. Public paid config remained disabled. No new payment or supplier
request was made by this acceptance.

### Private session recovery and small-debt policy

The operator selected a user-held recovery code with operator fallback and
carry-forward of small debt; no fixed pricing, small-debt forgiveness or
automatic payment-failure resume was approved.

Migration `003-session-recovery-code.sql` adds only a unique nullable recovery
hash and creation timestamp. Existing guests/financial records are unchanged.
New guest sessions generate an independent 256-bit random recovery code,
returned once alongside CSRF in a no-store JSON response. Only a domain-separated
SHA-256 digest is persisted. The UI masks the code, supports reveal/copy and
requires saving acknowledgement before leaving new-session setup for Stripe.
The paid UI does not persist codes in local/session storage or URLs.

Existing authenticated guests can explicitly create/replace a code through
`POST /api/paid/recovery-code` with exactly `{"replaceRecoveryCode":true}`;
same-origin, CSRF, rate limiting and current unexpired cookie ownership are
required. Replacement invalidates the old code. `GET /api/paid/status` exposes
only whether a code is configured, never its hash/value.

`POST /api/paid/restore-session` requires exactly `restore:true`, a complete
43-character `recoveryCode` and a verified paid-action `cfToken`. Same-origin/
Fetch-Metadata guards and existing per-IP rate limits apply before lookup.
An already-valid browser session cannot silently be overwritten; use a separate
browser profile for another session. A lost/expired/invalid cookie may be
replaced only after matching the code. The guest row is locked, token/CSRF
hashes rotate and cookie/DB expiry is renewed for 30 days. The same guest ID,
debt, collected spend, cap, consent, reservations and revocation remain intact.
Previously active spending is paused; normal debt/setup/reservation guards and
current explicit consent are still required to resume.

The saved recovery code remains usable until explicitly replaced. This permits
retry after a lost restore response without stranding the customer; each
successful restore invalidates the previous browser token. It is a bearer
credential, not proof of personal identity. Anyone who obtains it can restore
access. Save it in a password manager and keep it out of messages/screenshots.
Losing both cookie and code has no automatic email/account recovery.

Small balances carry forward. Automatic rate cards must set a collection
minimum of at least 50 USD cents and threshold at least USD 0.50, avoiding
invalid sub-minimum Stripe charges. Paused guests with whole-cent debt below
that minimum cannot checkout or resume; no round-up, forgiveness or added
supplier requests are used to force a charge. Existing sub-cent settlement
remainders still carry forward and do not prevent explicit resume once all
whole-cent debt and unresolved collections/reservations are cleared.

Operator fallback:

1. Do not ask customers to send a code, cookie, PAN/CVC or database credential.
   Never identify a guest from a name/email that PROBE does not collect.
2. With a valid cookie, use the explicit code replacement UI. With a valid code,
   use the bot-verified restore UI. If neither exists, preserve balances and
   paused/revoked status while assessing ownership from existing authoritative
   Stripe transaction references; assistance does not guarantee recovery.
3. Unknown payments remain frozen until authoritative Stripe reconciliation.
   Never delete a claim, mark debt paid, bypass a reservation or reverse
   revocation to resolve a support ticket.
4. Small whole-cent debts remain owed and paused until lawfully resolved;
   changing this policy needs explicit approval. Terminal job content retains
   the existing seven-day scrubbing rule; financial/consent retention still
   needs a lawful operator policy before launch, not blanket automatic deletion.

The existing authenticated staging recovery check applies migration 003 and
exercises small-debt refusal, expired-session restoration, credential rotation/
response-loss retry and revocation preservation with UUID-owned SQL fixtures.
It makes no Stripe or supplier requests.

Private recovery deployment `b0f776c` was verified on staging, then the hosted
check passed **12/12** against PostgreSQL 17 with trusted TLS. All three
migrations are applied, UUID-owned fixtures were removed and both supplier/
payment request counts were zero. Local validation passed **73 tests** including
offline browser recovery/save acknowledgement/small-debt controls; the separate
dedicated-local-PostgreSQL test was skipped because no local TLS database was
provided. Asset rebuild, syntax checks and whitespace checks passed. Public paid
configuration remained disabled; production was not changed.

### Supplier pricing evidence and reporting limits

Official [pricing](https://www.zyte.com/pricing/) and
[pricing documentation](https://docs.zyte.com/zyte-api/pricing.html), reviewed
2026-11-09, document per-website/per-transport tiers, not a universal per-request
price. PAYG base rates per 1,000 successful responses are $0.13-$1.27 for HTTP
and $1.01-$16.08 for browser. Thus the lowest HTTP base is $0.00013/request,
which is consistent with a four-decimal dashboard display of `0.0001`, though
the dashboard's exact rounding rule has not been verified. The operator's
10,000-request/$4 calculator result averages $0.0004/request; its selected
sites/features determine applicability.

Tier assignments can change; the documentation states quarterly reviews with
two weeks' notice. Explicit device residential IPs/extended geolocations have
different bases plus network costs, and actions/other features can add charges.
Automatic infrastructure selection is not the same pricing commitment as an
explicit residential request.

The public extraction OpenAPI, inspected directly from the official
[reference](https://docs.zyte.com/zyte-api/usage/reference.html), does not document
a per-response price field/header or a per-request billing-export endpoint.
The operator verified a read-only Stats API endpoint that reports cost
aggregates by domain and time window; it is not per-request attribution.
The pricing page advertises monthly reports and dashboard cost estimation.
This is not proof that private dashboard exports or support-provided reporting
are unavailable. Do not require the operator to keep searching for a specific
export assumed to exist, or invent an ingestion API.

The reported request-level `0.0001` records are useful supplier evidence for
the tested requests, but must not silently become an exact universal rate.
Documented successful Zyte responses include target 404s; PROBE classifications
still do not determine supplier costs.

On 2026-11-09 the operator explicitly retained **actual supplier cost plus the
disclosed margin**, rejecting a fixed per-attempt pricing substitution.
This earlier exact-individual-price requirement was superseded by the explicitly
approved equal-share policy above. Verified domain/window totals plus complete
membership and comparable pricing are the supported allocation basis. Calculator
estimates and rounded dashboard rows still cannot replace the measured total.
Unresolved attempts remain pending reconciliation, not collectible customer
debt; preserve existing
reservation/credit limits and absorb PROBE errors and duplicate attempts.
This decision does not authorize further supplier requests or public paid
activation.

#### Confirmed four-request USD batch

On 2026-11-09 the operator supplied the dashboard records below and explicitly
confirmed that **USD 0.000532 covers exactly these four requests**, not a
larger reporting window. This is operator-confirmed aggregate supplier evidence,
not an independently retrieved invoice or four full-precision individual costs.
All four requested `httpResponseBody`, `httpResponseHeaders` and
`customHttpRequestHeaders`; no browser/residential pricing is established.

| UTC timestamp (2026-11-09) | Supplier request ID | Target | Zyte / target status | Displayed USD row cost |
| --- | --- | --- | --- | --- |
| 07:30:05.507000 | `307b39bbb3f8418bf271a8d7d81ce4c1` | `hackerone.com/born2hack` | 200 / 200 | 0.0001 |
| 07:30:07.846000 | `089c9a46b30de316fb9426f948276a6c` | `hackerone.com/prbad7f0291ab` | 200 / 404 | 0.0001 |
| 07:30:09.559000 | `e1a7b966f0f33e8db8c101942f149779` | `tellonym.me/jane` | 200 / 200 | 0.0001 |
| 07:30:14.204000 | `dad53365fffa63076d291e50d0edf2f6` | `tellonym.me/prbad7f0291ab` | 200 / 404 | 0.0001 |

The batch totals **532 USD millionths**. Equal allocation is **133 USD
millionths (USD 0.000133) per request**, or USD 0.133 per 1,000 at this observed
batch average. The four displayed rows sum to USD 0.000400, which understates
the confirmed aggregate by USD 0.000132; do not ingest that displayed sum.
Both missing-profile controls are included in the billable batch despite
target 404s.

Timestamps and request IDs identify the members of this batch. Durations are
not a verified price formula, and a single aggregate cannot establish unequal
individual costs. Equal allocation is the explicitly approved accounting rule,
not a claim of supplier-provided individual prices.
It is not evidence that all sites share a rate or that this batch predicts
future costs. No new supplier requests are needed for this calculation.

New customer ledgers use **USD** after migration 006; old AUD records stay frozen.
These controls are operator tests with no customer ownership. All 532 microusd
is PROBE's absorbed cost. Only verified customer-owned attempts under the new
policy can post debt. The AUD conversion choices below are historical and do
not require an FX converter for new USD usage.

#### Historical AUD accounting policy (superseded for new usage by USD decision)

On 2026-11-09 the operator selected:

- **Conversion:** actual AUD supplier payment cost, including documented FX
  fees, rather than a daily reference exchange rate.
- **Credit basis:** supplier usage value before credits, plus the separately
  disclosed margin, even when free trial credits cover that usage.
- **Precision:** carry fractional AUD millionths forward per customer rather
  than discard them or round each request up.

On 2026-11-10 the operator chose USD for new customer usage and preservation/
freezing of existing AUD records. The AUD conversion design below is historical,
not a requirement to build FX conversion for the new USD path. The code's
new path now uses USD; these historical FX requirements are not active.

The credit decision qualifies the earlier "actual supplier cost" wording:
customer charges are based on supplier-recorded usage value before credits,
not PROBE's net cash outlay. Free trial credit is not passed through as free
customer usage. This is not permission to replace measured usage with a
universal fixed rate, disregard invoice adjustments, or treat a rounded row as
full-precision evidence.

Before enabling this policy, the consent text, rate fingerprint, meter and
payment disclosures must explicitly state the pre-credit basis, FX-cost
treatment and separate margin. Existing consent does not authorize silently
changing from net cost to pre-credit usage value. Suggested disclosure:
"Supplier-recorded usage before promotional credits, converted to AUD using
documented supplier payment exchange costs and applicable FX fees, plus the
separately disclosed PROBE margin. Supplier credits may reduce PROBE's payment
without reducing your usage charge."

An actual settlement conversion needs evidence linking the USD amount paid to
the AUD debit, its settlement date and separately charged attributable FX fees.
Do not count fees twice if they are already included in that debit, or include
unrelated card charges, interest or payment-processing fees in supplier FX cost.
The allocation of payment-level fees to usage must be approved and auditable
before charging customers; these choices do not approve a specific allocation.

During a fully credited trial there is no corresponding supplier cash payment
from which to establish that actual USD-to-AUD settlement conversion. Do not
divide by a zero payment, silently substitute a live/reference rate, or use a
later unrelated payment's rate. Credited usage therefore remains unconverted
and not collectible until a separately approved conversion rule/evidence can
cover it. No bank/card payment evidence has been supplied for this four-request
batch, and none is assumed.

The eventual converter must use exact decimal/integer-rational arithmetic and
durably retain the sub-micro remainder against the same guest. Post only whole
AUD millionths; never round individual requests up or transfer a remainder
between customers. Retry/duplicate evidence must not advance the remainder
twice. Conversion, remainder updates and ledger posting must be atomic,
preserve reservation/credit limits, and reject conflicting evidence or costs
above the authorized reservation. Existing cent-floor Stripe collection and
small-debt rules remain unchanged.

These were recorded AUD conversion requirements, not deployed conversion code.
The new USD path has durable fractional usage carry-forward and does not
implement FX conversion. Historical AUD records are frozen, never relabeled.

The reported Zyte calculator estimate is $4 for 10,000 requests/month ($0.0004
per request on average). Its currency and transport assumptions remain
unverified independently of the confirmed USD batch above; use the calculator
for planning, not customer ledger ingestion.

Historical hosted PostgreSQL accounting and AUD Stripe sandbox acceptance
passed. Four authorized Zyte HTTP controls also passed with supplier references.
The USD ledger/consent/Stripe code and exact fractional posting are implemented
locally. Remaining launch blockers: authorized migrations 005/006 and deployment,
fresh USD sandbox acceptance, complete verified customer-batch membership and
pre-credit basis, approved paid-source detection/transport and a lawful financial
retention/ownership-assistance policy. Small-debt carry-forward and private
lost/expired-session recovery are implemented; they do not bypass cost evidence.
Historical AUD recovery/replacement/resume proof is not USD proof. Browser
requests remain disabled for this policy, independently of prior browser flags.
Live activation and remaining launch gates are still separate.
Therefore public paid execution remains locked.

The lab's existing `config/paid-tier-hints.json` contains conditional metadata
extraction rules proven on captured browser pages/API documentation. These are
not per-source paid execution approvals or measured rates. Zyte supports
headless rendering (`browserHtml`) and automatic/explicit residential IPs, but
neither establishes accurate profile detection or safe remote subrequests.
The current paid parser still refuses manual sources/custom adapters; those
need reviewed positive/missing detection rules and explicit transport approval
rather than simply flipping a catalog flag.

Existing hint/catalog mapping (15 sources, all present in the current catalog):

| Current eligibility | Existing hint sources |
| --- | --- |
| Standard profile targets; candidate rules still require transport/detection validation | 7cup, ArtStation, PSN Profiles, Cults3D, VirusTotal, ACF, Lemon8 |
| Custom request/API/adapter handling; deliberately blocked by current paid parser | 500px, TryHackMe, Trakt.tv, Reddit, Apex Legends, Arduino (Forum), Cloudflare |
| Manual detection; deliberately blocked by current paid parser | Playstation Network |

None of these entries proves that residential IPs are required, supplies
measured prices or authorizes a new paid trial. Preserve the existing free
source behavior and conditional metadata evidence.

API contracts checked against official documentation:
[Stripe Checkout create](https://docs.stripe.com/api/checkout/sessions/create),
[Stripe webhooks](https://docs.stripe.com/webhooks),
[Zyte reference](https://docs.zyte.com/zyte-api/usage/reference.html),
[Zyte HTTP](https://docs.zyte.com/zyte-api/usage/http.html),
[Zyte browser](https://docs.zyte.com/zyte-api/usage/browser.html).
