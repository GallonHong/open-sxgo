import { z } from 'zod';
import type { Database, Query } from '../../db/src/adapter';
import { assert, DomainError } from '../../domain/src/index';
import { canonical, hash, utf8 } from '../../verifier/src/crypto';

const iso = z.string().datetime({ offset: true });
const identifier = z.string().regex(/^[a-z][a-z0-9_-]{2,100}$/);
const nonEmpty = z.string().trim().min(1).max(500);

export const proposalStates = [
  'draft',
  'discussion',
  'voting',
  'passed',
  'rejected',
  'withdrawn',
  'expired',
  'timelocked',
  'ready_to_execute',
  'executed',
  'blocked',
  'failed',
] as const;
export type ProposalState = (typeof proposalStates)[number];

export const proposalTypes = [
  'contribution_policy',
  'review_policy',
  'role_grant',
  'role_revoke',
  'node_policy',
  'privacy_policy',
  'rule_change',
  'targets_rotation',
  'root_rotation',
  'charter_change',
  'community_special',
] as const;
export type ProposalType = (typeof proposalTypes)[number];

const thresholdSchema = z.strictObject({
  members: z.literal(3),
  threshold: z.literal(2),
});

/**
 * The policy is intentionally strict.  Keeping all operational numbers in one
 * versioned object prevents a route from silently using a different threshold
 * or expiry than the signer and the public exporter.
 */
export const policySchema = z.strictObject({
  schema_version: z.literal('1.0'),
  policy_version: identifier,
  governance_stage: z.enum(['development', 'bootstrap', 'mature']),
  financial_rights: z.strictObject({
    token_issuance: z.literal(false),
    transferable_points: z.literal(false),
    paid_voting: z.literal(false),
    revenue_share: z.literal(false),
  }),
  signing: z.strictObject({
    root: thresholdSchema,
    targets: thresholdSchema,
    count_distinct_principals: z.literal(true),
    offline_root_required: z.literal(true),
  }),
  review: z.strictObject({
    independent_approvals_required: z.literal(2),
    unresolved_blocking_issue_prevents_publish: z.literal(true),
    allow_self_review: z.literal(false),
    same_revision_required: z.literal(true),
    new_reviewer_full_audit_cases: z.number().int().min(1).max(100),
    ordinary_quality_sample_rate: z.number().min(0).max(1),
  }),
  contribution: z.strictObject({
    recognition_challenge_days: z.number().int().positive().max(30),
    public_leaderboard: z.literal(false),
    count_raw_submission_volume: z.literal(false),
    auto_grant_role_from_count: z.literal(false),
  }),
  roles: z.strictObject({
    initial_reviewer_valid_days: z.number().int().positive().max(365),
    ordinary_role_reassessment_days: z.number().int().positive().max(730),
    claim_access_cache_seconds: z.number().int().positive().max(300),
    private_evidence_access_minutes: z.number().int().positive().max(120),
  }),
  voting: z.strictObject({
    voting_identity: z.literal('eligible_principal'),
    votes_per_principal: z.literal(1),
    delegation_enabled: z.literal(false),
    electorate_freeze_at: z.literal('discussion_start'),
    voter_credential_maturity_days: z.number().int().positive().max(365),
    mature_vote_min_electorate: z.number().int().positive().max(100),
    quorum_fraction: z.number().positive().max(1),
    quorum_minimum: z.number().int().positive().max(100),
    approval_fraction_numerator: z.literal(2),
    approval_fraction_denominator: z.literal(3),
    minimum_yes_fraction_of_electorate: z.number().positive().max(1),
    minimum_yes_absolute: z.number().int().positive().max(100),
    constitutional_discussion_days: z.number().int().positive().max(90),
    constitutional_voting_days: z.number().int().positive().max(90),
    constitutional_timelock_days: z.number().int().positive().max(90),
  }),
  privacy: z.strictObject({
    public_contribution_opt_in: z.literal(true),
    public_small_group_threshold: z.literal(5),
    public_summary_delay_days: z.number().int().positive().max(90),
    private_attachments_enabled: z.literal(false),
    retain_raw_evidence_after_review_days: z.number().int().nonnegative().max(30),
    raw_evidence_total_max_days: z.number().int().positive().max(90),
  }),
  source_security: z.strictObject({
    direct_reviewer_navigation: z.literal(false),
    dynamic_rendering_enabled: z.literal(false),
    unknown_domain_auto_fetch_enabled: z.literal(false),
    protocols: z.array(z.enum(['http', 'https'])).min(1),
    ports: z.array(z.union([z.literal(80), z.literal(443)])).min(1),
    max_redirects: z.number().int().nonnegative().max(3),
    max_task_seconds: z.number().int().positive().max(60),
    max_response_bytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024),
    max_task_network_bytes: z
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024),
    max_network_requests: z.number().int().positive().max(200),
    network_egress_policy_required: z.literal(true),
  }),
  emergency: z.strictObject({
    provisional_authority_hours: z.literal(24),
    restore_hidden_content_automatically: z.literal(false),
    may_expand_privileges: z.literal(false),
  }),
});
export type GovernancePolicy = z.infer<typeof policySchema>;

