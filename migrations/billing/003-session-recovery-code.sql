ALTER TABLE probe_billing.guests
  ADD COLUMN recovery_code_hash text UNIQUE
    CHECK (recovery_code_hash IS NULL OR recovery_code_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN recovery_code_created_at timestamptz;
