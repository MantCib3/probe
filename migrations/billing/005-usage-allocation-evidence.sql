ALTER TABLE probe_billing.attempts
  ADD COLUMN dispatched_at timestamptz,
  ADD COLUMN dispatch_evidence jsonb;

CREATE TABLE probe_billing.usage_allocations (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL UNIQUE REFERENCES probe_billing.zyte_stats_imports,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL,
  plan jsonb NOT NULL CHECK (plan->>'state' = 'evidence_only' AND plan->>'currency' = 'usd'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE probe_billing.usage_allocation_requests (
  organization_id bigint NOT NULL CHECK (organization_id > 0),
  provider_ref text NOT NULL CHECK (provider_ref ~ '^[a-f0-9]{32}$'),
  allocation_id uuid NOT NULL REFERENCES probe_billing.usage_allocations,
  PRIMARY KEY (organization_id, provider_ref)
);
REVOKE ALL ON probe_billing.usage_allocations FROM PUBLIC;
REVOKE ALL ON probe_billing.usage_allocation_requests FROM PUBLIC;
