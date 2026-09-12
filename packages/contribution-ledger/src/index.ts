import { z } from 'zod';
import type { Database, Query } from '../../db/src/adapter';
import { assert, DomainError } from '../../domain/src/index';
import { canonical, hash, utf8 } from '../../verifier/src/crypto';
import { defaultPolicy, type GovernancePolicy } from '../../governance-policy/src/index';

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{2,100}$/);
const text = z.string().trim().min(1).max(500);
const optionalText = z.string().max(2048).nullable().optional();

export const contributionStates = [
  'submitted',
  'deduplicated',
  'under_assessment',
  'accepted_pending',
  'recognized',
  'duplicate',
  'needs_info',
  'not_qualified',
  'challenged',
  'confirmed',
  'adjusted',
  'revoked',
] as const;
export type ContributionState = (typeof contributionStates)[number];

export const contributionDomains = [
  'data',
  'review',
  'code_doc',
  'infrastructure',
  'security_governance',
] as const;
export type ContributionDomain = (typeof contributionDomains)[number];

export const contributionInputSchema = z.strictObject({
  contribution_id: identifier.optional(),
  principal_id: identifier,
  domain: z.enum(contributionDomains),
  work_type: text,
  subject_ref: text,
  scope_ref: text,
  fact_cycle: text,
  source_family: text,
  work_fingerprint: text,
  source_ref: optionalText,
  materiality: z.enum(['routine', 'qualification', 'major', 'disputed']).default('routine'),
  public_summary_allowed: z.boolean().default(false),
  coauthor_principal_ids: z.array(identifier).max(30).default([]),
  idempotency_key: z.string().min(16).max(256).optional(),
});
// Service callers provide the schema input shape; Zod supplies defaulted
// fields during parsing. Keeping those fields optional here also lets typed
// fixtures and HTTP adapters omit values with server defaults.
export type ContributionInput = z.input<typeof contributionInputSchema>;

export const assessmentSchema = z.strictObject({
  contribution_id: identifier,
  assessor_principal_id: identifier,
  decision: z.enum([
    'accept',
    'duplicate',
    'needs_info',
    'not_qualified',
    'confirm',
    'adjust',
    'revoke',
  ]),
  reason: text,
  policy_version: identifier,
  expected_revision: z.number().int().positive(),
  conflicted: z.boolean().default(false),
});
export type ContributionAssessmentInput = z.input<typeof assessmentSchema>;

export const qualificationRoles = [
  'review_apprentice',
  'public_reviewer',
  'senior_reviewer',
  'code_maintainer',
  'infra_maintainer',
  'security_responder',
  'council_member',
  'governance_voter',
  'publisher',
  'root_custodian',
  'private_evidence_reviewer',
] as const;
export type QualificationRole = (typeof qualificationRoles)[number];

export const qualificationInputSchema = z.strictObject({
  application_id: identifier.optional(),
  principal_id: identifier,
  target_role: z.enum(qualificationRoles),
  scope: z.array(text).max(30),
  evidence_refs: z.array(text).max(100),
  training_modules: z.array(text).max(50),
  project_started_at: z.string().datetime({ offset: true }).nullable().optional(),
  equivalent_route: z.boolean().default(false),
  idempotency_key: z.string().min(16).max(256).optional(),
});
export type QualificationInput = z.input<typeof qualificationInputSchema>;

export const qualificationAssessmentSchema = z.strictObject({
  application_id: identifier,
  assessor_principal_id: identifier,
  decision: z.enum(['approve', 'reject', 'request_info']),
  reason: text,
  policy_version: identifier,
  expected_revision: z.number().int().positive(),
  conflicted: z.boolean().default(false),
});
export type QualificationAssessmentInput = z.input<typeof qualificationAssessmentSchema>;

export const appealInputSchema = z.strictObject({
  appeal_id: identifier.optional(),
  appellant_principal_id: identifier,
  subject_type: z.enum(['contribution', 'qualification']),
  subject_id: identifier,
  reason: text,
  evidence_refs: z.array(text).max(100),
  idempotency_key: z.string().min(16).max(256).optional(),
});
export type AppealInput = z.input<typeof appealInputSchema>;

export const nodeContributionSchema = z.strictObject({
  principal_id: identifier,
  domain: z.literal('infrastructure'),
  work_type: text,
  subject_ref: text,
  scope_ref: text,
  fact_cycle: text,
  source_family: text,
  work_fingerprint: text,
  source_ref: optionalText,
  materiality: z.enum(['routine', 'qualification', 'major', 'disputed']).default('routine'),
  public_summary_allowed: z.boolean().default(false),
  coauthor_principal_ids: z.array(identifier).max(30).default([]),
  idempotency_key: z.string().min(16).max(256).optional(),
});

