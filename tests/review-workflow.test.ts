import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { openDatabase } from '../packages/db/src/node';
import {
  ReviewWorkflowService,
  type AssignmentProvider,
  type CaseAssignment,
  type ReviewAuthorization,
} from '../packages/review-workflow/src/index';
import type { Database } from '../packages/db/src/adapter';

async function setup() {
  const n = openDatabase(':memory:');
  n.sqlite.exec(await readFile('migrations/0001_init.sql', 'utf8'));
  n.sqlite.exec(await readFile('migrations/0003_review.sql', 'utf8'));
  return n;
}

const future = '2026-12-31T00:00:00.000Z';
const auth = (principal: string, person: string, capability: ReviewAuthorization['capability']): ReviewAuthorization => ({
  principal_id: principal,
  person_id: person,
  grant_id: 'grant_' + person,
  capability,
  expires_at: future,
});

class Fixtures implements AssignmentProvider {
  assignments: CaseAssignment[] = [];
  async find(input: {
    assignment_id: string;
    case_id: string;
    case_revision: number;
    person_id: string;
    stage?: 'primary' | 'secondary' | 'escalation';
  }) {
    return (
      this.assignments.find(
        (assignment) =>
          assignment.assignment_id === input.assignment_id &&
          assignment.case_id === input.case_id &&
          assignment.case_revision === input.case_revision &&
          assignment.reviewer_person_id === input.person_id &&
          (!input.stage || assignment.stage === input.stage),
      ) ?? null
    );
  }
}

function assignment(
  id: string,
  caseId: string,
  revision: number,
  person: string,
  stage: 'primary' | 'secondary',
): CaseAssignment {
  return {
    assignment_id: id,
    case_id: caseId,
    case_revision: revision,
    reviewer_person_id: person,
    stage,
    state: 'active',
    expires_at: future,
  };
}

