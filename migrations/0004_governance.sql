PRAGMA foreign_keys=ON;

-- PRD2 private contribution, qualification and governance records.
-- This migration deliberately does not create role_grants; that table belongs to
-- the identity/permissions migration and is consumed by the services below.
CREATE TABLE IF NOT EXISTS contributions(
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK(domain IN ('data','review','code_doc','infrastructure','security_governance')),
  work_type TEXT NOT NULL,
  work_unit_json TEXT NOT NULL,
  source_ref TEXT,
  contribution_cluster_id TEXT NOT NULL,
  materiality TEXT NOT NULL CHECK(materiality IN ('routine','qualification','major','disputed')),
  status TEXT NOT NULL CHECK(status IN ('submitted','deduplicated','under_assessment','accepted_pending','recognized','duplicate','needs_info','not_qualified','challenged','confirmed','adjusted','revoked')),
  public_summary_allowed INTEGER NOT NULL DEFAULT 0 CHECK(public_summary_allowed IN (0,1)),
  challenge_expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT UNIQUE,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contributions_principal ON contributions(principal_id,domain,status);
CREATE INDEX IF NOT EXISTS contributions_cluster ON contributions(contribution_cluster_id,status);

CREATE TABLE IF NOT EXISTS contribution_assessments(
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  assessor_principal_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('accept','duplicate','needs_info','not_qualified','confirm','adjust','revoke')),
  reason TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  assessment_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(contribution_id,assessor_principal_id,assessment_revision)
);
CREATE INDEX IF NOT EXISTS contribution_assessor ON contribution_assessments(contribution_id,created_at);

CREATE TABLE IF NOT EXISTS contribution_events(
  id TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qualification_applications(
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  target_role TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  training_json TEXT NOT NULL,
  equivalent_route INTEGER NOT NULL DEFAULT 0 CHECK(equivalent_route IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('submitted','under_assessment','approved','rejected','appealed','expired','revoked')),
  decision_reason TEXT,
  valid_until TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT UNIQUE,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS qualification_principal ON qualification_applications(principal_id,target_role,status);

CREATE TABLE IF NOT EXISTS qualification_assessments(
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES qualification_applications(id) ON DELETE CASCADE,
  assessor_principal_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject','request_info')),
  reason TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(application_id,assessor_principal_id)
);

CREATE TABLE IF NOT EXISTS qualification_training(
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  target_role TEXT NOT NULL,
  module TEXT NOT NULL,
  passed_at TEXT NOT NULL,
  score INTEGER NOT NULL CHECK(score>=0 AND score<=100),
  evidence_ref TEXT,
  UNIQUE(principal_id,target_role,module)
);

CREATE TABLE IF NOT EXISTS contribution_appeals(
  id TEXT PRIMARY KEY,
  appellant_principal_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('contribution','qualification')),
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('submitted','under_review','confirmed','adjusted','rejected','paused')),
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT UNIQUE,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS appeals_subject ON contribution_appeals(subject_type,subject_id,status);

CREATE TABLE IF NOT EXISTS appeal_assessments(
  id TEXT PRIMARY KEY,
  appeal_id TEXT NOT NULL REFERENCES contribution_appeals(id) ON DELETE CASCADE,
  assessor_principal_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('confirm','adjust','reject','pause')),
  reason TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(appeal_id,assessor_principal_id)
);

CREATE TABLE IF NOT EXISTS governance_proposals(
  id TEXT PRIMARY KEY,
  proposer_principal_id TEXT NOT NULL,
  proposal_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body_json TEXT NOT NULL,
  public_summary TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','discussion','voting','passed','rejected','withdrawn','expired','timelocked','ready_to_execute','executed','blocked','failed')),
  revision INTEGER NOT NULL DEFAULT 1,
  discussion_started_at TEXT,
  discussion_ends_at TEXT,
  voting_ends_at TEXT,
  timelock_until TEXT,
  electorate_snapshot_id TEXT,
  execution_id TEXT UNIQUE,
  execution_result_json TEXT,
  idempotency_key TEXT UNIQUE,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS governance_proposal_state ON governance_proposals(state,updated_at);

CREATE TABLE IF NOT EXISTS electorate_snapshots(
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES governance_proposals(id) ON DELETE CASCADE,
  policy_version TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  eligible_count INTEGER NOT NULL,
  members_json TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS electorate_snapshot_lookup ON electorate_snapshots(proposal_id,frozen_at);

CREATE TABLE IF NOT EXISTS governance_ballots(
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES governance_proposals(id) ON DELETE CASCADE,
  proposal_revision INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK(choice IN ('yes','no','abstain')),
  ballot_revision INTEGER NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(proposal_id,principal_id,ballot_revision)
);
CREATE INDEX IF NOT EXISTS governance_ballots_latest ON governance_ballots(proposal_id,principal_id,ballot_revision);

-- P0 uses a three-person transition committee.  Mature community ballots are
-- intentionally kept separate and disabled until the P1 governance migration.
CREATE TABLE IF NOT EXISTS governance_committee_approvals(
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES governance_proposals(id) ON DELETE CASCADE,
  proposal_revision INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(proposal_id,proposal_revision,principal_id)
);
CREATE INDEX IF NOT EXISTS governance_committee_approval_lookup ON governance_committee_approvals(proposal_id,proposal_revision,decision);

CREATE TABLE IF NOT EXISTS governance_events(
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES governance_proposals(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS governance_execution_keys(
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES governance_proposals(id) ON DELETE CASCADE,
  signer_key_id TEXT NOT NULL,
  signer_principal_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(proposal_id,signer_key_id)
);

CREATE TABLE IF NOT EXISTS governance_nodes(
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  challenge_hash TEXT NOT NULL,
  challenge_expires_at TEXT NOT NULL,
  challenged_at TEXT,
  target_ref TEXT NOT NULL,
  control_group TEXT NOT NULL,
  provider_group TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active','expired','withdrawn','suppressed')),
  valid_until TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS governance_nodes_status ON governance_nodes(status,valid_until);

CREATE TABLE IF NOT EXISTS governance_node_observations(
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES governance_nodes(id) ON DELETE CASCADE,
  observer_ref TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  target_version TEXT NOT NULL,
  reachable INTEGER NOT NULL CHECK(reachable IN (0,1)),
  content_verified INTEGER NOT NULL CHECK(content_verified IN (0,1)),
  retrieval_verified INTEGER NOT NULL CHECK(retrieval_verified IN (0,1)),
  fault_domain TEXT NOT NULL,
  details_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS governance_outbox(
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
