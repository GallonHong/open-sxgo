import { z } from 'zod';
import type { Database, Query } from '../../db/src/adapter';

/**
 * The identity layer is deliberately separate from Better Auth accounts. A
 * Better Auth user is an authentication handle; a person_id is the private
 * independent-person mapping used for review and governance cardinality.
 */
export const capabilitySchema = z.enum([
  'account.provision',
  'contribution.read_own',
  'contribution.assess',
  'qualification.assess',
  'case.prepare',
  'case.read_public_source',
  'case.assign',
  'case.submit_decision',
  'case.independent_review',
  'case.resolve_blocking',
  'source.fetch',
  'evidence.read_scoped',
  'entry.emergency_suppress',
  'node.propose',
  'node.approve_listing',
  'node.observe',
  'policy.vote',
  'role.propose',
  'role.execute',
  'role.suspend',
  'role.revoke',
  'governance.propose',
  'governance.execute',
  'incident.manage',
  'release.sign',
  'root.sign',
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const grantStatusSchema = z.enum(['active', 'suspended', 'revoked', 'expired', 'frozen']);
export type GrantStatus = z.infer<typeof grantStatusSchema>;

export const grantScopeSchema = z
  .strictObject({
    source_types: z.array(z.string().min(1).max(100)).max(50).default([]),
    regions: z.array(z.string().min(1).max(100)).max(50).default([]),
    labor_rule_fields: z.array(z.string().min(1).max(100)).max(50).default([]),
    contribution_domains: z.array(z.string().min(1).max(100)).max(50).default([]),
    contribution_ids: z.array(z.string().min(1).max(120)).max(100).default([]),
    policy_ids: z.array(z.string().min(1).max(120)).max(100).default([]),
    role_ids: z.array(z.string().min(1).max(120)).max(100).default([]),
    company_ids: z.array(z.string().min(1).max(120)).max(100).default([]),
    qualification_ids: z.array(z.string().min(1).max(120)).max(100).default([]),
    source_ids: z.array(z.string().min(1).max(120)).max(100).default([]),
    proposal_ids: z.array(z.string().min(1).max(120)).max(100).default([]),
    incident_ids: z.array(z.string().min(1).max(120)).max(100).default([]),
    release_ids: z.array(z.string().min(1).max(120)).max(100).default([]),
    code_paths: z.array(z.string().min(1).max(300)).max(100).default([]),
    node_ids: z.array(z.string().min(1).max(120)).max(100).default([]),
    case_ids: z.array(z.string().min(1).max(120)).max(100).default([]),
  })
  .superRefine((scope, ctx) => {
    const values = Object.values(scope).flat();
    if (values.some((value) => value === '*'))
      ctx.addIssue({ code: 'custom', message: '全范围授权必须显式拆分为具体范围' });
    if (values.length === 0)
      ctx.addIssue({ code: 'custom', message: '授权必须至少绑定一个明确范围' });
  });
export type GrantScope = z.infer<typeof grantScopeSchema>;

export const roleGrantSchema = z.strictObject({
  grant_id: z.string().regex(/^grant_[a-z0-9_-]{8,120}$/),
  principal_id: z.string().regex(/^principal_[a-z0-9_-]{8,120}$/),
  person_id: z.string().regex(/^person_[a-z0-9_-]{3,120}$/),
  role: z.string().min(1).max(100),
  capabilities: z.array(capabilitySchema).min(1).max(30),
  scope: grantScopeSchema,
  issued_at: z.iso.datetime({ offset: true }),
  not_before: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }),
  policy_version: z.string().min(1).max(100),
  approval_ref: z.string().min(1).max(200),
  grant_revision: z.number().int().positive(),
  status: grantStatusSchema,
  revocation_status: z.enum(['not_revoked', 'suspended', 'revoked']),
  revoked_at: z.iso.datetime({ offset: true }).nullable(),
  revocation_reason: z.string().max(500).nullable(),
});
export type RoleGrant = z.infer<typeof roleGrantSchema>;

export const principalStatusSchema = z.enum([
  'pending',
  'active',
  'suspended',
  'revoked',
  'demo_only',
]);
export type PrincipalStatus = z.infer<typeof principalStatusSchema>;

export const sessionAssuranceSchema = z.enum([
  'basic',
  'password_mfa',
  'webauthn_uv',
  'webauthn_step_up',
]);
export type SessionAssurance = z.infer<typeof sessionAssuranceSchema>;

