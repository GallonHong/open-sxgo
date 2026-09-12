import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Database } from '../../../packages/db/src/adapter';
import { DomainError, assert } from '../../../packages/domain/src/index';
import { strictJSON } from '../../../packages/verifier/src/crypto';
import type { Principal } from '../../../packages/protocol/src/private';
import {
  authorize as authorizeIdentity,
  PermissionError,
  type AssignmentStage as IdentityAssignmentStage,
  type Identity,
  type AuthorizeInput,
} from '../../../packages/identity-permissions/src/index';
import {
  EvidenceGatewayService,
  type SourceAuthorization,
} from '../../../packages/evidence-gateway/src/index';
import {
  ReviewWorkflowService,
  type AssignmentProvider,
  type CaseAssignment,
  type CandidateValidator,
  type ReviewAuthorization,
  type ReviewAuthorizationCheck,
  type ReviewAuthorizationChecker,
  type ReviewStage,
  stageOf,
} from '../../../packages/review-workflow/src/index';

type Capability = ReviewAuthorization['capability'];
type ResolvePrincipal = (headers: Headers) => Promise<Principal | null>;
type ResolveIdentity = (headers: Headers) => Promise<Identity | null>;
type AuthorizationContext = {
  capability: Capability;
  case_id: string;
  case_revision: number;
  assignment_id?: string;
};

export type ReviewRoutesConfig = Readonly<{
  /** Keep both spellings so the existing app config can be passed through. */
  review_enabled?: boolean;
  reviewEnabled?: boolean;
  source_fetch_enabled?: boolean;
  sourceFetchEnabled?: boolean;
  assignments: AssignmentProvider;
  resolve_review_authorization?: (
    principal: Principal,
    context: AuthorizationContext,
  ) => Promise<ReviewAuthorization>;
  /** Production adapter: uses resolveIdentity and never trusts legacy role flags. */
  resolve_identity?: ResolveIdentity;
  resolve_identity_review_authorization?: (
    identity: Identity,
    context: AuthorizationContext,
  ) => Promise<ReviewAuthorization>;
  resolve_source_authorization?: (
    principal: Principal,
    context: {
      capability: SourceAuthorization['capability'];
      case_id: string;
      case_revision: number;
      source_id: string;
      assignment_id?: string;
    },
  ) => Promise<SourceAuthorization>;
  resolve_identity_source_authorization?: (
    identity: Identity,
    context: {
      capability: SourceAuthorization['capability'];
      case_id: string;
      case_revision: number;
      source_id: string;
      assignment_id?: string;
    },
  ) => Promise<SourceAuthorization>;
  authorize_review?: ReviewAuthorizationChecker;
  validate_candidate?: CandidateValidator;
  evidence_gateway?: EvidenceGatewayService;
}>;

type ErrorContext = { json: (body: unknown, status?: number) => Response };
type ReviewActor = Principal | Identity;

function isIdentity(actor: ReviewActor): actor is Identity {
  return 'grants' in actor && 'status' in actor && 'assurance' in actor;
}

const idSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,100}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const textSchema = z.string().trim().min(1).max(1000);
const reviewStageSchema = z.enum(['initial', 'independent', 'escalation']);
const blockingIssueSchema = z.enum([
  'privacy_leak',
  'subject_mismatch',
  'source_fabrication',
  'phishing_link',
  'scope_mismatch',
  'unresolved_major_conflict',
]);

