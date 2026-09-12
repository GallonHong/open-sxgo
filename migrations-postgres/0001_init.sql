-- PostgreSQL baseline.  Keep the Better Auth identifiers exactly as they are
-- in the SQLite database.  PostgreSQL folds unquoted names to lower case, so
-- every camelCase table/column is deliberately quoted here.

CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL,
  "twoFactorEnabled" BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS "session" (
  id TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMP NOT NULL,
  token TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
  id TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TIMESTAMP,
  "refreshTokenExpiresAt" TIMESTAMP,
  scope TEXT,
  password TEXT,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  "expiresAt" TIMESTAMP NOT NULL,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS "twoFactor" (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  "backupCodes" TEXT NOT NULL,
  verified BOOLEAN DEFAULT TRUE,
  "failedVerificationCount" INTEGER DEFAULT 0,
  "lockedUntil" TIMESTAMP,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "session_user" ON "session" ("userId");
CREATE INDEX IF NOT EXISTS verification_identifier ON "verification" (identifier);

-- Legacy closed-demo identity data.  It remains private project data and is
-- kept for the same compatibility window as the SQLite migrations.
CREATE TABLE IF NOT EXISTS principals (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id),
  person_id TEXT NOT NULL,
  roles TEXT NOT NULL,
  company_ids TEXT NOT NULL DEFAULT '[]',
  conflicts TEXT NOT NULL DEFAULT '[]',
  verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  body TEXT NOT NULL,
  receipt_hash TEXT UNIQUE,
  idempotency_hash TEXT UNIQUE,
  request_hash TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS work_queue ON work_items (state, updated_at);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES work_items(id),
  company_id TEXT NOT NULL,
  body TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  author_person TEXT NOT NULL,
  reviewer_person TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_records (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mutation_guard (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  -- The application stores Date.now() epoch milliseconds; INTEGER is 32-bit.
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_jobs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  input TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS governance (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retention_holds (
  item_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS "rateLimit" (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE,
  count INTEGER,
  -- Better Auth's numeric rate-limit timestamp is also epoch milliseconds.
  "lastRequest" BIGINT
);