export const identityContextSchema = z.strictObject({
  user_id: z.string().min(1).max(200),
  session_id: z.string().min(1).max(200),
  now: z.date().optional(),
});
export type IdentityContext = z.infer<typeof identityContextSchema>;

export type Identity = {
  user_id: string;
  principal_id: string;
  person_id: string;
  status: PrincipalStatus;
  session_id: string;
  assurance: SessionAssurance;
  assurance_expires_at: string | null;
  grants: RoleGrant[];
};

export const assignmentStageSchema = z.enum(['primary', 'secondary']);
export const assignmentStatusSchema = z.enum([
  'assigned',
  'accepted',
  'in_progress',
  'completed',
  'declined',
  'expired',
  'revoked',
]);
export type AssignmentStage = z.infer<typeof assignmentStageSchema>;
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;

export const caseAssignmentSchema = z.strictObject({
  assignment_id: z.string().regex(/^assignment_[a-z0-9_-]{8,120}$/),
  case_id: z.string().min(1).max(200),
  candidate_revision: z.number().int().positive(),
  stage: assignmentStageSchema,
  principal_id: z.string().regex(/^principal_[a-z0-9_-]{8,120}$/),
  person_id: z.string().regex(/^person_[a-z0-9_-]{3,120}$/),
  grant_id: z.string().regex(/^grant_[a-z0-9_-]{8,120}$/),
  conflict_snapshot: z.enum(['clear', 'blocked']),
  status: assignmentStatusSchema,
  assigned_at: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }),
  assignment_revision: z.number().int().positive(),
});
export type CaseAssignment = z.infer<typeof caseAssignmentSchema>;

export const jobStateSchema = z.enum([
  'queued',
  'running',
  'completed',
  'blocked_by_revocation',
  'failed',
  'cancelled',
]);
export type JobState = z.infer<typeof jobStateSchema>;

export const authorizationDecisionSchema = z.strictObject({
  allowed: z.boolean(),
  code: z.string(),
  principal_id: z.string().nullable(),
  person_id: z.string().nullable(),
  grant_id: z.string().nullable(),
  grant_revision: z.number().int().positive().nullable(),
});
export type AuthorizationDecision = z.infer<typeof authorizationDecisionSchema>;

export type AuthorizeInput = {
  capability: Capability;
  object_type:
    | 'case'
    | 'contribution'
    | 'qualification'
    | 'source'
    | 'node'
    | 'release'
    | 'role'
    | 'policy'
    | 'governance'
    | 'incident';
  object_id?: string;
  scope?: Partial<GrantScope>;
  required_assurance?: SessionAssurance;
  now?: Date;
};

type PrincipalRow = {
  user_id: string;
  principal_id: string;
  person_id: string;
  status: PrincipalStatus;
  session_id: string;
  assurance: SessionAssurance;
  assurance_expires_at: string | null;
};
type GrantRow = {
  grant_id: string;
  principal_id: string;
  person_id: string;
  role: string;
  capabilities: string;
  scope: string;
  issued_at: string;
  not_before: string;
  expires_at: string;
  policy_version: string;
  approval_ref: string;
  grant_revision: number;
  status: GrantStatus;
  revocation_status: 'not_revoked' | 'suspended' | 'revoked';
  revoked_at: string | null;
  revocation_reason: string | null;
};

export class PermissionError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 403,
  ) {
    super(code);
    this.name = 'PermissionError';
  }
}

const isoNow = (value = new Date()) => value.toISOString();
const randomId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const isActiveStatus = (status: GrantStatus) => status === 'active';
/**
 * Better Auth's `expiresAt` is an absolute upper bound, while `createdAt` and
 * `updatedAt` provide the independent hard and idle windows required for
 * privileged project sessions. `authorize()` touches updatedAt only after a
 * successful current-grant check, so the idle window is not extended by a
 * rejected request or by Better Auth's plugin refresh policy alone.
 */
export const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const assuranceRank: Record<SessionAssurance, number> = {
  basic: 0,
  password_mfa: 1,
  webauthn_uv: 2,
  webauthn_step_up: 3,
};

