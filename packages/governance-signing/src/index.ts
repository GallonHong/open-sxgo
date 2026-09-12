import { z } from 'zod';
import type { Database, Query } from '../../db/src/adapter';
import { assert, DomainError } from '../../domain/src/index';
import {
  capabilitySchema,
  type AuthorizeInput,
  type Capability,
  type Identity,
} from '../../identity-permissions/src/index';
import type {
  GovernanceExecutionInput,
  GovernanceExecutionResult,
  GovernanceExecutor,
} from '../../governance-policy/src/index';
import { proposalPayloadSchema } from '../../governance-policy/src/index';
import { canonical, hash, sign, strictJSON, utf8, verify } from '../../verifier/src/crypto';

/**
 * Business signing intentionally uses the prefix already used by the v1
 * reviewer protocol.  This package gives the payload a new, strict protocol
 * envelope; it does not change the bytes or verification rules of old v1
 * public approvals.
 */
export const BUSINESS_SIGNING_PREFIX = 'WFD-SIGNED-OBJECT-v1\n';
export const GOVERNANCE_ENVELOPE_PROTOCOL = 'wfd-governance-execution' as const;
export const GOVERNANCE_AUTHORITY_PROTOCOL = 'wfd-governance-authority' as const;
export const GOVERNANCE_SIGNING_SCHEMA_VERSION = '2.0' as const;

const identifier = z.string().regex(/^[a-z][a-z0-9_-]{2,120}$/);
const keyId = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
const publicKey = z.string().regex(/^[a-f0-9]{64}$/i);
const signature = z.string().regex(/^[a-f0-9]{128}$/i);
const instant = z.string().datetime({ offset: true });
const positiveRevision = z.number().int().positive();
const capability = capabilitySchema;
const status = z.enum(['active', 'revoked', 'expired', 'suspended']);

/**
 * The scope is deliberately explicit.  A role revoke must name the exact
 * grant in role_ids; a wildcard is not a valid governance authorization.
 * All arrays are required so event-id bytes cannot change because a parser
 * silently inserts a default value.
 */
export const governanceScopeSchema = z
  .strictObject({
    source_types: z.array(z.string().min(1).max(100)).max(50),
    regions: z.array(z.string().min(1).max(100)).max(50),
    labor_rule_fields: z.array(z.string().min(1).max(100)).max(50),
    contribution_domains: z.array(z.string().min(1).max(100)).max(50),
    contribution_ids: z.array(identifier).max(100),
    policy_ids: z.array(identifier).max(100),
    role_ids: z.array(identifier).max(100),
    company_ids: z.array(identifier).max(100),
    qualification_ids: z.array(identifier).max(100),
    source_ids: z.array(identifier).max(100),
    proposal_ids: z.array(identifier).max(100),
    incident_ids: z.array(identifier).max(100),
    release_ids: z.array(identifier).max(100),
    code_paths: z.array(z.string().min(1).max(300)).max(100),
    node_ids: z.array(identifier).max(100),
    case_ids: z.array(identifier).max(100),
  })
  .superRefine((value, ctx) => {
    if (Object.values(value).some((items) => items.includes('*')))
      ctx.addIssue({ code: 'custom', message: 'WILDCARD_SCOPE_FORBIDDEN' });
  });
export type GovernanceScope = z.infer<typeof governanceScopeSchema>;

export const governanceEnvironmentSchema = z.enum(['demo', 'production']);
export type GovernanceEnvironment = z.infer<typeof governanceEnvironmentSchema>;

const authorityMemberSchema = z.strictObject({
  key_id: keyId,
  /** Canonical person mapping is trusted private authorization data. */
  person_id: identifier,
  public_key: publicKey,
  capabilities: z.array(capability).min(1).max(30),
  scope: governanceScopeSchema,
  not_before: instant,
  expires_at: instant,
  status,
});
export type GovernanceAuthorityMember = z.infer<typeof authorityMemberSchema>;

/** Root-attested authorization statement. Keep this separate from public v1 authority. */
export const governanceAuthorityPayloadSchema = z
  .strictObject({
    protocol: z.literal(GOVERNANCE_AUTHORITY_PROTOCOL),
    schema_version: z.literal(GOVERNANCE_SIGNING_SCHEMA_VERSION),
    event_type: z.literal('authority.delegated'),
    purpose: z.literal('governance-execution'),
    environment: governanceEnvironmentSchema,
    authority_id: identifier,
    policy_version: identifier,
    revision: positiveRevision,
    threshold: z.literal(2),
    members: z.array(authorityMemberSchema).min(2).max(3),
    approval_ref: identifier,
    issued_at: instant,
    not_before: instant,
    expires_at: instant,
    status,
  })
  .superRefine((value, ctx) => {
    if (new Set(value.members.map((member) => member.key_id)).size !== value.members.length)
      ctx.addIssue({ code: 'custom', message: 'DUPLICATE_AUTHORITY_KEY' });
    if (new Set(value.members.map((member) => member.person_id)).size !== value.members.length)
      ctx.addIssue({ code: 'custom', message: 'DUPLICATE_AUTHORITY_PERSON' });
    if (Date.parse(value.not_before) >= Date.parse(value.expires_at))
      ctx.addIssue({ code: 'custom', message: 'INVALID_AUTHORITY_WINDOW' });
  });
export type GovernanceAuthorityPayload = z.infer<typeof governanceAuthorityPayloadSchema>;

export const businessSignatureSchema = z.strictObject({
  key_id: keyId,
  signature,
});
export type BusinessSignature = z.infer<typeof businessSignatureSchema>;

