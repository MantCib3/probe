ALTER TABLE probe_billing.guests ADD COLUMN currency text NOT NULL DEFAULT 'aud'
  CHECK (currency IN ('aud','usd'));
ALTER TABLE probe_billing.guests ALTER COLUMN currency SET DEFAULT 'usd';
ALTER TABLE probe_billing.guests ADD COLUMN remainder_numerator numeric(1000,0) NOT NULL DEFAULT 0
  CHECK (remainder_numerator >= 0);
ALTER TABLE probe_billing.guests ADD COLUMN remainder_denominator numeric(1000,0) NOT NULL DEFAULT 1
  CHECK (remainder_denominator > 0 AND remainder_numerator < remainder_denominator);
ALTER TABLE probe_billing.guests ADD CONSTRAINT guests_currency_identity UNIQUE(id,currency);

ALTER TABLE probe_billing.ledger DROP CONSTRAINT ledger_check;
ALTER TABLE probe_billing.ledger ADD CONSTRAINT ledger_check CHECK (
  (kind='payment' AND collection_id IS NOT NULL AND job_id IS NULL AND micros<0)
  OR (kind='usage' AND job_id IS NOT NULL AND collection_id IS NULL AND micros>=0
    AND supplier_micros>=0 AND micros>=supplier_micros AND evidence_reference IS NOT NULL)
  OR (kind='absorbed' AND job_id IS NOT NULL AND collection_id IS NULL AND micros=0)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['setups','jobs','collections','ledger','recoveries']
  LOOP
    EXECUTE format('ALTER TABLE probe_billing.%I ADD COLUMN currency text NOT NULL DEFAULT ''aud'' CHECK (currency IN (''aud'',''usd''))', table_name);
    EXECUTE format('ALTER TABLE probe_billing.%I ALTER COLUMN currency SET DEFAULT ''usd''', table_name);
    EXECUTE format('ALTER TABLE probe_billing.%I ADD FOREIGN KEY (guest_id,currency) REFERENCES probe_billing.guests(id,currency)', table_name);
  END LOOP;
END $$;

CREATE FUNCTION probe_billing.freeze_legacy_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.currency <> 'usd' THEN RAISE EXCEPTION 'legacy_currency_frozen'; END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.currency <> 'usd' THEN RAISE EXCEPTION 'legacy_currency_frozen'; END IF;
    RETURN OLD;
  ELSE
    IF OLD.currency <> 'usd' OR NEW.currency <> OLD.currency THEN
      RAISE EXCEPTION 'legacy_currency_frozen';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['guests','setups','jobs','collections','ledger','recoveries']
  LOOP
    EXECUTE format('CREATE TRIGGER freeze_legacy_currency BEFORE INSERT OR UPDATE OR DELETE ON probe_billing.%I FOR EACH ROW EXECUTE FUNCTION probe_billing.freeze_legacy_currency()', table_name);
  END LOOP;
END $$;

CREATE TABLE probe_billing.usage_allocation_postings (
  organization_id bigint NOT NULL,
  provider_ref text NOT NULL,
  guest_id uuid NOT NULL REFERENCES probe_billing.guests,
  job_id uuid NOT NULL UNIQUE REFERENCES probe_billing.jobs,
  supplier_micros bigint NOT NULL CHECK (supplier_micros >= 0),
  margin_micros bigint NOT NULL CHECK (margin_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,provider_ref),
  FOREIGN KEY(organization_id,provider_ref)
    REFERENCES probe_billing.usage_allocation_requests(organization_id,provider_ref)
);
REVOKE ALL ON probe_billing.usage_allocation_postings FROM PUBLIC;

CREATE TABLE probe_billing.usage_allocation_batches (
  allocation_id uuid PRIMARY KEY REFERENCES probe_billing.usage_allocations,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON probe_billing.usage_allocation_batches FROM PUBLIC;

CREATE FUNCTION probe_billing.freeze_legacy_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_currency text;
BEGIN
  SELECT currency INTO owner_currency FROM probe_billing.jobs
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.job_id ELSE NEW.job_id END;
  IF owner_currency IS DISTINCT FROM 'usd' THEN RAISE EXCEPTION 'legacy_currency_frozen'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.job_id <> OLD.job_id THEN RAISE EXCEPTION 'attempt_owner_immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER freeze_legacy_attempt BEFORE INSERT OR UPDATE OR DELETE ON probe_billing.attempts
  FOR EACH ROW EXECUTE FUNCTION probe_billing.freeze_legacy_attempt();