function matchesScope(grant: GrantScope, input: AuthorizeInput) {
  const objectScope: Partial<Record<AuthorizeInput['object_type'], keyof GrantScope>> = {
    case: 'case_ids',
    // The contribution API currently uses the contribution domain as its
    // object reference. Concrete contribution records must opt into an
    // explicit contribution_ids scope at the call site once they have an
    // object reference of their own.
    contribution: 'contribution_domains',
    qualification: 'qualification_ids',
    source: 'source_ids',
    node: 'node_ids',
    role: 'role_ids',
    policy: 'policy_ids',
    governance: 'proposal_ids',
    incident: 'incident_ids',
    release: 'release_ids',
  };
  const objectKey = objectScope[input.object_type];
  if (!objectKey || typeof input.object_id !== 'string' || input.object_id.length === 0)
    return false;
  const checks: [keyof GrantScope, string | undefined][] = [[objectKey, input.object_id]];
  for (const [key, value] of checks) {
    if (typeof value !== 'string' || value.length === 0) return false;
    const allowed = grant[key];
    if (!Array.isArray(allowed) || !allowed.includes(value)) return false;
  }
  for (const key of Object.keys(input.scope ?? {}) as (keyof GrantScope)[]) {
    const requested = input.scope?.[key];
    if (requested === undefined) continue;
    const allowed = grant[key];
    if (
      !Array.isArray(requested) ||
      requested.length === 0 ||
      !Array.isArray(allowed) ||
      allowed.length === 0 ||
      requested.some((item) => !allowed.includes(item))
    )
      return false;
  }
  return true;
}

function isAssuranceSufficient(actual: SessionAssurance, required: SessionAssurance) {
  return assuranceRank[actual] >= assuranceRank[required];
}

function parseGrant(row: GrantRow): RoleGrant | null {
  try {
    // Select only protocol fields. SQLite rows also contain private storage
    // bookkeeping columns, which must never leak into a strict public value.
    return roleGrantSchema.parse({
      grant_id: row.grant_id,
      principal_id: row.principal_id,
      person_id: row.person_id,
      role: row.role,
      capabilities: JSON.parse(row.capabilities),
      scope: JSON.parse(row.scope),
      issued_at: row.issued_at,
      not_before: row.not_before,
      expires_at: row.expires_at,
      policy_version: row.policy_version,
      approval_ref: row.approval_ref,
      grant_revision: row.grant_revision,
      status: row.status,
      revocation_status: row.revocation_status,
      revoked_at: row.revoked_at,
      revocation_reason: row.revocation_reason,
    });
  } catch {
    return null;
  }
}

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function currentAssurance(db: Database, sessionId: string, userId: string, now: Date) {
  const [row] = await db.all<{ assurance: string; expires_at: string }>(
    `SELECT assurance,expires_at FROM session_assurance
      WHERE session_id=? AND user_id=? AND expires_at>?
      ORDER BY verified_at DESC LIMIT 1`,
    [sessionId, userId, isoNow(now)],
  );
  if (!row) return { assurance: 'basic' as SessionAssurance, expires_at: null };
  const assurance = sessionAssuranceSchema.safeParse(row.assurance);
  return assurance.success
    ? { assurance: assurance.data, expires_at: row.expires_at }
    : { assurance: 'basic' as SessionAssurance, expires_at: null };
}

/**
 * Read the private account binding and current authorization state. This is
 * intentionally separate from the legacy Principal resolver: callers using
 * this API never receive roles from the legacy JSON columns.
 */