/** P0 currently exposes only the concrete role-revocation action. */
export const roleRevokePayloadSchema = z
  .strictObject({
    protocol: z.literal('wfd-governance'),
    schema_version: z.literal(GOVERNANCE_SIGNING_SCHEMA_VERSION),
    event_type: z.literal('role.revoke'),
    purpose: z.literal('governance-execution'),
    environment: governanceEnvironmentSchema,
    authority_id: identifier,
    authority_revision: positiveRevision,
    policy_version: identifier,
    proposal_id: identifier,
    /** Generic revision alias is retained in the signed payload for audit tooling. */
    revision: positiveRevision,
    proposal_revision: positiveRevision,
    grant_id: identifier,
    grant_revision: positiveRevision,
    /** Private target principal binding; never projected to the public export. */
    target_principal_id: identifier,
    target_role: z.string().trim().min(1).max(100),
    target_capabilities: z.array(capability).min(1).max(30),
    target_scope: governanceScopeSchema,
    target_not_before: instant,
    target_expires_at: instant,
    approval_ref: identifier,
    reason: z.string().trim().min(1).max(500),
    issued_at: instant,
    not_before: instant,
    expires_at: instant,
  })
  .superRefine((value, ctx) => {
    if (value.revision !== value.proposal_revision)
      ctx.addIssue({ code: 'custom', message: 'REVISION_ALIAS_MISMATCH' });
    if (Date.parse(value.not_before) >= Date.parse(value.expires_at))
      ctx.addIssue({ code: 'custom', message: 'INVALID_EVENT_WINDOW' });
    if (Date.parse(value.target_not_before) >= Date.parse(value.target_expires_at))
      ctx.addIssue({ code: 'custom', message: 'INVALID_TARGET_WINDOW' });
  });
export type RoleRevokePayload = z.infer<typeof roleRevokePayloadSchema>;

export const unsignedGovernanceEnvelopeSchema = z.strictObject({
  protocol: z.literal(GOVERNANCE_ENVELOPE_PROTOCOL),
  schema_version: z.literal(GOVERNANCE_SIGNING_SCHEMA_VERSION),
  signed: roleRevokePayloadSchema,
  event_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  signatures: z.array(businessSignatureSchema).max(3),
});
export type UnsignedGovernanceEnvelope = z.infer<typeof unsignedGovernanceEnvelopeSchema>;

export const governanceEnvelopeSchema = z.strictObject({
  protocol: z.literal(GOVERNANCE_ENVELOPE_PROTOCOL),
  schema_version: z.literal(GOVERNANCE_SIGNING_SCHEMA_VERSION),
  signed: roleRevokePayloadSchema,
  event_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  signatures: z.array(businessSignatureSchema).min(2).max(3),
});
export type GovernanceEnvelope = z.infer<typeof governanceEnvelopeSchema>;

export const unsignedAuthorityEnvelopeSchema = z.strictObject({
  protocol: z.literal(GOVERNANCE_AUTHORITY_PROTOCOL),
  schema_version: z.literal(GOVERNANCE_SIGNING_SCHEMA_VERSION),
  signed: governanceAuthorityPayloadSchema,
  event_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  signatures: z.array(businessSignatureSchema).max(3),
});
export type UnsignedAuthorityEnvelope = z.infer<typeof unsignedAuthorityEnvelopeSchema>;

export const authorityEnvelopeSchema = z.strictObject({
  protocol: z.literal(GOVERNANCE_AUTHORITY_PROTOCOL),
  schema_version: z.literal(GOVERNANCE_SIGNING_SCHEMA_VERSION),
  signed: governanceAuthorityPayloadSchema,
  event_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  signatures: z.array(businessSignatureSchema).min(2).max(3),
});
export type AuthorityEnvelope = z.infer<typeof authorityEnvelopeSchema>;

export type LocalSigningKey =
  | {
      key_id: string;
      private_key: CryptoKey;
      /** Optional public key lets the offline tool bind the private key to its authorization member. */
      public_key?: string;
    }
  /** Compatibility with the existing builder's local-only SigningKey shape. */
  | {
      id: string;
      privateKey: CryptoKey;
      publicHex?: string;
    };

export type AuthorityTrust = {
  /** Trust roots are environment-bound; demo keys cannot authorize production. */
  environment: GovernanceEnvironment;
  key_ids: string[];
  threshold: number;
  keys: Record<string, string | { public_key: string } | { keyval: { public: string } }>;
};

export type GovernanceVerificationOptions = {
  now?: Date | number;
  environment?: GovernanceEnvironment;
  policyVersion?: string;
  proposalId?: string;
  proposalRevision?: number;
  grantId?: string;
  grantRevision?: number;
  targetPersonId?: string;
  requiredCapability?: Capability;
};

const dateMillis = (value: string, code: string) => {
  const parsed = Date.parse(value);
  assert(Number.isFinite(parsed), code, 400);
  return parsed;
};

function currentMillis(value?: Date | number) {
  const result = value instanceof Date ? value.getTime() : (value ?? Date.now());
  assert(Number.isFinite(result), 'INVALID_SIGNING_TIME', 400);
  return result;
}

function assertActiveWindow(
  notBefore: string,
  expiresAt: string,
  now: number,
  expiredCode: string,
) {
  const start = dateMillis(notBefore, 'INVALID_SIGNING_TIME');
  const end = dateMillis(expiresAt, 'INVALID_SIGNING_TIME');
  assert(start < end, 'INVALID_SIGNING_WINDOW', 400);
  assert(now >= start, 'SIGNATURE_NOT_YET_VALID', 409);
  assert(now < end, expiredCode, 409);
}

function publicKeyOf(value: string | { public_key: string } | { keyval: { public: string } }) {
  return typeof value === 'string'
    ? value
    : 'public_key' in value
      ? value.public_key
      : value.keyval.public;
}

