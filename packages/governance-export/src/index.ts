import { z } from 'zod';
import { assert } from '../../domain/src/index';
import { canonical } from '../../verifier/src/crypto';
import {
  proposalStates,
  proposalTypes,
  type GovernancePolicy,
} from '../../governance-policy/src/index';

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{2,100}$/);
const keyId = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
const instant = z.string().datetime({ offset: true });
const summary = z.string().trim().min(1).max(500);

export const publicGrantScopeSchema = z.strictObject({
  evidence_classes: z
    .array(z.enum(['public_source']))
    .min(1)
    .max(5),
  rule_domains: z.array(summary).max(30),
  regions: z.array(summary).max(30),
  source_types: z.array(z.enum(['company', 'third_party', 'independent_practice'])).max(5),
});
export type PublicGrantScope = z.infer<typeof publicGrantScopeSchema>;

export const publicRoleGrantSchema = z.strictObject({
  grant_id: identifier,
  subject_key_id: keyId,
  role: z.enum([
    'review_apprentice',
    'public_reviewer',
    'senior_reviewer',
    'code_maintainer',
    'infra_maintainer',
    'security_responder',
    'publisher',
    'root_custodian',
  ]),
  capabilities: z.array(summary).min(1).max(30),
  scope: publicGrantScopeSchema,
  not_before: instant,
  expires_at: instant,
  policy_version: identifier,
  approval_ref: identifier,
  grant_revision: z.number().int().positive(),
  status: z.enum(['active', 'expired', 'revoked', 'suspended']),
});
export type PublicRoleGrant = z.infer<typeof publicRoleGrantSchema>;

export const publicAuthoritySchema = z.strictObject({
  authority_id: identifier,
  purpose: z.enum(['governance', 'role_authorization', 'publication']),
  key_ids: z.array(keyId).min(2).max(3),
  threshold: z.union([z.literal(2), z.literal(3)]),
  policy_version: identifier,
  not_before: instant,
  expires_at: instant,
  status: z.enum(['active', 'expired', 'revoked']),
});
export type PublicAuthority = z.infer<typeof publicAuthoritySchema>;

export const publicRoleStatusSchema = z.strictObject({
  grant: publicRoleGrantSchema,
  authority_ids: z.array(identifier).min(1).max(3),
  signatures: z
    .array(z.strictObject({ key_id: keyId, signature: z.string().min(1).max(4096) }))
    .min(2)
    .max(3),
});
export type PublicRoleStatus = z.infer<typeof publicRoleStatusSchema>;

export const publicProposalSchema = z.strictObject({
  proposal_id: identifier,
  proposal_revision: z.number().int().positive(),
  proposal_type: z.enum(proposalTypes),
  title: summary,
  public_summary: summary,
  state: z.enum(proposalStates),
  payload_digest: z.string().regex(/^[a-f0-9]{64}$/),
  policy_version: identifier,
  discussion_started_at: instant.nullable(),
  discussion_ends_at: instant.nullable(),
  voting_ends_at: instant.nullable(),
  timelock_until: instant.nullable(),
});
export type PublicProposal = z.infer<typeof publicProposalSchema>;

export const publicDecisionSchema = z.strictObject({
  decision_id: identifier,
  proposal_id: identifier,
  proposal_revision: z.number().int().positive(),
  outcome: z.enum(['passed', 'rejected', 'executed', 'failed', 'blocked']),
  approval_count: z.number().int().nonnegative(),
  required_count: z.number().int().positive(),
  executed_at: instant.nullable(),
  signatures: z
    .array(z.strictObject({ key_id: keyId, signature: z.string().min(1).max(4096) }))
    .min(1)
    .max(3),
});
export type PublicDecision = z.infer<typeof publicDecisionSchema>;

export const publicNodeSchema = z.strictObject({
  node_id: identifier,
  capabilities: z
    .array(z.enum(['data', 'web', 'ipfs']))
    .min(1)
    .max(3),
  control_group: identifier,
  provider_group: identifier,
  observed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valid_until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  status: z.enum(['active', 'expired', 'withdrawn', 'suppressed']),
  content_verified: z.boolean(),
});
export type PublicNode = z.infer<typeof publicNodeSchema>;

export const publicTransparencySchema = z.strictObject({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  domain: z.enum(['data', 'review', 'code_doc', 'infrastructure', 'security_governance']),
  level: z.enum(['none', 'coarse', 'suppressed']),
  contribution_count: z.number().int().nonnegative().nullable(),
  recognized_count: z.number().int().nonnegative().nullable(),
});
export type PublicTransparency = z.infer<typeof publicTransparencySchema>;

export const publicGovernanceProjectionSchema = z.strictObject({
  protocol: z.literal('wfd-governance'),
  schema_version: z.literal('1.0'),
  policy_version: identifier,
  governance_stage: z.enum(['development', 'bootstrap', 'mature']),
  generated_at: instant,
  authorities: z.array(publicAuthoritySchema).max(20),
  role_status: z.array(publicRoleStatusSchema).max(1000),
  proposals: z.array(publicProposalSchema).max(10000),
  decisions: z.array(publicDecisionSchema).max(10000),
  nodes: z.array(publicNodeSchema).max(10000),
  transparency: z.array(publicTransparencySchema).max(1000),
});
export type PublicGovernanceProjection = z.infer<typeof publicGovernanceProjectionSchema>;

const forbiddenKey =
  /(?:^|_)(?:principal|person|user|company_ids|conflict|employer|receipt|token|attachment|evidence|case_ref|source_ref|raw|private|password|secret)(?:$|_)/i;
