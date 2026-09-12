import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * PostgreSQL counterpart of `schema.ts`.
 *
 * The Better Auth tables intentionally keep their historical names.  In
 * particular, `user`, `account`, and their camelCase columns are not renamed
 * to snake_case: PostgreSQL/Drizzle quotes those identifiers when it emits
 * SQL.  Better Auth supplies JavaScript `Date` values, native PostgreSQL
 * booleans, and integer counters, so the types below do not emulate SQLite's
 * millisecond/0-or-1 representation.
 *
 * The WFD tables remain on the connection's search_path.  This lets a caller
 * run the same schema against an isolated PostgreSQL schema without baking a
 * tenant/schema name into this module.
 */

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
  twoFactorEnabled: boolean('twoFactorEnabled').default(false),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expiresAt').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: timestamp('accessTokenExpiresAt'),
  refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
});

export const passkey = pgTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('publicKey').notNull(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text('credentialID').notNull().unique(),
    counter: integer('counter').notNull().default(0),
    deviceType: text('deviceType').notNull(),
    backedUp: boolean('backedUp').notNull().default(false),
    transports: text('transports'),
    createdAt: timestamp('createdAt').notNull(),
    aaguid: text('aaguid'),
  },
  (table) => ({ user: index('passkey_user').on(table.userId) }),
);

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
});

export const rateLimit = pgTable('rateLimit', {
  id: text('id').primaryKey(),
  key: text('key').unique(),
  count: integer('count'),
  lastRequest: bigint('lastRequest', { mode: 'number' }),
});

export const twoFactor = pgTable('twoFactor', {
  id: text('id').primaryKey(),
  secret: text('secret').notNull(),
  backupCodes: text('backupCodes').notNull(),
  verified: boolean('verified').default(true),
  failedVerificationCount: integer('failedVerificationCount').default(0),
  lockedUntil: timestamp('lockedUntil'),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const principalIdentity = pgTable(
  'principal_identities',
  {
    principalId: text('principal_id').primaryKey(),
    personId: text('person_id').notNull(),
    status: text('status').notNull(),
    privacyPreferences: text('privacy_preferences').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    personStatus: index('principal_identities_person').on(table.personId, table.status),
  }),
);

export const principalAccount = pgTable(
  'principal_accounts',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => principalIdentity.principalId),
    status: text('status').notNull(),
    linkedAt: text('linked_at').notNull(),
    linkedBy: text('linked_by').notNull(),
    accountRevision: integer('account_revision').notNull().default(1),
  },
  (table) => ({
    principalStatus: index('principal_accounts_principal').on(table.principalId, table.status),
  }),
);