export async function resolveIdentity(
  db: Database,
  context: IdentityContext,
): Promise<Identity | null> {
  const parsed = identityContextSchema.parse(context);
  const now = parsed.now ?? new Date();
  const [row] = await db.all<PrincipalRow>(
    `SELECT pa.user_id, pi.principal_id, pi.person_id, pi.status,
            COALESCE(
              (SELECT sa.assurance FROM session_assurance sa
                WHERE sa.session_id=s.id AND sa.user_id=s.userId AND sa.expires_at>?
                ORDER BY sa.verified_at DESC LIMIT 1), 'basic'
            ) AS assurance,
            s.id AS session_id,
            (SELECT sa.expires_at FROM session_assurance sa
              WHERE sa.session_id=s.id AND sa.user_id=s.userId AND sa.expires_at>?
              ORDER BY sa.verified_at DESC LIMIT 1) AS assurance_expires_at
       FROM principal_accounts pa
       JOIN principal_identities pi ON pi.principal_id=pa.principal_id
       JOIN session s ON s.id=? AND s.userId=pa.user_id AND s.expiresAt>?
      WHERE pa.user_id=? AND pa.status='active'
        AND s.createdAt>? AND s.updatedAt>?`,
    [
      isoNow(now),
      isoNow(now),
      parsed.session_id,
      now.getTime(),
      parsed.user_id,
      now.getTime() - SESSION_MAX_AGE_MS,
      now.getTime() - SESSION_IDLE_TIMEOUT_MS,
    ],
  );
  if (!row || !['active', 'demo_only'].includes(row.status)) return null;
  const grants = await db.all<GrantRow>(
    'SELECT * FROM role_grants WHERE principal_id=? ORDER BY grant_id',
    [row.principal_id],
  );
  const parsedGrants = grants.flatMap((grant) => {
    const parsedGrant = parseGrant(grant);
    return parsedGrant ? [parsedGrant] : [];
  });
  const assurance = sessionAssuranceSchema.safeParse(row.assurance);
  return {
    user_id: row.user_id,
    principal_id: row.principal_id,
    person_id: row.person_id,
    status: row.status,
    session_id: row.session_id,
    assurance: assurance.success ? assurance.data : 'basic',
    assurance_expires_at: assurance.success ? row.assurance_expires_at : null,
    grants: parsedGrants,
  };
}

/**
 * Capability authorization is object-scoped and fail-closed. The optional
 * expected grant revision is useful to callers that queue a privileged job.
 */
export async function authorize(
  db: Database,
  identity: Identity,
  input: AuthorizeInput,
): Promise<AuthorizationDecision> {
  const required = input.required_assurance ?? 'basic';
  const now = input.now ?? new Date();
  const deny = (code: string): AuthorizationDecision => ({
    allowed: false,
    code,
    principal_id: identity.principal_id,
    person_id: identity.person_id,
    grant_id: null,
    grant_revision: null,
  });
  if (identity.status !== 'active') return deny('CAPABILITY_DENIED');

  // Never authorize against the resolver's grant snapshot. A revoke may have
  // committed after resolveIdentity returned, so every privileged request
  // reloads the account binding, session assurance and grant row.
  const [current] = await db.all<{
    principal_id: string;
    person_id: string;
    status: PrincipalStatus;
  }>(
    `SELECT pi.principal_id,pi.person_id,pi.status
       FROM principal_accounts pa
       JOIN principal_identities pi ON pi.principal_id=pa.principal_id
       JOIN session s ON s.id=? AND s.userId=pa.user_id AND s.expiresAt>?
      WHERE pa.user_id=? AND pa.status='active'
        AND s.createdAt>? AND s.updatedAt>?`,
    [
      identity.session_id,
      now.getTime(),
      identity.user_id,
      now.getTime() - SESSION_MAX_AGE_MS,
      now.getTime() - SESSION_IDLE_TIMEOUT_MS,
    ],
  );
  if (
    !current ||
    current.principal_id !== identity.principal_id ||
    current.person_id !== identity.person_id ||
    current.status !== 'active'
  )
    return deny('CAPABILITY_DENIED');

  const assurance = await currentAssurance(db, identity.session_id, identity.user_id, now);
  if (!isAssuranceSufficient(assurance.assurance, required))
    return deny(
      required.startsWith('webauthn') ? 'WEBAUTHN_STEP_UP_REQUIRED' : 'AUTHENTICATION_REQUIRED',
    );
  const [conflict] = await db.all<{ conflict_id: string }>(
    `SELECT conflict_id FROM conflict_declarations
      WHERE person_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)
        AND (object_id IS NULL OR (object_type=? AND object_id=?)) LIMIT 1`,
    [identity.person_id, isoNow(now), input.object_type, input.object_id ?? null],
  );
  if (conflict) return deny('CONFLICT_OF_INTEREST');

  const rows = await db.all<GrantRow>(
    `SELECT * FROM role_grants
      WHERE principal_id=? AND person_id=?
      ORDER BY grant_revision DESC,grant_id`,
    [current.principal_id, current.person_id],
  );
  const grants = rows.flatMap((row) => {
    const grant = parseGrant(row);
    return grant ? [grant] : [];
  });
  const grant = grants.find((candidate) => {
    if (!isActiveStatus(candidate.status) || candidate.revocation_status !== 'not_revoked')
      return false;
    if (!candidate.capabilities.includes(input.capability) || !matchesScope(candidate.scope, input))
      return false;
    return (
      Date.parse(candidate.not_before) <= now.getTime() &&
      Date.parse(candidate.expires_at) > now.getTime()
    );
  });
  if (!grant) return deny('CAPABILITY_DENIED');
  await db.batch([
    {
      sql: `UPDATE session SET updatedAt=MAX(updatedAt,?)
              WHERE id=? AND userId=? AND expiresAt>?
                AND createdAt>? AND updatedAt>?`,
      params: [
        now.getTime(),
        identity.session_id,
        identity.user_id,
        now.getTime(),
        now.getTime() - SESSION_MAX_AGE_MS,
        now.getTime() - SESSION_IDLE_TIMEOUT_MS,
      ],
    },
  ]);
  return {
    allowed: true,
    code: 'AUTHORIZED',
    principal_id: identity.principal_id,
    person_id: identity.person_id,
    grant_id: grant.grant_id,
    grant_revision: grant.grant_revision,
  };
}