function normalizeTrust(input: AuthorityTrust | Record<string, unknown>): AuthorityTrust {
  const root =
    input &&
    typeof input === 'object' &&
    'signed' in input &&
    input.signed &&
    typeof input.signed === 'object'
      ? (input.signed as Record<string, unknown>)
      : (input as Record<string, unknown>);
  const keys = root.keys;
  const custom = root.custom;
  const environment =
    root.environment === 'demo' || root.environment === 'production'
      ? root.environment
      : custom &&
          typeof custom === 'object' &&
          ((custom as Record<string, unknown>).environment === 'demo' ||
            (custom as Record<string, unknown>).environment === 'production')
        ? (custom as Record<string, GovernanceEnvironment>).environment
        : undefined;
  assert(environment, 'INVALID_TRUST_ROOT', 503);
  const roles = root.roles;
  const rootRole =
    roles && typeof roles === 'object' ? (roles as Record<string, unknown>).root : undefined;
  const keyIds = Array.isArray(root.key_ids)
    ? root.key_ids
    : Array.isArray(root.keyids)
      ? root.keyids
      : rootRole &&
          typeof rootRole === 'object' &&
          Array.isArray((rootRole as Record<string, unknown>).keyids)
        ? (rootRole as Record<string, unknown>).keyids
        : undefined;
  const threshold =
    typeof root.threshold === 'number'
      ? root.threshold
      : rootRole &&
          typeof rootRole === 'object' &&
          typeof (rootRole as Record<string, unknown>).threshold === 'number'
        ? (rootRole as Record<string, unknown>).threshold
        : undefined;
  assert(
    Array.isArray(keyIds) && keyIds.every((item) => typeof item === 'string'),
    'INVALID_TRUST_ROOT',
    503,
  );
  assert(keys && typeof keys === 'object' && !Array.isArray(keys), 'INVALID_TRUST_ROOT', 503);
  const numericThreshold = typeof threshold === 'number' ? threshold : NaN;
  assert(Number.isInteger(numericThreshold) && numericThreshold >= 2, 'INVALID_TRUST_ROOT', 503);
  const normalizedKeys: Record<string, string> = {};
  for (const id of keyIds as string[]) {
    const value = (keys as Record<string, unknown>)[id];
    assert(
      (value && typeof value === 'object') || typeof value === 'string',
      'INVALID_TRUST_ROOT',
      503,
    );
    const publicHex = publicKeyOf(
      value as string | { public_key: string } | { keyval: { public: string } },
    );
    assert(/^[a-f0-9]{64}$/i.test(publicHex), 'INVALID_TRUST_ROOT', 503);
    normalizedKeys[id] = publicHex;
  }
  return {
    environment,
    key_ids: [...keyIds] as string[],
    threshold: numericThreshold,
    keys: normalizedKeys,
  };
}

/** Exact business bytes used by both the signer and the verifier. */
export function businessSignedBytes(payload: unknown): Uint8Array {
  assert(
    payload !== null && typeof payload === 'object' && !Array.isArray(payload),
    'INVALID_SIGNED_PAYLOAD',
    400,
  );
  return utf8(BUSINESS_SIGNING_PREFIX + canonical(payload));
}

export async function businessEventId(payload: unknown): Promise<string> {
  return `sha256:${await hash(businessSignedBytes(payload))}`;
}

async function assertEnvelopeEventId(envelope: { signed: unknown; event_id: string }) {
  assert((await businessEventId(envelope.signed)) === envelope.event_id, 'EVENT_ID_MISMATCH', 409);
}

export async function createUnsignedGovernanceEnvelope(
  payload: RoleRevokePayload,
): Promise<UnsignedGovernanceEnvelope> {
  const signedPayload = roleRevokePayloadSchema.parse(payload);
  return unsignedGovernanceEnvelopeSchema.parse({
    protocol: GOVERNANCE_ENVELOPE_PROTOCOL,
    schema_version: GOVERNANCE_SIGNING_SCHEMA_VERSION,
    signed: signedPayload,
    event_id: await businessEventId(signedPayload),
    signatures: [],
  });
}

export async function createUnsignedAuthorityEnvelope(
  payload: GovernanceAuthorityPayload,
): Promise<UnsignedAuthorityEnvelope> {
  const signedPayload = governanceAuthorityPayloadSchema.parse(payload);
  return unsignedAuthorityEnvelopeSchema.parse({
    protocol: GOVERNANCE_AUTHORITY_PROTOCOL,
    schema_version: GOVERNANCE_SIGNING_SCHEMA_VERSION,
    signed: signedPayload,
    event_id: await businessEventId(signedPayload),
    signatures: [],
  });
}

async function signPayload(payload: unknown, key: LocalSigningKey): Promise<BusinessSignature> {
  const keyIdValue = 'key_id' in key ? key.key_id : key.id;
  const keyValue = 'private_key' in key ? key.private_key : key.privateKey;
  assert(keyId.safeParse(keyIdValue).success, 'INVALID_SIGNING_KEY', 400);
  const parsed = keyValue;
  assert(parsed && parsed.type === 'private', 'INVALID_SIGNING_KEY', 400);
  return businessSignatureSchema.parse({
    key_id: keyIdValue,
    signature: await sign(payload, parsed, true),
  });
}

export async function signGovernanceEvent(
  payload: RoleRevokePayload,
  key: LocalSigningKey,
): Promise<BusinessSignature> {
  const parsed = roleRevokePayloadSchema.parse(payload);
  return signPayload(parsed, key);
}

export async function signAuthorityEvent(
  payload: GovernanceAuthorityPayload,
  key: LocalSigningKey,
): Promise<BusinessSignature> {
  const parsed = governanceAuthorityPayloadSchema.parse(payload);
  return signPayload(parsed, key);
}

export async function appendGovernanceSignature(
  envelope: UnsignedGovernanceEnvelope,
  next: BusinessSignature,
): Promise<UnsignedGovernanceEnvelope> {
  const parsed = unsignedGovernanceEnvelopeSchema.parse(envelope);
  await assertEnvelopeEventId(parsed);
  const signatureValue = businessSignatureSchema.parse(next);
  assert(
    !parsed.signatures.some((item) => item.key_id === signatureValue.key_id),
    'DUPLICATE_SIGNATURE',
    409,
  );
  return unsignedGovernanceEnvelopeSchema.parse({
    ...parsed,
    signatures: [...parsed.signatures, signatureValue],
  });
}