export const principalKey = pgTable(
  'principal_keys',
  {
    keyId: text('key_id').primaryKey(),
    principalId: text('principal_id')
      .notNull()
      .references(() => principalIdentity.principalId),
    purpose: text('purpose').notNull(),
    publicKey: text('public_key').notNull(),
    algorithm: text('algorithm').notNull(),
    validFrom: text('valid_from').notNull(),
    expiresAt: text('expires_at'),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (table) => ({
    lookup: index('principal_keys_active').on(table.principalId, table.purpose, table.status),
    uniqueness: uniqueIndex('principal_keys_identity_purpose_key').on(
      table.principalId,
      table.purpose,
      table.publicKey,
    ),
  }),
);

export const principalApiCredential = pgTable(
  'principal_api_credentials',
  {
    credentialId: text('credential_id').primaryKey(),
    principalId: text('principal_id')
      .notNull()
      .references(() => principalIdentity.principalId),
    grantId: text('grant_id').references(() => roleGrant.grantId),
    secretHash: text('secret_hash').notNull(),
    status: text('status').notNull(),
    issuedAt: text('issued_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (table) => ({
    lookup: index('principal_api_credentials_lookup').on(
      table.principalId,
      table.grantId,
      table.status,
      table.expiresAt,
    ),
  }),
);

export const webauthnCredential = pgTable(
  'webauthn_credentials',
  {
    credentialId: text('credential_id').primaryKey(),
    principalId: text('principal_id')
      .notNull()
      .references(() => principalIdentity.principalId),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    rpId: text('rp_id').notNull(),
    publicKey: bytea('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    transports: text('transports').notNull().default('[]'),
    userVerifiedRequired: boolean('user_verified_required').notNull().default(true),
    status: text('status').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (table) => ({
    principalStatus: index('webauthn_credentials_principal').on(table.principalId, table.status),
  }),
);

export const sessionAssurance = pgTable(
  'session_assurance',
  {
    assuranceId: text('assurance_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    assurance: text('assurance').notNull(),
    credentialId: text('credential_id'),
    challengeId: text('challenge_id').notNull(),
    verifiedAt: text('verified_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (table) => ({ current: index('session_assurance_current').on(table.sessionId, table.expiresAt) }),
);

export const webauthnChallenge = pgTable(
  'webauthn_challenges',
  {
    challengeId: text('challenge_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    credentialId: text('credential_id'),
    challenge: text('challenge').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    consumedAt: text('consumed_at'),
  },
  (table) => ({
    active: index('webauthn_challenges_active').on(
      table.sessionId,
      table.expiresAt,
      table.consumedAt,
    ),
  }),
);

export const conflictDeclaration = pgTable(
  'conflict_declarations',
  {
    conflictId: text('conflict_id').primaryKey(),
    personId: text('person_id').notNull(),
    principalId: text('principal_id').references(() => principalIdentity.principalId),
    objectType: text('object_type').notNull(),
    objectId: text('object_id'),
    reasonCategory: text('reason_category').notNull(),
    status: text('status').notNull(),
    disclosedAt: text('disclosed_at').notNull(),
    expiresAt: text('expires_at'),
    reviewedAt: text('reviewed_at'),
    reviewedBy: text('reviewed_by'),
  },
  (table) => ({
    lookup: index('conflict_declarations_lookup').on(
      table.personId,
      table.status,
      table.objectType,
      table.objectId,
    ),
  }),
);

export const roleGrant = pgTable(
  'role_grants',
  {
    grantId: text('grant_id').primaryKey(),
    principalId: text('principal_id')
      .notNull()
      .references(() => principalIdentity.principalId),
    personId: text('person_id').notNull(),
    role: text('role').notNull(),
    capabilities: text('capabilities').notNull(),
    scope: text('scope').notNull(),
    issuedAt: text('issued_at').notNull(),
    notBefore: text('not_before').notNull(),
    expiresAt: text('expires_at').notNull(),
    policyVersion: text('policy_version').notNull(),
    approvalRef: text('approval_ref').notNull(),
    grantRevision: integer('grant_revision').notNull().default(1),
    status: text('status').notNull(),
    revocationStatus: text('revocation_status').notNull(),
    revokedAt: text('revoked_at'),
    revocationReason: text('revocation_reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    lookup: index('role_grants_lookup').on(table.principalId, table.status, table.expiresAt),
    person: index('role_grants_person').on(table.personId, table.status, table.expiresAt),
  }),
);

export const caseAssignment = pgTable(
  'case_assignments',
  {
    assignmentId: text('assignment_id').primaryKey(),
    caseId: text('case_id').notNull(),
    candidateRevision: integer('candidate_revision').notNull(),
    stage: text('stage').notNull(),
    principalId: text('principal_id')
      .notNull()
      .references(() => principalIdentity.principalId),
    personId: text('person_id').notNull(),
    grantId: text('grant_id')
      .notNull()
      .references(() => roleGrant.grantId),
    conflictSnapshot: text('conflict_snapshot').notNull(),
    status: text('status').notNull(),
    assignedAt: text('assigned_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    assignmentRevision: integer('assignment_revision').notNull().default(1),
  },
  (table) => ({
    queue: index('case_assignments_queue').on(
      table.caseId,
      table.candidateRevision,
      table.stage,
      table.status,
    ),
    person: index('case_assignments_person').on(table.personId, table.status, table.expiresAt),
  }),
);

export const authorizationJob = pgTable(
  'authorization_jobs',
  {
    jobId: text('job_id').primaryKey(),
    kind: text('kind').notNull(),
    principalId: text('principal_id')
      .notNull()
      .references(() => principalIdentity.principalId),
    grantId: text('grant_id')
      .notNull()
      .references(() => roleGrant.grantId),
    grantRevision: integer('grant_revision').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    scopeSnapshot: text('scope_snapshot').notNull(),
    state: text('state').notNull(),
    version: integer('version').notNull().default(1),
    inputRef: text('input_ref').notNull(),
    outputRef: text('output_ref'),
    leaseOwner: text('lease_owner'),
    leaseUntil: text('lease_until'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    closedAt: text('closed_at'),
  },
  (table) => ({
    queue: index('authorization_jobs_queue').on(table.state, table.updatedAt),
    grant: index('authorization_jobs_grant').on(table.grantId, table.state),
  }),
);

export const outboxEvent = pgTable(
  'outbox_events',
  {
    eventId: text('event_id').primaryKey(),
    topic: text('topic').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    aggregateRevision: integer('aggregate_revision').notNull(),
    payloadJson: text('payload_json').notNull(),
    payloadHash: text('payload_hash').notNull(),
    state: text('state').notNull(),
    attempts: integer('attempts').notNull().default(0),
    availableAt: text('available_at').notNull(),
    claimedBy: text('claimed_by'),
    leaseUntil: text('lease_until'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    deliveredAt: text('delivered_at'),
  },
  (table) => ({
    ready: index('outbox_events_ready').on(table.state, table.availableAt),
    aggregate: uniqueIndex('outbox_events_aggregate').on(
      table.topic,
      table.aggregateType,
      table.aggregateId,
      table.aggregateRevision,
    ),
  }),
);

export const identityLegacyImport = pgTable('identity_legacy_import', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  personId: text('person_id').notNull(),
  legacyRoles: text('legacy_roles').notNull(),
  legacyCompanyIds: text('legacy_company_ids').notNull(),
  legacyConflicts: text('legacy_conflicts').notNull(),
  migrationStatus: text('migration_status').notNull().default('demo_only'),
  importedAt: text('imported_at').notNull(),
  reviewedAt: text('reviewed_at'),
  reviewedBy: text('reviewed_by'),
});
