import { Hono } from 'hono';
import { resultView } from './response-projections';
import { z } from 'zod';
import type { Database } from '../../../packages/db/src/adapter';
import { assert, DomainError } from '../../../packages/domain/src/index';
import { strictJSON } from '../../../packages/verifier/src/crypto';
import type {
  AuthorizeInput,
  Capability,
  Identity,
} from '../../../packages/identity-permissions/src/index';
import {
  ContributionLedger,
  qualificationAssessmentSchema,
  type QualificationAssessmentInput,
} from '../../../packages/contribution-ledger/src/index';
import {
  GovernanceService,
  proposalPayloadSchema,
  type ElectorateCandidate,
  type GovernanceExecutor,
} from '../../../packages/governance-policy/src/index';

/**
 * The action router is intentionally a factory. Authentication, current
 * grant loading and object-scoped authorization stay with the host app; this
 * module only turns the verified identity into service calls. In production
 * `authorize` must reload the session/grant state for every request.
 */
export type GovernanceActionAuthorizer = (
  identity: Identity,
  input: AuthorizeInput,
) => Promise<{ allowed: boolean; code?: string }> | { allowed: boolean; code?: string };

export type GovernanceActionsConfig = {
  governance: GovernanceService;
  ledger: ContributionLedger;
  resolveIdentity: (headers: Headers) => Promise<Identity | null>;
  authorize?: GovernanceActionAuthorizer;
  getElectorate?: (identity: Identity, proposalId: string) => Promise<ElectorateCandidate[]>;
  isConflicted?: (
    identity: Identity,
    objectType: 'proposal' | 'qualification',
    objectId: string,
  ) => Promise<boolean> | boolean;
  executor?:
    GovernanceExecutor | ((identity: Identity) => GovernanceExecutor | Promise<GovernanceExecutor>);
};

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{2,100}$/);
const expectedRevision = z.number().int().positive();
const reason = z.string().trim().min(1).max(500);
const proposalActionSchema = z.strictObject({ expected_revision: expectedRevision });
const committeeApprovalSchema = z.strictObject({
  expected_revision: expectedRevision,
  decision: z.enum(['approve', 'reject']),
  reason,
});
const executionSchema = z.strictObject({
  expected_revision: expectedRevision,
  execution_id: identifier,
});
const appealResolutionSchema = z.strictObject({
  expected_revision: expectedRevision,
  decision: z.enum(['confirm', 'adjust', 'reject', 'pause']),
  reason,
});

type ActionContext = {
  req: { raw: Request; param(name: string): string };
};

/**
 * Build the P0 governance action endpoints. The host may mount this factory
 * under `/` or a dedicated prefix; paths include their API version so the
 * ownership boundary remains explicit when the legacy proposal API is
 * removed.
 */
