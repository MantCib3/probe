ALTER TABLE probe_billing.collections ADD COLUMN payment_method_id text;
UPDATE probe_billing.collections c SET payment_method_id=g.payment_method_id
FROM probe_billing.guests g WHERE g.id=c.guest_id;

CREATE TABLE probe_billing.recoveries (
  id uuid PRIMARY KEY,
  guest_id uuid NOT NULL REFERENCES probe_billing.guests,
  collection_id uuid NOT NULL REFERENCES probe_billing.collections,
  prior_payment_intent_id text,
  customer_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  consent_version text NOT NULL,
  terms_hash text NOT NULL CHECK (terms_hash ~ '^[a-f0-9]{64}$'),
  consent_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL CHECK (state IN ('creating','ready','uncertain','confirmed','expired')),
  checkout_id text UNIQUE,
  checkout_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_open_recovery ON probe_billing.recoveries(guest_id)
  WHERE state IN ('creating','ready','uncertain');
REVOKE ALL ON probe_billing.recoveries FROM PUBLIC;