export function defaultPolicy(): GovernancePolicy {
  return policySchema.parse({
    schema_version: '1.0',
    policy_version: 'wfd-gov-1-0',
    governance_stage: 'bootstrap',
    financial_rights: {
      token_issuance: false,
      transferable_points: false,
      paid_voting: false,
      revenue_share: false,
    },
    signing: {
      root: { members: 3, threshold: 2 },
      targets: { members: 3, threshold: 2 },
      count_distinct_principals: true,
      offline_root_required: true,
    },
    review: {
      independent_approvals_required: 2,
      unresolved_blocking_issue_prevents_publish: true,
      allow_self_review: false,
      same_revision_required: true,
      new_reviewer_full_audit_cases: 20,
      ordinary_quality_sample_rate: 0.1,
    },
    contribution: {
      recognition_challenge_days: 7,
      public_leaderboard: false,
      count_raw_submission_volume: false,
      auto_grant_role_from_count: false,
    },
    roles: {
      initial_reviewer_valid_days: 90,
      ordinary_role_reassessment_days: 180,
      claim_access_cache_seconds: 60,
      private_evidence_access_minutes: 30,
    },
    voting: {
      voting_identity: 'eligible_principal',
      votes_per_principal: 1,
      delegation_enabled: false,
      electorate_freeze_at: 'discussion_start',
      voter_credential_maturity_days: 30,
      mature_vote_min_electorate: 10,
      quorum_fraction: 0.4,
      quorum_minimum: 5,
      approval_fraction_numerator: 2,
      approval_fraction_denominator: 3,
      minimum_yes_fraction_of_electorate: 0.25,
      minimum_yes_absolute: 3,
      constitutional_discussion_days: 7,
      constitutional_voting_days: 7,
      constitutional_timelock_days: 7,
    },
    privacy: {
      public_contribution_opt_in: true,
      public_small_group_threshold: 5,
      public_summary_delay_days: 7,
      private_attachments_enabled: false,
      retain_raw_evidence_after_review_days: 7,
      raw_evidence_total_max_days: 30,
    },
    source_security: {
      direct_reviewer_navigation: false,
      dynamic_rendering_enabled: false,
      unknown_domain_auto_fetch_enabled: false,
      protocols: ['http', 'https'],
      ports: [80, 443],
      max_redirects: 3,
      max_task_seconds: 30,
      max_response_bytes: 10 * 1024 * 1024,
      max_task_network_bytes: 30 * 1024 * 1024,
      max_network_requests: 100,
      network_egress_policy_required: true,
    },
    emergency: {
      provisional_authority_hours: 24,
      restore_hidden_content_automatically: false,
      may_expand_privileges: false,
    },
  });
}

export function assertP0Policy(input: unknown): GovernancePolicy {
  const policy = policySchema.parse(input);
  assert(policy.governance_stage !== 'mature', 'P1_MATURE_GOVERNANCE_DISABLED', 409);
  assert(
    policy.signing.root.members === 3 && policy.signing.root.threshold === 2,
    'ROOT_THRESHOLD_POLICY',
    409,
  );
  assert(
    policy.signing.targets.members === 3 && policy.signing.targets.threshold === 2,
    'TARGETS_THRESHOLD_POLICY',
    409,
  );
  return policy;
}

export const proposalPayloadSchema = z.strictObject({
  proposal_type: z.enum(proposalTypes),
  title: nonEmpty,
  background: nonEmpty,
  change: nonEmpty,
  affected_objects: z.array(identifier).max(100),
  current_policy_version: identifier,
  proposed_policy_version: identifier,
  risk: nonEmpty,
  recusal_refs: z.array(identifier).max(100),
  cost_summary: nonEmpty,
  execution_steps: z.array(nonEmpty).min(1).max(30),
  rollback_steps: z.array(nonEmpty).min(1).max(30),
  public_summary: nonEmpty,
  discussion_days: z.number().int().positive().max(90),
  voting_days: z.number().int().positive().max(90),
  timelock_days: z.number().int().positive().max(90),
});
export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;