export function createGovernanceActionsRouter(config: GovernanceActionsConfig) {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: { code: 'INVALID_SCHEMA' } }, 400);
    if (error instanceof DomainError)
      return new Response(JSON.stringify({ error: { code: error.code } }), {
        status: error.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    // Do not echo database, session or adapter errors from an admin route.
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503);
  });

  const parseBody = async (c: ActionContext) => {
    try {
      return strictJSON(await c.req.raw.text());
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('INVALID_JSON', 400);
    }
  };
  const idFrom = (c: ActionContext, name = 'id') => identifier.parse(c.req.param(name));

  async function currentIdentity(c: ActionContext): Promise<Identity> {
    const identity = await config.resolveIdentity(c.req.raw.headers);
    assert(identity, 'AUTHENTICATION_REQUIRED', 401);
    assert(identity.status === 'active', 'CAPABILITY_DENIED', 403);
    return identity;
  }

  async function requireAuthorization(identity: Identity, input: AuthorizeInput) {
    assert(config.authorize, 'GOVERNANCE_AUTHORIZER_UNAVAILABLE', 503);
    const decision = await config.authorize(identity, input);
    if (decision?.allowed === true) return;
    if (decision && decision.allowed === false)
      throw new DomainError(decision.code ?? 'CAPABILITY_DENIED', 403);
    throw new DomainError('GOVERNANCE_AUTHORIZER_UNAVAILABLE', 503);
  }

  async function conflict(
    identity: Identity,
    objectType: 'proposal' | 'qualification',
    objectId: string,
  ) {
    return config.isConflicted
      ? Boolean(await config.isConflicted(identity, objectType, objectId))
      : false;
  }

  async function executor(identity: Identity): Promise<GovernanceExecutor | undefined> {
    if (!config.executor) return undefined;
    return typeof config.executor === 'function' ? config.executor(identity) : config.executor;
  }

  const proposalCapability: Capability = 'governance.propose';
  const executeCapability: Capability = 'governance.execute';
  const policyAuthorization = (capability: Capability): AuthorizeInput => ({
    capability,
    object_type: 'policy',
    object_id: config.governance.policy.policy_version,
    scope: { policy_ids: [config.governance.policy.policy_version] },
  });

  app.get('/admin/v1/governance/proposals', async (c) => {
    const identity = await currentIdentity(c);
    await requireAuthorization(identity, policyAuthorization(proposalCapability));
    return c.json({ items: await config.governance.listProposals() });
  });

  app.post('/admin/v1/governance/proposals', async (c) => {
    const identity = await currentIdentity(c);
    await requireAuthorization(identity, policyAuthorization(proposalCapability));
    const body = proposalPayloadSchema.parse(await parseBody(c));
    const idempotencyKey = z.string().min(16).max(256).parse(c.req.header('idempotency-key'));
    const proposal = await config.governance.createProposal({
      ...body,
      proposer_principal_id: identity.principal_id,
      policy_version: config.governance.policy.policy_version,
      idempotency_key: idempotencyKey,
    });
    return c.json(proposal, 201);
  });

  app.get('/admin/v1/governance/proposals/:id', async (c) => {
    const identity = await currentIdentity(c);
    const proposalId = idFrom(c);
    await requireAuthorization(identity, policyAuthorization(proposalCapability));
    const proposal = await config.governance.getProposal(proposalId);
    // The authorization check happens before the lookup to avoid object
    // existence disclosure through an unauthorized admin account.
    assert(proposal, 'NOT_FOUND', 404);
    return c.json(proposal);
  });

  app.post('/admin/v1/governance/proposals/:id/discussion', async (c) => {
    const identity = await currentIdentity(c);
    const proposalId = idFrom(c);
    await requireAuthorization(identity, policyAuthorization(proposalCapability));
    const body = proposalActionSchema.parse(await parseBody(c));
    const candidates = config.getElectorate ? await config.getElectorate(identity, proposalId) : [];
    return c.json(
      await config.governance.startDiscussion(
        proposalId,
        identity.principal_id,
        body.expected_revision,
        candidates,
      ),
    );
  });

  app.post('/admin/v1/governance/proposals/:id/approval', async (c) => {
    const identity = await currentIdentity(c);
    const proposalId = idFrom(c);
    await requireAuthorization(identity, policyAuthorization(executeCapability));
    const body = committeeApprovalSchema.parse(await parseBody(c));
    return c.json(
      await config.governance.approveProposal(
        proposalId,
        identity.principal_id,
        body.expected_revision,
        body.decision,
        await conflict(identity, 'proposal', proposalId),
        body.reason,
      ),
    );
  });

  app.post('/admin/v1/governance/proposals/:id/ready', async (c) => {
    const identity = await currentIdentity(c);
    const proposalId = idFrom(c);
    await requireAuthorization(identity, policyAuthorization(executeCapability));
    const body = proposalActionSchema.parse(await parseBody(c));
    return c.json(
      await config.governance.makeReady(proposalId, identity.principal_id, body.expected_revision),
    );
  });

  app.post('/admin/v1/governance/proposals/:id/execute', async (c) => {
    const identity = await currentIdentity(c);
    const proposalId = idFrom(c);
    await requireAuthorization(identity, policyAuthorization(executeCapability));
    const body = executionSchema.parse(await parseBody(c));
    return c.json(
      await config.governance.execute(
        proposalId,
        identity.principal_id,
        body.expected_revision,
        body.execution_id,
        await executor(identity),
      ),
    );
  });

  app.post('/admin/v1/qualifications/:id/assess', async (c) => {
    const identity = await currentIdentity(c);
    const applicationId = idFrom(c);
    await requireAuthorization(identity, {
      capability: 'qualification.assess',
      object_type: 'qualification',
      object_id: applicationId,
      scope: { qualification_ids: [applicationId] },
    });
    const input = qualificationAssessmentSchema
      .omit({
        application_id: true,
        assessor_principal_id: true,
        conflicted: true,
        policy_version: true,
      })
      .parse(await parseBody(c));
    const serviceInput: QualificationAssessmentInput = {
      ...input,
      application_id: applicationId,
      assessor_principal_id: identity.principal_id,
      conflicted: await conflict(identity, 'qualification', applicationId),
      policy_version: config.governance.policy.policy_version,
    };
    return c.json(resultView(await config.ledger.assessQualification(serviceInput)));
  });

  app.post('/admin/v1/appeals/:id/resolve', async (c) => {
    const identity = await currentIdentity(c);
    const appealId = idFrom(c);
    await requireAuthorization(identity, policyAuthorization(executeCapability));
    const body = appealResolutionSchema.parse(await parseBody(c));
    return c.json(
      resultView(
        await config.ledger.assessAppeal(
          appealId,
          identity.principal_id,
          body.decision,
          body.reason,
          body.expected_revision,
        ),
      ),
    );
  });

  // P1 endpoint remains deliberately absent. The service also rejects calls
  // made directly so a future route cannot accidentally enable mature voting.
  return app;
}

export const governanceActions = createGovernanceActionsRouter;

export type GovernanceActionsWiring = Omit<
  GovernanceActionsConfig,
  'governance' | 'ledger' | 'resolveIdentity'
> & {
  governance?: GovernanceService;
  ledger?: ContributionLedger;
};

/** Convenience wiring for the host app; authorization remains explicit. */
export function governanceActionsRoutes(
  db: Database,
  resolveIdentity: GovernanceActionsConfig['resolveIdentity'],
  wiring: GovernanceActionsWiring = {},
) {
  const governance = wiring.governance ?? new GovernanceService(db);
  const ledger = wiring.ledger ?? new ContributionLedger(db, governance.policy);
  return createGovernanceActionsRouter({
    ...wiring,
    governance,
    ledger,
    resolveIdentity,
  });
}
