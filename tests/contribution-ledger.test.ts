import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../packages/db/src/node';
import { ContributionLedger } from '../packages/contribution-ledger/src';
import type { Database } from '../packages/db/src/adapter';

describe('PRD2 contribution ledger', () => {
  let db: Database;
  let sqlite: ReturnType<typeof openDatabase>['sqlite'];
  let now: Date;
  let ledger: ContributionLedger;

  beforeEach(() => {
    const opened = openDatabase(':memory:');
    sqlite = opened.sqlite;
    db = opened.db;
    sqlite.exec(readFileSync('migrations/0001_init.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0004_governance.sql', 'utf8'));
    now = new Date('2026-01-01T00:00:00.000Z');
    ledger = new ContributionLedger(
      db,
      undefined,
      () => now,
      async (principal) =>
        ({ person_b: 'person_same', person_c: 'person_same' })[principal] ?? principal,
    );
  });

  afterEach(() => sqlite.close());

  function input(overrides: Record<string, unknown> = {}) {
    return {
      principal_id: 'person_a',
      domain: 'data' as const,
      work_type: 'material_correction',
      subject_ref: 'company_x',
      scope_ref: 'scope_x',
      fact_cycle: '2026-01',
      source_family: 'family_x',
      work_fingerprint: 'arbitrary-client-fingerprint',
      ...overrides,
    };
  }

  it('groups same subject/scope/source cycle even when a client changes its fingerprint', async () => {
    const first = await ledger.submit(input({ idempotency_key: 'contribution-idempotency-a' }));
    const duplicate = await ledger.submit(
      input({
        principal_id: 'person_z',
        work_fingerprint: 'a-different-fingerprint',
        idempotency_key: 'contribution-idempotency-b',
      }),
    );
    expect(first.status).toBe('submitted');
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.contribution_cluster_id).toBe(first.contribution_cluster_id);
    await expect(
      ledger.submit(input({ subject_ref: 'other', idempotency_key: 'contribution-idempotency-a' })),
    ).rejects.toThrow('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('blocks self, conflict and same-person multi-account assessments, then recognizes after the window', async () => {
    const created = await ledger.submit(input({ materiality: 'qualification' }));
    await expect(ledger.beginAssessment(created.id, 'person_a', 1)).rejects.toThrow(
      'SELF_ASSESSMENT',
    );
    await expect(ledger.beginAssessment(created.id, 'person_b', 1, true)).rejects.toThrow(
      'CONFLICT_OF_INTEREST',
    );
    await ledger.beginAssessment(created.id, 'person_b', 1);
    const first = await ledger.assess({
      contribution_id: created.id,
      assessor_principal_id: 'person_b',
      decision: 'accept',
      reason: '资料有实质更正价值',
      policy_version: 'wfd-gov-1-0',
      expected_revision: 2,
    });
    expect(first.status).toBe('accepted_pending');
    await expect(
      ledger.assess({
        contribution_id: created.id,
        assessor_principal_id: 'person_c',
        decision: 'accept',
        reason: '独立账号',
        policy_version: 'wfd-gov-1-0',
        expected_revision: first.version,
      }),
    ).rejects.toThrow('SAME_PERSON_NOT_INDEPENDENT');
    const second = await ledger.assess({
      contribution_id: created.id,
      assessor_principal_id: 'person_d',
      decision: 'accept',
      reason: '第二位独立评估者确认',
      policy_version: 'wfd-gov-1-0',
      expected_revision: first.version,
    });
    expect(second.status).toBe('accepted_pending');
    expect(second.version).toBe(first.version + 1);
    await expect(ledger.finalize(created.id, 'person_d', second.version)).rejects.toThrow(
      'CHALLENGE_WINDOW_OPEN',
    );
    now = new Date('2026-01-09T00:00:00.000Z');
    const recognized = await ledger.finalize(created.id, 'person_d', second.version);
    expect(recognized.status).toBe('recognized');
  });

  it('keeps corrections append-only and routes an appeal to independent assessors', async () => {
    const created = await ledger.submit(input());
    await ledger.beginAssessment(created.id, 'person_b', 1);
    const pending = await ledger.assess({
      contribution_id: created.id,
      assessor_principal_id: 'person_b',
      decision: 'accept',
      reason: '初次认定',
      policy_version: 'wfd-gov-1-0',
      expected_revision: 2,
    });
    now = new Date('2026-01-09T00:00:00.000Z');
    const recognized = await ledger.finalize(created.id, 'person_b', pending.version);
    const challenged = await ledger.challenge(
      created.id,
      'person_z',
      '去重判断需要复核',
      recognized.version,
    );
    const appeal = await ledger.openAppeal({
      appellant_principal_id: 'person_z',
      subject_type: 'contribution',
      subject_id: created.id,
      reason: '去重判断需要复核',
      evidence_refs: ['private:appeal-note'],
      idempotency_key: 'appeal-idempotency-a',
    });
    await expect(
      ledger.assessAppeal(appeal.id, 'person_b', 'adjust', '原评估者不得参与申诉', 1),
    ).rejects.toThrow('ORIGINAL_DECISION_REVIEWER');
    const firstAssessment = await ledger.assessAppeal(
      appeal.id,
      'person_x',
      'adjust',
      '补充核验后调整',
      1,
    );
    expect(firstAssessment.status).toBe('under_review');
    const resolved = await ledger.assessAppeal(
      appeal.id,
      'person_y',
      'adjust',
      '补充核验后调整',
      firstAssessment.version,
    );
    expect(resolved.status).toBe('adjusted');
    expect((await ledger.getContribution(created.id))?.status).toBe('adjusted');
    expect(
      await db.all<{ from_state: string | null; to_state: string }>(
        'SELECT from_state,to_state FROM contribution_events WHERE contribution_id=? ORDER BY revision',
        [created.id],
      ),
    ).toHaveLength(6);
    expect(recognized.status).toBe('recognized');
    expect(challenged.status).toBe('challenged');
  });

  it('requires two independent approvals for a qualification and never creates a role grant', async () => {
    await expect(
      ledger.applyQualification({
        principal_id: 'person_a',
        target_role: 'private_evidence_reviewer',
        scope: ['public_source'],
        evidence_refs: [],
        training_modules: [],
      }),
    ).rejects.toThrow('P1_DISABLED');
    const application = await ledger.applyQualification({
      principal_id: 'person_a',
      target_role: 'public_reviewer',
      scope: ['ordinary_employment_public_policy'],
      evidence_refs: ['contribution:one'],
      training_modules: ['source-safety'],
      idempotency_key: 'qualification-idempotency-a',
    });
    const first = await ledger.assessQualification({
      application_id: application.id,
      assessor_principal_id: 'person_b',
      decision: 'approve',
      reason: '初次资格评估',
      policy_version: 'wfd-gov-1-0',
      expected_revision: 1,
    });
    expect(first.status).toBe('under_assessment');
    await expect(
      ledger.assessQualification({
        application_id: application.id,
        assessor_principal_id: 'person_c',
        decision: 'approve',
        reason: '同一真人的第二账号',
        policy_version: 'wfd-gov-1-0',
        expected_revision: first.version,
      }),
    ).rejects.toThrow('SAME_PERSON_NOT_INDEPENDENT');
    const approved = await ledger.assessQualification({
      application_id: application.id,
      assessor_principal_id: 'person_y',
      decision: 'approve',
      reason: '独立资格评估',
      policy_version: 'wfd-gov-1-0',
      expected_revision: first.version,
    });
    expect(approved.status).toBe('approved');
    expect(approved.valid_until).toBe('2026-04-01T00:00:00.000Z');
    expect(
      await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='role_grants'"),
    ).toHaveLength(0);
  });
});