function parseError(e: unknown, c: ErrorContext) {
  if (e instanceof z.ZodError) return c.json({ error: { code: 'INVALID_SCHEMA' } }, 400);
  if (e instanceof DomainError) return c.json({ error: { code: e.code } }, e.status);
  if (e instanceof PermissionError) return c.json({ error: { code: e.code } }, e.status);
  if (
    e instanceof Error &&
    /^(?:INVALID_JSON|JSON_TOO_DEEP|DUPLICATE_KEY|NON_INTEGER)$/.test(e.message)
  )
    return c.json({ error: { code: e.message } }, 400);
  if (
    e instanceof Error &&
    /(?:mutation_guard|UNIQUE constraint|CHECK constraint)/i.test(e.message)
  )
    return c.json({ error: { code: 'REVISION_CONFLICT' } }, 409);
  return c.json({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503);
}

export function reviewRoutes(
  db: Database,
  resolveLegacyPrincipal: ResolvePrincipal,
  config: ReviewRoutesConfig,
) {
  const app = new Hono();
  const review = new ReviewWorkflowService(db, {
    assignments: config.assignments,
    authorize: config.authorize_review,
    validate_candidate: config.validate_candidate,
  });
  const reviewEnabled = () => config.review_enabled ?? config.reviewEnabled ?? false;
  const sourceEnabled = () => config.source_fetch_enabled ?? config.sourceFetchEnabled ?? false;
  const body = async (c: { req: { text: () => Promise<string> } }) =>
    strictJSON(await c.req.text());
  const principal = async (c: { req: { raw: Request } }): Promise<ReviewActor> => {
    if (config.resolve_identity) {
      const identity = await config.resolve_identity(c.req.raw.headers);
      assert(identity, 'AUTHENTICATION_REQUIRED', 401);
      assert(identity.status === 'active', 'CAPABILITY_DENIED', 403);
      return identity;
    }
    const p = await resolveLegacyPrincipal(c.req.raw.headers);
    assert(p, 'AUTHENTICATION_REQUIRED', 401);
    assert(p.verified && p.two_factor, 'MFA_REQUIRED', 403);
    return p;
  };
  const reviewAuthorization = async (
    c: { req: { raw: Request } },
    context: AuthorizationContext,
    actorOverride?: ReviewActor,
  ) => {
    const actor = actorOverride ?? (await principal(c));
    const resolved = isIdentity(actor)
      ? await config.resolve_identity_review_authorization?.(actor, context)
      : await config.resolve_review_authorization?.(actor, context);
    assert(resolved, 'AUTHORIZATION_STATE_UNAVAILABLE', 503);
    assert(resolved.capability === context.capability, 'CAPABILITY_DENIED', 403);
    assert(
      resolved.principal_id.length >= 3 && resolved.person_id.length >= 3,
      'CAPABILITY_DENIED',
      403,
    );
    return resolved;
  };
  const sourceAuthorization = async (
    c: { req: { raw: Request } },
    context: {
      capability: SourceAuthorization['capability'];
      case_id: string;
      case_revision: number;
      source_id: string;
      assignment_id?: string;
    },
    requireAssignment = true,
    actorOverride?: ReviewActor,
  ) => {
    const actor = actorOverride ?? (await principal(c));
    let assignmentId = context.assignment_id;
    if (requireAssignment) {
      const assignment = await assignmentFor({
        case_id: context.case_id,
        case_revision: context.case_revision,
        person_id: actor.person_id,
        assignment_id: context.assignment_id,
      });
      assignmentId = assignment.assignment_id;
    }
    const authorizationContext = { ...context, assignment_id: assignmentId };
    const resolved = isIdentity(actor)
      ? await config.resolve_identity_source_authorization?.(actor, authorizationContext)
      : await config.resolve_source_authorization?.(actor, authorizationContext);
    assert(resolved, 'AUTHORIZATION_STATE_UNAVAILABLE', 503);
    assert(
      resolved.capability === authorizationContext.capability &&
        resolved.case_id === authorizationContext.case_id &&
        resolved.case_revision === authorizationContext.case_revision,
      'CAPABILITY_DENIED',
      403,
    );
    assert(resolved.principal_id.length >= 3, 'CAPABILITY_DENIED', 403);
    if (requireAssignment) {
      assert(
        !resolved.assignment_id || resolved.assignment_id === assignmentId,
        'CASE_NOT_ASSIGNED',
        403,
      );
    }
    // Always pass the server-selected assignment to the gateway.  A resolver
    // must not be able to turn a checked assignment into a broad case grant.
    return { ...resolved, assignment_id: assignmentId };
  };

  app.onError((error, c) => parseError(error, c));

  const assignmentFor = async (input: {
    case_id: string;
    case_revision: number;
    person_id: string;
    assignment_id?: string;
    stage?: ReviewStage;
  }): Promise<CaseAssignment> => {
    const isLive = (assignment: CaseAssignment) =>
      ['assigned', 'active'].includes(assignment.state) &&
      Date.parse(assignment.expires_at) > Date.now();
    const identityStage: 'primary' | 'secondary' | undefined = input.stage
      ? input.stage === 'initial'
        ? 'primary'
        : input.stage === 'independent'
          ? 'secondary'
          : undefined
      : undefined;
    if (input.assignment_id) {
      const found = await config.assignments.find({
        assignment_id: input.assignment_id,
        case_id: input.case_id,
        case_revision: input.case_revision,
        person_id: input.person_id,
        stage: identityStage,
      });
      assert(found, 'CASE_NOT_ASSIGNED', 403);
      assert(isLive(found), 'CASE_NOT_ASSIGNED', 403);
      return found;
    }
    assert(config.assignments.listForPerson, 'AUTHORIZATION_STATE_UNAVAILABLE', 503);
    const candidates = (
      await config.assignments.listForPerson({
        case_id: input.case_id,
        case_revision: input.case_revision,
        person_id: input.person_id,
      })
    ).filter(
      (assignment) => isLive(assignment) && (!identityStage || assignment.stage === identityStage),
    );
    assert(candidates.length > 0, 'CASE_NOT_ASSIGNED', 403);
    assert(candidates.length === 1, 'REVISION_CONFLICT', 409);
    return candidates[0];
  };

  const optionalAssignmentId = (c: Context) => {
    const value = c.req.query('assignment_id');
    return value ? idSchema.parse(value) : undefined;
  };

  /**
   * Object reads must not disclose whether a caller guessed an existing id.
   * Authentication errors still keep their normal status, while every
   * authenticated object-level denial and missing object share NOT_FOUND.
   */
  const hideObjectExistence = (error: unknown, preserveExpiry = false): never => {
    if (error instanceof DomainError || error instanceof PermissionError) {
      if (
        (error.status === 403 ||
          error.status === 404 ||
          error.status === 409 ||
          error.status === 410) &&
        !(preserveExpiry && error.code === 'PREVIEW_OR_ACCESS_EXPIRED')
      )
        throw new DomainError('NOT_FOUND', 404);
    }
    throw error;
  };

  const protectedObjectRead = async <T>(work: () => Promise<T>, preserveExpiry = false) => {
    try {
      return await work();
    } catch (error) {
      return hideObjectExistence(error, preserveExpiry);
    }
  };

  const listCases = async (c: Context) => {
    assert(reviewEnabled(), 'PRODUCTION_GATE_CLOSED', 403);
    const actor = await principal(c);
    assert(config.assignments.listForPerson, 'AUTHORIZATION_STATE_UNAVAILABLE', 503);
    const assignments = await config.assignments.listForPerson({ person_id: actor.person_id });
    const items: {
      assignment_id: string;
      case_id: string;
      revision: number;
      stage: ReviewStage;
      state: CaseAssignment['state'];
      expires_at: string;
    }[] = [];
    for (const assignment of assignments) {
      if (!['assigned', 'active'].includes(assignment.state)) continue;
      const [current] = await db.all<{ current_revision: number; state: string }>(
        'SELECT current_revision,state FROM review_cases WHERE id=?',
        [assignment.case_id],
      );
      if (
        !current ||
        current.current_revision !== assignment.case_revision ||
        !['open', 'awaiting_independent_review'].includes(current.state)
      )
        continue;
      try {
        await reviewAuthorization(c, {
          capability: 'case.read_public_source',
          case_id: assignment.case_id,
          case_revision: assignment.case_revision,
          assignment_id: assignment.assignment_id,
        });
      } catch (error) {
        if (
          (error instanceof DomainError &&
            ['CAPABILITY_DENIED', 'ROLE_EXPIRED_OR_REVOKED', 'CONFLICT_OF_INTEREST'].includes(
              error.code,
            )) ||
          (error instanceof PermissionError &&
            ['CAPABILITY_DENIED', 'ROLE_EXPIRED_OR_REVOKED', 'CONFLICT_OF_INTEREST'].includes(
              error.code,
            ))
        )
          continue;
        throw error;
      }
      items.push({
        assignment_id: assignment.assignment_id,
        case_id: assignment.case_id,
        revision: assignment.case_revision,
        stage: stageOf(assignment.stage),
        state: assignment.state,
        expires_at: assignment.expires_at,
      });
    }
    return c.json({ items });
  };

  const createCase = async (c: Context) => {
    assert(reviewEnabled(), 'PRODUCTION_GATE_CLOSED', 403);
    const parsed = z
      .strictObject({
        case_id: idSchema,
        submission_id: idSchema,
        candidate: z.unknown(),
        source_preview_ids: z.array(idSchema).max(100),
        reason: textSchema,
      })
      .parse(await body(c));
    const authorization = await reviewAuthorization(c, {
      capability: 'case.prepare',
      case_id: parsed.case_id,
      case_revision: 0,
    });
    if (authorization.capability !== 'case.prepare')
      throw new DomainError('CAPABILITY_DENIED', 403);
    const prepareAuthorization = authorization as ReviewAuthorization & {
      capability: 'case.prepare';
    };
    return c.json(await review.createCase({ ...parsed, authorization: prepareAuthorization }), 201);
  };

  const submitRevision = async (c: Context) => {
    assert(reviewEnabled(), 'PRODUCTION_GATE_CLOSED', 403);
    const caseId = idSchema.parse(c.req.param('id'));
    const parsed = z
      .strictObject({
        expected_revision: z.number().int().positive(),
        candidate: z.unknown(),
        source_preview_ids: z.array(idSchema).max(100),
        reason: textSchema,
        assignment_id: idSchema.optional(),
      })
      .parse(await body(c));
    const authorization = await reviewAuthorization(c, {
      capability: 'case.submit_decision',
      case_id: caseId,
      case_revision: parsed.expected_revision,
      assignment_id: parsed.assignment_id,
    });
    const assignment = await assignmentFor({
      case_id: caseId,
      case_revision: parsed.expected_revision,
      person_id: authorization.person_id,
      assignment_id: parsed.assignment_id,
      stage: 'initial',
    });
    return c.json(
      await review.submitRevision({
        case_id: caseId,
        expected_revision: parsed.expected_revision,
        candidate: parsed.candidate,
        source_preview_ids: parsed.source_preview_ids,
        reason: parsed.reason,
        assignment_id: assignment.assignment_id,
        authorization,
      }),
      201,
    );
  };

  const bindPreviews = async (c: Context) => {
    assert(reviewEnabled(), 'PRODUCTION_GATE_CLOSED', 403);
    const caseId = idSchema.parse(c.req.param('id'));
    const parsed = z
      .strictObject({
        expected_revision: z.number().int().positive(),
        source_preview_ids: z.array(idSchema).min(1).max(100),
        reason: textSchema,
      })
      .parse(await body(c));
    const authorization = await reviewAuthorization(c, {
      capability: 'case.prepare',
      case_id: caseId,
      case_revision: parsed.expected_revision,
    });
    if (authorization.capability !== 'case.prepare')
      throw new DomainError('CAPABILITY_DENIED', 403);
    const prepareAuthorization = authorization as ReviewAuthorization & {
      capability: 'case.prepare';
    };
    return c.json(
      await review.bindPreviews({
        case_id: caseId,
        expected_revision: parsed.expected_revision,
        source_preview_ids: parsed.source_preview_ids,
        reason: parsed.reason,
        authorization: prepareAuthorization,
      }),
    );
  };

  const getCase = async (c: Context) => {
    assert(reviewEnabled(), 'PRODUCTION_GATE_CLOSED', 403);
    const caseId = idSchema.parse(c.req.param('id'));
    const requestedStage = c.req.query('stage');
    const stage = requestedStage
      ? (reviewStageSchema.parse(requestedStage) as ReviewStage)
      : undefined;
    const actor = await principal(c);
    const [current] = await db.all<{ current_revision: number }>(
      'SELECT current_revision FROM review_cases WHERE id=?',
      [caseId],
    );
    assert(current && current.current_revision > 0, 'NOT_FOUND', 404);
    return protectedObjectRead(async () => {
      const authorization = await reviewAuthorization(
        c,
        {
          capability: 'case.read_public_source',
          case_id: caseId,
          case_revision: current.current_revision,
          assignment_id: optionalAssignmentId(c),
        },
        actor,
      );
      const assignment = await assignmentFor({
        case_id: caseId,
        case_revision: current.current_revision,
        person_id: authorization.person_id,
        assignment_id: optionalAssignmentId(c),
        stage,
      });
      const resolvedStage = stage ?? stageOf(assignment.stage);
      return c.json(
        await review.getCaseForReview({
          case_id: caseId,
          assignment_id: assignment.assignment_id,
          stage: resolvedStage,
          authorization,
        }),
      );
    });
  };

  const recordDecision = async (c: Context) => {
    assert(reviewEnabled(), 'PRODUCTION_GATE_CLOSED', 403);
    const caseId = idSchema.parse(c.req.param('id'));
    const parsed = z
      .strictObject({
        revision: z.number().int().positive(),
        candidate_digest: digestSchema,
        action: z.enum(['approve', 'reject', 'return', 'abstain']),
        reason: textSchema,
        blocking_issue_codes: z.array(blockingIssueSchema).max(10).optional(),
        assignment_id: idSchema.optional(),
      })
      .parse(await body(c));
    const authorization = await reviewAuthorization(c, {
      capability: 'case.submit_decision',
      case_id: caseId,
      case_revision: parsed.revision,
      assignment_id: parsed.assignment_id,
    });
    const assignment = await assignmentFor({
      case_id: caseId,
      case_revision: parsed.revision,
      person_id: authorization.person_id,
      assignment_id: parsed.assignment_id,
    });
    return c.json(
      await review.recordDecision({
        case_id: caseId,
        revision: parsed.revision,
        candidate_digest: parsed.candidate_digest,
        action: parsed.action,
        reason: parsed.reason,
        blocking_issue_codes: parsed.blocking_issue_codes,
        assignment_id: assignment.assignment_id,
        authorization,
      }),
    );
  };

  const publicationStatus = async (c: Context) => {
    assert(reviewEnabled(), 'PRODUCTION_GATE_CLOSED', 403);
    const caseId = idSchema.parse(c.req.param('id'));
    const actor = await principal(c);
    const [current] = await db.all<{ current_revision: number }>(
      'SELECT current_revision FROM review_cases WHERE id=?',
      [caseId],
    );
    assert(current && current.current_revision > 0, 'NOT_FOUND', 404);
    return protectedObjectRead(async () => {
      const authorization = await reviewAuthorization(
        c,
        {
          capability: 'case.read_public_source',
          case_id: caseId,
          case_revision: current.current_revision,
          assignment_id: optionalAssignmentId(c),
        },
        actor,
      );
      await assignmentFor({
        case_id: caseId,
        case_revision: current.current_revision,
        person_id: authorization.person_id,
        assignment_id: optionalAssignmentId(c),
      });
      return c.json(await review.publicationStatus(caseId));
    });
  };

  const resolveBlocker = async (c: Context) => {
    assert(reviewEnabled(), 'PRODUCTION_GATE_CLOSED', 403);
    const caseId = idSchema.parse(c.req.param('id'));
    const issueId = idSchema.parse(c.req.param('issueId'));
    const parsed = z
      .strictObject({
        revision: z.number().int().positive(),
        expected_revision: z.number().int().positive(),
        reason: textSchema,
        assignment_id: idSchema.optional(),
      })
      .parse(await body(c));
    const authorization = await reviewAuthorization(c, {
      capability: 'case.resolve_blocking',
      case_id: caseId,
      case_revision: parsed.revision,
      assignment_id: parsed.assignment_id,
    });
    const assignment = await assignmentFor({
      case_id: caseId,
      case_revision: parsed.revision,
      person_id: authorization.person_id,
      assignment_id: parsed.assignment_id,
    });
    return c.json(
      await review.resolveBlocking({
        case_id: caseId,
        issue_id: issueId,
        revision: parsed.revision,
        expected_revision: parsed.expected_revision,
        reason: parsed.reason,
        assignment_id: assignment.assignment_id,
        authorization,
      }),
    );
  };

  const fetchSource = async (c: Context) => {
    assert(sourceEnabled(), 'PRODUCTION_GATE_CLOSED', 403);
    assert(config.evidence_gateway, 'SAFE_PROCESSOR_UNAVAILABLE', 503);
    const sourceId = idSchema.parse(c.req.param('sourceId'));
    const parsed = z
      .strictObject({
        case_id: idSchema,
        case_revision: z.number().int().positive(),
        url: z.string().min(1).max(2048),
        idempotency_key: z.string().min(16).max(256),
        assignment_id: idSchema.optional(),
      })
      .parse(await body(c));
    const authorization = await sourceAuthorization(c, {
      capability: 'source.fetch',
      case_id: parsed.case_id,
      case_revision: parsed.case_revision,
      source_id: sourceId,
      assignment_id: parsed.assignment_id,
    });
    return c.json(
      await config.evidence_gateway.enqueue({
        source_id: sourceId,
        ...parsed,
        authorization,
      }),
      201,
    );
  };

  const sourceJob = async (c: Context) => {
    assert(sourceEnabled(), 'PRODUCTION_GATE_CLOSED', 403);
    const gateway = config.evidence_gateway;
    assert(gateway, 'SAFE_PROCESSOR_UNAVAILABLE', 503);
    const jobId = idSchema.parse(c.req.param('jobId'));
    const actor = await principal(c);
    const [job] = await db.all<{
      case_id: string;
      case_revision: number;
      source_id: string;
    }>('SELECT case_id,case_revision,source_id FROM source_fetch_jobs WHERE id=?', [jobId]);
    assert(job, 'NOT_FOUND', 404);
    return protectedObjectRead(async () => {
      const authorization = await sourceAuthorization(
        c,
        {
          capability: 'case.read_public_source',
          case_id: job.case_id,
          case_revision: job.case_revision,
          source_id: job.source_id,
          assignment_id: optionalAssignmentId(c),
        },
        true,
        actor,
      );
      return c.json(await gateway.status(jobId, authorization));
    });
  };

  const sourcePreview = async (c: Context) => {
    assert(sourceEnabled(), 'PRODUCTION_GATE_CLOSED', 403);
    const gateway = config.evidence_gateway;
    assert(gateway, 'SAFE_PROCESSOR_UNAVAILABLE', 503);
    const previewId = c.req.param('previewId');
    const sourceId = c.req.param('sourceId');
    const parsedId = idSchema.parse(previewId ?? sourceId ?? '');
    const actor = await principal(c);
    const [preview] = await db.all<{
      id: string;
      source_id: string;
      case_id: string;
      case_revision: number;
    }>(
      previewId
        ? 'SELECT id,source_id,case_id,case_revision FROM sanitized_previews WHERE id=?'
        : 'SELECT id,source_id,case_id,case_revision FROM sanitized_previews WHERE source_id=? ORDER BY created_at DESC LIMIT 1',
      [parsedId],
    );
    assert(preview, 'NOT_FOUND', 404);
    return protectedObjectRead(async () => {
      const authorization = await sourceAuthorization(
        c,
        {
          capability: 'case.read_public_source',
          case_id: preview.case_id,
          case_revision: preview.case_revision,
          source_id: preview.source_id,
          assignment_id: optionalAssignmentId(c),
        },
        true,
        actor,
      );
      return c.json(await gateway.preview(preview.id, authorization));
    }, true);
  };

  for (const path of ['/cases', '/review/cases']) app.get(path, listCases);
  for (const path of ['/cases', '/review/cases']) app.post(path, createCase);
  for (const path of ['/cases/:id/revisions', '/review/cases/:id/revisions'])
    app.post(path, submitRevision);
  for (const path of ['/cases/:id/previews', '/review/cases/:id/previews'])
    app.post(path, bindPreviews);
  for (const path of ['/cases/:id', '/review/cases/:id']) app.get(path, getCase);
  for (const path of ['/cases/:id/decision', '/cases/:id/decisions', '/review/cases/:id/decisions'])
    app.post(path, recordDecision);
  for (const path of ['/cases/:id/publication-status', '/review/cases/:id/publication-status'])
    app.get(path, publicationStatus);
  for (const path of [
    '/cases/:id/blockers/:issueId/resolve',
    '/review/cases/:id/blockers/:issueId/resolve',
  ])
    app.post(path, resolveBlocker);
  app.post('/sources/:sourceId/fetch', fetchSource);
  app.get('/sources/jobs/:jobId', sourceJob);
  app.get('/sources/previews/:previewId', sourcePreview);
  app.get('/sources/:sourceId/preview', sourcePreview);

  return app;
}

/**
 * Production identity wiring.  The low-level reviewRoutes factory above is
 * intentionally injectable for tests and legacy hosts; this adapter resolves
 * the private identity, live grant and identity-owned assignment tables on
 * every request.  It is mounted by the host with:
 *
 *   app.route('/admin/v1', createReviewRoutes(db, resolveAuthorizedPrincipal, { mode }))
 *
 * The returned paths therefore are /admin/v1/cases and /admin/v1/sources.
 */
export type ReviewRuntimeConfig = Readonly<{
  mode: 'demo' | 'production';
  reviewEnabled?: boolean;
  sourceFetchEnabled?: boolean;
  evidenceGateway?: EvidenceGatewayService;
  validateCandidate?: CandidateValidator;
}>;

type IdentityAssignmentRow = Readonly<{
  assignment_id: string;
  case_id: string;
  candidate_revision: number;
  stage: IdentityAssignmentStage;
  principal_id: string;
  person_id: string;
  grant_id: string;
  conflict_snapshot: 'clear' | 'blocked';
  status:
    'assigned' | 'accepted' | 'in_progress' | 'completed' | 'declined' | 'expired' | 'revoked';
  expires_at: string;
}>;

function mapIdentityAssignment(row: IdentityAssignmentRow): CaseAssignment {
  return {
    assignment_id: row.assignment_id,
    case_id: row.case_id,
    case_revision: row.candidate_revision,
    reviewer_person_id: row.person_id,
    stage: row.stage,
    state:
      row.status === 'assigned'
        ? 'assigned'
        : row.status === 'accepted' || row.status === 'in_progress'
          ? 'active'
          : row.status === 'completed'
            ? 'completed'
            : row.status === 'declined'
              ? 'declined'
              : 'expired',
    expires_at: row.expires_at,
  };
}

function identityAssignments(db: Database): AssignmentProvider {
  return {
    async find(input) {
      if (input.stage === 'escalation') return null;
      const params: unknown[] = [
        input.assignment_id,
        input.case_id,
        input.case_revision,
        input.person_id,
      ];
      const stage = input.stage ? ' AND stage=?' : '';
      if (input.stage) params.push(input.stage);
      const [row] = await db.all<IdentityAssignmentRow>(
        `SELECT assignment_id,case_id,candidate_revision,stage,principal_id,person_id,
                grant_id,conflict_snapshot,status,expires_at
           FROM case_assignments
          WHERE assignment_id=? AND case_id=? AND candidate_revision=? AND person_id=?
            AND conflict_snapshot='clear'
            AND status IN ('assigned','accepted','in_progress')${stage}`,
        params,
      );
      return row ? mapIdentityAssignment(row) : null;
    },
    async listForPerson(input) {
      const clauses = [
        'person_id=?',
        "conflict_snapshot='clear'",
        "status IN ('assigned','accepted','in_progress')",
      ];
      const params: unknown[] = [input.person_id];
      if (input.case_id) {
        clauses.push('case_id=?');
        params.push(input.case_id);
      }
      if (input.case_revision !== undefined) {
        clauses.push('candidate_revision=?');
        params.push(input.case_revision);
      }
      const rows = await db.all<IdentityAssignmentRow>(
        `SELECT assignment_id,case_id,candidate_revision,stage,principal_id,person_id,
                grant_id,conflict_snapshot,status,expires_at
           FROM case_assignments WHERE ${clauses.join(' AND ')}
          ORDER BY case_id,candidate_revision,stage,assignment_id`,
        params,
      );
      return rows.map(mapIdentityAssignment);
    },
  };
}

async function activeAssignmentForIdentity(
  db: Database,
  identity: Identity,
  assignmentId: string,
  caseId: string,
  revision: number,
) {
  const [row] = await db.all<IdentityAssignmentRow>(
    `SELECT assignment_id,case_id,candidate_revision,stage,principal_id,person_id,
            grant_id,conflict_snapshot,status,expires_at
       FROM case_assignments
      WHERE assignment_id=? AND case_id=? AND candidate_revision=? AND person_id=?
        AND principal_id=? AND conflict_snapshot='clear'
        AND status IN ('assigned','accepted','in_progress') AND expires_at>?`,
    [
      assignmentId,
      caseId,
      revision,
      identity.person_id,
      identity.principal_id,
      new Date().toISOString(),
    ],
  );
  if (!row) throw new PermissionError('CASE_NOT_ASSIGNED', 403);
  return row;
}

type LiveGrantRow = Readonly<{
  grant_id: string;
  principal_id: string;
  person_id: string;
  capabilities: string;
  scope: string;
  status: string;
  revocation_status: string;
  not_before: string;
  expires_at: string;
}>;

async function liveGrant(
  db: Database,
  principalId: string,
  personId: string,
  grantId: string,
): Promise<LiveGrantRow> {
  const [grant] = await db.all<LiveGrantRow>(
    `SELECT grant_id,principal_id,person_id,capabilities,scope,status,
            revocation_status,not_before,expires_at
       FROM role_grants
      WHERE grant_id=? AND principal_id=? AND person_id=?`,
    [grantId, principalId, personId],
  );
  if (!grant) throw new PermissionError('ROLE_EXPIRED_OR_REVOKED', 403);
  const now = Date.now();
  if (
    grant.status !== 'active' ||
    grant.revocation_status !== 'not_revoked' ||
    Date.parse(grant.not_before) > now ||
    Date.parse(grant.expires_at) <= now
  )
    throw new PermissionError('ROLE_EXPIRED_OR_REVOKED', 403);
  return grant;
}

function jsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function requireGrantCapability(
  grant: LiveGrantRow,
  capability: string,
  scopeKey: 'case_ids' | 'source_ids',
  objectId: string,
) {
  if (!jsonArray(grant.capabilities).includes(capability))
    throw new PermissionError('CAPABILITY_DENIED', 403);
  let scope: Record<string, unknown>;
  try {
    scope = JSON.parse(grant.scope) as Record<string, unknown>;
  } catch {
    throw new PermissionError('CAPABILITY_DENIED', 403);
  }
  if (!Array.isArray(scope[scopeKey]) || !scope[scopeKey].includes(objectId))
    throw new PermissionError('CAPABILITY_DENIED', 403);
}

async function identityReviewAuthorization(
  db: Database,
  identity: Identity,
  context: AuthorizationContext,
): Promise<ReviewAuthorization> {
  let requiredCapability: AuthorizeInput['capability'] = context.capability;
  let assignmentGrantId: string | undefined;
  if (context.assignment_id) {
    const assignment = await activeAssignmentForIdentity(
      db,
      identity,
      context.assignment_id,
      context.case_id,
      context.case_revision,
    );
    assignmentGrantId = assignment.grant_id;
    if (context.capability === 'case.submit_decision') {
      if (assignment.stage === 'secondary') requiredCapability = 'case.independent_review';
      else if (assignment.stage !== 'primary') throw new PermissionError('CAPABILITY_DENIED', 403);
    }
  }
  const decision = await authorizeIdentity(db, identity, {
    capability: requiredCapability,
    object_type: 'case',
    object_id: context.case_id,
    scope: { case_ids: [context.case_id] },
    required_assurance: 'webauthn_step_up',
  });
  if (!decision.allowed || !decision.grant_id) throw new PermissionError(decision.code, 403);
  if (assignmentGrantId && assignmentGrantId !== decision.grant_id)
    throw new PermissionError('ROLE_EXPIRED_OR_REVOKED', 403);
  const grant = await liveGrant(db, identity.principal_id, identity.person_id, decision.grant_id);
  return {
    principal_id: identity.principal_id,
    person_id: identity.person_id,
    grant_id: grant.grant_id,
    capability: context.capability,
    expires_at: grant.expires_at,
  };
}

async function identitySourceAuthorization(
  db: Database,
  identity: Identity,
  context: {
    capability: SourceAuthorization['capability'];
    case_id: string;
    case_revision: number;
    source_id: string;
    assignment_id?: string;
  },
): Promise<SourceAuthorization> {
  const [current] = await db.all<{ current_revision: number }>(
    'SELECT current_revision FROM review_cases WHERE id=?',
    [context.case_id],
  );
  if (!current || current.current_revision !== context.case_revision)
    throw new PermissionError('REVISION_CONFLICT', 409);
  if (context.assignment_id)
    await activeAssignmentForIdentity(
      db,
      identity,
      context.assignment_id,
      context.case_id,
      context.case_revision,
    );
  const requiredCapability = context.capability;
  const decision = await authorizeIdentity(db, identity, {
    capability: requiredCapability,
    object_type: requiredCapability === 'source.fetch' ? 'source' : 'case',
    object_id: requiredCapability === 'source.fetch' ? context.source_id : context.case_id,
    scope:
      requiredCapability === 'source.fetch'
        ? { source_ids: [context.source_id] }
        : { case_ids: [context.case_id] },
    required_assurance: 'webauthn_step_up',
  });
  if (!decision.allowed || !decision.grant_id) throw new PermissionError(decision.code, 403);
  if (context.assignment_id) {
    const assignment = await activeAssignmentForIdentity(
      db,
      identity,
      context.assignment_id,
      context.case_id,
      context.case_revision,
    );
    if (assignment.grant_id !== decision.grant_id)
      throw new PermissionError('ROLE_EXPIRED_OR_REVOKED', 403);
  }
  const grant = await liveGrant(db, identity.principal_id, identity.person_id, decision.grant_id);
  return {
    principal_id: identity.principal_id,
    grant_id: grant.grant_id,
    capability: context.capability,
    case_id: context.case_id,
    case_revision: context.case_revision,
    assignment_id: context.assignment_id,
    expires_at: grant.expires_at,
  };
}

async function reauthorizeReview(db: Database, input: ReviewAuthorizationCheck): Promise<void> {
  let requiredCapability: AuthorizeInput['capability'] = input.action;
  if (input.assignment_id) {
    const [assignment] = await db.all<
      Pick<
        IdentityAssignmentRow,
        'stage' | 'status' | 'expires_at' | 'person_id' | 'principal_id' | 'grant_id'
      >
    >(
      `SELECT stage,status,expires_at,person_id,principal_id,grant_id FROM case_assignments
        WHERE assignment_id=? AND case_id=? AND candidate_revision=?`,
      [input.assignment_id, input.case_id, input.case_revision],
    );
    if (
      !assignment ||
      assignment.person_id !== input.person_id ||
      assignment.principal_id !== input.principal_id ||
      assignment.grant_id !== input.grant_id ||
      !['assigned', 'accepted', 'in_progress'].includes(assignment.status) ||
      Date.parse(assignment.expires_at) <= Date.now()
    )
      throw new PermissionError('CASE_NOT_ASSIGNED', 403);
    if (input.action === 'case.submit_decision') {
      if (assignment.stage === 'secondary') requiredCapability = 'case.independent_review';
      else if (assignment.stage !== 'primary') throw new PermissionError('CAPABILITY_DENIED', 403);
    }
  }
  const grant = await liveGrant(db, input.principal_id, input.person_id, input.grant_id);
  requireGrantCapability(grant, requiredCapability, 'case_ids', input.case_id);
  const [conflict] = await db.all<{ conflict_id: string }>(
    `SELECT conflict_id FROM conflict_declarations
      WHERE person_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?)
        AND (object_id IS NULL OR (object_type='case' AND object_id=?)) LIMIT 1`,
    [input.person_id, new Date().toISOString(), input.case_id],
  );
  if (conflict) throw new PermissionError('CONFLICT_OF_INTEREST', 403);
}

async function reauthorizeSource(
  db: Database,
  input: {
    action: 'source.fetch' | 'source.read';
    job_id?: string;
    source_id: string;
    case_id: string;
    case_revision: number;
    grant_id: string;
    assignment_id?: string;
  },
) {
  const [current] = await db.all<{ current_revision: number }>(
    'SELECT current_revision FROM review_cases WHERE id=?',
    [input.case_id],
  );
  if (!current || current.current_revision !== input.case_revision)
    throw new PermissionError('REVISION_CONFLICT', 409);
  const [grant] = await db.all<LiveGrantRow>(
    `SELECT grant_id,principal_id,person_id,capabilities,scope,status,
            revocation_status,not_before,expires_at
       FROM role_grants WHERE grant_id=?`,
    [input.grant_id],
  );
  if (!grant || grant.status !== 'active' || grant.revocation_status !== 'not_revoked')
    throw new PermissionError('ROLE_EXPIRED_OR_REVOKED', 403);
  if (Date.parse(grant.not_before) > Date.now() || Date.parse(grant.expires_at) <= Date.now())
    throw new PermissionError('ROLE_EXPIRED_OR_REVOKED', 403);
  const capability = input.action === 'source.fetch' ? 'source.fetch' : 'case.read_public_source';
  requireGrantCapability(
    grant,
    capability,
    input.action === 'source.fetch' ? 'source_ids' : 'case_ids',
    input.action === 'source.fetch' ? input.source_id : input.case_id,
  );
  if (input.assignment_id) {
    const [assignment] = await db.all<{
      person_id: string;
      principal_id: string;
      grant_id: string;
      status: string;
      expires_at: string;
    }>(
      `SELECT person_id,principal_id,grant_id,status,expires_at FROM case_assignments
        WHERE assignment_id=? AND case_id=? AND candidate_revision=?`,
      [input.assignment_id, input.case_id, input.case_revision],
    );
    if (
      !assignment ||
      assignment.person_id !== grant.person_id ||
      assignment.principal_id !== grant.principal_id ||
      assignment.grant_id !== grant.grant_id ||
      !['assigned', 'accepted', 'in_progress'].includes(assignment.status) ||
      Date.parse(assignment.expires_at) <= Date.now()
    )
      throw new PermissionError('CASE_NOT_ASSIGNED', 403);
  }
}

/**
 * Wire the review and source services to the identity service.  Production
 * defaults keep both gates closed unless explicitly enabled; demo defaults
 * only the review UI gate on, while source fetching still requires an
 * explicit safe-processor switch.
 */
export function createReviewRoutes(
  db: Database,
  resolveIdentity: ResolveIdentity,
  options: ReviewRuntimeConfig,
) {
  const assignments = identityAssignments(db);
  const reviewEnabled = options.reviewEnabled ?? options.mode === 'demo';
  const sourceFetchEnabled = options.sourceFetchEnabled ?? false;
  const config: ReviewRoutesConfig = {
    review_enabled: reviewEnabled,
    source_fetch_enabled: sourceFetchEnabled,
    assignments,
    resolve_identity: resolveIdentity,
    resolve_identity_review_authorization: (identity, context) =>
      identityReviewAuthorization(db, identity, context),
    resolve_identity_source_authorization: (identity, context) =>
      identitySourceAuthorization(db, identity, context),
    authorize_review: (input) => reauthorizeReview(db, input),
    evidence_gateway: options.evidenceGateway,
    validate_candidate: options.validateCandidate,
  };
  return reviewRoutes(db, async () => null, config);
}