export async function appendAuthoritySignature(
  envelope: UnsignedAuthorityEnvelope,
  next: BusinessSignature,
): Promise<UnsignedAuthorityEnvelope> {
  const parsed = unsignedAuthorityEnvelopeSchema.parse(envelope);
  await assertEnvelopeEventId(parsed);
  const signatureValue = businessSignatureSchema.parse(next);
  assert(
    !parsed.signatures.some((item) => item.key_id === signatureValue.key_id),
    'DUPLICATE_SIGNATURE',
    409,
  );
  return unsignedAuthorityEnvelopeSchema.parse({
    ...parsed,
    signatures: [...parsed.signatures, signatureValue],
  });
}

export function finalizeGovernanceEnvelope(input: unknown): GovernanceEnvelope {
  return governanceEnvelopeSchema.parse(input);
}

export function finalizeAuthorityEnvelope(input: unknown): AuthorityEnvelope {
  return authorityEnvelopeSchema.parse(input);
}

/** Verify an authority statement against a pre-trusted root key set. */
export async function verifyAuthorityEnvelope(
  input: unknown,
  trustInput: AuthorityTrust | Record<string, unknown>,
  now?: Date | number,
): Promise<GovernanceAuthorityPayload> {
  const envelope = authorityEnvelopeSchema.parse(input);
  await assertEnvelopeEventId(envelope);
  const authority = envelope.signed;
  const current = currentMillis(now);
  assert(authority.status === 'active', 'AUTHORIZATION_REVOKED', 403);
  assertActiveWindow(authority.not_before, authority.expires_at, current, 'AUTHORIZATION_EXPIRED');
  const trust = normalizeTrust(trustInput);
  assert(trust.environment === authority.environment, 'TRUST_ENVIRONMENT_MISMATCH', 409);
  assert(trust.threshold === 2 && trust.key_ids.length === 3, 'ROOT_THRESHOLD_POLICY', 409);
  const validKeys = new Set<string>();
  for (const item of envelope.signatures) {
    if (!trust.key_ids.includes(item.key_id) || validKeys.has(item.key_id)) continue;
    const trustedPublic = publicKeyOf(trust.keys[item.key_id]);
    if (await verify(authority, item.signature, trustedPublic, true)) validKeys.add(item.key_id);
  }
  assert(validKeys.size >= trust.threshold, 'AUTHORIZATION_ROOT_THRESHOLD', 403);
  return authority;
}

export type GovernanceVerificationResult = {
  envelope: GovernanceEnvelope;
  authorization: GovernanceAuthorityPayload;
  event_id: string;
  signer_key_ids: string[];
  signer_person_ids: string[];
};

/**
 * Verify a role-revoke event against an already root-verified authority
 * statement.  The function counts canonical person IDs, never key count.
 */
export async function verifyGovernanceEnvelope(
  input: unknown,
  authorizationInput: GovernanceAuthorityPayload,
  options: GovernanceVerificationOptions = {},
): Promise<GovernanceVerificationResult> {
  const envelope = governanceEnvelopeSchema.parse(input);
  const authorization = governanceAuthorityPayloadSchema.parse(authorizationInput);
  await assertEnvelopeEventId(envelope);
  const payload = envelope.signed;
  const now = currentMillis(options.now);
  assert(authorization.status === 'active', 'AUTHORIZATION_REVOKED', 403);
  assertActiveWindow(
    authorization.not_before,
    authorization.expires_at,
    now,
    'AUTHORIZATION_EXPIRED',
  );
  assertActiveWindow(payload.not_before, payload.expires_at, now, 'SIGNATURE_EXPIRED');
  assert(
    Date.parse(payload.expires_at) <= Date.parse(authorization.expires_at),
    'SIGNATURE_OUTLIVES_AUTHORIZATION',
    409,
  );
  assert(payload.authority_id === authorization.authority_id, 'AUTHORITY_MISMATCH', 409);
  assert(payload.authority_revision === authorization.revision, 'AUTHORITY_REVISION_CONFLICT', 409);
  assert(payload.approval_ref === authorization.approval_ref, 'APPROVAL_REFERENCE_MISMATCH', 409);
  assert(payload.environment === authorization.environment, 'ENVIRONMENT_MISMATCH', 409);
  assert(payload.policy_version === authorization.policy_version, 'POLICY_VERSION_MISMATCH', 409);
  if (options.environment)
    assert(payload.environment === options.environment, 'ENVIRONMENT_MISMATCH', 409);
  if (options.policyVersion)
    assert(payload.policy_version === options.policyVersion, 'POLICY_VERSION_MISMATCH', 409);
  if (options.proposalId)
    assert(payload.proposal_id === options.proposalId, 'PROPOSAL_MISMATCH', 409);
  if (options.proposalRevision !== undefined)
    assert(payload.proposal_revision === options.proposalRevision, 'REVISION_CONFLICT', 409);
  if (options.grantId) assert(payload.grant_id === options.grantId, 'GRANT_MISMATCH', 409);
  if (options.grantRevision !== undefined)
    assert(payload.grant_revision === options.grantRevision, 'GRANT_REVISION_CONFLICT', 409);
  const targetPersonId = options.targetPersonId;
  const requiredCapability = options.requiredCapability ?? 'role.revoke';
  const members = new Map(authorization.members.map((member) => [member.key_id, member]));
  const signerKeyIds: string[] = [];
  const signerPeople = new Set<string>();
  for (const item of envelope.signatures) {
    if (signerKeyIds.includes(item.key_id)) throw new DomainError('DUPLICATE_SIGNATURE', 409);
    const member = members.get(item.key_id);
    if (!member || member.status !== 'active') continue;
    if (!member.capabilities.includes(requiredCapability)) continue;
    if (!member.scope.role_ids.includes(payload.grant_id)) continue;
    if (Date.parse(member.not_before) > now || Date.parse(member.expires_at) <= now) continue;
    if (targetPersonId && member.person_id === targetPersonId)
      throw new DomainError('SELF_AUTHORIZATION', 403);
    if (!(await verify(payload, item.signature, member.public_key, true))) continue;
    signerKeyIds.push(item.key_id);
    signerPeople.add(member.person_id);
  }
  assert(signerPeople.size >= authorization.threshold, 'INDEPENDENT_SIGNATURE_THRESHOLD', 403);
  return {
    envelope,
    authorization,
    event_id: envelope.event_id,
    signer_key_ids: signerKeyIds,
    signer_person_ids: [...signerPeople].sort(),
  };
}

