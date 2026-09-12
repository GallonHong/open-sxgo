import { verifyPassword } from 'better-auth/crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountsRoutes } from '../apps/api/src/accounts';
import type { Database } from '../packages/db/src/adapter';
import {
  grantScopeSchema,
  resolveIdentity as resolveAuthorizedIdentity,
  type GrantScope,
} from '../packages/identity-permissions/src/index';
import { databaseAdapters, testDatabase } from './support/database';

const ORIGIN = 'https://admin.example.test';

const emptyScope = (): GrantScope => ({
  source_types: [],
  regions: [],
  labor_rule_fields: [],
  contribution_domains: [],
  contribution_ids: [],
  policy_ids: [],
  role_ids: ['reviewer'],
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

type Fixture = {
  db: Database;
  close: () => Promise<void>;
  app: Hono;
  actorUserId: string;
  actorPersonId: string;
  sessionId: string;
};

async function makeFixture(adapter: (typeof databaseAdapters)[number]): Promise<Fixture> {
  const opened = await testDatabase(adapter);
  const { db, close } = opened;
  const now = new Date();
  const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const actorUserId = `user_actor_${crypto.randomUUID().replaceAll('-', '')}`;
  const actorPrincipalId = `principal_actor_${crypto.randomUUID().replaceAll('-', '')}`;
  const actorPersonId = `person_actor_${crypto.randomUUID().replaceAll('-', '')}`;
  const sessionId = `session_actor_${crypto.randomUUID().replaceAll('-', '')}`;
  const grantId = `grant_actor_${crypto.randomUUID().replaceAll('-', '')}`;
  const scope = emptyScope();
  grantScopeSchema.parse(scope);

  await db.batch([
    {
      sql: 'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled) VALUES(?,?,?,?,?,?,?)',
      params: [
        actorUserId,
        'Account administrator',
        'official@gallonhong.com',
        1,
        now.getTime(),
        now.getTime(),
        1,
      ],
    },
    {
      sql: 'INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
      params: [
        sessionId,
        later.getTime(),
        `token_${sessionId}`,
        now.getTime(),
        now.getTime(),
        actorUserId,
      ],
    },
    {
      sql: `INSERT INTO principal_identities
        (principal_id,person_id,status,privacy_preferences,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`,
      params: [
        actorPrincipalId,
        actorPersonId,
        'active',
        '{}',
        now.toISOString(),
        now.toISOString(),
      ],
    },
    {
      sql: `INSERT INTO principal_accounts
        (user_id,principal_id,status,linked_at,linked_by,account_revision)
        VALUES(?,?,?,?,?,?)`,
      params: [
        actorUserId,
        actorPrincipalId,
        'active',
        now.toISOString(),
        'deployment-operator',
        1,
      ],
    },
    {
      sql: `INSERT INTO role_grants
        (grant_id,principal_id,person_id,role,capabilities,scope,issued_at,not_before,expires_at,policy_version,approval_ref,grant_revision,status,revocation_status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        grantId,
        actorPrincipalId,
        actorPersonId,
        'reviewer',
        JSON.stringify(['account.provision']),
        JSON.stringify(scope),
        now.toISOString(),
        now.toISOString(),
        later.toISOString(),
        'policy-test-1',
        'approval-test-1',
        1,
        'active',
        'not_revoked',
        now.toISOString(),
        now.toISOString(),
      ],
    },
    {
      sql: `INSERT INTO session_assurance
        (assurance_id,session_id,user_id,method,assurance,challenge_id,verified_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`,
      params: [
        `assurance_${sessionId}`,
        sessionId,
        actorUserId,
        'webauthn',
        'webauthn_step_up',
        `challenge_${sessionId}`,
        now.toISOString(),
        new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      ],
    },
  ]);

  const resolve = async (headers: Headers) => {
    if (headers.get('x-test-actor') !== 'admin') return null;
    return resolveAuthorizedIdentity(db, {
      user_id: actorUserId,
      session_id: sessionId,
    });
  };
  const app = new Hono();
  app.route('/admin/v1', createAccountsRoutes(db, resolve, ORIGIN));
  return { db, close, app, actorUserId, actorPersonId, sessionId };
}

function jsonHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    'x-test-actor': 'admin',
  };
}

function accountBody(
  email = 'reviewer@example.test',
  person_id = 'person_reviewer_01',
  name = '新审核员',
) {
  return JSON.stringify({ email, person_id, name });
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

for (const adapter of databaseAdapters) {
  describe(`account management (${adapter})`, () => {
    let fixture: Fixture;

    beforeEach(async () => {
      fixture = await makeFixture(adapter);
    });

    afterEach(async () => {
      await fixture?.close();
    });

    it('creates a pending reviewer account with a one-time initial password and complete transaction', async () => {
      const response = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: accountBody(),
      });
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const result = await responseJson(response);
      expect(result.email).toBe('reviewer@example.test');
      expect(result.initial_password).toMatch(/^[A-Za-z0-9_-]{40,}$/);

      const user = await fixture.db.all<{
        id: string;
        name: string;
        email: string;
        emailVerified: number;
        twoFactorEnabled: number;
      }>('SELECT id,name,email,emailVerified,twoFactorEnabled FROM user WHERE email=?', [
        'reviewer@example.test',
      ]);
      expect(user).toHaveLength(1);
      expect(user[0]).toMatchObject({
        name: '新审核员',
        emailVerified: fixture.db.dialect === 'postgres' ? false : 0,
        twoFactorEnabled: fixture.db.dialect === 'postgres' ? false : 0,
      });

      const account = await fixture.db.all<{
        id: string;
        accountId: string;
        providerId: string;
        userId: string;
        password: string;
      }>('SELECT id,accountId,providerId,userId,password FROM account WHERE userId=?', [
        user[0]!.id,
      ]);
      expect(account).toHaveLength(1);
      expect(account[0]).toMatchObject({
        accountId: user[0]!.id,
        providerId: 'credential',
        userId: user[0]!.id,
      });
      expect(account[0]!.password).not.toBe(result.initial_password);
      expect(
        await verifyPassword({ hash: account[0]!.password, password: result.initial_password }),
      ).toBe(true);

      const [identity] = await fixture.db.all<{
        principal_id: string;
        person_id: string;
        status: string;
      }>('SELECT principal_id,person_id,status FROM principal_identities WHERE person_id=?', [
        'person_reviewer_01',
      ]);
      expect(identity).toMatchObject({ person_id: 'person_reviewer_01', status: 'pending' });
      const [binding] = await fixture.db.all<{
        user_id: string;
        principal_id: string;
        status: string;
        linked_by: string;
      }>('SELECT user_id,principal_id,status,linked_by FROM principal_accounts WHERE user_id=?', [
        user[0]!.id,
      ]);
      expect(binding).toMatchObject({
        user_id: user[0]!.id,
        principal_id: identity!.principal_id,
        status: 'pending',
        linked_by: fixture.actorPersonId,
      });
      expect(
        await fixture.db.all('SELECT grant_id FROM role_grants WHERE principal_id=?', [
          identity!.principal_id,
        ]),
      ).toEqual([]);
      expect(
        await fixture.db.all('SELECT user_id FROM principals WHERE user_id=?', [user[0]!.id]),
      ).toEqual([]);

      const [audit] = await fixture.db.all<{
        item_id: string;
        actor: string;
        action: string;
        reason: string;
      }>('SELECT item_id,actor,action,reason FROM audit WHERE item_id=?', [identity!.principal_id]);
      expect(audit).toMatchObject({
        item_id: identity!.principal_id,
        actor: fixture.actorPersonId,
        action: 'account.provision',
      });
      expect(JSON.parse(audit!.reason)).toMatchObject({
        email: 'reviewer@example.test',
        person_id: 'person_reviewer_01',
        role: 'reviewer',
        status: 'pending',
      });
      expect(audit!.reason).not.toContain(result.initial_password);

      const listing = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
        headers: { 'x-test-actor': 'admin' },
      });
      expect(listing.status).toBe(200);
      const listed = await responseJson(listing);
      expect(listed.items).toContainEqual({
        user_id: user[0]!.id,
        email: 'reviewer@example.test',
        name: '新审核员',
        principal_id: identity!.principal_id,
        person_id: 'person_reviewer_01',
        account_status: 'pending',
        person_status: 'pending',
      });
      expect(JSON.stringify(listed)).not.toContain('initial_password');
    });

    it('rejects unauthenticated, unauthorized, missing-TOTP, stale-step-up, and pending actors', async () => {
      const unauthenticated = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`);
      expect(unauthenticated.status).toBe(401);

      // Use the actor's exact principal id without exposing it in the route.
      const [actorBinding] = await fixture.db.all<{ principal_id: string }>(
        'SELECT principal_id FROM principal_accounts WHERE user_id=?',
        [fixture.actorUserId],
      );
      await fixture.db.batch([
        {
          sql: 'UPDATE role_grants SET capabilities=? WHERE principal_id=?',
          params: [JSON.stringify(['case.submit_decision']), actorBinding!.principal_id],
        },
      ]);
      const unauthorized = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
        headers: { 'x-test-actor': 'admin' },
      });
      expect(unauthorized.status).toBe(403);
      expect((await responseJson(unauthorized)).error.code).toBe('CAPABILITY_DENIED');

      await fixture.db.batch([
        {
          sql: 'UPDATE role_grants SET capabilities=? WHERE principal_id=?',
          params: [JSON.stringify(['account.provision']), actorBinding!.principal_id],
        },
      ]);
      await fixture.db.batch([
        {
          sql: 'UPDATE user SET twoFactorEnabled=? WHERE id=?',
          params: [0, fixture.actorUserId],
        },
      ]);
      const mfaMissing = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
        headers: { 'x-test-actor': 'admin' },
      });
      expect(mfaMissing.status).toBe(403);
      expect((await responseJson(mfaMissing)).error.code).toBe('MFA_SETUP_REQUIRED');

      await fixture.db
        .batch([
          {
            sql: 'UPDATE user SET twoFactorEnabled=? WHERE id=?',
            params: [1, fixture.actorUserId],
          },
          {
            sql: 'DELETE FROM session_assurance WHERE session_id=?',
            params: [fixture.sessionId],
          },
        ])
        .catch(() => undefined);
      const noProof = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
        headers: { 'x-test-actor': 'admin' },
      });
      expect(noProof.status).toBe(403);
      expect((await responseJson(noProof)).error.code).toBe('WEBAUTHN_STEP_UP_REQUIRED');

      await fixture.db.batch([
        {
          sql: `INSERT INTO session_assurance
            (assurance_id,session_id,user_id,method,assurance,challenge_id,verified_at,expires_at)
            VALUES(?,?,?,?,?,?,?,?)`,
          params: [
            `assurance_restored_${fixture.sessionId}`,
            fixture.sessionId,
            fixture.actorUserId,
            'webauthn',
            'webauthn_step_up',
            `challenge_restored_${fixture.sessionId}`,
            new Date().toISOString(),
            new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          ],
        },
        {
          sql: 'UPDATE principal_accounts SET status=? WHERE user_id=?',
          params: ['pending', fixture.actorUserId],
        },
      ]);
      const pending = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
        headers: { 'x-test-actor': 'admin' },
      });
      expect(pending.status).toBe(401);
    });

    it('enforces same-origin POSTs and the 8 KiB request boundary', async () => {
      const wrongOrigin = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
        method: 'POST',
        headers: { ...jsonHeaders(), Origin: 'https://attacker.example.test' },
        body: accountBody(),
      });
      expect(wrongOrigin.status).toBe(403);

      const oversized = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          email: 'reviewer@example.test',
          person_id: 'person_reviewer_01',
          name: 'x'.repeat(9000),
        }),
      });
      expect(oversized.status).toBe(413);
      expect(oversized.headers.get('cache-control')).toBe('no-store');
    });

    it('rejects duplicate email and personnel identity with 409 without creating another row', async () => {
      const first = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: accountBody(),
      });
      expect(first.status).toBe(201);

      const duplicateEmail = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: accountBody('REVIEWER@example.test', 'person_other_02', '另一个人'),
      });
      expect(duplicateEmail.status).toBe(409);
      expect((await responseJson(duplicateEmail)).error.code).toBe('EMAIL_ALREADY_EXISTS');

      const duplicatePerson = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: accountBody('other@example.test', 'person_reviewer_01', '另一个人'),
      });
      expect(duplicatePerson.status).toBe(409);
      expect((await responseJson(duplicatePerson)).error.code).toBe('PERSON_ALREADY_EXISTS');

      expect(await fixture.db.all<{ count: number }>('SELECT COUNT(*) AS count FROM user')).toEqual(
        [{ count: 2 }],
      );
    });

    it('permits only one concurrent account for the same person', async () => {
      const responses = await Promise.all(
        ['first', 'second'].map((label) =>
          fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
            method: 'POST',
            headers: jsonHeaders(),
            body: accountBody(`${label}@example.test`, 'person_concurrent_01', '并发测试'),
          }),
        ),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(
        await fixture.db.all('SELECT principal_id FROM principal_identities WHERE person_id=?', [
          'person_concurrent_01',
        ]),
      ).toHaveLength(1);
    });

    it('rolls back account, identity, and binding when the audit write fails', async () => {
      await fixture.db.batch([
        { sql: 'DROP TABLE audit' },
        { sql: 'CREATE TABLE audit (id TEXT CHECK (0=1))' },
      ]);
      const failed = await fixture.app.request(`${ORIGIN}/admin/v1/accounts`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: accountBody('rollback@example.test', 'person_rollback_01', '回滚测试'),
      });
      expect(failed.status).toBe(503);
      expect(
        await fixture.db.all('SELECT id FROM user WHERE email=?', ['rollback@example.test']),
      ).toEqual([]);
      expect(
        await fixture.db.all('SELECT principal_id FROM principal_identities WHERE person_id=?', [
          'person_rollback_01',
        ]),
      ).toEqual([]);
      expect(await fixture.db.all('SELECT user_id FROM principal_accounts')).toHaveLength(1);
    });
  });
}
