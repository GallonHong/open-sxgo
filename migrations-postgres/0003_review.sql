-- PRD2 G2 review and source-processing state.  The identity service owns
-- case_assignments; this migration stores only the opaque assignment id.

CREATE TABLE IF NOT EXISTS source_fetch_jobs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  source_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'fetching', 'blocked', 'needs_manual_triage',
    'fetchable_under_policy', 'sanitized_preview_ready', 'failed', 'expired'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  redirect_count INTEGER NOT NULL DEFAULT 0 CHECK (redirect_count >= 0),
  error_code TEXT,
  preview_id TEXT,
  assignment_id TEXT,
  grant_id TEXT NOT NULL,
  claim_token TEXT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (source_id, case_revision, idempotency_key)
);
CREATE INDEX IF NOT EXISTS source_fetch_queue
  ON source_fetch_jobs (state, updated_at);
CREATE INDEX IF NOT EXISTS source_fetch_case
  ON source_fetch_jobs (case_id, case_revision, updated_at);

CREATE TABLE IF NOT EXISTS sanitized_previews (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES source_fetch_jobs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision INTEGER NOT NULL CHECK (case_revision > 0),
  state TEXT NOT NULL CHECK (state = 'sanitized_preview_ready'),
  display_domain TEXT NOT NULL,
  final_domain TEXT NOT NULL,
  fetch_policy TEXT NOT NULL,
  redirect_count INTEGER NOT NULL DEFAULT 0 CHECK (redirect_count >= 0),
  threat_intelligence TEXT NOT NULL DEFAULT 'not_checked',
  source_authenticity TEXT NOT NULL DEFAULT 'unverified',
  text_ref TEXT NOT NULL,
  text_content TEXT NOT NULL,
  image_ref TEXT,
  raw_html_available_to_reviewer INTEGER NOT NULL DEFAULT 0
    CHECK (raw_html_available_to_reviewer = 0),
  public_destination_enforced INTEGER NOT NULL CHECK (public_destination_enforced = 1),
  network_egress_policy_enforced INTEGER NOT NULL CHECK (network_egress_policy_enforced = 1),
  login_required INTEGER NOT NULL DEFAULT 0 CHECK (login_required IN (0, 1)),
  download_attempted INTEGER NOT NULL DEFAULT 0 CHECK (download_attempted = 0),
  output_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sanitized_preview_case
  ON sanitized_previews (case_id, case_revision, expires_at);

-- A case revision is the immutable candidate digest against which both
-- independent decisions must be recorded.
CREATE TABLE IF NOT EXISTS review_cases (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  state TEXT NOT NULL CHECK (state IN (
    'open', 'awaiting_independent_review', 'approved_for_publication',
    'rejected', 'returned', 'blocked', 'needs_escalation', 'superseded'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_case_revisions (
  case_id TEXT NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  candidate_digest TEXT NOT NULL,
  candidate_body TEXT NOT NULL,
  source_preview_ids TEXT NOT NULL DEFAULT '[]',
  created_by_person_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, revision)
);
CREATE INDEX IF NOT EXISTS review_revision_digest
  ON review_case_revisions (case_id, candidate_digest);

-- assignment_id is supplied and checked by the identity service.  Keeping it
-- opaque here prevents this workflow from becoming a second identity DB.
CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  candidate_digest TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  reviewer_person_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('initial', 'independent', 'escalation')),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'return', 'abstain')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (case_id, revision, reviewer_person_id, stage)
);
CREATE INDEX IF NOT EXISTS review_decision_revision
  ON review_decisions (case_id, revision, stage, action);

CREATE TABLE IF NOT EXISTS review_blocking_issues (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  code TEXT NOT NULL CHECK (code IN (
    'privacy_leak', 'subject_mismatch', 'source_fabrication',
    'phishing_link', 'scope_mismatch', 'unresolved_major_conflict'
  )),
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
  reported_by_person_id TEXT NOT NULL,
  resolution_reason TEXT,
  resolved_by_person_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (case_id, revision, code)
);
CREATE INDEX IF NOT EXISTS review_open_blockers
  ON review_blocking_issues (case_id, revision, state);

CREATE TABLE IF NOT EXISTS review_events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
  revision INTEGER,
  actor_person_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_events_case
  ON review_events (case_id, created_at);