export async function verifyTrustedGovernanceEnvelope(
  input: unknown,
  authorityInput: unknown,
  trustInput: AuthorityTrust | Record<string, unknown>,
  options: GovernanceVerificationOptions = {},
) {
  const authority = await verifyAuthorityEnvelope(authorityInput, trustInput, options.now);
  return verifyGovernanceEnvelope(input, authority, options);
}

/** Compare a private JWK's public half to the authorized business key. */
export async function assertSigningKeyAuthorized(
  key: LocalSigningKey,
  authorization: GovernanceAuthorityPayload,
) {
  const keyIdValue = 'key_id' in key ? key.key_id : key.id;
  const suppliedPublic = 'key_id' in key ? key.public_key : key.publicHex;
  const member = authorization.members.find((candidate) => candidate.key_id === keyIdValue);
  assert(member, 'SIGNING_KEY_NOT_AUTHORIZED', 403);
  assert(suppliedPublic, 'SIGNING_KEY_PUBLIC_REQUIRED', 400);
  assert(
    suppliedPublic.toLowerCase() === member.public_key.toLowerCase(),
    'SIGNING_KEY_MISMATCH',
    403,
  );
  return member;
}

/** Human-readable review text shown before a local signer asks for confirmation. */
export function formatSigningReview(
  payloadInput: RoleRevokePayload,
  authorizationInput: GovernanceAuthorityPayload,
  eventId: string,
) {
  const payload = roleRevokePayloadSchema.parse(payloadInput);
  const authorization = governanceAuthorityPayloadSchema.parse(authorizationInput);
  return [
    'WFD 治理业务签名待确认',
    `event_id: ${eventId}`,
    `对象: role_grant/${payload.grant_id}`,
    `目标成员标识: ${payload.target_principal_id}`,
    `权限: ${payload.target_role} · ${payload.target_capabilities.join(', ')}`,
    `范围: ${canonical(payload.target_scope)}`,
    `授权有效期: ${payload.not_before} → ${payload.expires_at}`,
    `目标授权有效期: ${payload.target_not_before} → ${payload.target_expires_at}`,
    `策略/版本: ${payload.policy_version} / proposal ${payload.proposal_id}@${payload.proposal_revision} / grant ${payload.grant_revision}`,
    `依据: ${payload.approval_ref}`,
    `原因: ${payload.reason}`,
    `可信授权: ${authorization.authority_id}@${authorization.revision} (${authorization.members.length} keys, ${authorization.threshold}-of-${authorization.members.length})`,
    `完整负载(JCS): ${canonical(payload)}`,
  ].join('\n');
}

export function requireConfirmation(confirmation: string | undefined, eventId: string) {
  assert(confirmation === eventId, 'CONFIRMATION_DIGEST_MISMATCH', 400);
}

type GrantRow = {
  grant_id: string;
  principal_id: string;
  person_id: string;
  role: string;
  capabilities: string;
  scope: string;
  issued_at: string;
  not_before: string;
  expires_at: string;
  grant_revision: number;
  status: 'active' | 'suspended' | 'revoked' | 'expired' | 'frozen';
  revocation_status: 'not_revoked' | 'suspended' | 'revoked';
};

export type CurrentExecutionAuthorizationInput = {
  identity?: Identity;
  actor_principal_id: string;
  capability: 'role.execute';
  object_type: Extract<AuthorizeInput['object_type'], 'role'>;
  object_id: string;
  scope: { role_ids: string[] };
  proposal_id: string;
  proposal_revision: number;
  event_id: string;
};

export type RoleRevokeExecutorOptions = {
  db: Database;
  loadEnvelope: (input: GovernanceExecutionInput) => Promise<unknown | null>;
  loadAuthorization: (input: GovernanceExecutionInput) => Promise<unknown | null>;
  /** Required for production; root-attested authority envelopes are verified locally. */
  authorityTrust?:
    | AuthorityTrust
    | Record<string, unknown>
    | (() => Promise<AuthorityTrust | Record<string, unknown>>);
  /** Alternative trusted loader for a deployment whose root verifier is outside this package. */
  verifyAuthorization?: (input: unknown, now: Date) => Promise<GovernanceAuthorityPayload>;
  authorizeCurrent?: (
    input: CurrentExecutionAuthorizationInput,
  ) => Promise<{ allowed: boolean; code?: string }>;
  /** Optional deployment-specific checks; the built-in DB binding check always runs first. */
  revalidateSignerBindings?: (input: GovernanceVerificationResult & { now: Date }) => Promise<void>;
  resolvePerson?: (principalId: string) => Promise<string>;
  environment: GovernanceEnvironment;
  policyVersion?: string | (() => string);
  clock?: () => Date;
};

type ExecutionReceiptRow = {
  execution_id: string;
  proposal_id: string;
  proposal_revision: number;
  payload_digest: string;
  event_id: string;
  result_json: string;
  created_at: string;
};

type LiveProposalRow = {
  id: string;
  state: string;
  revision: number;
  payload_digest: string;
};

