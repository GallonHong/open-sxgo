PRAGMA foreign_keys=ON;

-- PRD2 identity and authorization data is additive. The legacy principals
-- row remains readable by the closed demo until callers migrate explicitly;
-- this migration never turns legacy roles or '*' scopes into active grants.
CREATE TABLE IF NOT EXISTS principal_identities(
  principal_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','active','suspended','revoked','demo_only')),
  privacy_preferences TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS principal_identities_person ON principal_identities(person_id,status);

CREATE TABLE IF NOT EXISTS principal_accounts(
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principal_identities(principal_id),
  status TEXT NOT NULL CHECK(status IN ('pending','active','suspended','revoked')),
  linked_at TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  account_revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS principal_accounts_principal ON principal_accounts(principal_id,status);

CREATE TABLE IF NOT EXISTS principal_keys(
  key_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principal_identities(principal_id),
  purpose TEXT NOT NULL CHECK(purpose IN ('login','business','encryption','root')),
  public_key TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','revoked','expired','frozen')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(principal_id,purpose,public_key)
);
CREATE INDEX IF NOT EXISTS principal_keys_active ON principal_keys(principal_id,purpose,status);

CREATE TABLE IF NOT EXISTS principal_api_credentials(
  credential_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principal_identities(principal_id),
  grant_id TEXT REFERENCES role_grants(grant_id),
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked','expired','frozen')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS principal_api_credentials_lookup
  ON principal_api_credentials(principal_id,grant_id,status,expires_at);

CREATE TABLE IF NOT EXISTS webauthn_credentials(
  credential_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principal_identities(principal_id),
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  rp_id TEXT NOT NULL,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  user_verified_required INTEGER NOT NULL DEFAULT 1 CHECK(user_verified_required=1),
  status TEXT NOT NULL CHECK(status IN ('active','revoked','frozen')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE(user_id,credential_id)
);
CREATE INDEX IF NOT EXISTS webauthn_credentials_principal ON webauthn_credentials(principal_id,status);

-- Better Auth's passkey plugin uses this table for ordinary passkey login and
-- registration. High-privilege authorization additionally requires the
-- session-bound proof stored below; a passkey enrollment flag is not proof.
CREATE TABLE IF NOT EXISTS passkey(
  id TEXT PRIMARY KEY,
  name TEXT,
  publicKey TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  credentialID TEXT NOT NULL UNIQUE,
  counter INTEGER NOT NULL DEFAULT 0,
  deviceType TEXT NOT NULL,
  backedUp INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  createdAt INTEGER NOT NULL,
  aaguid TEXT
);
CREATE INDEX IF NOT EXISTS passkey_user ON passkey(userId);
CREATE INDEX IF NOT EXISTS passkey_credential ON passkey(credentialID);

CREATE TABLE IF NOT EXISTS webauthn_challenges(
  challenge_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('registration','step_up')),
  credential_id TEXT,
  challenge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS webauthn_challenges_unique
  ON webauthn_challenges(session_id,purpose,challenge);
CREATE INDEX IF NOT EXISTS webauthn_challenges_active ON webauthn_challenges(session_id,expires_at,consumed_at);

-- This is a per-session proof, not an account enrollment flag. It is written
-- only after the WebAuthn/TOTP verifier has accepted the current challenge.
CREATE TABLE IF NOT EXISTS session_assurance(
  assurance_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK(method IN ('password','totp','webauthn')),
  assurance TEXT NOT NULL CHECK(assurance IN ('basic','password_mfa','webauthn_uv','webauthn_step_up')),
  credential_id TEXT,
  challenge_id TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(session_id,challenge_id)
);
CREATE INDEX IF NOT EXISTS session_assurance_current ON session_assurance(session_id,expires_at);

CREATE TABLE IF NOT EXISTS conflict_declarations(
  conflict_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  principal_id TEXT REFERENCES principal_identities(principal_id),
  object_type TEXT NOT NULL,
  object_id TEXT,
  reason_category TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','resolved','expired')),
  disclosed_at TEXT NOT NULL,
  expires_at TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT
);
CREATE INDEX IF NOT EXISTS conflict_declarations_lookup ON conflict_declarations(person_id,status,object_type,object_id);

CREATE TABLE IF NOT EXISTS role_grants(
  grant_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principal_identities(principal_id),
  person_id TEXT NOT NULL,
  role TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  scope TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  approval_ref TEXT NOT NULL,
  grant_revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('active','suspended','revoked','expired','frozen')),
  revocation_status TEXT NOT NULL CHECK(revocation_status IN ('not_revoked','suspended','revoked')),
  revoked_at TEXT,
  revocation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(json_valid(capabilities)),
  CHECK(json_valid(scope)),
  CHECK(instr(capabilities,'*')=0),
  CHECK(instr(scope,'"*"')=0)
);
CREATE INDEX IF NOT EXISTS role_grants_lookup ON role_grants(principal_id,status,expires_at);
CREATE INDEX IF NOT EXISTS role_grants_person ON role_grants(person_id,status,expires_at);

CREATE TABLE IF NOT EXISTS case_assignments(
  assignment_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  candidate_revision INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('primary','secondary')),
  principal_id TEXT NOT NULL REFERENCES principal_identities(principal_id),
  person_id TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES role_grants(grant_id),
  conflict_snapshot TEXT NOT NULL CHECK(conflict_snapshot IN ('clear','blocked')),
  status TEXT NOT NULL CHECK(status IN ('assigned','accepted','in_progress','completed','declined','expired','revoked')),
  assigned_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  assignment_revision INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS case_assignments_active_seat
  ON case_assignments(case_id,candidate_revision,stage)
  WHERE status IN ('assigned','accepted','in_progress');
CREATE UNIQUE INDEX IF NOT EXISTS case_assignments_active_person
  ON case_assignments(case_id,candidate_revision,person_id)
  WHERE status IN ('assigned','accepted','in_progress');
CREATE INDEX IF NOT EXISTS case_assignments_person ON case_assignments(person_id,status,expires_at);

CREATE TABLE IF NOT EXISTS authorization_jobs(
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principal_identities(principal_id),
  grant_id TEXT NOT NULL REFERENCES role_grants(grant_id),
  grant_revision INTEGER NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  scope_snapshot TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','completed','blocked_by_revocation','failed','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  input_ref TEXT NOT NULL,
  output_ref TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK(json_valid(scope_snapshot))
);
CREATE INDEX IF NOT EXISTS authorization_jobs_queue ON authorization_jobs(state,updated_at);
CREATE INDEX IF NOT EXISTS authorization_jobs_grant ON authorization_jobs(grant_id,state);

CREATE TABLE IF NOT EXISTS outbox_events(
  event_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','processing','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  claimed_by TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE(topic,aggregate_type,aggregate_id,aggregate_revision)
);
CREATE INDEX IF NOT EXISTS outbox_events_ready ON outbox_events(state,available_at);

CREATE TABLE IF NOT EXISTS identity_legacy_import(
  user_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  legacy_roles TEXT NOT NULL,
  legacy_company_ids TEXT NOT NULL,
  legacy_conflicts TEXT NOT NULL,
  migration_status TEXT NOT NULL DEFAULT 'demo_only' CHECK(migration_status IN ('demo_only','pending_reverification','imported')),
  imported_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
);
INSERT OR IGNORE INTO identity_legacy_import
  (user_id,person_id,legacy_roles,legacy_company_ids,legacy_conflicts,migration_status,imported_at)
SELECT user_id,person_id,roles,company_ids,conflicts,'demo_only',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM principals;