function assertPublicKeys(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) assertPublicKeys(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert(key === 'evidence_classes' || !forbiddenKey.test(key), 'PRIVACY_BLOCKED', 409);
    assertPublicKeys(item);
  }
}

/** Validate and return only the explicitly public governance projection. */
export function exportPublicGovernance(input: unknown): PublicGovernanceProjection {
  const parsed = publicGovernanceProjectionSchema.parse(input);
  assert(parsed.governance_stage !== 'mature', 'P1_MATURE_GOVERNANCE_DISABLED', 409);
  for (const grant of parsed.role_status) {
    assert(grant.grant.not_before < grant.grant.expires_at, 'INVALID_GRANT_WINDOW', 409);
  }
  assertPublicKeys(parsed);
  return parsed;
}

/** Stable bytes for a signed PUB target.  This never serializes private rows. */
export function serializePublicGovernance(input: unknown): Uint8Array {
  return new TextEncoder().encode(canonical(exportPublicGovernance(input)));
}

export type PublicContributionSummaryInput = {
  month: string;
  domain: PublicTransparency['domain'];
  /** Number of distinct contributors; this controls the small-group gate. */
  distinctContributorCount: number;
  /** Raw contribution volume is display data only and never the privacy gate. */
  contributionCount: number;
  recognizedCount: number;
  /** Server/builder time. Reports become eligible after the month plus seven days. */
  availableAt?: Date | string;
  policy?: Pick<GovernancePolicy['privacy'], 'public_small_group_threshold'>;
};

/**
 * Build a delayed public transparency row. The caller must supply the
 * distinct-person count separately from raw contribution volume so one person
 * cannot make a small group look large. `availableAt` is an operational
 * server/builder value, never a client-provided HTTP field.
 */
export function publicContributionSummary(
  input: PublicContributionSummaryInput,
): PublicTransparency;
/** @deprecated Prefer the named input above. Kept for internal builder callers during migration. */
export function publicContributionSummary(
  month: string,
  domain: PublicTransparency['domain'],
  distinctContributorCount: number,
  contributionCount: number,
  recognizedCount?: number,
  policy?: Pick<GovernancePolicy['privacy'], 'public_small_group_threshold'>,
  availableAt?: Date | string,
): PublicTransparency;
export function publicContributionSummary(
  inputOrMonth: PublicContributionSummaryInput | string,
  domain?: PublicTransparency['domain'],
  distinctContributorCount?: number,
  contributionCount?: number,
  recognizedCount?: number,
  policy?: Pick<GovernancePolicy['privacy'], 'public_small_group_threshold'>,
  availableAt?: Date | string,
): PublicTransparency {
  const input: PublicContributionSummaryInput =
    typeof inputOrMonth === 'string'
      ? {
          month: inputOrMonth,
          domain: domain!,
          distinctContributorCount: distinctContributorCount!,
          contributionCount: contributionCount!,
          recognizedCount: recognizedCount ?? 0,
          policy,
          availableAt,
        }
      : inputOrMonth;
  const parsedMonth = z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .parse(input.month);
  assert(
    Number.isInteger(input.distinctContributorCount) && input.distinctContributorCount >= 0,
    'INVALID_PUBLIC_COUNT',
  );
  assert(
    Number.isInteger(input.contributionCount) && input.contributionCount >= 0,
    'INVALID_PUBLIC_COUNT',
  );
  assert(
    Number.isInteger(input.recognizedCount) && input.recognizedCount >= 0,
    'INVALID_PUBLIC_COUNT',
  );
  const [year, monthNumber] = parsedMonth.split('-').map(Number);
  assert(monthNumber >= 1 && monthNumber <= 12, 'INVALID_PUBLIC_MONTH');
  const monthEnd = Date.UTC(year, monthNumber, 0, 23, 59, 59, 999);
  const available =
    input.availableAt === undefined
      ? Date.now()
      : input.availableAt instanceof Date
        ? input.availableAt.getTime()
        : Date.parse(input.availableAt);
  assert(Number.isFinite(available), 'INVALID_PUBLIC_TIME');
  assert(available >= monthEnd + 7 * 86400000, 'PUBLIC_SUMMARY_DELAY_NOT_ELAPSED', 409);
  const threshold = input.policy?.public_small_group_threshold ?? 5;
  const suppressed = input.distinctContributorCount < threshold;
  return publicTransparencySchema.parse({
    month: parsedMonth,
    domain: input.domain,
    level: suppressed ? 'suppressed' : 'coarse',
    contribution_count: suppressed ? null : input.contributionCount,
    recognized_count: suppressed ? null : input.recognizedCount,
  });
}

export type PublicProjectionInput = Omit<PublicGovernanceProjection, 'protocol' | 'schema_version'>;
export function projectGovernance(input: PublicProjectionInput): PublicGovernanceProjection {
  return exportPublicGovernance({ protocol: 'wfd-governance', schema_version: '1.0', ...input });
}

export class GovernanceExporter {
  constructor(public policyVersion: string) {}
  export(
    input: Omit<PublicGovernanceProjection, 'protocol' | 'schema_version' | 'policy_version'>,
  ) {
    return projectGovernance({ ...input, policy_version: this.policyVersion });
  }
  bytes(input: Omit<PublicGovernanceProjection, 'protocol' | 'schema_version' | 'policy_version'>) {
    return serializePublicGovernance(this.export(input));
  }
}
