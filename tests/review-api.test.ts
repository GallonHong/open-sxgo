import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '../packages/protocol/src/private';
import { createReviewRoutes, reviewRoutes } from '../apps/api/src/review';
import {
  type AssignmentProvider,
  type CaseAssignment,
  type ReviewAuthorization,
} from '../packages/review-workflow/src/index';
import { EvidenceGatewayService, staticSourcePolicy } from '../packages/evidence-gateway/src/index';
import {
  resolveIdentity,
  grantScopeSchema,
  type GrantScope,
} from '../packages/identity-permissions/src/index';
import { testDatabase } from './support/database';

const future = '2026-12-31T00:00:00.000Z';
const origin = 'https://admin.example';
const now = new Date('2026-09-12T00:00:00.000Z');

class Assignments implements AssignmentProvider {
  readonly rows: CaseAssignment[] = [];

  async find(input: {
    assignment_id: string;
    case_id: string;
    case_revision: number;
    person_id: string;
    stage?: 'primary' | 'secondary' | 'escalation';
  }) {
    return (
      this.rows.find(
        (row) =>
          row.assignment_id === input.assignment_id &&
          row.case_id === input.case_id &&
          row.case_revision === input.case_revision &&
          row.reviewer_person_id === input.person_id &&
          (!input.stage || row.stage === input.stage),
      ) ?? null
    );
  }

  async listForPerson(input: { case_id?: string; case_revision?: number; person_id: string }) {
    return this.rows.filter(
      (row) =>
        row.reviewer_person_id === input.person_id &&
        (!input.case_id || row.case_id === input.case_id) &&
        (input.case_revision === undefined || row.case_revision === input.case_revision),
    );
  }
}

function principal(personId: string, mfa = true): Principal {
  return {
    user_id: 'user_' + personId,
    session_id: 'session_' + personId,
    person_id: personId,
    roles: ['reviewer'],
    company_ids: [],
    conflicts: [],
    verified: true,
    two_factor: mfa,
  };
}

function authorization(
  personId: string,
  requested: ReviewAuthorization['capability'],
): ReviewAuthorization {
  return {
    principal_id: 'principal_' + personId,
    person_id: personId,
    grant_id: 'grant_' + personId,
    capability: requested,
    expires_at: future,
  };
}

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

function assignment(
  id: string,
  caseId: string,
  personId: string,
  stage: 'primary' | 'secondary',
): CaseAssignment {
  return {
    assignment_id: id,
    case_id: caseId,
    case_revision: 1,
    reviewer_person_id: personId,
    stage,
    state: 'active',
    expires_at: future,
  };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function seedPreview(db: Awaited<ReturnType<typeof testDatabase>>['db']) {
  const timestamp = new Date('2026-09-12T00:00:00.000Z').toISOString();
  await db.batch([
    {
      sql: 'INSERT INTO source_fetch_jobs(id,case_id,case_revision,source_id,source_url,policy_version,state,attempt_count,redirect_count,error_code,preview_id,assignment_id,grant_id,claim_token,idempotency_key,request_hash,revision,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      params: [
        'job_api_preview',
        'case_api',
        1,
        'source_api',
        'https://example.org/policy',
        'wfd-fetch-static-1.0',
        'sanitized_preview_ready',
        1,
        0,
        null,
        'preview_api',
        null,
        'grant_source_api',
        null,
        'fixture-api-preview',
        'c'.repeat(64),
        2,
        timestamp,
        timestamp,
        future,
      ],
    },
    {
      sql: 'INSERT INTO sanitized_previews(id,job_id,source_id,case_id,case_revision,state,display_domain,final_domain,fetch_policy,redirect_count,threat_intelligence,source_authenticity,text_ref,text_content,image_ref,raw_html_available_to_reviewer,public_destination_enforced,network_egress_policy_enforced,login_required,download_attempted,output_hash,captured_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      params: [
        'preview_api',
        'job_api_preview',
        'source_api',
        'case_api',
        1,
        'sanitized_preview_ready',
        'example.org',
        'example.org',
        'wfd-fetch-static-1.0',
        0,
        'not_checked',
        'unverified',
        'preview_api_text',
        '候选来源文本',
        null,
        0,
        1,
        1,
        0,
        0,
        'd'.repeat(64),
        timestamp,
        future,
        timestamp,
      ],
    },
  ]);
}

