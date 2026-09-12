PRAGMA foreign_keys=ON;

-- A role mutation is committed before GovernanceService records the final
-- proposal state.  This receipt closes that crash window: retrying the same
-- execution id returns the recorded result without revoking the grant twice.
CREATE TABLE IF NOT EXISTS governance_execution_receipts(
  execution_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL,
  payload_digest TEXT NOT NULL,
  event_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(proposal_id,proposal_revision,payload_digest)
);
CREATE INDEX IF NOT EXISTS governance_execution_receipts_proposal
  ON governance_execution_receipts(proposal_id,proposal_revision);
