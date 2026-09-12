import { describe, expect, it } from 'vitest';
import { DomainError } from '../packages/domain/src';
import { publicContributionSummary, projectGovernance } from '../packages/governance-export/src';

describe('public governance projection', () => {
  it('uses distinct contributors for the small-group gate', () => {
    const hidden = publicContributionSummary({
      month: '2026-01',
      domain: 'data',
      distinctContributorCount: 1,
      contributionCount: 20,
      recognizedCount: 20,
      availableAt: '2026-02-08T00:00:00.000Z',
    });
    expect(hidden.level).toBe('suppressed');
    expect(hidden.contribution_count).toBeNull();

    const coarse = publicContributionSummary({
      month: '2026-01',
      domain: 'data',
      distinctContributorCount: 5,
      contributionCount: 20,
      recognizedCount: 17,
      availableAt: '2026-02-08T00:00:00.000Z',
    });
    expect(coarse.level).toBe('coarse');
    expect(coarse.contribution_count).toBe(20);
  });

  it('enforces the seven-day post-month delay and P0 stage', () => {
    expect(() =>
      publicContributionSummary({
        month: '2026-01',
        domain: 'data',
        distinctContributorCount: 5,
        contributionCount: 5,
        recognizedCount: 5,
        availableAt: '2026-02-07T23:59:59.998Z',
      }),
    ).toThrowError(DomainError);
    expect(() =>
      projectGovernance({
        policy_version: 'wfd-gov-1-0',
        governance_stage: 'mature',
        generated_at: '2026-02-08T00:00:00.000Z',
        authorities: [],
        role_status: [],
        proposals: [],
        decisions: [],
        nodes: [],
        transparency: [],
      }),
    ).toThrow('P1_MATURE_GOVERNANCE_DISABLED');
  });
});
