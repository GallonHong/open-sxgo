import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../packages/db/src/node';
import type { Database } from '../packages/db/src/adapter';
import type { Identity } from '../packages/identity-permissions/src';
import { authorize, resolveIdentity } from '../packages/identity-permissions/src';
import { ContributionLedger } from '../packages/contribution-ledger/src';
import { GovernanceService, defaultPolicy } from '../packages/governance-policy/src';
import {
  createGovernanceActionsRouter,
  governanceActionsRoutes,
} from '../apps/api/src/governance-actions';

describe('P0 governance action routes', () => {
  let db: Database;
  let sqlite: ReturnType<typeof openDatabase>['sqlite'];
  let governance: GovernanceService;
  let ledger: ContributionLedger;
  const identity: Identity = {
    user_id: 'user_demo',
    principal_id: 'principal_session',
    person_id: 'person_session',
    status: 'active',
    session_id: 'session_demo',
    assurance: 'basic',
    assurance_expires_at: null,
    grants: [],
  };

  beforeEach(() => {
    const opened = openDatabase(':memory:');
    sqlite = opened.sqlite;
    db = opened.db;
    sqlite.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0002_identity.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0004_governance.sql', 'utf8'));
    governance = new GovernanceService(
      db,
      defaultPolicy(),
      () => new Date('2026-01-01T00:00:00.000Z'),
    );
    ledger = new ContributionLedger(
      db,
      defaultPolicy(),
      () => new Date('2026-01-01T00:00:00.000Z'),
    );
  });

  afterEach(() => sqlite.close());

  function router() {
    return createGovernanceActionsRouter({
      governance,
      ledger,
      resolveIdentity: async () => identity,
      authorize: async () => ({ allowed: true }),
    });
  }

  const payload = {
    proposal_type: 'rule_change',
    title: '更新审核规则',
    background: '现行规则需要复核',
    change: '将复核日期写入政策版本',
    affected_objects: ['rule_demo'],
    current_policy_version: 'wfd-gov-1-0',
    proposed_policy_version: 'wfd-gov-1-1',
    risk: '部分资料需要重新确认',
    recusal_refs: [],
    cost_summary: '由维护者安排',
    execution_steps: ['发布新版本'],
    rollback_steps: ['恢复旧版本'],
    public_summary: '规则版本更新',
    discussion_days: 1,
    voting_days: 1,
    timelock_days: 1,
  };

  it('resolves proposer from the session and rejects actor fields', async () => {
    const app = router();
    const invalid = await app.request('http://localhost/admin/v1/governance/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'governance-route-key-a' },
      body: JSON.stringify({ ...payload, proposer_principal_id: 'attacker' }),
    });
    expect(invalid.status).toBe(400);

    const response = await app.request('http://localhost/admin/v1/governance/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'governance-route-key-b' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { proposer_principal_id: string };
    expect(created.proposer_principal_id).toBe(identity.principal_id);
  });

  it('does not accept caller supplied execution result or appeal assessors', async () => {
    const app = router();
    const execute = await app.request(
      'http://localhost/admin/v1/governance/proposals/gov_demo/execute',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expected_revision: 1,
          execution_id: 'execution_demo',
          succeeded: true,
          result: { applied: true },
        }),
      },
    );
    expect(execute.status).toBe(400);

    const appeal = await app.request('http://localhost/admin/v1/appeals/appeal_demo/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expected_revision: 1,
        decision: 'confirm',
        reason: '复核完成',
        assessor_principal_ids: ['attacker', 'attacker2'],
      }),
    });
    expect(appeal.status).toBe(400);
  });

  it('returns authentication failure before parsing an object identifier', async () => {
    const app = createGovernanceActionsRouter({
      governance,
      ledger,
      resolveIdentity: async () => null,
      authorize: async () => ({ allowed: true }),
    });
    const response = await app.request(
      'http://localhost/admin/v1/governance/proposals/not-a-valid-id!',
    );
    expect(response.status).toBe(401);
  });

  it('wires the factory to the real session and scope authorizer', async () => {
    const now = new Date();
    const at = now.toISOString();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    await db.batch([
      {
        sql: 'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
        params: [
          'user_real_auth',
          'Real Auth',
          'real-auth@example.org',
          1,
          now.getTime(),
          now.getTime(),
        ],
      },
      {
        sql: 'INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
        params: [
          'session_real_auth',
          now.getTime() + 60 * 60 * 1000,
          'token-real-auth',
          now.getTime(),
          now.getTime(),
          'user_real_auth',
        ],
      },
      {
        sql: 'INSERT INTO principal_identities(principal_id,person_id,status,privacy_preferences,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        params: ['principal_real_auth', 'person_real_auth', 'active', '{}', at, at],
      },
      {
        sql: 'INSERT INTO principal_accounts(user_id,principal_id,status,linked_at,linked_by,account_revision) VALUES(?,?,?,?,?,?)',
        params: ['user_real_auth', 'principal_real_auth', 'active', at, 'staff', 1],
      },
      {
        sql: `INSERT INTO role_grants
          (grant_id,principal_id,person_id,role,capabilities,scope,issued_at,not_before,expires_at,policy_version,approval_ref,grant_revision,status,revocation_status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [
          'grant_real_auth_1',
          'principal_real_auth',
          'person_real_auth',
          'reviewer',
          JSON.stringify(['governance.propose']),
          JSON.stringify({ policy_ids: ['wfd-gov-1-0'] }),
          at,
          at,
          expiresAt,
          'wfd-gov-1-0',
          'approval_real_auth',
          1,
          'active',
          'not_revoked',
          at,
          at,
        ],
      },
    ]);
    const sessionIdentity = await resolveIdentity(db, {
      user_id: 'user_real_auth',
      session_id: 'session_real_auth',
      now,
    });
    expect(sessionIdentity).not.toBeNull();
    const app = governanceActionsRoutes(db, async () => sessionIdentity, {
      authorize: async (current, input) => authorize(db, current, input),
    });
    const response = await app.request('http://localhost/admin/v1/governance/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'real-auth-route-key' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { proposer_principal_id: string };
    expect(created.proposer_principal_id).toBe('principal_real_auth');
  });
});