export const proposalInputSchema = proposalPayloadSchema.extend({
  proposal_id: identifier.optional(),
  proposer_principal_id: identifier,
  policy_version: identifier,
  idempotency_key: z.string().min(16).max(256).optional(),
});
export type ProposalInput = z.infer<typeof proposalInputSchema>;

export const ballotSchema = z.strictObject({
  principal_id: identifier,
  choice: z.enum(['yes', 'no', 'abstain']),
  ballot_revision: z.number().int().positive(),
  proposal_revision: z.number().int().positive(),
});
export type BallotInput = z.infer<typeof ballotSchema>;

export type ElectorateCandidate = {
  principal_id: string;
  key_id?: string;
  eligible?: boolean;
  matured_at?: string;
  conflicted?: boolean;
};
export type ElectorateMember = { principal_id: string; key_id: string | null };
export type VoteCount = {
  electorate: number;
  yes: number;
  no: number;
  abstain: number;
  participation: number;
};
export type VoteOutcome = VoteCount & {
  status: 'passed' | 'rejected' | 'quorum_unmet' | 'not_applicable' | 'deadline_pending';
  reason?: string;
};

export type GovernanceExecutionInput = {
  proposal_id: string;
  proposal_revision: number;
  execution_id: string;
  actor_principal_id: string;
  payload_digest: string;
  body_json: string;
};
export type GovernanceExecutionResult = {
  status: 'executed' | 'failed';
  result?: unknown;
  reason?: string;
};
/**
 * Execution is deliberately an adapter rather than a caller supplied result.
 * The adapter must re-authorize the current proposal and perform the target
 * mutation.  A route cannot mark a proposal as executed by posting JSON.
 */
export type GovernanceExecutor = {
  execute(input: GovernanceExecutionInput): Promise<GovernanceExecutionResult>;
};

export function freezeElectorate(
  candidates: ElectorateCandidate[],
  at: Date,
  policy = defaultPolicy(),
): ElectorateMember[] {
  const cutoff = at.getTime() - policy.voting.voter_credential_maturity_days * 86400000;
  const members = new Map<string, ElectorateMember>();
  for (const candidate of candidates) {
    if (!candidate.eligible || candidate.conflicted) continue;
    if (!candidate.matured_at || Date.parse(candidate.matured_at) > cutoff) continue;
    if (!members.has(candidate.principal_id))
      members.set(candidate.principal_id, {
        principal_id: candidate.principal_id,
        key_id: candidate.key_id ?? null,
      });
  }
  return [...members.values()].sort((a, b) => a.principal_id.localeCompare(b.principal_id));
}

export function countLatestBallots(
  members: ElectorateMember[],
  ballots: Pick<BallotInput, 'principal_id' | 'choice' | 'ballot_revision'>[],
): VoteCount {
  const allowed = new Set(members.map((m) => m.principal_id));
  const latest = new Map<string, Pick<BallotInput, 'choice' | 'ballot_revision'>>();
  for (const ballot of ballots) {
    if (!allowed.has(ballot.principal_id)) continue;
    const old = latest.get(ballot.principal_id);
    if (!old || ballot.ballot_revision > old.ballot_revision)
      latest.set(ballot.principal_id, ballot);
  }
  const count = {
    electorate: members.length,
    yes: 0,
    no: 0,
    abstain: 0,
    participation: latest.size,
  };
  for (const ballot of latest.values()) count[ballot.choice]++;
  return count;
}

/** Apply the PRD2 special vote formula without treating abstention as yes/no. */
export function evaluateSpecialVote(
  count: VoteCount,
  now = new Date(),
  deadline?: string,
): VoteOutcome {
  if (deadline && Date.parse(deadline) > now.getTime())
    return { ...count, status: 'deadline_pending', reason: 'TIMELOCK_NOT_ELAPSED' };
  if (count.electorate < 10)
    return { ...count, status: 'not_applicable', reason: 'TRANSITIONAL_PROCEDURE_REQUIRED' };
  const quorum = Math.max(5, Math.ceil(0.4 * count.electorate));
  if (count.participation < quorum)
    return { ...count, status: 'quorum_unmet', reason: 'QUORUM_UNMET' };
  const decided = count.yes + count.no;
  const fractionPasses = decided > 0 && count.yes * 3 >= decided * 2;
  const minimumYes = Math.max(3, Math.ceil(0.25 * count.electorate));
  if (fractionPasses && count.yes >= minimumYes) return { ...count, status: 'passed' };
  return { ...count, status: 'rejected', reason: 'MINIMUM_YES_OR_APPROVAL_FRACTION_UNMET' };
}