function mutationGuard(): Query[] {
  return [
    { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
    { sql: 'DELETE FROM mutation_guard' },
  ];
}

export type GrantRevocation = {
  grant_id: string;
  expected_revision: number;
  reason: string;
  actor_person_id: string;
};

/** Revoke a grant and invalidate sessions/jobs through the same transaction. */
export async function revokeGrant(db: Database, input: GrantRevocation) {
  const at = isoNow();
  const [grant] = await db.all<GrantRow>('SELECT * FROM role_grants WHERE grant_id=?', [
    input.grant_id,
  ]);
  if (!grant) throw new PermissionError('NOT_FOUND', 404);
  if (grant.grant_revision !== input.expected_revision)
    throw new PermissionError('REVISION_CONFLICT', 409);
  if (grant.person_id === input.actor_person_id)
    throw new PermissionError('SELF_AUTHORIZATION', 403);
  const eventId = randomId('outbox');
  const payload = JSON.stringify({
    grant_id: grant.grant_id,
    principal_id: grant.principal_id,
    reason: input.reason,
  });
  await db.batch([
    {
      sql: `UPDATE role_grants
               SET status='revoked', revocation_status='revoked', revoked_at=?,
                   revocation_reason=?, grant_revision=grant_revision+1, updated_at=?
             WHERE grant_id=? AND grant_revision=? AND status='active' AND revocation_status='not_revoked'`,
      params: [at, input.reason, at, input.grant_id, input.expected_revision],
    },
    ...mutationGuard(),
    {
      sql: `DELETE FROM session
             WHERE userId IN (SELECT pa.user_id FROM principal_accounts pa WHERE pa.principal_id=?)`,
      params: [grant.principal_id],
    },
    {
      sql: `UPDATE principal_api_credentials
               SET status='revoked',revoked_at=?
             WHERE grant_id=? AND status='active'`,
      params: [at, input.grant_id],
    },
    {
      sql: `UPDATE principal_keys SET status='revoked',revoked_at=?
             WHERE principal_id=? AND purpose='business' AND status='active'`,
      params: [at, grant.principal_id],
    },
    {
      sql: `UPDATE case_assignments SET status='revoked',assignment_revision=assignment_revision+1
             WHERE grant_id=? AND status IN ('assigned','accepted','in_progress')`,
      params: [input.grant_id],
    },
    {
      sql: `UPDATE authorization_jobs
               SET state='blocked_by_revocation', version=version+1, updated_at=?
             WHERE principal_id=? AND grant_id=? AND state IN ('queued','running')`,
      params: [at, grant.principal_id, input.grant_id],
    },
    {
      sql: `INSERT INTO outbox_events
        (event_id,topic,aggregate_type,aggregate_id,aggregate_revision,payload_json,payload_hash,state,attempts,available_at,created_at)
        VALUES(?,?,?,?,?,?,?,'pending',0,?,?)`,
      params: [
        eventId,
        'authorization.revoked',
        'role_grant',
        grant.grant_id,
        input.expected_revision + 1,
        payload,
        await sha256Hex(payload),
        at,
        at,
      ],
    },
    {
      sql: 'INSERT INTO audit(id,item_id,actor,action,reason,created_at) VALUES(?,?,?,?,?,?)',
      params: [
        eventId.replace('outbox_', 'audit_'),
        grant.grant_id,
        input.actor_person_id,
        'grant_revoked',
        input.reason,
        at,
      ],
    },
  ]);
  return {
    grant_id: grant.grant_id,
    state: 'revoked',
    grant_revision: input.expected_revision + 1,
  };
}

export type AssignmentRequest = {
  case_id: string;
  candidate_revision: number;
  stage: AssignmentStage;
  principal_id: string;
  person_id: string;
  grant_id: string;
  expires_at: string;
  expected_case_revision: number;
};

/** Assign one person to one review seat; a person cannot occupy both seats. */
export async function assignCase(db: Database, input: AssignmentRequest) {
  // A newly-created review case has current_revision=0. Assignment is made
  // against that exact version and can reserve the first candidate revision;
  // treating zero as invalid deadlocks the normal create -> assign -> submit
  // flow. The CAS below still prevents a stale assignment from being written.
  if (!Number.isInteger(input.expected_case_revision) || input.expected_case_revision < 0)
    throw new PermissionError('REVISION_REQUIRED', 409);
  if (
    !Number.isInteger(input.candidate_revision) ||
    input.candidate_revision <= 0 ||
    ![input.expected_case_revision, input.expected_case_revision + 1].includes(
      input.candidate_revision,
    )
  )
    throw new PermissionError('REVISION_CONFLICT', 409);
  const now = new Date();
  const [identity] = await db.all<{
    principal_id: string;
    person_id: string;
    status: PrincipalStatus;
  }>(`SELECT principal_id,person_id,status FROM principal_identities WHERE principal_id=?`, [
    input.principal_id,
  ]);
  if (!identity || identity.status !== 'active' || identity.person_id !== input.person_id)
    throw new PermissionError('CAPABILITY_DENIED', 403);
  const [grantRow] = await db.all<GrantRow>(
    `SELECT * FROM role_grants
      WHERE grant_id=? AND principal_id=? AND person_id=?`,
    [input.grant_id, input.principal_id, input.person_id],
  );
  const grant = grantRow && parseGrant(grantRow);
  if (
    !grant ||
    !grant.capabilities.includes(
      input.stage === 'secondary' ? 'case.independent_review' : 'case.submit_decision',
    ) ||
    !isActiveStatus(grant.status) ||
    grant.revocation_status !== 'not_revoked' ||
    Date.parse(grant.not_before) > now.getTime() ||
    Date.parse(grant.expires_at) <= now.getTime() ||
    !grant.scope.case_ids.includes(input.case_id)
  )
    throw new PermissionError('CAPABILITY_DENIED', 403);
  // G1 review cases are revisioned by review_cases.current_revision. Keep a
  // work_items fallback for the existing closed demo and older adapters, but
  // only after proving which backing table contains this case.
  const [reviewTable] = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='review_cases'",
  );
  let caseSource: 'review_cases' | 'work_items' = 'work_items';
  let caseRow: { revision: number; state: string } | undefined;
  if (reviewTable) {
    [caseRow] = await db.all<{ revision: number; state: string }>(
      'SELECT current_revision AS revision,state FROM review_cases WHERE id=?',
      [input.case_id],
    );
    if (caseRow) caseSource = 'review_cases';
  }
  if (!caseRow) {
    [caseRow] = await db.all<{ revision: number; state: string }>(
      'SELECT version AS revision,state FROM work_items WHERE id=?',
      [input.case_id],
    );
  }
  if (
    !caseRow ||
    caseRow.revision !== input.expected_case_revision ||
    (caseSource === 'review_cases'
      ? !['open', 'awaiting_independent_review'].includes(caseRow.state)
      : ['withdrawn', 'closed'].includes(caseRow.state))
  )
    throw new PermissionError('REVISION_CONFLICT', 409);
  const parsed = caseAssignmentSchema.parse({
    assignment_id: randomId('assignment'),
    case_id: input.case_id,
    candidate_revision: input.candidate_revision,
    stage: input.stage,
    principal_id: input.principal_id,
    person_id: input.person_id,
    grant_id: input.grant_id,
    conflict_snapshot: 'clear',
    status: 'assigned',
    assigned_at: isoNow(),
    expires_at: input.expires_at,
    assignment_revision: 1,
  });
  if (Date.parse(parsed.expires_at) <= now.getTime())
    throw new PermissionError('ROLE_EXPIRED_OR_REVOKED', 403);
  const [conflict] = await db.all<{ conflict_id: string }>(
    `SELECT conflict_id FROM conflict_declarations
      WHERE person_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)
        AND object_type='case' AND (object_id=? OR object_id IS NULL) LIMIT 1`,
    [input.person_id, isoNow(now), input.case_id],
  );
  if (conflict) throw new PermissionError('CONFLICT_OF_INTEREST', 403);
  const sourcePredicate =
    caseSource === 'review_cases'
      ? `EXISTS (SELECT 1 FROM review_cases WHERE id=? AND current_revision=?
                 AND state IN ('open','awaiting_independent_review'))`
      : `EXISTS (SELECT 1 FROM work_items WHERE id=? AND version=?
                 AND state NOT IN ('withdrawn','closed'))`;
  try {
    await db.batch([
      {
        sql: `INSERT INTO case_assignments
          (assignment_id,case_id,candidate_revision,stage,principal_id,person_id,grant_id,conflict_snapshot,status,assigned_at,expires_at,assignment_revision)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?
            WHERE ${sourcePredicate}`,
        params: [
          parsed.assignment_id,
          parsed.case_id,
          parsed.candidate_revision,
          parsed.stage,
          parsed.principal_id,
          parsed.person_id,
          parsed.grant_id,
          parsed.conflict_snapshot,
          parsed.status,
          parsed.assigned_at,
          parsed.expires_at,
          parsed.assignment_revision,
          input.case_id,
          input.expected_case_revision,
        ],
      },
      ...mutationGuard(),
    ]);
  } catch (error) {
    // Both the revision CAS (mutation_guard) and the partial uniqueness
    // indexes are concurrent-writer conflicts. Keep the storage error out of
    // the API and let the caller retry with a fresh case revision.
    if (
      error instanceof Error &&
      /mutation_guard|CHECK constraint|UNIQUE constraint/i.test(error.message)
    )
      throw new PermissionError('REVISION_CONFLICT', 409);
    throw error;
  }
  return parsed;
}