const mutationGuard = (): Query[] => [
  { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
  { sql: 'DELETE FROM mutation_guard' },
];

function parseStoredJSON(value: string, code: string) {
  try {
    return strictJSON(value);
  } catch {
    throw new DomainError(code, 503);
  }
}

async function defaultResolvePerson(db: Database, principalId: string) {
  const [row] = await db.all<{ person_id: string }>(
    'SELECT person_id FROM principal_identities WHERE principal_id=? LIMIT 1',
    [principalId],
  );
  return row?.person_id ?? principalId;
}

async function readExecutionReceipt(db: Database, executionId: string) {
  try {
    const [row] = await db.all<ExecutionReceiptRow>(
      'SELECT execution_id,proposal_id,proposal_revision,payload_digest,event_id,result_json,created_at FROM governance_execution_receipts WHERE execution_id=?',
      [executionId],
    );
    return row ?? null;
  } catch {
    throw new DomainError('SIGNING_RECEIPT_STORAGE_UNAVAILABLE', 503);
  }
}

async function findExecutionReceipt(
  db: Database,
  proposalId: string,
  proposalRevision: number,
  payloadDigest: string,
) {
  try {
    const [row] = await db.all<ExecutionReceiptRow>(
      'SELECT execution_id,proposal_id,proposal_revision,payload_digest,event_id,result_json,created_at FROM governance_execution_receipts WHERE proposal_id=? AND proposal_revision=? AND payload_digest=?',
      [proposalId, proposalRevision, payloadDigest],
    );
    return row ?? null;
  } catch {
    throw new DomainError('SIGNING_RECEIPT_STORAGE_UNAVAILABLE', 503);
  }
}

async function assertLiveExecutionProposal(db: Database, input: GovernanceExecutionInput) {
  try {
    const [proposal] = await db.all<LiveProposalRow>(
      'SELECT id,state,revision,payload_digest FROM governance_proposals WHERE id=?',
      [input.proposal_id],
    );
    assert(proposal, 'PROPOSAL_NOT_FOUND', 404);
    assert(proposal.state === 'ready_to_execute', 'EXECUTION_NOT_READY', 409);
    assert(proposal.revision === input.proposal_revision, 'REVISION_CONFLICT', 409);
    assert(proposal.payload_digest === input.payload_digest, 'PROPOSAL_CONTENT_CHANGED', 409);
    return proposal;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('PROPOSAL_STORAGE_UNAVAILABLE', 503);
  }
}

function receiptResult(
  row: ExecutionReceiptRow,
  input: GovernanceExecutionInput,
): GovernanceExecutionResult {
  assert(
    row.proposal_id === input.proposal_id && row.proposal_revision === input.proposal_revision,
    'EXECUTION_ID_PAYLOAD_MISMATCH',
    409,
  );
  assert(row.payload_digest === input.payload_digest, 'EXECUTION_ID_PAYLOAD_MISMATCH', 409);
  const result = parseStoredJSON(row.result_json, 'SIGNING_RECEIPT_INVALID');
  assert(
    result && typeof result === 'object' && !Array.isArray(result),
    'SIGNING_RECEIPT_INVALID',
    503,
  );
  const parsed = result as Record<string, unknown>;
  assert(
    parsed.status === 'executed' || parsed.status === 'failed',
    'SIGNING_RECEIPT_INVALID',
    503,
  );
  return {
    status: parsed.status,
    result: parsed.result,
    reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
  };
}

function parseProposalBody(input: GovernanceExecutionInput) {
  const parsed = proposalPayloadSchema.parse(
    parseStoredJSON(input.body_json, 'PROPOSAL_BODY_INVALID'),
  );
  assert(parsed.proposal_type === 'role_revoke', 'UNSUPPORTED_EXECUTION_ACTION', 409);
  assert(parsed.affected_objects.length === 1, 'ROLE_REVOKE_TARGET_REQUIRED', 400);
  const [grantId] = parsed.affected_objects;
  assert(/^grant_[a-z0-9_-]{3,120}$/.test(grantId), 'ROLE_REVOKE_TARGET_INVALID', 400);
  return { proposal: parsed, grantId };
}

async function loadGrant(db: Database, grantId: string) {
  try {
    const [row] = await db.all<GrantRow>(
      `SELECT grant_id,principal_id,person_id,role,capabilities,scope,issued_at,not_before,expires_at,
              grant_revision,status,revocation_status
         FROM role_grants WHERE grant_id=?`,
      [grantId],
    );
    return row ?? null;
  } catch {
    throw new DomainError('EXECUTOR_STORAGE_UNAVAILABLE', 503);
  }
}

function normalizeGrant(row: GrantRow) {
  const capabilities = parseStoredJSON(row.capabilities, 'EXECUTOR_GRANT_INVALID');
  const scope = parseStoredJSON(row.scope, 'EXECUTOR_GRANT_INVALID');
  assert(Array.isArray(capabilities), 'EXECUTOR_GRANT_INVALID', 503);
  return {
    ...row,
    capabilities: z.array(capability).parse(capabilities),
    scope: governanceScopeSchema.parse(scope),
  };
}

/**
 * Revalidate every business signer against live private identity state.  A
 * root-attested authority is only a capability declaration; it cannot keep a
 * revoked key or role alive.  The signer must still have an active business
 * key bound to the same person and an active, scoped role grant.
 */
async function revalidateSignerBindings(
  db: Database,
  verification: GovernanceVerificationResult,
  now: Date,
  policyVersion: string,
) {
  const members = new Map(
    verification.authorization.members.map((member) => [member.key_id, member]),
  );
  try {
    for (const keyId of verification.signer_key_ids) {
      const member = members.get(keyId);
      assert(member, 'SIGNER_AUTHORIZATION_INVALID', 403);
      const [binding] = await db.all<{
        principal_id: string;
        person_id: string;
        principal_status: string;
        public_key: string;
        key_status: string;
        valid_from: string;
        expires_at: string | null;
      }>(
        `SELECT pk.principal_id,pi.person_id,pi.status AS principal_status,
                pk.public_key,pk.status AS key_status,pk.valid_from,pk.expires_at
           FROM principal_keys pk
           JOIN principal_identities pi ON pi.principal_id=pk.principal_id
          WHERE pk.key_id=? AND pk.purpose='business'`,
        [keyId],
      );
      assert(binding, 'SIGNER_KEY_NOT_BOUND', 403);
      assert(binding.principal_status === 'active', 'SIGNER_IDENTITY_REVOKED', 403);
      assert(binding.key_status === 'active', 'SIGNER_KEY_REVOKED', 403);
      assert(binding.person_id === member.person_id, 'SIGNER_PERSON_BINDING_MISMATCH', 403);
      assert(
        binding.public_key.toLowerCase() === member.public_key.toLowerCase(),
        'SIGNER_KEY_BINDING_MISMATCH',
        403,
      );
      assert(Date.parse(binding.valid_from) <= now.getTime(), 'SIGNER_KEY_NOT_YET_VALID', 403);
      assert(
        !binding.expires_at || Date.parse(binding.expires_at) > now.getTime(),
        'SIGNER_KEY_EXPIRED',
        403,
      );
      const grants = await db.all<{
        person_id: string;
        capabilities: string;
        scope: string;
        policy_version: string;
        status: string;
        revocation_status: string;
        not_before: string;
        expires_at: string;
      }>(
        `SELECT person_id,capabilities,scope,policy_version,status,revocation_status,not_before,expires_at
           FROM role_grants WHERE principal_id=?`,
        [binding.principal_id],
      );
      const authorized = grants.some((grant) => {
        if (
          grant.person_id !== member.person_id ||
          grant.policy_version !== policyVersion ||
          grant.status !== 'active' ||
          grant.revocation_status !== 'not_revoked' ||
          Date.parse(grant.not_before) > now.getTime() ||
          Date.parse(grant.expires_at) <= now.getTime()
        )
          return false;
        try {
          const capabilities = z
            .array(capability)
            .parse(parseStoredJSON(grant.capabilities, 'SIGNER_GRANT_INVALID'));
          const scope = governanceScopeSchema.parse(
            parseStoredJSON(grant.scope, 'SIGNER_GRANT_INVALID'),
          );
          return (
            capabilities.includes('role.revoke') &&
            scope.role_ids.includes(verification.envelope.signed.grant_id)
          );
        } catch {
          return false;
        }
      });
      assert(authorized, 'SIGNER_AUTHORIZATION_REVOKED', 403);
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('SIGNER_AUTHORIZATION_STORAGE_UNAVAILABLE', 503);
  }
}

/**
 * Build the only P0 concrete executor.  It requires an external envelope and
 * authority loader, rechecks the live executor authorization, then atomically
 * revokes a single grant and writes an execution receipt before returning.
 */
export function createRoleRevokeExecutor(options: RoleRevokeExecutorOptions): GovernanceExecutor {
  const clock = options.clock ?? (() => new Date());
  const resolvePerson =
    options.resolvePerson ??
    ((principalId: string) => defaultResolvePerson(options.db, principalId));
  return {
    async execute(input) {
      const existingByExecution = await readExecutionReceipt(options.db, input.execution_id);
      if (existingByExecution) return receiptResult(existingByExecution, input);
      const existingByProposal = await findExecutionReceipt(
        options.db,
        input.proposal_id,
        input.proposal_revision,
        input.payload_digest,
      );
      if (existingByProposal && existingByProposal.execution_id !== input.execution_id)
        throw new DomainError('EXECUTION_RECEIPT_EXISTS', 409);

      await assertLiveExecutionProposal(options.db, input);
      const { proposal, grantId } = parseProposalBody(input);
      const expectedDigest = await hash(utf8(canonical(proposal)));
      assert(expectedDigest === input.payload_digest, 'PROPOSAL_CONTENT_CHANGED', 409);
      const grantRow = await loadGrant(options.db, grantId);
      assert(grantRow, 'ROLE_GRANT_NOT_FOUND', 404);
      assert(
        grantRow.status === 'active' && grantRow.revocation_status === 'not_revoked',
        'ROLE_EXPIRED_OR_REVOKED',
        403,
      );
      const grant = normalizeGrant(grantRow);
      const rawEnvelope = await options.loadEnvelope(input);
      assert(rawEnvelope, 'SIGNING_ENVELOPE_UNAVAILABLE', 503);
      const envelope = governanceEnvelopeSchema.parse(
        typeof rawEnvelope === 'string' ? strictJSON(rawEnvelope) : rawEnvelope,
      );
      const rawAuthorization = await options.loadAuthorization(input);
      assert(rawAuthorization, 'SIGNING_AUTHORIZATION_UNAVAILABLE', 503);
      const current = clock();
      let authorization: GovernanceAuthorityPayload;
      if (options.verifyAuthorization) {
        authorization = await options.verifyAuthorization(rawAuthorization, current);
      } else {
        assert(options.authorityTrust, 'SIGNING_TRUST_UNAVAILABLE', 503);
        const trust =
          typeof options.authorityTrust === 'function'
            ? await options.authorityTrust()
            : options.authorityTrust;
        authorization = await verifyAuthorityEnvelope(rawAuthorization, trust, current);
      }
      const verified = await verifyGovernanceEnvelope(envelope, authorization, {
        now: current,
        environment: options.environment,
        policyVersion:
          typeof options.policyVersion === 'function'
            ? options.policyVersion()
            : options.policyVersion,
        proposalId: input.proposal_id,
        proposalRevision: input.proposal_revision,
        grantId,
        grantRevision: grant.grant_revision,
        targetPersonId: grant.person_id,
      });
      const policyVersion =
        typeof options.policyVersion === 'function'
          ? options.policyVersion()
          : (options.policyVersion ?? authorization.policy_version);
      await revalidateSignerBindings(options.db, verified, current, policyVersion);
      if (options.revalidateSignerBindings)
        await options.revalidateSignerBindings({ ...verified, now: current });
      assert(envelope.signed.target_role === grant.role, 'GRANT_CONTENT_CHANGED', 409);
      assert(
        envelope.signed.target_principal_id === grant.principal_id,
        'GRANT_CONTENT_CHANGED',
        409,
      );
      assert(
        canonical(envelope.signed.target_capabilities) === canonical(grant.capabilities),
        'GRANT_CONTENT_CHANGED',
        409,
      );
      assert(
        canonical(envelope.signed.target_scope) === canonical(grant.scope),
        'GRANT_CONTENT_CHANGED',
        409,
      );
      assert(envelope.signed.target_not_before === grant.not_before, 'GRANT_CONTENT_CHANGED', 409);
      assert(envelope.signed.target_expires_at === grant.expires_at, 'GRANT_CONTENT_CHANGED', 409);
      assert(options.authorizeCurrent, 'EXECUTOR_AUTHORIZATION_UNAVAILABLE', 503);
      const authorizationDecision = await options.authorizeCurrent({
        actor_principal_id: input.actor_principal_id,
        capability: 'role.execute',
        object_type: 'role',
        object_id: grant.grant_id,
        scope: { role_ids: [grant.grant_id] },
        proposal_id: input.proposal_id,
        proposal_revision: input.proposal_revision,
        event_id: verified.event_id,
      });
      if (authorizationDecision?.allowed !== true)
        throw new DomainError(authorizationDecision?.code ?? 'CAPABILITY_DENIED', 403);
      const actorPerson = await resolvePerson(input.actor_principal_id);
      assert(actorPerson !== grant.person_id, 'SELF_AUTHORIZATION', 403);

      const at = current.toISOString();
      const outboxId = `outbox_${crypto.randomUUID().replaceAll('-', '')}`;
      const auditId = `audit_${crypto.randomUUID().replaceAll('-', '')}`;
      const result: GovernanceExecutionResult = {
        status: 'executed',
        result: {
          action: 'role_revoke',
          grant_id: grant.grant_id,
          grant_revision: grant.grant_revision + 1,
          event_id: verified.event_id,
          signer_person_ids: verified.signer_person_ids,
        },
      };
      const resultJson = canonical(result);
      const outboxPayload = canonical({
        grant_id: grant.grant_id,
        principal_id: grant.principal_id,
        event_id: verified.event_id,
        proposal_id: input.proposal_id,
        proposal_revision: input.proposal_revision,
        reason: envelope.signed.reason,
      });
      await options.db.batch([
        {
          // This no-op update is an atomic compare-and-set guard.  It is
          // intentionally before the role mutation so a withdrawn/revised
          // proposal cannot be executed after the service's initial read.
          sql: `UPDATE governance_proposals SET updated_at=updated_at
                 WHERE id=? AND state='ready_to_execute' AND revision=? AND payload_digest=?`,
          params: [input.proposal_id, input.proposal_revision, input.payload_digest],
        },
        ...mutationGuard(),
        {
          sql: `UPDATE role_grants
                   SET status='revoked',revocation_status='revoked',revoked_at=?,
                       revocation_reason=?,grant_revision=grant_revision+1,updated_at=?
                 WHERE grant_id=? AND grant_revision=? AND status='active' AND revocation_status='not_revoked'`,
          params: [at, envelope.signed.reason, at, grant.grant_id, grant.grant_revision],
        },
        ...mutationGuard(),
        {
          sql: `DELETE FROM session
                 WHERE userId IN (SELECT user_id FROM principal_accounts WHERE principal_id=?)`,
          params: [grant.principal_id],
        },
        {
          sql: `UPDATE principal_api_credentials SET status='revoked',revoked_at=?
                 WHERE grant_id=? AND status='active'`,
          params: [at, grant.grant_id],
        },
        {
          sql: `UPDATE principal_keys SET status='revoked',revoked_at=?
                 WHERE principal_id=? AND purpose='business' AND status='active'`,
          params: [at, grant.principal_id],
        },
        {
          sql: `UPDATE case_assignments SET status='revoked',assignment_revision=assignment_revision+1
                 WHERE grant_id=? AND status IN ('assigned','accepted','in_progress')`,
          params: [grant.grant_id],
        },
        {
          sql: `UPDATE authorization_jobs SET state='blocked_by_revocation',version=version+1,updated_at=?
                 WHERE principal_id=? AND grant_id=? AND state IN ('queued','running')`,
          params: [at, grant.principal_id, grant.grant_id],
        },
        {
          sql: `INSERT INTO outbox_events
            (event_id,topic,aggregate_type,aggregate_id,aggregate_revision,payload_json,payload_hash,state,attempts,available_at,created_at)
            VALUES(?,?,?,?,?,?,?,'pending',0,?,?)`,
          params: [
            outboxId,
            'authorization.revoked',
            'role_grant',
            grant.grant_id,
            grant.grant_revision + 1,
            outboxPayload,
            await hash(utf8(outboxPayload)),
            at,
            at,
          ],
        },
        {
          sql: `INSERT INTO audit(id,item_id,actor,action,reason,created_at)
                VALUES(?,?,?,?,?,?)`,
          params: [
            auditId,
            grant.grant_id,
            actorPerson,
            'grant_revoked_by_governance',
            envelope.signed.reason,
            at,
          ],
        },
        {
          sql: `INSERT INTO governance_execution_receipts
            (execution_id,proposal_id,proposal_revision,payload_digest,event_id,result_json,created_at)
            VALUES(?,?,?,?,?,?,?)`,
          params: [
            input.execution_id,
            input.proposal_id,
            input.proposal_revision,
            input.payload_digest,
            verified.event_id,
            resultJson,
            at,
          ],
        },
      ]);
      return result;
    },
  };
}

export type RoleRevokeExecutor = GovernanceExecutor;