describe('PRD2 review workflow', () => {
  let db: Database | undefined;
  afterEach(() => db && (db as { close?: () => void }).close?.());

  async function serviceFixture() {
    const n = await setup();
    db = n.db;
    const assignments = new Fixtures();
    const service = new ReviewWorkflowService(db, {
      assignments,
      authorize: async () => undefined,
      now: () => new Date('2026-09-12T00:00:00.000Z'),
    });
    return { n, assignments, service };
  }

  async function createInitial() {
    const fixture = await serviceFixture();
    const { service, assignments } = fixture;
    await service.createCase({
      case_id: 'case_a',
      submission_id: 'submission_a',
      candidate: { title: '公开制度', scope: '研发', source: { source_id: 'source_a' } },
      source_preview_ids: [],
      reason: '初始公开候选',
      authorization: auth('principal_prepare', 'person_prepare', 'case.prepare') as ReviewAuthorization & {
        capability: 'case.prepare';
      },
    });
    const timestamp = new Date('2026-09-12T00:00:00.000Z').toISOString();
    await fixture.n.db.batch([
      {
        sql: 'INSERT INTO source_fetch_jobs(id,case_id,case_revision,source_id,source_url,policy_version,state,attempt_count,redirect_count,error_code,preview_id,assignment_id,grant_id,claim_token,idempotency_key,request_hash,revision,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        params: [
          'job_preview_a',
          'case_a',
          1,
          'source_a',
          'https://example.org/policy',
          'wfd-fetch-static-1.0',
          'sanitized_preview_ready',
          1,
          0,
          null,
          'preview_a',
          null,
          'grant_source_a',
          null,
          'fixture-preview-a',
          'a'.repeat(64),
          2,
          timestamp,
          timestamp,
          '2026-12-31T00:00:00.000Z',
        ],
      },
      {
        sql: 'INSERT INTO sanitized_previews(id,job_id,source_id,case_id,case_revision,state,display_domain,final_domain,fetch_policy,redirect_count,threat_intelligence,source_authenticity,text_ref,text_content,image_ref,raw_html_available_to_reviewer,public_destination_enforced,network_egress_policy_enforced,login_required,download_attempted,output_hash,captured_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        params: [
          'preview_a',
          'job_preview_a',
          'source_a',
          'case_a',
          1,
          'sanitized_preview_ready',
          'example.org',
          'example.org',
          'wfd-fetch-static-1.0',
          0,
          'not_checked',
          'unverified',
          'preview_a_text',
          '公开制度来源',
          null,
          0,
          1,
          1,
          0,
          0,
          'b'.repeat(64),
          timestamp,
          '2026-12-31T00:00:00.000Z',
          timestamp,
        ],
      },
    ]);
    await service.bindPreviews({
      case_id: 'case_a',
      expected_revision: 1,
      source_preview_ids: ['preview_a'],
      reason: '来源处理完成，绑定初稿',
      authorization: auth('principal_prepare', 'person_prepare', 'case.prepare') as ReviewAuthorization & {
        capability: 'case.prepare';
      },
    });
    assignments.assignments.push(
      assignment('assign_primary', 'case_a', 1, 'person_primary', 'primary'),
      assignment('assign_secondary', 'case_a', 1, 'person_secondary', 'secondary'),
    );
    return fixture;
  }

  it('初始候选版本为 1，secondary 在自己的决定前看不到 primary 结论', async () => {
    const { service } = await createInitial();
    await service.recordDecision({
      case_id: 'case_a',
      revision: 1,
      candidate_digest: (await service.publicationStatus('case_a')).candidate_digest,
      action: 'approve',
      reason: '主体和范围已核对',
      authorization: auth('principal_primary', 'person_primary', 'case.submit_decision'),
      assignment_id: 'assign_primary',
    });
    const blind = await service.getCaseForReview({
      case_id: 'case_a',
      assignment_id: 'assign_secondary',
      stage: 'independent',
      authorization: auth('principal_secondary', 'person_secondary', 'case.read_public_source'),
    });
    expect(blind.decision_visibility).toBe('blind');
    expect(blind.decisions).toHaveLength(0);
    expect(JSON.stringify(blind)).not.toContain('person_primary');
  });

  it('两名 canonical person 批准同一摘要才进入公开候选', async () => {
    const { service } = await createInitial();
    const digest = (await service.publicationStatus('case_a')).candidate_digest;
    await service.recordDecision({
      case_id: 'case_a',
      revision: 1,
      candidate_digest: digest,
      action: 'approve',
      reason: '初审通过',
      authorization: auth('principal_primary', 'person_primary', 'case.submit_decision'),
      assignment_id: 'assign_primary',
    });
    const pending = await service.publicationStatus('case_a');
    expect(pending.reason).toBe('waiting_for_independent_review');
    const result = await service.recordDecision({
      case_id: 'case_a',
      revision: 1,
      candidate_digest: digest,
      action: 'approve',
      reason: '独立复核通过',
      authorization: auth('principal_secondary', 'person_secondary', 'case.submit_decision'),
      assignment_id: 'assign_secondary',
    });
    expect(result.eligible).toBe(true);
    expect(result.state).toBe('approved_for_publication');
    const revealed = await service.getCaseForReview({
      case_id: 'case_a',
      assignment_id: 'assign_secondary',
      stage: 'independent',
      authorization: auth('principal_secondary', 'person_secondary', 'case.read_public_source'),
    });
    expect(revealed.decision_visibility).toBe('revealed');
    expect(revealed.decisions).toHaveLength(2);
  });

  it('同一 person_id 的两个 principal/密钥不能占两席', async () => {
    const { service, assignments } = await createInitial();
    assignments.assignments.push(assignment('assign_same_person', 'case_a', 1, 'person_primary', 'secondary'));
    const digest = (await service.publicationStatus('case_a')).candidate_digest;
    await service.recordDecision({
      case_id: 'case_a',
      revision: 1,
      candidate_digest: digest,
      action: 'approve',
      reason: '初审',
      authorization: auth('principal_primary', 'person_primary', 'case.submit_decision'),
      assignment_id: 'assign_primary',
    });
    await expect(
      service.recordDecision({
        case_id: 'case_a',
        revision: 1,
        candidate_digest: digest,
        action: 'approve',
        reason: '伪造独立复核',
        authorization: auth('principal_other_key', 'person_primary', 'case.submit_decision'),
        assignment_id: 'assign_same_person',
      }),
    ).rejects.toThrow('SELF_REVIEW');
  });

  it('阻断问题不能被多数批准覆盖，解除后才可发布', async () => {
    const { service } = await createInitial();
    const digest = (await service.publicationStatus('case_a')).candidate_digest;
    await service.recordDecision({
      case_id: 'case_a',
      revision: 1,
      candidate_digest: digest,
      action: 'approve',
      reason: '发现来源风险',
      blocking_issue_codes: ['phishing_link'],
      authorization: auth('principal_primary', 'person_primary', 'case.submit_decision'),
      assignment_id: 'assign_primary',
    });
    const blocked = await service.recordDecision({
      case_id: 'case_a',
      revision: 1,
      candidate_digest: digest,
      action: 'approve',
      reason: '复核通过但保留风险',
      authorization: auth('principal_secondary', 'person_secondary', 'case.submit_decision'),
      assignment_id: 'assign_secondary',
    });
    expect(blocked.eligible).toBe(false);
    expect(blocked.reason).toBe('blocking_issue_unresolved');
    const [issue] = await db!.all<{ id: string }>('SELECT id FROM review_blocking_issues');
    const resolved = await service.resolveBlocking({
      case_id: 'case_a',
      revision: 1,
      issue_id: issue.id,
      expected_revision: 1,
      reason: '第二人已核对并隔离钓鱼链接',
      authorization: auth('principal_secondary', 'person_secondary', 'case.resolve_blocking'),
      assignment_id: 'assign_secondary',
    });
    expect(resolved.eligible).toBe(true);
  });

  it('实质改版 supersede 旧 revision，旧双审不能沿用', async () => {
    const { service, assignments } = await createInitial();
    const digest = (await service.publicationStatus('case_a')).candidate_digest;
    await service.recordDecision({
      case_id: 'case_a',
      revision: 1,
      candidate_digest: digest,
      action: 'approve',
      reason: '初审',
      authorization: auth('principal_primary', 'person_primary', 'case.submit_decision'),
      assignment_id: 'assign_primary',
    });
    await service.recordDecision({
      case_id: 'case_a',
      revision: 1,
      candidate_digest: digest,
      action: 'approve',
      reason: '复核',
      authorization: auth('principal_secondary', 'person_secondary', 'case.submit_decision'),
      assignment_id: 'assign_secondary',
    });
    assignments.assignments.push(assignment('assign_primary_v2', 'case_a', 1, 'person_primary', 'primary'));
    const changed = await service.submitRevision({
      case_id: 'case_a',
      expected_revision: 1,
      candidate: { title: '修改后的公开制度', scope: '研发', source: { source_id: 'source_a' } },
      source_preview_ids: [],
      reason: '来源内容发生实质变化',
      authorization: auth('principal_primary', 'person_primary', 'case.submit_decision'),
      assignment_id: 'assign_primary_v2',
    });
    expect(changed.revision).toBe(2);
    const status = await service.publicationStatus('case_a');
    expect(status.eligible).toBe(false);
    expect(status.reason).toBe('waiting_for_initial_review');
    expect((await db!.all<{ status: string }>('SELECT status FROM review_case_revisions WHERE revision=1'))[0].status).toBe('superseded');
  });

  it('候选摘要不匹配或过期 revision 均拒绝决定', async () => {
    const { service } = await createInitial();
    const digest = (await service.publicationStatus('case_a')).candidate_digest;
    await expect(
      service.recordDecision({
        case_id: 'case_a',
        revision: 1,
        candidate_digest: '0'.repeat(64),
        action: 'approve',
        reason: '错误摘要',
        authorization: auth('principal_primary', 'person_primary', 'case.submit_decision'),
        assignment_id: 'assign_primary',
      }),
    ).rejects.toThrow('PROPOSAL_CONTENT_CHANGED');
    await expect(
      service.recordDecision({
        case_id: 'case_a',
        revision: 2,
        candidate_digest: digest,
        action: 'approve',
        reason: '过期版本',
        authorization: auth('principal_primary', 'person_primary', 'case.submit_decision'),
        assignment_id: 'assign_primary',
      }),
    ).rejects.toThrow('REVISION_CONFLICT');
  });

  it('没有绑定有效净化预览时批准被阻断', async () => {
    const { service, assignments } = await serviceFixture();
    await service.createCase({
      case_id: 'case_without_preview',
      submission_id: 'submission_without_preview',
      candidate: { title: '待处理来源的候选' },
      source_preview_ids: [],
      reason: '先建立候选再排队来源任务',
      authorization: auth('principal_prepare', 'person_prepare', 'case.prepare') as ReviewAuthorization & {
        capability: 'case.prepare';
      },
    });
    assignments.assignments.push(
      assignment('assign_primary_no_preview', 'case_without_preview', 1, 'person_primary', 'primary'),
    );
    const digest = (await service.publicationStatus('case_without_preview')).candidate_digest;
    await expect(
      service.recordDecision({
        case_id: 'case_without_preview',
        revision: 1,
        candidate_digest: digest,
        action: 'approve',
        reason: '没有来源不应批准',
        authorization: auth('principal_primary', 'person_primary', 'case.submit_decision'),
        assignment_id: 'assign_primary_no_preview',
      }),
    ).rejects.toThrow('SOURCE_PREVIEW_REQUIRED');
  });
});
