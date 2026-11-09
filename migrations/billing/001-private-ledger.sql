CREATE SCHEMA IF NOT EXISTS probe_billing;
REVOKE ALL ON SCHEMA probe_billing FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA probe_billing FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA probe_billing FROM authenticated';
  END IF;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA probe_billing REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA probe_billing REVOKE ALL ON SEQUENCES FROM PUBLIC;

CREATE TABLE probe_billing.guests (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'new' CHECK (state IN ('new','active','revoked','action_required')),
  consent_version text,
  terms_hash text CHECK (terms_hash IS NULL OR terms_hash ~ '^[a-f0-9]{64}$'),
  consent_at timestamptz,
  customer_id text UNIQUE,
  payment_method_id text,
  cap_micros bigint CHECK (cap_micros BETWEEN 0 AND 1000000000000),
  debt_micros bigint NOT NULL DEFAULT 0 CHECK (debt_micros BETWEEN 0 AND 1000000000000),
  reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros BETWEEN 0 AND 1000000000000),
  paid_micros bigint NOT NULL DEFAULT 0 CHECK (paid_micros BETWEEN 0 AND 1000000000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  last_collection_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'active' OR (consent_at IS NOT NULL AND customer_id IS NOT NULL AND payment_method_id IS NOT NULL))
);
CREATE TABLE probe_billing.setups (
  id uuid PRIMARY KEY,
  guest_id uuid NOT NULL REFERENCES probe_billing.guests,
  state text NOT NULL CHECK (state IN ('pending','creating','ready','confirmed','uncertain','expired')),
  consent_version text NOT NULL,
  terms_hash text NOT NULL,
  consent_at timestamptz NOT NULL DEFAULT now(),
  customer_id text,
  checkout_id text UNIQUE,
  setup_intent_id text UNIQUE,
  checkout_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_open_setup ON probe_billing.setups(guest_id)
  WHERE state IN ('pending','creating','ready','uncertain');
CREATE TABLE probe_billing.jobs (
  id uuid PRIMARY KEY,
  guest_id uuid NOT NULL REFERENCES probe_billing.guests,
  request_key uuid NOT NULL,
  source text NOT NULL,
  username text,
  target_url text,
  rate jsonb NOT NULL,
  terms_hash text NOT NULL,
  reservation_micros bigint NOT NULL CHECK (reservation_micros BETWEEN 1 AND 1000000000000),
  state text NOT NULL CHECK (state IN ('queued','leased','reconcile','settled','absorbed','cancelled')),
  lease_id uuid,
  lease_until timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(guest_id, request_key)
);
CREATE INDEX jobs_queue ON probe_billing.jobs(created_at) WHERE state = 'queued';
CREATE TABLE probe_billing.attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES probe_billing.jobs,
  state text NOT NULL CHECK (state IN ('started','dispatched','response','uncertain','provider_error','probe_error')),
  provider_status integer CHECK (provider_status BETWEEN 100 AND 599),
  target_status integer CHECK (target_status BETWEEN 100 AND 599),
  provider_ref text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE probe_billing.collections (
  id uuid PRIMARY KEY,
  guest_id uuid NOT NULL REFERENCES probe_billing.guests,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  state text NOT NULL CHECK (state IN ('claimed','pending','succeeded','failed','uncertain')),
  payment_intent_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX one_open_collection ON probe_billing.collections(guest_id)
  WHERE state IN ('claimed','pending','uncertain');
CREATE TABLE probe_billing.ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guest_id uuid NOT NULL REFERENCES probe_billing.guests,
  job_id uuid UNIQUE REFERENCES probe_billing.jobs,
  collection_id uuid UNIQUE REFERENCES probe_billing.collections,
  kind text NOT NULL CHECK (kind IN ('usage','payment','absorbed')),
  micros bigint NOT NULL CHECK (micros BETWEEN -1000000000000 AND 1000000000000),
  supplier_micros bigint CHECK (supplier_micros BETWEEN 0 AND 1000000000000),
  evidence_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'payment' AND collection_id IS NOT NULL AND job_id IS NULL AND micros < 0)
    OR (kind = 'usage' AND job_id IS NOT NULL AND collection_id IS NULL AND micros > 0 AND supplier_micros > 0 AND evidence_reference IS NOT NULL)
    OR (kind = 'absorbed' AND job_id IS NOT NULL AND collection_id IS NULL AND micros = 0))
);
CREATE TABLE probe_billing.payment_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  object_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON ALL TABLES IN SCHEMA probe_billing FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA probe_billing FROM PUBLIC;