type ContributionRow = {
  id: string;
  principal_id: string;
  domain: ContributionDomain;
  work_type: string;
  work_unit_json: string;
  source_ref: string | null;
  contribution_cluster_id: string;
  materiality: 'routine' | 'qualification' | 'major' | 'disputed';
  status: ContributionState;
  public_summary_allowed: number;
  challenge_expires_at: string | null;
  version: number;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: string;
  updated_at: string;
};
type QualificationRow = {
  id: string;
  principal_id: string;
  target_role: QualificationRole;
  scope_json: string;
  evidence_json: string;
  training_json: string;
  equivalent_route: number;
  status:
    'submitted' | 'under_assessment' | 'approved' | 'rejected' | 'appealed' | 'expired' | 'revoked';
  decision_reason: string | null;
  valid_until: string | null;
  version: number;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: string;
  updated_at: string;
};
type AppealRow = {
  id: string;
  appellant_principal_id: string;
  subject_type: 'contribution' | 'qualification';
  subject_id: string;
  reason: string;
  evidence_json: string;
  status: 'submitted' | 'under_review' | 'confirmed' | 'adjusted' | 'rejected' | 'paused';
  version: number;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: string;
  updated_at: string;
};

type Actor = string | { principal_id: string };
const actorId = (actor: Actor) => (typeof actor === 'string' ? actor : actor.principal_id);
const stamp = (clock: () => Date) => clock().toISOString();
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const mutationGuard = (): Query[] => [
  { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
  { sql: 'DELETE FROM mutation_guard' },
];

function addDays(value: string, days: number) {
  return new Date(Date.parse(value) + days * 86400000).toISOString();
}

function isAssessmentIndependent(
  contribution: ContributionRow & { coauthor_principal_ids?: string[] },
  assessor: string,
  conflicted: boolean,
) {
  assert(assessor !== contribution.principal_id, 'SELF_ASSESSMENT', 403);
  assert(!conflicted, 'CONFLICT_OF_INTEREST', 403);
  if (contribution.coauthor_principal_ids?.includes(assessor))
    throw new DomainError('COAUTHOR_ASSESSMENT_REQUIRES_INDEPENDENT_REVIEW', 403);
}

export class ContributionLedger {
  constructor(
    public db: Database,
    public policy: GovernancePolicy = defaultPolicy(),
    public clock: () => Date = () => new Date(),
    /** Identity agent may inject its canonical person resolver. */
    public resolvePerson: (principalId: string) => Promise<string> = async (principalId) => {
      try {
        const [row] = await db.all<{ person_id: string }>(
          'SELECT person_id FROM principal_identities WHERE principal_id=? LIMIT 1',
          [principalId],
        );
        return row?.person_id ?? principalId;
      } catch {
        // 0004 is usable before 0005 is installed; identity linkage is then
        // conservatively one principal per person until the resolver exists.
        return principalId;
      }
    },
  ) {}

  async getContribution(id: string): Promise<ContributionRow | null> {
    const [row] = await this.db.all<ContributionRow>('SELECT * FROM contributions WHERE id=?', [
      id,
    ]);
    return row ?? null;
  }

  async listContributions(principalId?: string) {
    const rows = principalId
      ? await this.db.all<ContributionRow>(
          'SELECT * FROM contributions WHERE principal_id=? ORDER BY created_at,id',
          [principalId],
        )
      : await this.db.all<ContributionRow>('SELECT * FROM contributions ORDER BY created_at,id');
    return rows;
  }

  private async clusterId(input: ContributionInput) {
    // Never trust a client supplied cluster id or a client controlled
    // fingerprint as the deduplication key.  A new fingerprint is useful as
    // evidence, but it must not turn the same subject/scope/source cycle into
    // another qualification contribution.
    const basis = canonical({
      subject_ref: input.subject_ref,
      scope_ref: input.scope_ref,
      fact_cycle: input.fact_cycle,
      source_family: input.source_family,
    });
    return `cluster_${(await hash(utf8(basis))).slice(0, 48)}`;
  }

  async submit(input: ContributionInput) {
    const parsed = contributionInputSchema.parse(input);
    const body = canonical(parsed);
    const requestHash = await hash(utf8(body));
    if (parsed.idempotency_key) {
      const [old] = await this.db.all<ContributionRow>(
        'SELECT * FROM contributions WHERE idempotency_key=?',
        [parsed.idempotency_key],
      );
      if (old) {
        assert(old.request_hash === requestHash, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
        return { ...old, replayed: true };
      }
    }
    const cluster = await this.clusterId(parsed);
    const [existing] = await this.db.all<{ id: string }>(
      "SELECT id FROM contributions WHERE contribution_cluster_id=? AND status NOT IN ('duplicate','revoked') ORDER BY created_at,id LIMIT 1",
      [cluster],
    );
    const initial: ContributionState = existing ? 'duplicate' : 'submitted';
    const now = stamp(this.clock);
    const id = parsed.contribution_id ?? newId('con');
    const row: ContributionRow = {
      id,
      principal_id: parsed.principal_id,
      domain: parsed.domain,
      work_type: parsed.work_type,
      work_unit_json: canonical({
        subject_ref: parsed.subject_ref,
        scope_ref: parsed.scope_ref,
        fact_cycle: parsed.fact_cycle,
        source_family: parsed.source_family,
        work_fingerprint: parsed.work_fingerprint,
        coauthor_principal_ids: parsed.coauthor_principal_ids,
      }),
      source_ref: parsed.source_ref ?? null,
      contribution_cluster_id: cluster,
      materiality: parsed.materiality,
      status: initial,
      public_summary_allowed: parsed.public_summary_allowed ? 1 : 0,
      challenge_expires_at: null,
      version: 1,
      idempotency_key: parsed.idempotency_key ?? null,
      request_hash: requestHash,
      created_at: now,
      updated_at: now,
    };
    await this.db.batch([
      {
        sql: `INSERT INTO contributions
          (id,principal_id,domain,work_type,work_unit_json,source_ref,contribution_cluster_id,materiality,status,public_summary_allowed,challenge_expires_at,version,idempotency_key,request_hash,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          row.id,
          row.principal_id,
          row.domain,
          row.work_type,
          row.work_unit_json,
          row.source_ref,
          row.contribution_cluster_id,
          row.materiality,
          row.status,
          row.public_summary_allowed,
          row.challenge_expires_at,
          row.version,
          row.idempotency_key,
          row.request_hash,
          row.created_at,
          row.updated_at,
        ],
      },
      {
        sql: `INSERT INTO contribution_events
          (id,contribution_id,from_state,to_state,actor_principal_id,reason,policy_version,revision,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
        params: [
          newId('conev'),
          id,
          null,
          initial,
          parsed.principal_id,
          existing ? 'duplicate_cluster' : 'submitted',
          this.policy.policy_version,
          1,
          now,
        ],
      },
      {
        sql: 'INSERT INTO governance_outbox(id,event_type,aggregate_id,payload_json,created_at) VALUES(?,?,?,?,?)',
        params: [
          newId('out'),
          'contribution.submitted',
          id,
          canonical({ contribution_id: id, state: initial, cluster_id: cluster }),
          now,
        ],
      },
    ]);
    return { ...row, replayed: false };
  }

  private async requireContribution(id: string) {
    const row = await this.getContribution(id);
    assert(row, 'NOT_FOUND', 404);
    return row;
  }

  private contributionTransitionQueries(
    row: ContributionRow,
    to: ContributionState,
    actor: Actor,
    reason: string,
    expectedRevision: number,
    extra: Query[] = [],
    now = stamp(this.clock),
  ): Query[] {
    const allowed: Record<ContributionState, ContributionState[]> = {
      submitted: ['deduplicated', 'under_assessment', 'needs_info', 'not_qualified'],
      deduplicated: ['under_assessment', 'duplicate'],
      under_assessment: [
        'accepted_pending',
        'duplicate',
        'needs_info',
        'not_qualified',
        'challenged',
      ],
      accepted_pending: ['recognized', 'challenged', 'adjusted', 'revoked'],
      recognized: ['challenged', 'revoked'],
      challenged: ['confirmed', 'adjusted', 'revoked'],
      duplicate: [],
      needs_info: ['under_assessment', 'not_qualified'],
      not_qualified: ['under_assessment', 'challenged'],
      confirmed: [],
      adjusted: [],
      revoked: [],
    };
    assert(allowed[row.status]?.includes(to), 'INVALID_CONTRIBUTION_TRANSITION', 409);
    const revision = row.version + 1;
    return [
      {
        sql: 'UPDATE contributions SET status=?,version=version+1,updated_at=? WHERE id=? AND status=? AND version=?',
        params: [to, now, row.id, row.status, expectedRevision],
      },
      ...mutationGuard(),
      ...extra,
      {
        sql: `INSERT INTO contribution_events
          (id,contribution_id,from_state,to_state,actor_principal_id,reason,policy_version,revision,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
        params: [
          newId('conev'),
          row.id,
          row.status,
          to,
          actorId(actor),
          reason,
          this.policy.policy_version,
          revision,
          now,
        ],
      },
      {
        sql: 'INSERT INTO governance_outbox(id,event_type,aggregate_id,payload_json,created_at) VALUES(?,?,?,?,?)',
        params: [
          newId('out'),
          `contribution.${to}`,
          row.id,
          canonical({ contribution_id: row.id, state: to, revision }),
          now,
        ],
      },
    ];
  }

  private async transitionContribution(
    row: ContributionRow,
    to: ContributionState,
    actor: Actor,
    reason: string,
    expectedRevision: number,
    extra: Query[] = [],
  ) {
    await this.db.batch(
      this.contributionTransitionQueries(row, to, actor, reason, expectedRevision, extra),
    );
    const updated = await this.getContribution(row.id);
    assert(updated, 'NOT_FOUND', 404);
    return updated;
  }

  async beginAssessment(
    contributionId: string,
    assessorPrincipalId: string,
    expectedRevision: number,
    conflicted = false,
  ) {
    const row = await this.requireContribution(contributionId);
    const unit = JSON.parse(row.work_unit_json) as { coauthor_principal_ids?: string[] };
    isAssessmentIndependent(
      { ...row, coauthor_principal_ids: unit.coauthor_principal_ids },
      assessorPrincipalId,
      conflicted,
    );
    assert(row.version === expectedRevision, 'REVISION_CONFLICT', 409);
    return this.transitionContribution(
      row,
      'under_assessment',
      assessorPrincipalId,
      'assessment_started',
      expectedRevision,
    );
  }

  async assess(input: ContributionAssessmentInput) {
    const parsed = assessmentSchema.parse(input);
    assert(parsed.policy_version === this.policy.policy_version, 'POLICY_VERSION_MISMATCH', 409);
    const row = await this.requireContribution(parsed.contribution_id);
    const unit = JSON.parse(row.work_unit_json) as { coauthor_principal_ids?: string[] };
    isAssessmentIndependent(
      { ...row, coauthor_principal_ids: unit.coauthor_principal_ids },
      parsed.assessor_principal_id,
      parsed.conflicted,
    );
    assert(row.version === parsed.expected_revision, 'REVISION_CONFLICT', 409);
    const [prior] = await this.db.all<{ id: string }>(
      'SELECT id FROM contribution_assessments WHERE contribution_id=? AND assessor_principal_id=? LIMIT 1',
      [row.id, parsed.assessor_principal_id],
    );
    assert(!prior, 'ASSESSMENT_ALREADY_SUBMITTED', 409);
    const assessments = await this.db.all<{ assessor_principal_id: string; decision: string }>(
      'SELECT assessor_principal_id,decision FROM contribution_assessments WHERE contribution_id=? ORDER BY created_at,id',
      [row.id],
    );
    const assessorPerson = await this.resolvePerson(parsed.assessor_principal_id);
    for (const assessment of assessments)
      assert(
        (await this.resolvePerson(assessment.assessor_principal_id)) !== assessorPerson,
        'SAME_PERSON_NOT_INDEPENDENT',
        409,
      );
    const now = stamp(this.clock);
    const assessmentId = newId('assess');
    let next: ContributionState = row.status;
    let challengeUntil = row.challenge_expires_at;
    if (parsed.decision === 'accept') {
      const accepted = assessments.some((a) => a.decision === 'accept' || a.decision === 'confirm');
      next = accepted ? 'accepted_pending' : 'accepted_pending';
      challengeUntil = addDays(now, this.policy.contribution.recognition_challenge_days);
    } else if (parsed.decision === 'duplicate') next = 'duplicate';
    else if (parsed.decision === 'needs_info') next = 'needs_info';
    else if (parsed.decision === 'not_qualified') next = 'not_qualified';
    else {
      assert(row.status === 'challenged', 'INVALID_ASSESSMENT_DECISION', 409);
      next =
        parsed.decision === 'confirm'
          ? 'confirmed'
          : parsed.decision === 'adjust'
            ? 'adjusted'
            : 'revoked';
    }
    const assessmentRevision = row.version;
    const extra: Query[] = [
      {
        sql: 'INSERT INTO contribution_assessments(id,contribution_id,assessor_principal_id,decision,reason,policy_version,assessment_revision,created_at) VALUES(?,?,?,?,?,?,?,?)',
        params: [
          assessmentId,
          row.id,
          parsed.assessor_principal_id,
          parsed.decision,
          parsed.reason,
          parsed.policy_version,
          assessmentRevision,
          now,
        ],
      },
      {
        sql: 'UPDATE contributions SET challenge_expires_at=? WHERE id=?',
        params: [challengeUntil, row.id],
      },
    ];
    if (next === row.status) {
      const updated = await this.updateSameContributionState(
        row,
        parsed.assessor_principal_id,
        parsed.decision,
        parsed.expected_revision,
        extra,
      );
      return { ...updated, assessment_id: assessmentId };
    }
    const updated = await this.transitionContribution(
      row,
      next,
      parsed.assessor_principal_id,
      parsed.decision,
      parsed.expected_revision,
      extra,
    );
    return { ...updated, assessment_id: assessmentId };
  }

  private async updateSameContributionState(
    row: ContributionRow,
    actor: string,
    reason: string,
    expectedRevision: number,
    extra: Query[],
  ) {
    const revision = row.version + 1;
    const now = stamp(this.clock);
    await this.db.batch([
      {
        sql: 'UPDATE contributions SET version=version+1,updated_at=? WHERE id=? AND status=? AND version=?',
        params: [now, row.id, row.status, expectedRevision],
      },
      ...mutationGuard(),
      ...extra,
      {
        sql: `INSERT INTO contribution_events
          (id,contribution_id,from_state,to_state,actor_principal_id,reason,policy_version,revision,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
        params: [
          newId('conev'),
          row.id,
          row.status,
          row.status,
          actor,
          reason,
          this.policy.policy_version,
          revision,
          now,
        ],
      },
      {
        sql: 'INSERT INTO governance_outbox(id,event_type,aggregate_id,payload_json,created_at) VALUES(?,?,?,?,?)',
        params: [
          newId('out'),
          `contribution.${row.status}`,
          row.id,
          canonical({ contribution_id: row.id, state: row.status, revision }),
          now,
        ],
      },
    ]);
    const updated = await this.getContribution(row.id);
    assert(updated, 'NOT_FOUND', 404);
    return updated;
  }

  async finalize(contributionId: string, actor: Actor, expectedRevision: number) {
    const row = await this.requireContribution(contributionId);
    assert(row.status === 'accepted_pending', 'CONTRIBUTION_NOT_PENDING', 409);
    assert(row.version === expectedRevision, 'REVISION_CONFLICT', 409);
    assert(
      row.challenge_expires_at && Date.parse(row.challenge_expires_at) <= this.clock().getTime(),
      'CHALLENGE_WINDOW_OPEN',
      409,
    );
    const assessments = await this.db.all<{ assessor_principal_id: string; decision: string }>(
      'SELECT assessor_principal_id,decision FROM contribution_assessments WHERE contribution_id=?',
      [row.id],
    );
    const independent = new Set<string>();
    for (const assessment of assessments) {
      if (!['accept', 'confirm'].includes(assessment.decision)) continue;
      independent.add(await this.resolvePerson(assessment.assessor_principal_id));
    }
    if (['qualification', 'major', 'disputed'].includes(row.materiality))
      assert(
        independent.size >= this.policy.review.independent_approvals_required,
        'INSUFFICIENT_INDEPENDENT_APPROVALS',
        409,
      );
    assert(independent.size >= 1, 'INSUFFICIENT_INDEPENDENT_APPROVALS', 409);
    return this.transitionContribution(
      row,
      'recognized',
      actor,
      'challenge_window_closed',
      expectedRevision,
    );
  }

  async challenge(
    contributionId: string,
    appellantPrincipalId: string,
    reason: string,
    expectedRevision: number,
  ) {
    const row = await this.requireContribution(contributionId);
    assert(
      ['accepted_pending', 'recognized', 'confirmed', 'adjusted'].includes(row.status),
      'CONTRIBUTION_NOT_CHALLENGEABLE',
      409,
    );
    assert(row.version === expectedRevision, 'REVISION_CONFLICT', 409);
    assert(reason.trim().length > 0 && reason.length <= 500, 'INVALID_REASON');
    return this.transitionContribution(
      row,
      'challenged',
      appellantPrincipalId,
      reason,
      expectedRevision,
    );
  }

  async recordTraining(
    principalId: string,
    targetRole: QualificationRole,
    module: string,
    score: number,
    evidenceRef: string | null = null,
  ) {
    assert(score >= 0 && score <= 100 && Number.isInteger(score), 'INVALID_TRAINING_SCORE');
    assert(module.trim().length > 0 && module.length <= 200, 'INVALID_TRAINING_MODULE');
    const id = newId('training');
    const now = stamp(this.clock);
    await this.db.batch([
      {
        sql: `INSERT INTO qualification_training(id,principal_id,target_role,module,passed_at,score,evidence_ref)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(principal_id,target_role,module) DO UPDATE SET passed_at=excluded.passed_at,score=excluded.score,evidence_ref=excluded.evidence_ref`,
        params: [id, principalId, targetRole, module, now, score, evidenceRef],
      },
    ]);
    return { principal_id: principalId, target_role: targetRole, module, score, passed_at: now };
  }

  async getQualification(id: string): Promise<QualificationRow | null> {
    const [row] = await this.db.all<QualificationRow>(
      'SELECT * FROM qualification_applications WHERE id=?',
      [id],
    );
    return row ?? null;
  }

  async getAppeal(id: string): Promise<AppealRow | null> {
    const [row] = await this.db.all<AppealRow>('SELECT * FROM contribution_appeals WHERE id=?', [
      id,
    ]);
    return row ?? null;
  }

  async applyQualification(input: QualificationInput) {
    const parsed = qualificationInputSchema.parse(input);
    assert(parsed.target_role !== 'private_evidence_reviewer', 'P1_DISABLED', 403);
    assert(
      parsed.target_role !== 'council_member' && parsed.target_role !== 'governance_voter',
      'P1_MATURE_GOVERNANCE_DISABLED',
      409,
    );
    assert(parsed.evidence_refs.length > 0, 'QUALIFICATION_EVIDENCE_REQUIRED', 400);
    assert(
      parsed.equivalent_route || parsed.training_modules.length > 0,
      'QUALIFICATION_TRAINING_REQUIRED',
      400,
    );
    const body = canonical(parsed);
    const requestHash = await hash(utf8(body));
    if (parsed.idempotency_key) {
      const [old] = await this.db.all<QualificationRow>(
        'SELECT * FROM qualification_applications WHERE idempotency_key=?',
        [parsed.idempotency_key],
      );
      if (old) {
        assert(old.request_hash === requestHash, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
        return { ...old, replayed: true };
      }
    }
    const id = parsed.application_id ?? newId('qual');
    const now = stamp(this.clock);
    const row: QualificationRow = {
      id,
      principal_id: parsed.principal_id,
      target_role: parsed.target_role,
      scope_json: canonical(parsed.scope),
      evidence_json: canonical(parsed.evidence_refs),
      training_json: canonical(parsed.training_modules),
      equivalent_route: parsed.equivalent_route ? 1 : 0,
      status: 'submitted',
      decision_reason: null,
      valid_until: null,
      version: 1,
      idempotency_key: parsed.idempotency_key ?? null,
      request_hash: requestHash,
      created_at: now,
      updated_at: now,
    };
    const [existing] = await this.db.all<{ id: string }>(
      "SELECT id FROM qualification_applications WHERE principal_id=? AND target_role=? AND status IN ('submitted','under_assessment','approved') LIMIT 1",
      [row.principal_id, row.target_role],
    );
    assert(!existing, 'QUALIFICATION_ALREADY_ACTIVE', 409);
    await this.db.batch([
      {
        sql: `INSERT INTO qualification_applications
          (id,principal_id,target_role,scope_json,evidence_json,training_json,equivalent_route,status,decision_reason,valid_until,version,idempotency_key,request_hash,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          row.id,
          row.principal_id,
          row.target_role,
          row.scope_json,
          row.evidence_json,
          row.training_json,
          row.equivalent_route,
          row.status,
          row.decision_reason,
          row.valid_until,
          row.version,
          row.idempotency_key,
          row.request_hash,
          row.created_at,
          row.updated_at,
        ],
      },
      {
        sql: 'INSERT INTO governance_outbox(id,event_type,aggregate_id,payload_json,created_at) VALUES(?,?,?,?,?)',
        params: [
          newId('out'),
          'qualification.applied',
          id,
          canonical({ application_id: id, target_role: row.target_role }),
          now,
        ],
      },
    ]);
    return { ...row, replayed: false };
  }

  async assessQualification(input: QualificationAssessmentInput) {
    const parsed = qualificationAssessmentSchema.parse(input);
    assert(parsed.policy_version === this.policy.policy_version, 'POLICY_VERSION_MISMATCH', 409);
    const row = await this.getQualification(parsed.application_id);
    assert(row, 'NOT_FOUND', 404);
    assert(
      row.status === 'submitted' || row.status === 'under_assessment',
      'QUALIFICATION_NOT_ASSESSABLE',
      409,
    );
    assert(row.version === parsed.expected_revision, 'REVISION_CONFLICT', 409);
    assert(parsed.assessor_principal_id !== row.principal_id, 'SELF_ASSESSMENT', 403);
    assert(!parsed.conflicted, 'CONFLICT_OF_INTEREST', 403);
    const [prior] = await this.db.all<{ id: string }>(
      'SELECT id FROM qualification_assessments WHERE application_id=? AND assessor_principal_id=?',
      [row.id, parsed.assessor_principal_id],
    );
    assert(!prior, 'ASSESSMENT_ALREADY_SUBMITTED', 409);
    const now = stamp(this.clock);
    const priorApprovals = await this.db.all<{ assessor_principal_id: string; decision: string }>(
      'SELECT assessor_principal_id,decision FROM qualification_assessments WHERE application_id=?',
      [row.id],
    );
    const approving = priorApprovals.filter((a) => a.decision === 'approve');
    const assessorPerson = await this.resolvePerson(parsed.assessor_principal_id);
    for (const assessment of priorApprovals)
      assert(
        (await this.resolvePerson(assessment.assessor_principal_id)) !== assessorPerson,
        'SAME_PERSON_NOT_INDEPENDENT',
        409,
      );
    const decisionPeople = new Set<string>();
    for (const approval of approving)
      decisionPeople.add(await this.resolvePerson(approval.assessor_principal_id));
    let next: QualificationRow['status'] = row.status;
    if (parsed.decision === 'approve') {
      next =
        decisionPeople.size + 1 >= this.policy.review.independent_approvals_required
          ? 'approved'
          : 'under_assessment';
    } else if (parsed.decision === 'reject') next = 'rejected';
    else next = 'under_assessment';
    const validUntil =
      next === 'approved'
        ? addDays(now, this.policy.roles.initial_reviewer_valid_days)
        : row.valid_until;
    const assessmentId = newId('qassess');
    const revision = row.version + (next === row.status ? 0 : 1);
    const statements: Query[] = [
      {
        sql: 'INSERT INTO qualification_assessments(id,application_id,assessor_principal_id,decision,reason,policy_version,created_at) VALUES(?,?,?,?,?,?,?)',
        params: [
          assessmentId,
          row.id,
          parsed.assessor_principal_id,
          parsed.decision,
          parsed.reason,
          parsed.policy_version,
          now,
        ],
      },
    ];
    if (next === row.status) {
      const nextRevision = row.version + 1;
      await this.db.batch([
        {
          sql: 'UPDATE qualification_applications SET version=version+1,updated_at=? WHERE id=? AND status=? AND version=?',
          params: [now, row.id, row.status, parsed.expected_revision],
        },
        ...mutationGuard(),
        ...statements,
        {
          sql: 'INSERT INTO governance_outbox(id,event_type,aggregate_id,payload_json,created_at) VALUES(?,?,?,?,?)',
          params: [
            newId('out'),
            'qualification.assessed',
            row.id,
            canonical({ application_id: row.id, revision: nextRevision }),
            now,
          ],
        },
      ]);
      const updated = await this.getQualification(row.id);
      assert(updated, 'NOT_FOUND', 404);
      return { ...updated, assessment_id: assessmentId };
    }
    await this.db.batch([
      {
        sql: 'UPDATE qualification_applications SET status=?,decision_reason=?,valid_until=?,version=version+1,updated_at=? WHERE id=? AND status=? AND version=?',
        params: [
          next,
          parsed.reason,
          validUntil,
          now,
          row.id,
          row.status,
          parsed.expected_revision,
        ],
      },
      ...mutationGuard(),
      ...statements,
    ]);
    const updated = await this.getQualification(row.id);
    assert(updated, 'NOT_FOUND', 404);
    void revision;
    return { ...updated, assessment_id: assessmentId };
  }

  async openAppeal(input: AppealInput) {
    const parsed = appealInputSchema.parse(input);
    const body = canonical(parsed);
    const requestHash = await hash(utf8(body));
    if (parsed.idempotency_key) {
      const [old] = await this.db.all<AppealRow>(
        'SELECT * FROM contribution_appeals WHERE idempotency_key=?',
        [parsed.idempotency_key],
      );
      if (old) {
        assert(old.request_hash === requestHash, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
        return { ...old, replayed: true };
      }
    }
    const id = parsed.appeal_id ?? newId('appeal');
    const now = stamp(this.clock);
    const row: AppealRow = {
      id,
      appellant_principal_id: parsed.appellant_principal_id,
      subject_type: parsed.subject_type,
      subject_id: parsed.subject_id,
      reason: parsed.reason,
      evidence_json: canonical(parsed.evidence_refs),
      status: 'submitted',
      version: 1,
      idempotency_key: parsed.idempotency_key ?? null,
      request_hash: requestHash,
      created_at: now,
      updated_at: now,
    };
    if (parsed.subject_type === 'contribution') await this.requireContribution(parsed.subject_id);
    else assert(await this.getQualification(parsed.subject_id), 'NOT_FOUND', 404);
    await this.db.batch([
      {
        sql: `INSERT INTO contribution_appeals
          (id,appellant_principal_id,subject_type,subject_id,reason,evidence_json,status,version,idempotency_key,request_hash,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          row.id,
          row.appellant_principal_id,
          row.subject_type,
          row.subject_id,
          row.reason,
          row.evidence_json,
          row.status,
          row.version,
          row.idempotency_key,
          row.request_hash,
          row.created_at,
          row.updated_at,
        ],
      },
    ]);
    return { ...row, replayed: false };
  }

  /**
   * Record one appeal assessor's decision. The appeal is finalized only after
   * two canonical people independently choose the same outcome; the second
   * assessor is never supplied by the first request.
   */
  async assessAppeal(
    appealId: string,
    assessorPrincipalId: string,
    decision: 'confirm' | 'adjust' | 'reject' | 'pause',
    reason: string,
    expectedRevision: number,
    conflicted = false,
  ) {
    const appeal = await this.getAppeal(appealId);
    assert(appeal, 'NOT_FOUND', 404);
    assert(appeal.version === expectedRevision, 'REVISION_CONFLICT', 409);
    assert(appeal.status === 'submitted' || appeal.status === 'under_review', 'APPEAL_CLOSED', 409);
    assert(reason.trim().length > 0 && reason.length <= 500, 'INVALID_REASON');
    assert(!conflicted, 'CONFLICT_OF_INTEREST', 403);
    const assessorPerson = await this.resolvePerson(assessorPrincipalId);
    const appellantPerson = await this.resolvePerson(appeal.appellant_principal_id);
    assert(assessorPerson !== appellantPerson, 'APPELLANT_CANNOT_REVIEW_OWN_APPEAL', 403);

    const originalRows =
      appeal.subject_type === 'contribution'
        ? await this.db.all<{ assessor_principal_id: string }>(
            'SELECT assessor_principal_id FROM contribution_assessments WHERE contribution_id=?',
            [appeal.subject_id],
          )
        : await this.db.all<{ assessor_principal_id: string }>(
            'SELECT assessor_principal_id FROM qualification_assessments WHERE application_id=?',
            [appeal.subject_id],
          );
    const originalPeople = new Set<string>();
    for (const row of originalRows)
      originalPeople.add(await this.resolvePerson(row.assessor_principal_id));
    assert(!originalPeople.has(assessorPerson), 'ORIGINAL_DECISION_REVIEWER', 403);

    type AppealDecision = 'confirm' | 'adjust' | 'reject' | 'pause';
    const existing = await this.db.all<{
      assessor_principal_id: string;
      decision: AppealDecision;
    }>('SELECT assessor_principal_id,decision FROM appeal_assessments WHERE appeal_id=?', [
      appeal.id,
    ]);
    assert(
      !existing.some((row) => row.assessor_principal_id === assessorPrincipalId),
      'ASSESSMENT_ALREADY_SUBMITTED',
      409,
    );
    const decisionPeople = new Map<AppealDecision, Set<string>>();
    for (const row of existing) {
      const person = await this.resolvePerson(row.assessor_principal_id);
      assert(person !== assessorPerson, 'SAME_PERSON_NOT_INDEPENDENT', 409);
      const people = decisionPeople.get(row.decision) ?? new Set<string>();
      people.add(person);
      decisionPeople.set(row.decision, people);
    }
    const currentPeople = decisionPeople.get(decision) ?? new Set<string>();
    currentPeople.add(assessorPerson);
    decisionPeople.set(decision, currentPeople);
    const finalDecision =
      [...decisionPeople.entries()].find(
        ([, people]) => people.size >= this.policy.review.independent_approvals_required,
      )?.[0] ?? null;
    const next: AppealRow['status'] = finalDecision
      ? finalDecision === 'confirm'
        ? 'confirmed'
        : finalDecision === 'adjust'
          ? 'adjusted'
          : finalDecision === 'reject'
            ? 'rejected'
            : 'paused'
      : 'under_review';
    const now = stamp(this.clock);
    const assessmentId = newId('aassess');
    const statements: Query[] = [
      {
        sql: 'UPDATE contribution_appeals SET status=?,version=version+1,updated_at=? WHERE id=? AND status=? AND version=?',
        params: [next, now, appeal.id, appeal.status, expectedRevision],
      },
      ...mutationGuard(),
      {
        sql: 'INSERT INTO appeal_assessments(id,appeal_id,assessor_principal_id,decision,reason,policy_version,created_at) VALUES(?,?,?,?,?,?,?)',
        params: [
          assessmentId,
          appeal.id,
          assessorPrincipalId,
          decision,
          reason,
          this.policy.policy_version,
          now,
        ],
      },
      {
        sql: 'INSERT INTO governance_outbox(id,event_type,aggregate_id,payload_json,created_at) VALUES(?,?,?,?,?)',
        params: [
          newId('out'),
          finalDecision ? `appeal.${next}` : 'appeal.assessment_recorded',
          appeal.id,
          canonical({ appeal_id: appeal.id, status: next, revision: appeal.version + 1 }),
          now,
        ],
      },
    ];
    if (appeal.subject_type === 'contribution' && finalDecision && finalDecision !== 'pause') {
      const contribution = await this.requireContribution(appeal.subject_id);
      assert(
        ['accepted_pending', 'recognized', 'confirmed', 'adjusted', 'challenged'].includes(
          contribution.status,
        ),
        'INVALID_APPEAL_TARGET',
        409,
      );
      const target: ContributionState =
        finalDecision === 'confirm'
          ? 'confirmed'
          : finalDecision === 'adjust'
            ? 'adjusted'
            : 'revoked';
      assert(
        contribution.status === 'challenged' ||
          (target === 'revoked' && contribution.status === 'recognized'),
        'INVALID_APPEAL_TARGET',
        409,
      );
      statements.push(
        ...this.contributionTransitionQueries(
          contribution,
          target,
          assessorPrincipalId,
          `appeal_${finalDecision}`,
          contribution.version,
          [],
          now,
        ),
      );
    }
    await this.db.batch(statements);
    const updated = await this.getAppeal(appeal.id);
    assert(updated, 'NOT_FOUND', 404);
    return { ...updated, assessment_id: assessmentId, resolved: Boolean(finalDecision) };
  }

  /** @deprecated Batch assessor input is disabled; call assessAppeal once per person. */
  async resolveAppeal(
    appealId: string,
    assessorPrincipalIds: string[],
    decision: 'confirm' | 'adjust' | 'reject' | 'pause',
    reason: string,
    expectedRevision: number,
  ) {
    assert(assessorPrincipalIds.length === 1, 'BATCH_APPEAL_ASSESSMENT_DISABLED', 409);
    return this.assessAppeal(appealId, assessorPrincipalIds[0], decision, reason, expectedRevision);
  }

  async expireQualifications() {
    const now = stamp(this.clock);
    const rows = await this.db.all<{ id: string }>(
      "SELECT id FROM qualification_applications WHERE status='approved' AND valid_until IS NOT NULL AND valid_until<=?",
      [now],
    );
    for (const row of rows)
      await this.db.batch([
        {
          sql: "UPDATE qualification_applications SET status='expired',version=version+1,updated_at=? WHERE id=? AND status='approved'",
          params: [now, row.id],
        },
        ...mutationGuard(),
      ]);
    return rows.length;
  }
}

export type { ContributionRow, QualificationRow, AppealRow };
export const ContributionService = ContributionLedger;