export async function authorizeCaseAssignment(
  db: Database,
  identity: Identity,
  caseId: string,
  candidateRevision: number,
  stage: AssignmentStage,
) {
  const [assignment] = await db.all<CaseAssignment>(
    `SELECT * FROM case_assignments
      WHERE case_id=? AND candidate_revision=? AND stage=? AND person_id=?
        AND principal_id=? AND status IN ('assigned','accepted','in_progress')
        AND expires_at>?`,
    [caseId, candidateRevision, stage, identity.person_id, identity.principal_id, isoNow()],
  );
  if (!assignment) return { allowed: false, code: 'CASE_NOT_ASSIGNED' as const };
  const decision = await authorize(db, identity, {
    capability: stage === 'secondary' ? 'case.independent_review' : 'case.submit_decision',
    object_type: 'case',
    object_id: caseId,
    required_assurance: 'webauthn_step_up',
  });
  if (decision.allowed && decision.grant_id === assignment.grant_id)
    return { allowed: true, code: 'AUTHORIZED' as const, assignment };
  return {
    allowed: false,
    code: decision.allowed ? ('CAPABILITY_DENIED' as const) : decision.code,
  };
}

export type AuthorizedJobInput = {
  job_id?: string;
  kind: string;
  capability: Capability;
  object_type: AuthorizeInput['object_type'];
  object_id: string;
  scope?: Partial<GrantScope>;
  input_ref: string;
  now?: Date;
};