const allowedTransitions: Record<ProposalState, ProposalState[]> = {
  draft: ['discussion', 'withdrawn', 'expired'],
  // P0 bootstrap uses the transition committee in place of the disabled
  // community ballot, so a passed proposal may come directly from discussion.
  discussion: ['voting', 'passed', 'withdrawn', 'expired', 'blocked'],
  voting: ['passed', 'rejected', 'withdrawn', 'expired', 'blocked'],
  passed: ['timelocked', 'blocked', 'failed'],
  timelocked: ['ready_to_execute', 'blocked', 'expired'],
  ready_to_execute: ['executed', 'failed', 'blocked'],
  executed: [],
  rejected: [],
  withdrawn: [],
  expired: [],
  blocked: ['discussion', 'voting', 'ready_to_execute', 'withdrawn'],
  failed: ['ready_to_execute', 'blocked'],
};
export function canTransition(from: ProposalState, to: ProposalState) {
  return allowedTransitions[from]?.includes(to) ?? false;
}

type ProposalRow = {
  id: string;
  proposer_principal_id: string;
  proposal_type: ProposalType;
  title: string;
  body_json: string;
  public_summary: string;
  payload_digest: string;
  policy_version: string;
  state: ProposalState;
  revision: number;
  discussion_started_at: string | null;
  discussion_ends_at: string | null;
  voting_ends_at: string | null;
  timelock_until: string | null;
  electorate_snapshot_id: string | null;
  execution_id: string | null;
  execution_result_json: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: string;
  updated_at: string;
};

