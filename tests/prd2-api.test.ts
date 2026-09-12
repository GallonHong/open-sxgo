import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { testDatabase, databaseAdapters } from './support/database';
import { createApp } from '../apps/api/src/app';
import type { Principal } from '../packages/protocol/src/private';
const origin = 'https://admin.example';
const current: Principal = {
  user_id: 'user_member',
  session_id: 'session_member',
  person_id: 'person_member',
  roles: ['governor', 'reviewer'],
  company_ids: ['*'],
  conflicts: [],
  verified: true,
  two_factor: true,
};
for (const adapter of databaseAdapters)
  describe(adapter + ' PRD2 interface boundaries', () => {
    let fixture: Awaited<ReturnType<typeof testDatabase>>;
    beforeEach(async () => {
      fixture = await testDatabase(adapter);
      const now = Date.now();
      await fixture.db.batch([
        {
          sql: 'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
          params: [current.user_id, 'Fictional member', 'member@example.invalid', 1, now, now],
        },
        {
          sql: 'INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
          params: [
            current.session_id,
            now + 3600000,
            'test-session-only',
            now,
            now,
            current.user_id,
          ],
        },
        {
          sql: 'INSERT INTO principal_identities(principal_id,person_id,status,created_at,updated_at) VALUES(?,?,?,?,?)',
          params: [
            'principal_member01',
            current.person_id,
            'active',
            new Date(now).toISOString(),
            new Date(now).toISOString(),
          ],
        },
        {
          sql: 'INSERT INTO principal_accounts(user_id,principal_id,status,linked_at,linked_by) VALUES(?,?,?,?,?)',
          params: [
            current.user_id,
            'principal_member01',
            'active',
            new Date(now).toISOString(),
            'fixture_registrar',
          ],
        },
      ]);
    });
    afterEach(async () => {
      await fixture?.close();
    });
    function app(mode: 'demo' | 'production' = 'demo', authenticated = true, intakeEnabled = true) {
      return createApp(
        fixture.db,
        {
          mode,
          intakeEnabled,
          promotionEnabled: false,
          productionReleaseEnabled: false,
          origins: [origin],
          rateSecret: 'fixture-rate',
        },
        async () => (authenticated ? current : null),
      );
    }
    function post(path: string, value: unknown, key = crypto.randomUUID()) {
      return {
        path,
        init: {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify(value),
        },
      };
    }
    it('legacy roles cannot access new privileged endpoints; production legacy endpoints are closed', async () => {
      const call = post('/admin/v1/roles/grant_unknown/suspend', {
        expected_revision: 1,
        incident_id: 'incident_example',
        reason: 'test',
      });
      expect((await app().request(call.path, call.init)).status).toBe(403);
      expect((await app('production').request('/admin/v1/work-items')).status).toBe(403);
      expect((await app('production').request('/health')).status).toBe(200);
    });
    it('member creation is authenticated, scoped and idempotent without accepting a supplied actor', async () => {
      const input = {
        domain: 'data',
        work_type: '资料核对',
        subject_ref: 'fictional-company',
        scope_ref: '研发',
        fact_cycle: '2026-09',
        source_family: 'source-family-1',
        work_fingerprint: '核对休息安排',
        source_ref: 'https://example.invalid/reference?token=PRIVATE_REFERENCE_CANARY',
      };
      const call = post('/private/v1/contributions', input);
      const first = await app().request(call.path, call.init);
      expect(first.status).toBe(201);
      const responseBody = await first.text();
      expect(responseBody).not.toMatch(
        /PRIVATE_REFERENCE_CANARY|source_ref|request_hash|idempotency_key|principal_id|contribution_cluster_id/,
      );
      const listing = await app().request('/private/v1/contributions/mine');
      expect(await listing.text()).not.toMatch(
        /PRIVATE_REFERENCE_CANARY|source_ref|request_hash|idempotency_key|principal_id|contribution_cluster_id/,
      );
      expect((await app().request(call.path, call.init)).status).toBe(201);
      const changed = post(
        call.path,
        { ...input, scope_ref: 'different' },
        call.init.headers['idempotency-key'],
      );
      expect((await app().request(changed.path, changed.init)).status).toBe(409);
      const forged = post(call.path, { ...input, principal_id: 'principal_other01' });
      expect((await app().request(forged.path, forged.init)).status).toBe(400);
      expect((await app('demo', false).request(call.path, call.init)).status).toBe(401);
      expect((await fixture.db.all('SELECT * FROM contributions')).length).toBe(1);
    });
    it('P1 evidence remains closed and credentials in URLs are refused', async () => {
      const call = post('/admin/v1/evidence/unknown/access', {});
      expect((await app().request(call.path, call.init)).status).toBe(403);
      expect((await app().request('/private/v1/member?receipt=canary')).status).toBe(400);
    });
    it('pausing anonymous intake leaves authenticated member work and withdrawal requests reachable', async () => {
      const paused = app('demo', true, false);
      const submission = post('/private/v1/submissions', {});
      expect((await paused.request(submission.path, submission.init)).status).toBe(503);
      const member = post('/private/v1/contributions', {
        domain: 'data',
        work_type: '核对',
        subject_ref: 'fictional',
        scope_ref: 'scope',
        fact_cycle: '2026-09',
        source_family: 'family',
        work_fingerprint: 'check',
      });
      expect((await paused.request(member.path, member.init)).status).toBe(201);
      const withdrawal = post('/private/v1/submissions/withdraw', {});
      const response = await paused.request(withdrawal.path, withdrawal.init);
      expect(response.status).not.toBe(503);
      expect(await response.text()).not.toContain('INTAKE_PAUSED');
    });
  });