const emptyScope = (): GrantScope => ({
  source_types: [],
  regions: [],
  labor_rule_fields: [],
  contribution_domains: [],
  contribution_ids: [],
  policy_ids: [],
  role_ids: [],
  company_ids: [],
  qualification_ids: [],
  source_ids: [],
  proposal_ids: [],
  incident_ids: [],
  release_ids: [],
  code_paths: [],
  node_ids: [],
  case_ids: [],
});

export async function enqueueAuthorizedJob(
  db: Database,
  identity: Identity,
  input: AuthorizedJobInput,
) {
  const now = input.now ?? new Date();
  const decision = await authorize(db, identity, {
    capability: input.capability,
    object_type: input.object_type,
    object_id: input.object_id,
    scope: input.scope,
    required_assurance: 'webauthn_step_up',
    now,
  });
  if (!decision.allowed || !decision.grant_id || !decision.grant_revision)
    throw new PermissionError(
      decision.code,
      decision.code === 'WEBAUTHN_STEP_UP_REQUIRED' ? 403 : 403,
    );
  const [grant] = await db.all<{ expires_at: string }>(
    "SELECT expires_at FROM role_grants WHERE grant_id=? AND grant_revision=? AND status='active'",
    [decision.grant_id, decision.grant_revision],
  );
  if (!grant) throw new PermissionError('ROLE_EXPIRED_OR_REVOKED', 403);
  const jobId = input.job_id ?? randomId('job');
  const scope = { ...emptyScope(), ...(input.scope ?? {}) };
  grantScopeSchema.parse(scope);
  const created = isoNow(now);
  await db.batch([
    {
      sql: `INSERT INTO authorization_jobs
        (job_id,kind,principal_id,grant_id,grant_revision,object_type,object_id,scope_snapshot,state,version,input_ref,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        jobId,
        input.kind,
        identity.principal_id,
        decision.grant_id,
        decision.grant_revision,
        input.object_type,
        input.object_id,
        JSON.stringify(scope),
        'queued',
        1,
        input.input_ref,
        created,
        created,
      ],
    },
    ...mutationGuard(),
  ]);
  return {
    job_id: jobId,
    state: 'queued' as const,
    grant_id: decision.grant_id,
    grant_revision: decision.grant_revision,
    expires_at: grant.expires_at,
  };
}

export type ReauthorizeJobInput = {
  job_id: string;
  principal_id: string;
  grant_id: string;
  expected_grant_revision: number;
  state: 'queued' | 'running';
};

/** Called at queue, start and output; the caller must discard output on false. */
export async function reauthorizeJob(db: Database, input: ReauthorizeJobInput) {
  const [row] = await db.all<{
    state: JobState;
    principal_id: string;
    grant_id: string;
    grant_revision: number;
    principal_status: PrincipalStatus;
    grant_status: GrantStatus | null;
    revocation_status: 'not_revoked' | 'suspended' | 'revoked' | null;
    not_before: string | null;
    expires_at: string;
  }>(
    `SELECT j.state,j.principal_id,j.grant_id,j.grant_revision,
            pi.status AS principal_status,g.status AS grant_status,
            g.revocation_status,g.not_before,g.expires_at
       FROM authorization_jobs j
       JOIN principal_identities pi ON pi.principal_id=j.principal_id
       LEFT JOIN role_grants g ON g.grant_id=j.grant_id
      WHERE j.job_id=? AND j.principal_id=? AND j.grant_id=?`,
    [input.job_id, input.principal_id, input.grant_id],
  );
  const now = Date.now();
  if (
    !row ||
    row.state !== input.state ||
    row.principal_status !== 'active' ||
    row.grant_status !== 'active' ||
    row.revocation_status !== 'not_revoked' ||
    row.grant_revision !== input.expected_grant_revision ||
    !row.not_before ||
    Date.parse(row.not_before) > now ||
    !row.expires_at ||
    Date.parse(row.expires_at) <= now
  ) {
    await db.batch([
      {
        sql: `UPDATE authorization_jobs SET state='blocked_by_revocation',version=version+1,updated_at=?
              WHERE job_id=? AND principal_id=? AND grant_id=? AND state IN ('queued','running')`,
        params: [isoNow(), input.job_id, input.principal_id, input.grant_id],
      },
    ]);
    return false;
  }
  return true;
}

export const identityTables = {
  principal_identities: 'principal_identities',
  principal_accounts: 'principal_accounts',
  principal_keys: 'principal_keys',
  principal_api_credentials: 'principal_api_credentials',
  webauthn_credentials: 'webauthn_credentials',
  session_assurance: 'session_assurance',
  conflict_declarations: 'conflict_declarations',
  role_grants: 'role_grants',
  case_assignments: 'case_assignments',
  authorization_jobs: 'authorization_jobs',
  outbox_events: 'outbox_events',
} as const;

// Keep the package entry point usable by API adapters while the WebAuthn
// module continues to import the shared PermissionError and session policy.
export * from './webauthn';
