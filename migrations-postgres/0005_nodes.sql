CREATE TABLE IF NOT EXISTS node_registrations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  control_group TEXT NOT NULL,
  fault_domain TEXT NOT NULL,
  state TEXT NOT NULL,
  challenge_hash TEXT,
  challenge_expires_at TEXT,
  challenge_consumed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_observations (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES node_registrations(id),
  observer_id TEXT NOT NULL,
  observer_control_group TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  reachable INTEGER NOT NULL,
  signature_valid INTEGER NOT NULL,
  content_retrieved INTEGER NOT NULL,
  release_version TEXT,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS node_observation_date
  ON node_observations (node_id, observed_at);

CREATE TABLE IF NOT EXISTS node_decisions (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES node_registrations(id),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
