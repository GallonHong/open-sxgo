import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../packages/db/src/node';
import type { Database } from '../packages/db/src/adapter';
import {
  GovernanceService,
  defaultPolicy,
  evaluateSpecialVote,
  freezeElectorate,
  type ProposalPayload,
} from '../packages/governance-policy/src';

describe('PRD2 bootstrap governance', () => {
  let db: Database;
  let sqlite: ReturnType<typeof openDatabase>['sqlite'];
  let now: Date;
  let governance: GovernanceService;

  beforeEach(() => {
    const opened = openDatabase(':memory:');
    sqlite = opened.sqlite;
    db = opened.db;
    sqlite.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0004_governance.sql', 'utf8'));
    now = new Date('2026-01-01T00:00:00.000Z');
    governance = new GovernanceService(
      db,
      defaultPolicy(),
      () => now,
      async (principal) =>
        ({ person_c: 'person_same', person_b: 'person_same' })[principal] ?? principal,
    );
  });

  afterEach(() => sqlite.close());

  const payload = (overrides: Partial<ProposalPayload> = {}): ProposalPayload => ({
    proposal_type: 'rule_change',
    title: '更新审核规则',
    background: '现行规则需要在下一周期复核',
    change: '把规则更新日写入版本化政策',
    affected_objects: ['rule_demo'],
    current_policy_version: 'wfd-gov-1-0',
    proposed_policy_version: 'wfd-gov-1-1',
    risk: '可能需要重新审核部分资料',
    recusal_refs: [],
    cost_summary: '由维护者安排',
    execution_steps: ['发布新政策', '安排复核'],
    rollback_steps: ['恢复上一政策'],
    public_summary: '公开说明规则版本变化',
    discussion_days: 1,
    voting_days: 1,
    timelock_days: 2,
    ...overrides,
  });

  const proposalInput = (overrides: Partial<ProposalPayload> = {}) => ({
    ...payload(overrides),
    proposer_principal_id: 'person_a',
    policy_version: 'wfd-gov-1-0',
    idempotency_key: 'governance-idempotency-a',
  });

  it('freezes mature voters once and never implements mature P1 ballots in P0', () => {
    const members = freezeElectorate(
      [
        {
          principal_id: 'person_a',
          key_id: 'key_a',
          eligible: true,
          matured_at: '2025-11-01T00:00:00.000Z',
        },
        {
          principal_id: 'person_a',
          key_id: 'key_a-rotated',
          eligible: true,
          matured_at: '2025-11-01T00:00:00.000Z',
        },
        {
          principal_id: 'person_b',
          key_id: 'key_b',
          eligible: true,
          matured_at: '2025-12-15T00:00:00.000Z',
        },
      ],
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(members.map((member) => member.principal_id)).toEqual(['person_a']);
    expect(
      evaluateSpecialVote({ electorate: 9, yes: 5, no: 0, abstain: 0, participation: 5 }).status,
    ).toBe('not_applicable');
  });

  it('requires two distinct people, timelocks the passed proposal, and preserves revisions', async () => {
    const created = await governance.createProposal(proposalInput());
    const discussing = await governance.startDiscussion(created.id, 'person_a', 1, []);
    expect(discussing.state).toBe('discussion');
    const first = await governance.approveProposal(
      discussing.id,
      'person_b',
      discussing.revision,
      'approve',
    );
    expect(first.proposal.state).toBe('discussion');
    await expect(
      governance.approveProposal(first.proposal.id, 'person_c', first.proposal.revision, 'approve'),
    ).rejects.toThrow('SAME_PERSON_NOT_INDEPENDENT');
    const second = await governance.approveProposal(
      first.proposal.id,
      'person_d',
      first.proposal.revision,
      'approve',
    );
    expect(second.proposal.state).toBe('timelocked');
    expect(second.proposal.timelock_until).toBe('2026-01-03T00:00:00.000Z');
    expect(
      await db.all('SELECT * FROM governance_committee_approvals WHERE proposal_id=?', [
        created.id,
      ]),
    ).toHaveLength(2);
    await expect(
      governance.makeReady(created.id, 'person_d', second.proposal.revision),
    ).rejects.toThrow('TIMELOCK_NOT_ELAPSED');
    now = new Date('2026-01-03T00:00:00.000Z');
    const ready = await governance.makeReady(created.id, 'person_d', second.proposal.revision);
    expect(ready.state).toBe('ready_to_execute');
  });

  it('requires an execution adapter and returns idempotent result only after adapter confirmation', async () => {
    const created = await governance.createProposal({
      ...proposalInput(),
      idempotency_key: 'governance-idempotency-b',
    });
    const discussing = await governance.startDiscussion(created.id, 'person_a', 1, []);
    const first = await governance.approveProposal(
      discussing.id,
      'person_b',
      discussing.revision,
      'approve',
    );
    const second = await governance.approveProposal(
      first.proposal.id,
      'person_d',
      first.proposal.revision,
      'approve',
    );
    now = new Date('2026-01-03T00:00:00.000Z');
    const ready = await governance.makeReady(created.id, 'person_d', second.proposal.revision);
    await expect(
      governance.execute(created.id, 'person_d', ready.revision, 'execution-a', undefined as never),
    ).rejects.toThrow('GOVERNANCE_EXECUTOR_UNAVAILABLE');
    const executed = await governance.execute(
      created.id,
      'person_d',
      ready.revision,
      'execution-a',
      {
        execute: async (input) => {
          expect(input.payload_digest).toHaveLength(64);
          return { status: 'executed' as const, result: { applied: true } };
        },
      },
    );
    expect(executed.state).toBe('executed');
    const replay = await governance.execute(created.id, 'person_d', 999, 'execution-a', {
      execute: async () => ({ status: 'executed' as const }),
    });
    expect(replay.replayed).toBe(true);
  });

  it('marks failed execution separately and only allows explicit retry', async () => {
    const created = await governance.createProposal({
      ...proposalInput(),
      idempotency_key: 'governance-idempotency-c',
    });
    const discussing = await governance.startDiscussion(created.id, 'person_a', 1, []);
    const first = await governance.approveProposal(
      discussing.id,
      'person_b',
      discussing.revision,
      'approve',
    );
    const second = await governance.approveProposal(
      first.proposal.id,
      'person_d',
      first.proposal.revision,
      'approve',
    );
    now = new Date('2026-01-03T00:00:00.000Z');
    const ready = await governance.makeReady(created.id, 'person_d', second.proposal.revision);
    const failed = await governance.execute(
      created.id,
      'person_d',
      ready.revision,
      'execution-fail',
      {
        execute: async () => ({ status: 'failed' as const, reason: '目标版本已改变' }),
      },
    );
    expect(failed.state).toBe('failed');
    const retried = await governance.retryFailed(created.id, 'person_d', failed.revision);
    expect(retried.state).toBe('ready_to_execute');
  });

  it('rejects mature community special voting at the P0 service boundary', async () => {
    const created = await governance.createProposal({
      ...proposalInput({ proposal_type: 'community_special' }),
      idempotency_key: 'governance-idempotency-d',
    });
    const discussing = await governance.startDiscussion(created.id, 'person_a', 1, []);
    await expect(
      governance.openVoting(discussing.id, 'person_a', discussing.revision),
    ).rejects.toThrow('P1_MATURE_GOVERNANCE_DISABLED');
  });
});