type Actor = string | { principal_id: string };
function actorId(actor: Actor) {
  return typeof actor === 'string' ? actor : actor.principal_id;
}
function stamp(now = new Date()) {
  return now.toISOString();
}
function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}
const mutationGuard = (): Query[] => [
  { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
  { sql: 'DELETE FROM mutation_guard' },
];
function proposalBody(input: ProposalInput) {
  const {
    proposal_id: _proposalId,
    proposer_principal_id: _proposer,
    policy_version: _policyVersion,
    idempotency_key: _idempotency,
    ...payload
  } = input;
  return proposalPayloadSchema.parse(payload);
}

export class GovernanceService {
  constructor(
    public db: Database,
    public policy: GovernancePolicy = defaultPolicy(),
    public clock: () => Date = () => new Date(),
    /** Identity agent supplies canonical principal -> person linkage. */
    public resolvePerson: (principalId: string) => Promise<string> = async (principalId) => {
      try {
        const [row] = await db.all<{ person_id: string }>(
          'SELECT person_id FROM principal_identities WHERE principal_id=? LIMIT 1',
          [principalId],
        );
        return row?.person_id ?? principalId;
      } catch {
        return principalId;
      }
    },
  ) {
    assertP0Policy(policy);
  }

  async getProposal(id: string): Promise<ProposalRow | null> {
    const [row] = await this.db.all<ProposalRow>('SELECT * FROM governance_proposals WHERE id=?', [
      id,
    ]);
    return row ?? null;
  }

  async listProposals(limit = 100): Promise<ProposalRow[]> {
    assert(Number.isInteger(limit) && limit > 0 && limit <= 500, 'INVALID_LIMIT');
    return this.db.all<ProposalRow>(
      'SELECT * FROM governance_proposals ORDER BY created_at DESC,id DESC LIMIT ?',
      [limit],
    );
  }

  async createProposal(input: ProposalInput): Promise<ProposalRow> {
    const parsed = proposalInputSchema.parse(input);
    assert(parsed.policy_version === this.policy.policy_version, 'POLICY_VERSION_MISMATCH', 409);
    const body = proposalBody(parsed);
    const bodyJson = canonical(body);
    const requestHash = await hash(utf8(bodyJson));
    if (parsed.idempotency_key) {
      const [existing] = await this.db.all<ProposalRow>(
        'SELECT * FROM governance_proposals WHERE idempotency_key=?',
        [parsed.idempotency_key],
      );
      if (existing) {
        assert(existing.request_hash === requestHash, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
        return existing;
      }
    }
    const id = parsed.proposal_id ?? newId('gov');
    const now = stamp(this.clock());
    const digest = requestHash;
    const row: ProposalRow = {
      id,
      proposer_principal_id: parsed.proposer_principal_id,
      proposal_type: parsed.proposal_type,
      title: parsed.title,
      body_json: bodyJson,
      public_summary: parsed.public_summary,
      payload_digest: digest,
      policy_version: parsed.policy_version,
      state: 'draft',
      revision: 1,
      discussion_started_at: null,
      discussion_ends_at: null,
      voting_ends_at: null,
      timelock_until: null,
      electorate_snapshot_id: null,
      execution_id: null,
      execution_result_json: null,
      idempotency_key: parsed.idempotency_key ?? null,
      request_hash: requestHash,
      created_at: now,
      updated_at: now,
    };
    await this.db.batch([
      {
        sql: `INSERT INTO governance_proposals
          (id,proposer_principal_id,proposal_type,title,body_json,public_summary,payload_digest,policy_version,state,revision,idempotency_key,request_hash,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          row.id,
          row.proposer_principal_id,
          row.proposal_type,
          row.title,
          row.body_json,
          row.public_summary,
          row.payload_digest,
          row.policy_version,
          row.state,
          row.revision,
          row.idempotency_key,
          row.request_hash,
          now,
          now,
        ],
      },
      {
        sql: `INSERT INTO governance_events
          (id,proposal_id,from_state,to_state,actor_principal_id,reason,payload_digest,revision,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
        params: [
          newId('govev'),
          id,
          null,
          'draft',
          row.proposer_principal_id,
          'proposal_created',
          digest,
          1,
          now,
        ],
      },
      {
        sql: 'INSERT INTO governance_outbox(id,event_type,aggregate_id,payload_json,created_at) VALUES(?,?,?,?,?)',
        params: [
          newId('out'),
          'governance.proposal.created',
          id,
          canonical({ proposal_id: id, revision: 1, digest }),
          now,
        ],
      },
    ]);
    return row;
  }

  /**
   * A material edit is a new proposal revision.  Existing ballots are retained
   * for audit, but are tied to the old payload revision and cannot be counted
   * for the new discussion.
   */
  async reviseProposal(
    proposalId: string,
    actor: Actor,
    expectedRevision: number,
    payload: ProposalPayload,
    candidates: ElectorateCandidate[] = [],
  ) {
    const proposal = await this.requireProposal(proposalId);
    assert(
      ['draft', 'discussion', 'voting'].includes(proposal.state),
      'PROPOSAL_NOT_EDITABLE',
      409,
    );
    assert(proposal.revision === expectedRevision, 'REVISION_CONFLICT', 409);
    const body = proposalPayloadSchema.parse(payload);
    assert(
      body.current_policy_version === this.policy.policy_version,
      'POLICY_VERSION_MISMATCH',
      409,
    );
    const bodyJson = canonical(body);
    const digest = await hash(utf8(bodyJson));
    const nowDate = this.clock();
    const now = stamp(nowDate);
    const discussionEnds = stamp(new Date(nowDate.getTime() + body.discussion_days * 86400000));
    const members = freezeElectorate(candidates, nowDate, this.policy);
    const snapshotId = newId('electorate');
    const membersJson = canonical(members);
    const snapshotDigest = await hash(utf8(membersJson));
    const revision = proposal.revision + 1;
    await this.db.batch([
      {
        sql: `UPDATE governance_proposals SET proposal_type=?,title=?,body_json=?,public_summary=?,payload_digest=?,policy_version=?,state='discussion',revision=revision+1,discussion_started_at=?,discussion_ends_at=?,voting_ends_at=NULL,timelock_until=NULL,electorate_snapshot_id=?,execution_id=NULL,execution_result_json=NULL,updated_at=?
          WHERE id=? AND revision=? AND state=?`,
        params: [
          body.proposal_type,
          body.title,
          bodyJson,
          body.public_summary,
          digest,
          this.policy.policy_version,
          now,
          discussionEnds,
          snapshotId,
          now,
          proposal.id,
          expectedRevision,
          proposal.state,
        ],
      },
      ...mutationGuard(),
      {
        sql: 'INSERT INTO electorate_snapshots(id,proposal_id,policy_version,frozen_at,eligible_count,members_json,snapshot_digest) VALUES(?,?,?,?,?,?,?)',
        params: [
          snapshotId,
          proposal.id,
          this.policy.policy_version,
          now,
          members.length,
          membersJson,
          snapshotDigest,
        ],
      },
      {
        sql: `INSERT INTO governance_events
          (id,proposal_id,from_state,to_state,actor_principal_id,reason,payload_digest,revision,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
        params: [
          newId('govev'),
          proposal.id,
          proposal.state,
          'discussion',
          actorId(actor),
          'proposal_revision_created',
          digest,
          revision,
          now,
        ],
      },
      {
        sql: 'INSERT INTO governance_outbox(id,event_type,aggregate_id,payload_json,created_at) VALUES(?,?,?,?,?)',
        params: [
          newId('out'),
          'governance.proposal.revised',
          proposal.id,
          canonical({ proposal_id: proposal.id, revision, digest }),
          now,
        ],
      },
    ]);
    const updated = await this.getProposal(proposal.id);
    assert(updated, 'NOT_FOUND', 404);
    return updated;
  }

  private async transition(
    proposal: ProposalRow,
    to: ProposalState,
    actor: Actor,
    reason: string,
    changes: Query[],
    expectedRevision: number,
  ) {
    assert(canTransition(proposal.state, to), 'INVALID_PROPOSAL_TRANSITION', 409);
    const revision = proposal.revision + 1;
    const now = stamp(this.clock());
    await this.db.batch([
      {
        sql: 'UPDATE governance_proposals SET state=?,revision=revision+1,updated_at=? WHERE id=? AND state=? AND revision=?',
        params: [to, now, proposal.id, proposal.state, expectedRevision],
      },
      ...mutationGuard(),
      ...changes,
      {
        sql: `INSERT INTO governance_events
          (id,proposal_id,from_state,to_state,actor_principal_id,reason,payload_digest,revision,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
        params: [
          newId('govev'),
          proposal.id,
          proposal.state,
          to,
          actorId(actor),
          reason,
          proposal.payload_digest,
          revision,
          now,
        ],
      },
      {
        sql: 'INSERT INTO governance_outbox(id,event_type,aggregate_id,payload_json,created_at) VALUES(?,?,?,?,?)',
        params: [
          newId('out'),
          `governance.proposal.${to}`,
          proposal.id,
          canonical({ proposal_id: proposal.id, revision, state: to }),
          now,
        ],
      },
    ]);
    const updated = await this.getProposal(proposal.id);
    assert(updated, 'NOT_FOUND', 404);
    return updated;
  }

  async startDiscussion(
    proposalId: string,
    actor: Actor,
    expectedRevision: number,
    candidates: ElectorateCandidate[],
  ) {
    const proposal = await this.requireProposal(proposalId);
    assert(proposal.revision === expectedRevision, 'REVISION_CONFLICT', 409);
    const nowDate = this.clock();
    const now = stamp(nowDate);
    const body = proposalPayloadSchema.parse(JSON.parse(proposal.body_json));
    const discussionDays =
      body.discussion_days || this.policy.voting.constitutional_discussion_days;
    const discussionEnds = stamp(new Date(nowDate.getTime() + discussionDays * 86400000));
    const members = freezeElectorate(candidates, nowDate, this.policy);
    const snapshotId = newId('electorate');
    const membersJson = canonical(members);
    const digest = await hash(utf8(membersJson));
    return this.transition(
      proposal,
      'discussion',
      actor,
      'discussion_started',
      [
        {
          sql: 'UPDATE governance_proposals SET discussion_started_at=?,discussion_ends_at=?,electorate_snapshot_id=? WHERE id=?',
          params: [now, discussionEnds, snapshotId, proposal.id],
        },
        {
          sql: 'INSERT INTO electorate_snapshots(id,proposal_id,policy_version,frozen_at,eligible_count,members_json,snapshot_digest) VALUES(?,?,?,?,?,?,?)',
          params: [
            snapshotId,
            proposal.id,
            this.policy.policy_version,
            now,
            members.length,
            membersJson,
            digest,
          ],
        },
      ],
      expectedRevision,
    );
  }

  private async updateSameProposalState(
    proposal: ProposalRow,
    actor: Actor,
    reason: string,
    expectedRevision: number,
    changes: Query[],
  ) {
    const revision = proposal.revision + 1;
    const now = stamp(this.clock());
    await this.db.batch([
      {
        sql: 'UPDATE governance_proposals SET revision=revision+1,updated_at=? WHERE id=? AND state=? AND revision=?',
        params: [now, proposal.id, proposal.state, expectedRevision],
      },
      ...mutationGuard(),
      ...changes,
      {
        sql: `INSERT INTO governance_events
          (id,proposal_id,from_state,to_state,actor_principal_id,reason,payload_digest,revision,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
        params: [
          newId('govev'),
          proposal.id,
          proposal.state,
          proposal.state,
          actorId(actor),
          reason,
          proposal.payload_digest,
          revision,
          now,
        ],
      },
      {
        sql: 'INSERT INTO governance_outbox(id,event_type,aggregate_id,payload_json,created_at) VALUES(?,?,?,?,?)',
        params: [
          newId('out'),
          `governance.proposal.${proposal.state}`,
          proposal.id,
          canonical({ proposal_id: proposal.id, revision, state: proposal.state }),
          now,
        ],
      },
    ]);
    const updated = await this.getProposal(proposal.id);
    assert(updated, 'NOT_FOUND', 404);
    return updated;
  }

  /**
   * P0 transition governance: two independent committee approvals are
   * required.  It records each approval against the exact proposal revision;
   * a different revision cannot reuse it.
   */
  async approveProposal(
    proposalId: string,
    actor: Actor,
    expectedRevision: number,
    decision: 'approve' | 'reject',
    conflicted = false,
    reason?: string,
  ) {
    const proposal = await this.requireProposal(proposalId);
    const principal = actorId(actor);
    assert(proposal.state === 'discussion', 'INVALID_APPROVAL_STATE', 409);
    assert(proposal.revision === expectedRevision, 'REVISION_CONFLICT', 409);
    assert(principal !== proposal.proposer_principal_id, 'SELF_APPROVAL', 403);
    assert(!conflicted, 'CONFLICT_OF_INTEREST', 403);
    if (reason !== undefined)
      assert(reason.trim().length > 0 && reason.length <= 500, 'INVALID_REASON');
    const actorPerson = await this.resolvePerson(principal);
    const existing = await this.db.all<{ principal_id: string; decision: 'approve' | 'reject' }>(
      'SELECT principal_id,decision FROM governance_committee_approvals WHERE proposal_id=? AND proposal_revision=?',
      [proposal.id, proposal.revision],
    );
    assert(
      !existing.some((row) => row.principal_id === principal),
      'APPROVAL_ALREADY_SUBMITTED',
      409,
    );
    for (const row of existing)
      assert(
        (await this.resolvePerson(row.principal_id)) !== actorPerson,
        'SAME_PERSON_NOT_INDEPENDENT',
        409,
      );
    const now = stamp(this.clock());
    const approval = {
      id: newId('gapproval'),
      proposal_id: proposal.id,
      // A same-state approval increments the aggregate revision.  Record the
      // approval against the revision that becomes current so the next
      // independent approval can see it while a later material edit starts a
      // fresh approval round.
      proposal_revision:
        decision === 'approve' && existing.length === 0 ? proposal.revision + 1 : proposal.revision,
      principal_id: principal,
      decision,
      reason:
        reason?.trim() || (decision === 'approve' ? 'committee_approval' : 'committee_rejection'),
      created_at: now,
    };
    const approvalRevision = approval.proposal_revision;
    const approvals = [...existing, { principal_id: principal, decision }];
    const approvalsByPerson = new Map<string, 'approve' | 'reject'>();
    for (const row of approvals)
      approvalsByPerson.set(await this.resolvePerson(row.principal_id), row.decision);
    const approveCount = [...approvalsByPerson.values()].filter(
      (value) => value === 'approve',
    ).length;
    const rejectCount = [...approvalsByPerson.values()].filter(
      (value) => value === 'reject',
    ).length;
    const insert: Query = {
      sql: 'INSERT INTO governance_committee_approvals(id,proposal_id,proposal_revision,principal_id,decision,reason,created_at) VALUES(?,?,?,?,?,?,?)',
      params: [
        approval.id,
        approval.proposal_id,
        approvalRevision,
        approval.principal_id,
        approval.decision,
        approval.reason,
        approval.created_at,
      ],
    };
    if (decision === 'reject' || rejectCount >= 2) {
      const updated = await this.transition(
        proposal,
        'rejected',
        actor,
        'committee_rejected',
        [insert],
        expectedRevision,
      );
      return { proposal: updated, approvals: { approve: approveCount, reject: rejectCount } };
    }
    if (approveCount < 2)
      return {
        proposal: await this.updateSameProposalState(
          proposal,
          actor,
          'committee_approval_recorded',
          expectedRevision,
          [insert],
        ),
        approvals: { approve: approveCount, reject: rejectCount },
      };
    const passed = await this.transition(
      proposal,
      'passed',
      actor,
      'committee_threshold_met',
      [insert],
      expectedRevision,
    );
    const body = proposalPayloadSchema.parse(JSON.parse(proposal.body_json));
    const timelockUntil = stamp(new Date(this.clock().getTime() + body.timelock_days * 86400000));
    const timelocked = await this.transition(
      passed,
      'timelocked',
      actor,
      'committee_timelock_started',
      [
        {
          sql: 'UPDATE governance_proposals SET timelock_until=? WHERE id=?',
          params: [timelockUntil, proposal.id],
        },
      ],
      passed.revision,
    );
    return { proposal: timelocked, approvals: { approve: approveCount, reject: rejectCount } };
  }

  async openVoting(proposalId: string, actor: Actor, expectedRevision: number) {
    // Mature community voting is a P1 surface.  Reject before reading the
    // proposal so the disabled endpoint does not become an object-existence
    // oracle while the feature is closed.
    void proposalId;
    void actor;
    void expectedRevision;
    throw new DomainError('P1_MATURE_GOVERNANCE_DISABLED', 409);
  }

  async castBallot(proposalId: string, input: BallotInput) {
    void proposalId;
    void input;
    throw new DomainError('P1_MATURE_GOVERNANCE_DISABLED', 409);
  }

  async evaluateVoting(proposalId: string, actor: Actor, expectedRevision: number) {
    void proposalId;
    void actor;
    void expectedRevision;
    throw new DomainError('P1_MATURE_GOVERNANCE_DISABLED', 409);
  }

  async makeReady(proposalId: string, actor: Actor, expectedRevision: number) {
    const proposal = await this.requireProposal(proposalId);
    assert(proposal.revision === expectedRevision, 'REVISION_CONFLICT', 409);
    assert(
      proposal.timelock_until && Date.parse(proposal.timelock_until) <= this.clock().getTime(),
      'TIMELOCK_NOT_ELAPSED',
      409,
    );
    return this.transition(
      proposal,
      'ready_to_execute',
      actor,
      'timelock_elapsed',
      [],
      expectedRevision,
    );
  }

  async execute(
    proposalId: string,
    actor: Actor,
    expectedRevision: number,
    executionId: string,
    executor: GovernanceExecutor | undefined,
  ) {
    const proposal = await this.requireProposal(proposalId);
    if (proposal.state === 'executed' && proposal.execution_id === executionId)
      return { ...proposal, replayed: true };
    if (proposal.state === 'failed' && proposal.execution_id === executionId)
      return { ...proposal, replayed: true };
    assert(proposal.state === 'ready_to_execute', 'EXECUTION_NOT_READY', 409);
    assert(proposal.revision === expectedRevision, 'REVISION_CONFLICT', 409);
    assert(/^[a-z][a-z0-9_-]{2,100}$/.test(executionId), 'INVALID_EXECUTION_ID');
    assert(
      executor && typeof executor.execute === 'function',
      'GOVERNANCE_EXECUTOR_UNAVAILABLE',
      503,
    );
    const result = await executor.execute({
      proposal_id: proposal.id,
      proposal_revision: proposal.revision,
      execution_id: executionId,
      actor_principal_id: actorId(actor),
      payload_digest: proposal.payload_digest,
      body_json: proposal.body_json,
    });
    assert(
      result && (result.status === 'executed' || result.status === 'failed'),
      'INVALID_EXECUTION_RESULT',
      503,
    );
    const to: ProposalState = result.status;
    // The deterministic business serializer rejects `undefined`; normalize an
    // adapter that only returns a status into an explicit null payload.
    const executionJson = canonical({
      result: result.result ?? null,
      reason: result.reason ?? null,
    });
    const updated = await this.transition(
      proposal,
      to,
      actor,
      result.status === 'executed' ? 'execution_succeeded' : 'execution_failed',
      [
        {
          sql: 'UPDATE governance_proposals SET execution_id=?,execution_result_json=? WHERE id=?',
          params: [executionId, executionJson, proposal.id],
        },
      ],
      expectedRevision,
    );
    return { ...updated, replayed: false };
  }

  async retryFailed(proposalId: string, actor: Actor, expectedRevision: number) {
    const proposal = await this.requireProposal(proposalId);
    assert(proposal.state === 'failed', 'EXECUTION_NOT_FAILED', 409);
    assert(proposal.revision === expectedRevision, 'REVISION_CONFLICT', 409);
    return this.transition(
      proposal,
      'ready_to_execute',
      actor,
      'execution_retry_requested',
      [],
      expectedRevision,
    );
  }

  async withdraw(proposalId: string, actor: Actor, expectedRevision: number) {
    const proposal = await this.requireProposal(proposalId);
    assert(proposal.revision === expectedRevision, 'REVISION_CONFLICT', 409);
    return this.transition(
      proposal,
      'withdrawn',
      actor,
      'proposal_withdrawn',
      [],
      expectedRevision,
    );
  }

  private async requireProposal(id: string) {
    const row = await this.getProposal(id);
    assert(row, 'NOT_FOUND', 404);
    return row;
  }
}

export type { ProposalRow };
