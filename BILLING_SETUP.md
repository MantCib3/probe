# Accountless paid infrastructure — staging only

## Implemented, but locked

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

The private schema has been migrated on staging and the deployed read-only
connection check has passed with verified client TLS. No provider trial or
payment has been performed. Render secrets are not locally available.
Rates remain unmeasured. Keep `PAID_INFRA_ENABLED=0`
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
npm run billing:migrate
```

The operator command requires staging, `PAID_INFRA_ENABLED=0`, PostgreSQL 14+
and TLS. It takes a transaction-scoped advisory lock, verifies the immutable
SHA-256 of previously applied versioned SQL, and atomically applies new
migrations. Never edit an applied migration: add another version. The
digest uses canonical LF endings. Legacy Windows CRLF digests are accepted
only for otherwise byte-identical SQL; migration history is not rewritten.
All substantive changes still fail checksum validation. The
`probe_billing` schema is private, with no PUBLIC/anon/authenticated schema
access; use a controlled dedicated database role and do not expose it through
Supabase's API. Migrations are not run on web startup.

Local tests require no secrets or remote services:

```powershell
node --test test\billing.test.js test\billing-check.test.js test\billing-postgres.test.js test\billing-frontend.test.js test\classifier.test.js test\static-scripts.test.js
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
These actions seed a **synthetic AUD 1.00 balance** and one collection whose ID
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
Stripe outcome and actual signed event counts. Only fixed AUD 100-cent
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
| `currency` | `"aud"` |
| `billability` | `"authoritative-reconciliation"` |
| `measured` | `true`, only after an authorized measurement |
| `measurementReference` | Nonempty private reference to measured supplier evidence |
| `creditMicros` | Positive safe integer maximum outstanding debt + reservations |
| `thresholdMicros` | Integer >= 10,000 and <= credit; earlier collection threshold |
| `minimumCents` | Explicit positive integer, <= threshold in whole cents; set from current Stripe AUD minimum/fee requirements |
| `sources` | Nonempty array of individually approved sources |

Each source requires `source` (exact catalog name), `mode` (`http` or `browser`),
`hosts` (exact lowercase approved public hosts, no wildcard/IP/private host),
`supplierMicros` (measured maximum supplier AUD per attempt) and `marginMicros`
(explicit nonnegative AUD margin). Reservation is their sum, <= credit limit.
Optional `ipType` is exactly `datacenter` or `residential`; omission retains
Zyte's automatic IP selection. This choice is persisted in the rate/job and
consent fingerprint, displayed with prices and passed explicitly to Zyte.
Changing it requires renewed consent. Supplier price measurements must cover
the chosen mode/IP type; the HTTP trial did not verify explicit residential
pricing. Invalid transport values fail before dispatch.
Browser sources additionally require `browserIsolationVerified: true`, a
nonempty `browserApprovalReference` and `PAID_BROWSER_ENABLED=1`; approving
HTTP money-path tests alone never unlocks browser requests.
One AUD = 1,000,000 micro-units; one cent = 10,000 micro-units. These are units,
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
  AUD, card-only and test-only. There is no charge for this setup action.
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
Actual billability and AUD supplier cost remain unverified until matched to
authoritative Zyte usage evidence. An immediate HTTP 200/request reference or
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
Authoritative per-request supplier cost and reconciliation remain pending.

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

Use a private evidence JSON file with `jobId`, `supplierMicros` (actual AUD
supplier cost), `providerReference`, `evidenceReference`, `authoritative: true`
and `disposition` (`billed`, `not_billed`, or `probe_error`):

```powershell
npm run billing:reconcile -- .\billing-private\verified-usage.json
```

This explicit operator DB command makes no provider/payment request. It is
idempotent, rejects conflicting evidence/rate overrun, releases reservation
and books actual supplier cost plus the disclosed margin only when chargeable.
`not_billed` requires zero supplier cost. Unknown/duplicate/PROBE-error work is
absorbed; zero ledger entries are not a claim of zero supplier charges.
Unmatched/over-rate usage remains reserved for review; no automatic guesses.

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
provider reconciliation. This slice has no debt recovery/customer-action
portal: failed payments, stale unknown Stripe creations and setup timeouts
require operator review and remain fail-closed.

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
cookie still requires operator assistance; never silently create a replacement
money-bearing guest.

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
  succeeded AUD PaymentIntent and owned test card retrieval can settle debt.
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

Hosted debt amounts below Stripe's AUD 0.50 minimum are refused before checkout.
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
checksum-verified migrations and runs eight UUID-owned synthetic SQL checks,
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
fixture `bd9c7b44-b2af-4ba9-b855-086f878662ed` and its synthetic AUD 1.00 debt.
Authenticated `POST /api/staging-billing-stripe-setup` accepts exactly
`action` (`recovery-start`, `recovery-status` or `recovery-resume`), that
`guestId`, and `confirmation:"stripe-test-recovery-one-checkout-v1"`.
It cannot create another guest or another synthetic debt. Starting reuses a
ready checkout; any other existing recovery record blocks another start.
The standard recovery adapter cancels the owned failed PaymentIntent before
creating the one checkout. Use only Stripe test cards and fictional details.
The locked webhook exception admits only this zero-cap synthetic fixture's
owned AUD 1.00 recovery; standard authoritative retrieval and atomic accounting
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

The reported Zyte calculator estimate is $4 for 10,000 requests/month ($0.0004
per request on average). Currency, transport assumptions and actual per-request
costs are not verified; use this for planning, not customer ledger ingestion.

Real hosted PostgreSQL accounting and the exercised Stripe sandbox acceptance
paths passed. Four authorized Zyte HTTP controls also passed with supplier
references. Remaining blockers: automated authoritative per-request cost
ingestion (including precision/currency/FX policy), approved paid-source
detection/transport, browser-side supplier isolation, standalone card-replacement
checkout acceptance and small-debt/expired-session operator resolution.
Hosted recovery payment and explicit resume have now passed sandbox acceptance;
live activation and remaining launch gates are still separate.
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
