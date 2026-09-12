import type { Database, Query } from '../../db/src/adapter';
import { assert, DomainError } from '../../domain/src/index';
import { canonical, hash, utf8 } from '../../verifier/src/crypto';
import type {
  AssignmentProvider,
  AssignmentStage,
  BlockingIssueCode,
  BindPreviewInput,
  CaseAssignment,
  CandidateValidator,
  CreateCaseInput,
  RecordDecisionInput,
  ReviewAction,
  ReviewAuthorization,
  ReviewAuthorizationChecker,
  ReviewCaseState,
  ReviewCaseView,
  ReviewStage,
  ReviewWorkflowOptions,
  SubmitRevisionInput,
  PublicationStatus,
} from './types';

type CaseRow = {
  id: string;
  submission_id: string;
  current_revision: number;
  state: ReviewCaseState;
  created_at: string;
  updated_at: string;
};
type RevisionRow = {
  case_id: string;
  revision: number;
  candidate_digest: string;
  candidate_body: string;
  source_preview_ids: string;
  created_by_person_id: string;
  status: 'active' | 'superseded';
  created_at: string;
};
type DecisionRow = {
  id: string;
  case_id: string;
  revision: number;
  candidate_digest: string;
  assignment_id: string;
  reviewer_person_id: string;
  stage: ReviewStage;
  action: ReviewAction;
  reason: string;
  created_at: string;
};
type BlockingRow = {
  id: string;
  case_id: string;
  revision: number;
  code: BlockingIssueCode;
  state: 'open' | 'resolved';
  reported_by_person_id: string;
  resolution_reason: string | null;
  resolved_by_person_id: string | null;
  created_at: string;
  resolved_at: string | null;
};
type PreviewRefRow = {
  id: string;
  case_id: string;
  case_revision: number;
  state: 'sanitized_preview_ready';
  expires_at: string;
  raw_html_available_to_reviewer: number;
  public_destination_enforced: number;
  network_egress_policy_enforced: number;
  login_required: number;
  download_attempted: number;
};

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const isId = (value: string) => /^[a-z][a-z0-9_-]{2,100}$/.test(value);
const isDigest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const guard = (): Query[] => [
  { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
  { sql: 'DELETE FROM mutation_guard' },
];

function stageOf(assignmentStage: AssignmentStage): ReviewStage {
  if (assignmentStage === 'primary') return 'initial';
  if (assignmentStage === 'secondary') return 'independent';
  return 'escalation';
}

function ensureAuth(auth: ReviewAuthorization, capability: ReviewAuthorization['capability'], now: Date) {
  assert(auth.principal_id.length >= 3 && auth.person_id.length >= 3, 'CAPABILITY_DENIED', 403);
  assert(auth.grant_id.length >= 3, 'CAPABILITY_DENIED', 403);
  assert(auth.capability === capability, 'CAPABILITY_DENIED', 403);
  assert(Date.parse(auth.expires_at) > now.getTime(), 'ROLE_EXPIRED_OR_REVOKED', 403);
}

function validatePublicCandidate(candidate: unknown) {
  assert(typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate), 'INVALID_SCHEMA');
  const forbiddenKey = /(?:receipt|private[_-]?evidence|raw[_-]?html|attachment|session[_-]?token|internal[_-]?note)/i;
  const visit = (value: unknown, depth: number) => {
    assert(depth < 64, 'INVALID_SCHEMA');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      assert(!forbiddenKey.test(key), 'PRIVACY_BLOCKED');
      visit(child, depth + 1);
    }
  };
  visit(candidate, 0);
  const encoded = JSON.stringify(candidate);
  assert(typeof encoded === 'string' && encoded.length <= 8 * 1024 * 1024, 'RESOURCE_LIMIT_EXCEEDED', 413);
}

