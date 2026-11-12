CREATE TABLE probe_billing.zyte_stats_imports (
  id uuid PRIMARY KEY,
  organization_id bigint NOT NULL CHECK (organization_id > 0),
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL CHECK (end_time > start_time),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  total_result_count integer NOT NULL CHECK (total_result_count >= 0),
  page_count integer NOT NULL CHECK (page_count > 0),
  response jsonb NOT NULL,
  UNIQUE (organization_id, start_time, end_time)
);

CREATE TABLE probe_billing.zyte_stats_domains (
  import_id uuid NOT NULL REFERENCES probe_billing.zyte_stats_imports(id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain <> ''),
  request_count bigint NOT NULL CHECK (request_count >= 0),
  cost_microusd_total numeric(30, 8) NOT NULL CHECK (cost_microusd_total >= 0),
  cost_microusd_avg numeric(30, 8) NOT NULL CHECK (cost_microusd_avg >= 0),
  cost_microusd_p80 numeric(30, 8) NOT NULL CHECK (cost_microusd_p80 >= 0),
  PRIMARY KEY (import_id, domain)
);

REVOKE ALL ON probe_billing.zyte_stats_imports FROM PUBLIC;
REVOKE ALL ON probe_billing.zyte_stats_domains FROM PUBLIC;