async function seedRealSourceReviewer(db: Awaited<ReturnType<typeof testDatabase>>['db']) {
  const at = now.toISOString();
  const sessionExpires = '2026-12-31T00:00:00.000Z';
  const sessionAt = Date.now();
  const scope = { ...emptyScope(), case_ids: ['case_api'] };
  grantScopeSchema.parse(scope);
  await db.batch([
    {
      sql: 'INSERT INTO review_cases(id,submission_id,current_revision,state,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      params: ['case_api', 'submission_case_api', 1, 'open', at, at],
    },
    {
      sql: 'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
      params: [
        'user_source_real',
        'Real source reviewer',
        'source-real@example.invalid',
        1,
        sessionAt,
        sessionAt,
      ],
    },
    {
      sql: 'INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
      params: [
        'session_source_real',
        Date.parse(sessionExpires),
        'token-source-real',
        sessionAt,
        sessionAt,
        'user_source_real',
      ],
    },
    {
      sql: 'INSERT INTO principal_identities(principal_id,person_id,status,privacy_preferences,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      params: ['principal_source_real', 'person_source_real', 'active', '{}', at, at],
    },
    {
      sql: 'INSERT INTO principal_accounts(user_id,principal_id,status,linked_at,linked_by,account_revision) VALUES(?,?,?,?,?,?)',
      params: ['user_source_real', 'principal_source_real', 'active', at, 'staff', 1],
    },
    {
      sql: `INSERT INTO role_grants
        (grant_id,principal_id,person_id,role,capabilities,scope,issued_at,not_before,expires_at,policy_version,approval_ref,grant_revision,status,revocation_status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        'grant_source_real',
        'principal_source_real',
        'person_source_real',
        'reviewer',
        JSON.stringify(['case.read_public_source']),
        JSON.stringify(scope),
        at,
        at,
        sessionExpires,
        'policy-test-1',
        'approval-test-source',
        1,
        'active',
        'not_revoked',
        at,
        at,
      ],
    },
    {
      sql: `INSERT INTO session_assurance
        (assurance_id,session_id,user_id,method,assurance,challenge_id,verified_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`,
      params: [
        'assurance_source_real',
        'session_source_real',
        'user_source_real',
        'webauthn',
        'webauthn_step_up',
        'challenge_source_real',
        at,
        sessionExpires,
      ],
    },
    {
      sql: `INSERT INTO case_assignments
        (assignment_id,case_id,candidate_revision,stage,principal_id,person_id,grant_id,conflict_snapshot,status,assigned_at,expires_at,assignment_revision)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        'assignment_source_real',
        'case_api',
        1,
        'primary',
        'principal_source_real',
        'person_source_real',
        'grant_source_real',
        'clear',
        'assigned',
        at,
        sessionExpires,
        1,
      ],
    },
  ]);
}