export class ReviewWorkflowService {
  private readonly clock: () => Date;
  private readonly assignments: AssignmentProvider;
  private readonly authorizeCallback?: ReviewAuthorizationChecker;
  private readonly candidateValidator?: CandidateValidator;

  constructor(
    private readonly db: Database,
    options: ReviewWorkflowOptions,
  ) {
    this.clock = options.now ?? (() => new Date());
    this.assignments = options.assignments;
    this.authorizeCallback = options.authorize;
    this.candidateValidator = options.validate_candidate;
  }

  private now() {
    return this.clock();
  }

  private async authorize(
    auth: ReviewAuthorization,
    capability: ReviewAuthorization['capability'],
    input: { case_id: string; case_revision: number; assignment_id?: string },
  ) {
    ensureAuth(auth, capability, this.now());
    if (!this.authorizeCallback)
      throw new DomainError('AUTHORIZATION_STATE_UNAVAILABLE', 503);
    await this.authorizeCallback({
      action: capability,
      case_id: input.case_id,
      case_revision: input.case_revision,
      person_id: auth.person_id,
      principal_id: auth.principal_id,
      grant_id: auth.grant_id,
      assignment_id: input.assignment_id,
    });
  }

  private async assignment(input: {
    assignment_id: string;
    case_id: string;
    case_revision: number;
    person_id: string;
    stage?: ReviewStage;
  }) {
    const expectedStage = input.stage
      ? input.stage === 'initial'
        ? 'primary'
        : input.stage === 'independent'
          ? 'secondary'
          : 'escalation'
      : undefined;
    const assignment = await this.assignments.find({
      assignment_id: input.assignment_id,
      case_id: input.case_id,
      case_revision: input.case_revision,
      person_id: input.person_id,
      stage: expectedStage,
    });
    assert(assignment, 'CAPABILITY_DENIED', 403);
    assert(assignment.reviewer_person_id === input.person_id, 'CAPABILITY_DENIED', 403);
    assert(assignment.case_id === input.case_id && assignment.case_revision === input.case_revision, 'CAPABILITY_DENIED', 403);
    if (expectedStage) assert(stageOf(assignment.stage) === input.stage, 'CAPABILITY_DENIED', 403);
    assert(['assigned', 'active'].includes(assignment.state), 'CAPABILITY_DENIED', 403);
    assert(Date.parse(assignment.expires_at) > this.now().getTime(), 'ROLE_EXPIRED_OR_REVOKED', 403);
    return assignment;
  }

  private async caseRow(caseId: string) {
    const [row] = await this.db.all<CaseRow>('SELECT * FROM review_cases WHERE id=?', [caseId]);
    assert(row, 'NOT_FOUND', 404);
    return row;
  }

  private async revisionRow(caseId: string, revision: number) {
    const [row] = await this.db.all<RevisionRow>(
      'SELECT * FROM review_case_revisions WHERE case_id=? AND revision=?',
      [caseId, revision],
    );
    assert(row, 'NOT_FOUND', 404);
    return row;
  }

