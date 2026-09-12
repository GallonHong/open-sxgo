CREATE TABLE IF NOT EXISTS contribution_claims (
  submission_id TEXT PRIMARY KEY REFERENCES work_items(id),
  contribution_id TEXT NOT NULL UNIQUE REFERENCES contributions(id),
  principal_id TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS security_incidents (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  private_summary TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  review_due_at TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL
);