for (const adapter of ['sqlite', 'd1'] as const)
  describe(adapter + ' review API', () => {
    let fixture: Awaited<ReturnType<typeof testDatabase>> | undefined;
    let current = principal('person_prepare');

    afterEach(async () => {
      await fixture?.close();
      fixture = undefined;
    });

    function app(assignments: Assignments, source = false) {
      return reviewRoutes(fixture!.db, async () => current, {
        review_enabled: true,
        source_fetch_enabled: source,
        assignments,
        resolve_review_authorization: async (_principal, context) =>
          authorization(current.person_id, context.capability),
        resolve_source_authorization: async (_principal, context) => ({
          principal_id: 'principal_' + current.person_id,
          grant_id: 'grant_' + current.person_id,
          capability: context.capability,
          case_id: context.case_id,
          case_revision: context.case_revision,
          assignment_id: context.assignment_id,
          expires_at: future,
        }),
        authorize_review: async () => undefined,
        evidence_gateway: source
          ? new EvidenceGatewayService(fixture!.db, {
              policy: staticSourcePolicy(['example.org']),
              authorize: async () => undefined,
              now: () => now,
            })
          : undefined,
      });
    }

    async function post(
      application: ReturnType<typeof reviewRoutes>,
      path: string,
      payload: unknown,
    ) {
      return application.request(path, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    it('从初稿、绑定净化预览到双审，服务端按 session person 选 assignment', async () => {
      fixture = await testDatabase(adapter);
      const assignments = new Assignments();
      const application = app(assignments);
      const created = await post(application, '/cases', {
        case_id: 'case_api',
        submission_id: 'submission_api',
        candidate: { title: '公开候选', scope: '研发' },
        source_preview_ids: [],
        reason: '创建初稿',
      });
      expect(created.status).toBe(201);
      await seedPreview(fixture.db);
      const bound = await post(application, '/cases/case_api/previews', {
        expected_revision: 1,
        source_preview_ids: ['preview_api'],
        reason: '绑定来源处理结果',
      });
      expect(bound.status).toBe(200);

      assignments.rows.push(
        assignment('assignment_primary_api', 'case_api', 'person_primary', 'primary'),
        assignment('assignment_secondary_api', 'case_api', 'person_secondary', 'secondary'),
      );
      current = principal('person_primary');
      const queue = await application.request('/cases');
      expect(queue.status).toBe(200);
      expect((await json<{ items: unknown[] }>(queue)).items).toEqual([
        expect.objectContaining({ assignment_id: 'assignment_primary_api', stage: 'initial' }),
      ]);
      const initial = await application.request('/cases/case_api?stage=initial');
      expect(initial.status).toBe(200);
      const initialBody = await json<{ candidate_digest: string }>(initial);
      const approved = await post(application, '/cases/case_api/decision', {
        revision: 1,
        candidate_digest: initialBody.candidate_digest,
        action: 'approve',
        reason: '初审通过',
      });
      expect(approved.status).toBe(200);

      current = principal('person_secondary');
      const independent = await application.request('/cases/case_api?stage=independent');
      expect(independent.status).toBe(200);
      const independentBody = await json<{
        candidate_digest: string;
        decision_visibility: string;
        decisions: unknown[];
      }>(independent);
      expect(independentBody.decision_visibility).toBe('blind');
      expect(independentBody.decisions).toHaveLength(0);
      const final = await post(application, '/cases/case_api/decision', {
        revision: 1,
        candidate_digest: independentBody.candidate_digest,
        action: 'approve',
        reason: '独立复核通过',
      });
      expect(final.status).toBe(200);
      expect((await json<{ eligible: boolean }>(final)).eligible).toBe(true);
    });

    it('拒绝请求自带 actor/assignment 字段，缺少 MFA 也不能访问', async () => {
      fixture = await testDatabase(adapter);
      const assignments = new Assignments();
      const application = app(assignments);
      const forged = await post(application, '/cases', {
        case_id: 'case_forged',
        submission_id: 'submission_forged',
        candidate: { title: '候选' },
        source_preview_ids: [],
        reason: '测试',
        created_by_person: 'person_attacker',
      });
      expect(forged.status).toBe(400);
      current = principal('person_prepare', false);
      const noMfa = await post(application, '/cases', {
        case_id: 'case_no_mfa',
        submission_id: 'submission_no_mfa',
        candidate: { title: '候选' },
        source_preview_ids: [],
        reason: '测试',
      });
      expect(noMfa.status).toBe(403);
    });

    it('来源任务和预览必须绑定当前 person 的同版本 assignment，且隐藏对象存在性', async () => {
      fixture = await testDatabase(adapter);
      const assignments = new Assignments();
      await seedPreview(fixture.db);
      assignments.rows.push(
        assignment('assignment_source_api', 'case_api', 'person_source', 'primary'),
      );
      const application = app(assignments, true);

      current = principal('person_source');
      const allowedPreview = await application.request('/sources/previews/preview_api');
      expect(allowedPreview.status).toBe(200);
      expect((await json<{ text: string }>(allowedPreview)).text).toBe('候选来源文本');
      const allowedJob = await application.request('/sources/jobs/job_api_preview');
      expect(allowedJob.status).toBe(200);

      current = principal('person_unassigned');
      const deniedPreview = await application.request('/sources/previews/preview_api');
      const missingPreview = await application.request('/sources/previews/preview_missing');
      const deniedJob = await application.request('/sources/jobs/job_api_preview');
      const missingJob = await application.request('/sources/jobs/job_missing');
      expect(deniedPreview.status).toBe(404);
      expect(missingPreview.status).toBe(404);
      expect(deniedJob.status).toBe(404);
      expect(missingJob.status).toBe(404);
      expect(await deniedPreview.text()).toBe(await missingPreview.text());
      expect(await deniedJob.text()).toBe(await missingJob.text());
    });

    it('案件读取也统一现有和不存在对象的拒绝结果', async () => {
      fixture = await testDatabase(adapter);
      const assignments = new Assignments();
      const application = app(assignments);
      await post(application, '/cases', {
        case_id: 'case_visible_api',
        submission_id: 'submission_visible_api',
        candidate: { title: '候选' },
        source_preview_ids: [],
        reason: '创建案件',
      });

      current = principal('person_unassigned');
      const denied = await application.request('/cases/case_visible_api');
      const missing = await application.request('/cases/case_missing_api');
      expect(denied.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await denied.text()).toBe(await missing.text());
    });

    it('生产 identity 授权必须同时满足实时 session assurance 与同版本 assignment', async () => {
      fixture = await testDatabase(adapter);
      await seedPreview(fixture.db);
      await seedRealSourceReviewer(fixture.db);
      const application = createReviewRoutes(
        fixture.db,
        async (headers) => {
          const sessionId = headers.get('x-test-session-id');
          return sessionId
            ? resolveIdentity(fixture!.db, {
                user_id: 'user_source_real',
                session_id: sessionId,
                now,
              })
            : null;
        },
        {
          mode: 'production',
          reviewEnabled: true,
          sourceFetchEnabled: true,
          evidenceGateway: new EvidenceGatewayService(fixture.db, {
            policy: staticSourcePolicy(['example.org']),
            authorize: async () => undefined,
            now: () => now,
          }),
        },
      );
      const headers = { origin, 'x-test-session-id': 'session_source_real' };
      const allowed = await application.request('/sources/previews/preview_api', { headers });
      expect(allowed.status).toBe(200);

      await fixture.db.batch([
        {
          sql: "UPDATE case_assignments SET status='revoked' WHERE assignment_id=?",
          params: ['assignment_source_real'],
        },
      ]);
      const revokedAssignment = await application.request('/sources/previews/preview_api', {
        headers,
      });
      const unknownPreview = await application.request('/sources/previews/preview_missing', {
        headers,
      });
      expect(revokedAssignment.status).toBe(404);
      expect(await revokedAssignment.text()).toBe(await unknownPreview.text());
    });
  });