  /**
   * A decision is only meaningful with a live, sanitized preview bound to
   * the same case revision.  An empty list is allowed while a case is being
   * prepared and fetched, but it is rejected at the decision boundary.
   */
  private async validatePreviewRefs(
    caseId: string,
    revision: number,
    previewIds: readonly string[],
    requireOne = true,
  ) {
    const ids = [...new Set(previewIds)];
    assert(ids.every(isId), 'INVALID_SCHEMA');
    if (requireOne) assert(ids.length > 0, 'SOURCE_PREVIEW_REQUIRED', 409);
    if (!ids.length) return;
    const rows = await this.db.all<PreviewRefRow>(
      `SELECT id,case_id,case_revision,state,expires_at,
              raw_html_available_to_reviewer,public_destination_enforced,
              network_egress_policy_enforced,login_required,download_attempted
         FROM sanitized_previews WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    assert(rows.length === ids.length, 'SOURCE_PREVIEW_MISMATCH', 409);
    const now = this.now().getTime();
    for (const row of rows) {
      assert(
        row.case_id === caseId &&
          row.case_revision === revision &&
          row.state === 'sanitized_preview_ready',
        'SOURCE_PREVIEW_MISMATCH',
        409,
      );
      assert(Date.parse(row.expires_at) > now, 'PREVIEW_OR_ACCESS_EXPIRED', 410);
      assert(
        row.raw_html_available_to_reviewer === 0 &&
          row.public_destination_enforced === 1 &&
          row.network_egress_policy_enforced === 1 &&
          row.login_required === 0 &&
          row.download_attempted === 0,
        'SAFE_PROCESSOR_UNAVAILABLE',
        503,
      );
    }
  }

  async createCase(input: CreateCaseInput) {
    assert(isId(input.case_id) && isId(input.submission_id), 'INVALID_SCHEMA');
    await this.authorize(input.authorization, 'case.prepare', {
      case_id: input.case_id,
      case_revision: 0,
    });
    validatePublicCandidate(input.candidate);
    await this.validateCandidate(input.candidate);
    const sourcePreviewIds = [...new Set(input.source_preview_ids)];
    assert(sourcePreviewIds.every(isId), 'INVALID_SCHEMA');
    await this.validatePreviewRefs(input.case_id, 1, sourcePreviewIds, false);
    assert(input.reason.trim().length > 0 && input.reason.length <= 1000, 'INVALID_SCHEMA');
    const candidateDigest = await hash(utf8(canonical(input.candidate)));
    const [existing] = await this.db.all<CaseRow>('SELECT * FROM review_cases WHERE id=?', [input.case_id]);
    if (existing) {
      assert(existing.submission_id === input.submission_id, 'REVISION_CONFLICT', 409);
      const existingRevision = await this.db.all<RevisionRow>(
        'SELECT * FROM review_case_revisions WHERE case_id=? AND revision=1',
        [input.case_id],
      );
      assert(existingRevision[0]?.candidate_digest === candidateDigest, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      assert(
        JSON.stringify(JSON.parse(existingRevision[0].source_preview_ids)) ===
          JSON.stringify(sourcePreviewIds),
        'IDEMPOTENCY_PAYLOAD_MISMATCH',
        409,
      );
      return { case_id: existing.id, current_revision: existing.current_revision, state: existing.state };
    }
    const [sameSubmission] = await this.db.all<CaseRow>(
      'SELECT * FROM review_cases WHERE submission_id=?',
      [input.submission_id],
    );
    assert(!sameSubmission, 'REVISION_CONFLICT', 409);
    const timestamp = this.now().toISOString();
    await this.db.batch([
      {
        sql: 'INSERT INTO review_cases(id,submission_id,current_revision,state,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        params: [input.case_id, input.submission_id, 1, 'open', timestamp, timestamp],
      },
      ...guard(),
      {
        sql: 'INSERT INTO review_case_revisions(case_id,revision,candidate_digest,candidate_body,source_preview_ids,created_by_person_id,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
        params: [
          input.case_id,
          1,
          candidateDigest,
          JSON.stringify(input.candidate),
          JSON.stringify(sourcePreviewIds),
          input.authorization.person_id,
          'active',
          timestamp,
        ],
      },
      ...guard(),
      {
        sql: 'INSERT INTO review_events(id,case_id,revision,actor_person_id,action,reason,created_at) VALUES(?,?,?,?,?,?,?)',
        params: [newId('rev'), input.case_id, 1, input.authorization.person_id, 'case_created', input.reason, timestamp],
      },
    ]);
    return {
      case_id: input.case_id,
      current_revision: 1,
      revision: 1,
      candidate_digest: candidateDigest,
      state: 'open' as const,
    };
  }

  /**
   * Attach a completed source task to the initial candidate before identity
   * assigns review seats.  This closes the create -> fetch -> assign bootstrap
   * loop without allowing a reviewer to approve a candidate with no source.
   */
  async bindPreviews(input: BindPreviewInput) {
    assert(Number.isInteger(input.expected_revision) && input.expected_revision > 0, 'INVALID_SCHEMA');
    await this.authorize(input.authorization, 'case.prepare', {
      case_id: input.case_id,
      case_revision: input.expected_revision,
    });
    const current = await this.caseRow(input.case_id);
    assert(current.current_revision === input.expected_revision, 'REVISION_CONFLICT', 409);
    const revision = await this.revisionRow(input.case_id, input.expected_revision);
    assert(revision.status === 'active', 'REVISION_CONFLICT', 409);
    const decisions = await this.db.all<{ id: string }>(
      'SELECT id FROM review_decisions WHERE case_id=? AND revision=? LIMIT 1',
      [input.case_id, input.expected_revision],
    );
    assert(!decisions.length, 'REVISION_CONFLICT', 409);
    const sourcePreviewIds = [...new Set(input.source_preview_ids)];
    await this.validatePreviewRefs(input.case_id, input.expected_revision, sourcePreviewIds, true);
    assert(input.reason.trim().length > 0 && input.reason.length <= 1000, 'INVALID_SCHEMA');
    const timestamp = this.now().toISOString();
    await this.db.batch([
      {
        sql: 'UPDATE review_case_revisions SET source_preview_ids=? WHERE case_id=? AND revision=? AND status=\'active\'',
        params: [JSON.stringify(sourcePreviewIds), input.case_id, input.expected_revision],
      },
      ...guard(),
      {
        sql: 'INSERT INTO review_events(id,case_id,revision,actor_person_id,action,reason,created_at) VALUES(?,?,?,?,?,?,?)',
        params: [
          newId('rev'),
          input.case_id,
          input.expected_revision,
          input.authorization.person_id,
          'previews_bound',
          input.reason,
          timestamp,
        ],
      },
    ]);
    return {
      case_id: input.case_id,
      revision: input.expected_revision,
      source_preview_ids: sourcePreviewIds,
      state: current.state,
    };
  }

  async submitRevision(input: SubmitRevisionInput) {
    assert(Number.isInteger(input.expected_revision) && input.expected_revision >= 0, 'INVALID_SCHEMA');
    await this.authorize(input.authorization, 'case.submit_decision', {
      case_id: input.case_id,
      case_revision: input.expected_revision,
      assignment_id: input.assignment_id,
    });
    const assignment = await this.assignment({
      assignment_id: input.assignment_id,
      case_id: input.case_id,
      case_revision: input.expected_revision,
      person_id: input.authorization.person_id,
      stage: 'initial',
    });
    assert(stageOf(assignment.stage) === 'initial', 'CAPABILITY_DENIED', 403);
    const current = await this.caseRow(input.case_id);
    assert(current.current_revision === input.expected_revision, 'REVISION_CONFLICT', 409);
    validatePublicCandidate(input.candidate);
    await this.validateCandidate(input.candidate);
    const candidateDigest = await hash(utf8(canonical(input.candidate)));
    const sourcePreviewIds = [...new Set(input.source_preview_ids)];
    assert(sourcePreviewIds.every(isId), 'INVALID_SCHEMA');
    assert(input.reason.trim().length > 0 && input.reason.length <= 1000, 'INVALID_SCHEMA');
    const revision = input.expected_revision + 1;
    await this.validatePreviewRefs(input.case_id, revision, sourcePreviewIds, false);
    const timestamp = this.now().toISOString();
    const queries: Query[] = [];
    if (input.expected_revision > 0) {
      queries.push(
        {
          sql: 'UPDATE review_case_revisions SET status=\'superseded\' WHERE case_id=? AND status=\'active\'',
          params: [input.case_id],
        },
        ...guard(),
      );
    }
    queries.push(
      {
        sql: 'INSERT INTO review_case_revisions(case_id,revision,candidate_digest,candidate_body,source_preview_ids,created_by_person_id,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
        params: [
          input.case_id,
          revision,
          candidateDigest,
          JSON.stringify(input.candidate),
          JSON.stringify(sourcePreviewIds),
          input.authorization.person_id,
          'active',
          timestamp,
        ],
      },
      ...guard(),
      {
        sql: 'UPDATE review_cases SET current_revision=?,state=\'open\',updated_at=? WHERE id=? AND current_revision=?',
        params: [revision, timestamp, input.case_id, input.expected_revision],
      },
      ...guard(),
      {
        sql: 'INSERT INTO review_events(id,case_id,revision,actor_person_id,action,reason,created_at) VALUES(?,?,?,?,?,?,?)',
        params: [newId('rev'), input.case_id, revision, input.authorization.person_id, 'revision_submitted', input.reason, timestamp],
      },
    );
    await this.db.batch(queries);
    return {
      case_id: input.case_id,
      revision,
      candidate_digest: candidateDigest,
      state: 'open' as const,
      assignment_id: input.assignment_id,
    };
  }

  private async validateCandidate(candidate: unknown) {
    // The optional validator is supplied by the API integration (for example
    // validateDataset).  Its absence never disables the local private-field
    // rejection above.
    if (this.candidateValidator) await this.candidateValidator(candidate);
  }

  async getCaseForReview(input: {
    case_id: string;
    assignment_id: string;
    stage: ReviewStage;
    authorization: ReviewAuthorization;
  }): Promise<ReviewCaseView> {
    const current = await this.caseRow(input.case_id);
    assert(current.current_revision > 0, 'INVALID_TRANSITION', 409);
    await this.authorize(input.authorization, 'case.read_public_source', {
      case_id: input.case_id,
      case_revision: current.current_revision,
      assignment_id: input.assignment_id,
    });
    const assignment = await this.assignment({
      assignment_id: input.assignment_id,
      case_id: input.case_id,
      case_revision: current.current_revision,
      person_id: input.authorization.person_id,
      stage: input.stage,
    });
    assert(stageOf(assignment.stage) === input.stage, 'CAPABILITY_DENIED', 403);
    const revision = await this.revisionRow(input.case_id, current.current_revision);
    const decisions = await this.db.all<DecisionRow>(
      'SELECT * FROM review_decisions WHERE case_id=? AND revision=? ORDER BY created_at,id',
      [input.case_id, current.current_revision],
    );
    const ownIndependent = decisions.some(
      (decision) =>
        decision.reviewer_person_id === input.authorization.person_id &&
        decision.stage === 'independent',
    );
    const blind = input.stage === 'independent' && !ownIndependent;
    return {
      case_id: current.id,
      revision: revision.revision,
      state: current.state,
      candidate_digest: revision.candidate_digest,
      candidate: JSON.parse(revision.candidate_body),
      source_preview_ids: JSON.parse(revision.source_preview_ids),
      decision_visibility: blind ? 'blind' : 'revealed',
      decisions: blind
        ? []
        : decisions.map((decision) => ({
            stage: decision.stage,
            action: decision.action,
            reason: decision.reason,
            reviewer_person_id: decision.reviewer_person_id,
            created_at: decision.created_at,
          })),
    };
  }

  async recordDecision(input: RecordDecisionInput) {
    assert(Number.isInteger(input.revision) && input.revision > 0, 'INVALID_SCHEMA');
    assert(isDigest(input.candidate_digest), 'INVALID_SCHEMA');
    assert(input.reason.trim().length > 0 && input.reason.length <= 1000, 'INVALID_SCHEMA');
    await this.authorize(input.authorization, 'case.submit_decision', {
      case_id: input.case_id,
      case_revision: input.revision,
      assignment_id: input.assignment_id,
    });
    const current = await this.caseRow(input.case_id);
    assert(current.current_revision === input.revision, 'REVISION_CONFLICT', 409);
    const revision = await this.revisionRow(input.case_id, input.revision);
    assert(revision.status === 'active', 'REVISION_CONFLICT', 409);
    assert(revision.candidate_digest === input.candidate_digest, 'PROPOSAL_CONTENT_CHANGED', 409);
    await this.validatePreviewRefs(
      input.case_id,
      input.revision,
      JSON.parse(revision.source_preview_ids),
      true,
    );
    const assignment = await this.assignment({
      assignment_id: input.assignment_id,
      case_id: input.case_id,
      case_revision: input.revision,
      person_id: input.authorization.person_id,
    });
    const stage = stageOf(assignment.stage);
    assert(stage !== 'escalation', 'CAPABILITY_DENIED', 403);
    const previous = await this.db.all<DecisionRow>(
      'SELECT * FROM review_decisions WHERE case_id=? AND revision=? ORDER BY created_at,id',
      [input.case_id, input.revision],
    );
    assert(
      !previous.some((decision) => decision.reviewer_person_id === input.authorization.person_id),
      'SELF_REVIEW',
      403,
    );
    if (stage === 'independent')
      assert(previous.some((decision) => decision.stage === 'initial'), 'INVALID_TRANSITION', 409);
    const timestamp = this.now().toISOString();
    const queries: Query[] = [
      {
        sql: 'INSERT INTO review_decisions(id,case_id,revision,candidate_digest,assignment_id,reviewer_person_id,stage,action,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        params: [
          newId('dec'),
          input.case_id,
          input.revision,
          input.candidate_digest,
          input.assignment_id,
          input.authorization.person_id,
          stage,
          input.action,
          input.reason,
          timestamp,
        ],
      },
      ...guard(),
    ];
    for (const code of [...new Set(input.blocking_issue_codes ?? [])]) {
      queries.push({
        sql: 'INSERT OR IGNORE INTO review_blocking_issues(id,case_id,revision,code,state,reported_by_person_id,created_at) VALUES(?,?,?,?,?,?,?)',
        params: [newId('blk'), input.case_id, input.revision, code, 'open', input.authorization.person_id, timestamp],
      });
    }
    queries.push({
      sql: 'INSERT INTO review_events(id,case_id,revision,actor_person_id,action,reason,created_at) VALUES(?,?,?,?,?,?,?)',
      params: [newId('rev'), input.case_id, input.revision, input.authorization.person_id, 'decision_' + input.action, input.reason, timestamp],
    });
    await this.db.batch(queries);
    const state = await this.refreshState(input.case_id, input.revision);
    return { ...state, decision_stage: stage };
  }

  private async refreshState(caseId: string, revision: number): Promise<PublicationStatus> {
    const current = await this.caseRow(caseId);
    assert(current.current_revision === revision, 'REVISION_CONFLICT', 409);
    const row = await this.revisionRow(caseId, revision);
    const decisions = await this.db.all<DecisionRow>(
      'SELECT * FROM review_decisions WHERE case_id=? AND revision=? ORDER BY created_at,id',
      [caseId, revision],
    );
    const blockers = await this.db.all<BlockingRow>(
      'SELECT * FROM review_blocking_issues WHERE case_id=? AND revision=? AND state=\'open\'',
      [caseId, revision],
    );
    const initial = decisions.find((decision) => decision.stage === 'initial');
    const independent = decisions.find((decision) => decision.stage === 'independent');
    const approvals = decisions.filter((decision) => decision.action === 'approve');
    const distinctApprovers = new Set(approvals.map((decision) => decision.reviewer_person_id));
    let state: ReviewCaseState = 'open';
    let reason: PublicationStatus['reason'] = 'waiting_for_initial_review';
    let eligible = false;
    if (blockers.length) {
      state = 'blocked';
      reason = 'blocking_issue_unresolved';
    } else if (!initial) {
      state = 'open';
      reason = 'waiting_for_initial_review';
    } else if (!independent) {
      state = 'awaiting_independent_review';
      reason = 'waiting_for_independent_review';
    } else if (
      initial.action === 'approve' &&
      independent.action === 'approve' &&
      initial.candidate_digest === row.candidate_digest &&
      independent.candidate_digest === row.candidate_digest &&
      distinctApprovers.size >= 2
    ) {
      state = 'approved_for_publication';
      reason = 'ready';
      eligible = true;
    } else if (decisions.some((decision) => decision.action === 'return')) {
      state = 'returned';
      reason = 'returned';
    } else if (decisions.some((decision) => decision.action === 'reject')) {
      state = 'needs_escalation';
      reason = 'review_disagreement';
    } else {
      state = 'needs_escalation';
      reason = 'review_disagreement';
    }
    if (current.state !== state) {
      const timestamp = this.now().toISOString();
      await this.db.batch([
        {
          sql: 'UPDATE review_cases SET state=?,updated_at=? WHERE id=? AND current_revision=?',
          params: [state, timestamp, caseId, revision],
        },
        ...guard(),
      ]);
    }
    return {
      case_id: caseId,
      revision,
      state,
      candidate_digest: row.candidate_digest,
      eligible,
      independent_approvals: distinctApprovers.size,
      open_blocking_issues: blockers.length,
      reason,
    };
  }

  async publicationStatus(caseId: string): Promise<PublicationStatus> {
    const current = await this.caseRow(caseId);
    assert(current.current_revision > 0, 'INVALID_TRANSITION', 409);
    return this.refreshState(caseId, current.current_revision);
  }

  async resolveBlocking(input: {
    case_id: string;
    revision: number;
    issue_id: string;
    reason: string;
    authorization: ReviewAuthorization;
    assignment_id: string;
    expected_revision: number;
  }) {
    assert(input.revision === input.expected_revision, 'REVISION_CONFLICT', 409);
    assert(input.reason.trim().length > 0 && input.reason.length <= 1000, 'INVALID_SCHEMA');
    await this.authorize(input.authorization, 'case.resolve_blocking', {
      case_id: input.case_id,
      case_revision: input.revision,
      assignment_id: input.assignment_id,
    });
    const current = await this.caseRow(input.case_id);
    assert(current.current_revision === input.revision, 'REVISION_CONFLICT', 409);
    const assignment = await this.assignment({
      assignment_id: input.assignment_id,
      case_id: input.case_id,
      case_revision: input.revision,
      person_id: input.authorization.person_id,
    });
    assert(stageOf(assignment.stage) !== 'initial', 'CAPABILITY_DENIED', 403);
    const [issue] = await this.db.all<BlockingRow>(
      'SELECT * FROM review_blocking_issues WHERE id=? AND case_id=? AND revision=?',
      [input.issue_id, input.case_id, input.revision],
    );
    assert(issue, 'NOT_FOUND', 404);
    assert(issue.state === 'open', 'REVISION_CONFLICT', 409);
    assert(issue.reported_by_person_id !== input.authorization.person_id, 'SELF_REVIEW', 403);
    const timestamp = this.now().toISOString();
    await this.db.batch([
      {
        sql: 'UPDATE review_blocking_issues SET state=\'resolved\',resolution_reason=?,resolved_by_person_id=?,resolved_at=? WHERE id=? AND state=\'open\'',
        params: [input.reason, input.authorization.person_id, timestamp, input.issue_id],
      },
      ...guard(),
      {
        sql: 'INSERT INTO review_events(id,case_id,revision,actor_person_id,action,reason,created_at) VALUES(?,?,?,?,?,?,?)',
        params: [newId('rev'), input.case_id, input.revision, input.authorization.person_id, 'blocking_issue_resolved', input.reason, timestamp],
      },
    ]);
    return this.refreshState(input.case_id, input.revision);
  }
}

export { stageOf };
