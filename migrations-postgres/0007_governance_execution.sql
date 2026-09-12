-- A role mutation is committed before GovernanceService records the final
-- proposal state.  This receipt closes that crash window: retrying the same
-- execution id returns the recorded result without revoking the grant twice.
CREATE TABLE IF NOT EXISTS governance_execution_receipts (
  execution_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL,
  payload_digest TEXT NOT NULL,
  event_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (proposal_id, proposal_revision, payload_digest)
);
CREATE INDEX IF NOT EXISTS governance_execution_receipts_proposal
  ON governance_execution_receipts (proposal_id, proposal_revision);

-- All tables in this database are project-private.  Supabase installations
-- commonly define these roles; the guarded dynamic SQL keeps local PostgreSQL
-- and CI databases (where they may not exist) compatible as well.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM anon', current_schema());
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM anon', current_schema());
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM anon', current_schema());
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM anon', current_schema());
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM authenticated', current_schema());
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM authenticated', current_schema());
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM authenticated', current_schema());
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM authenticated', current_schema());
  END IF;
END
$$;
