import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { z } from 'zod';
import { assert, DomainError } from '../packages/domain/src/index';
import {
  appendGovernanceSignature,
  assertSigningKeyAuthorized,
  businessEventId,
  createUnsignedGovernanceEnvelope,
  formatSigningReview,
  governanceAuthorityPayloadSchema,
  roleRevokePayloadSchema,
  signGovernanceEvent,
  unsignedGovernanceEnvelopeSchema,
  verifyGovernanceEnvelope,
  verifyAuthorityEnvelope,
  type AuthorityTrust,
  type LocalSigningKey,
  type UnsignedGovernanceEnvelope,
} from '../packages/governance-signing/src/index';
import { authorityEnvelopeSchema } from '../packages/governance-signing/src/index';
import { canonical, hex, strictJSON, verify } from '../packages/verifier/src/crypto';

const keyFileSchema = z.strictObject({
  keyid: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/),
  jwk: z.record(z.string(), z.unknown()),
});

function usage(): never {
  throw new DomainError(
    'USAGE: pnpm tsx scripts/governance-sign.ts <payload.json> <authority.json> <trust-root.json> <private-jwk.json> <output-envelope.json> [--input-envelope <partial.json>] [--confirm-event-id <sha256:...>]',
    400,
  );
}

function parseOption(args: string[], name: string) {
  const index = args.indexOf(name);
  const prefixed = args.find((item) => item.startsWith(`${name}=`));
  if (index >= 0 && prefixed) throw new DomainError('DUPLICATE_OPTION', 400);
  if (prefixed) return prefixed.slice(name.length + 1);
  if (index < 0) return undefined;
  assert(
    index + 1 < args.length && !args[index + 1].startsWith('--'),
    'OPTION_VALUE_REQUIRED',
    400,
  );
  return args[index + 1];
}

function assertKnownOptions(args: string[]) {
  for (let index = 0; index < args.length; index++) {
    const item = args[index];
    if (item === '--input-envelope' || item === '--confirm-event-id') {
      assert(
        index + 1 < args.length && !args[index + 1].startsWith('--'),
        'OPTION_VALUE_REQUIRED',
        400,
      );
      index++;
      continue;
    }
    if (
      item !== '--input-envelope' &&
      item !== '--confirm-event-id' &&
      !item.startsWith('--input-envelope=') &&
      !item.startsWith('--confirm-event-id=')
    )
      throw new DomainError('UNKNOWN_OPTION', 400);
  }
}

async function strictFile(path: string, code: string) {
  try {
    const file = await stat(path);
    assert(file.isFile(), 'INPUT_NOT_REGULAR', 400);
    assert(file.size <= 1024 * 1024, 'INPUT_TOO_LARGE', 413);
    const bytes = await readFile(path);
    assert(bytes.byteLength <= 1024 * 1024, 'INPUT_TOO_LARGE', 413);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return strictJSON(text);
  } catch (error) {
    if (
      error instanceof DomainError &&
      (error.code === 'INPUT_NOT_REGULAR' || error.code === 'INPUT_TOO_LARGE')
    )
      throw error;
    if (error instanceof DomainError) throw new DomainError(code, 400);
    throw new DomainError(code, 503);
  }
}

function parseStrict<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(code, 400);
  }
}

function decodeJwkPart(value: unknown) {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'INVALID_SIGNING_KEY', 400);
  const bytes = Buffer.from(value, 'base64url');
  assert(bytes.length === 32, 'INVALID_SIGNING_KEY', 400);
  assert(bytes.toString('base64url') === value, 'INVALID_SIGNING_KEY', 400);
  return bytes;
}

async function loadLocalSigningKey(path: string): Promise<LocalSigningKey> {
  const input = parseStrict(
    keyFileSchema,
    await strictFile(path, 'SIGNING_KEY_UNAVAILABLE'),
    'INVALID_SIGNING_KEY',
  );
  const jwk = input.jwk;
  assert(jwk.kty === 'OKP' && jwk.crv === 'Ed25519', 'INVALID_SIGNING_KEY', 400);
  const publicBytes = decodeJwkPart(jwk.x);
  decodeJwkPart(jwk.d);
  const privateKey = await crypto.subtle.importKey('jwk', jwk as JsonWebKey, 'Ed25519', false, [
    'sign',
  ]);
  return {
    key_id: input.keyid,
    private_key: privateKey,
    public_key: hex(publicBytes),
  };
}

async function verifyExistingSignatures(
  envelope: UnsignedGovernanceEnvelope,
  authority: ReturnType<typeof governanceAuthorityPayloadSchema.parse>,
  now: Date,
) {
  const members = new Map(authority.members.map((member) => [member.key_id, member]));
  const seen = new Set<string>();
  for (const item of envelope.signatures) {
    assert(!seen.has(item.key_id), 'DUPLICATE_SIGNATURE', 409);
    seen.add(item.key_id);
    const member = members.get(item.key_id);
    assert(member && member.status === 'active', 'EXISTING_SIGNATURE_UNAUTHORIZED', 403);
    assert(member.capabilities.includes('role.revoke'), 'EXISTING_SIGNATURE_UNAUTHORIZED', 403);
    assert(Date.parse(member.not_before) <= now.getTime(), 'EXISTING_SIGNATURE_NOT_YET_VALID', 403);
    assert(Date.parse(member.expires_at) > now.getTime(), 'EXISTING_SIGNATURE_EXPIRED', 403);
    assert(
      member.scope.role_ids.includes(envelope.signed.grant_id),
      'EXISTING_SIGNATURE_OUT_OF_SCOPE',
      403,
    );
    assert(
      await verify(envelope.signed, item.signature, member.public_key, true),
      'EXISTING_SIGNATURE_INVALID',
      403,
    );
  }
}

async function askForConfirmation(eventId: string, supplied: string | undefined) {
  if (supplied !== undefined) return supplied.trim();
  if (!stdin.isTTY || !stdout.isTTY) throw new DomainError('CONFIRMATION_REQUIRED', 400);
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return (await prompt.question('输入完整 event_id 以确认签署: ')).trim();
  } finally {
    prompt.close();
  }
}

async function main() {
  const [payloadPath, authorityPath, trustPath, keyPath, outputPath, ...options] =
    process.argv.slice(2);
  if (!payloadPath || !authorityPath || !trustPath || !keyPath || !outputPath) usage();
  assertKnownOptions(options);
  const inputEnvelopePath = parseOption(options, '--input-envelope');
  const suppliedConfirmation = parseOption(options, '--confirm-event-id');
  const now = new Date();

  const payload = parseStrict(
    roleRevokePayloadSchema,
    await strictFile(payloadPath, 'PAYLOAD_UNAVAILABLE'),
    'INVALID_PAYLOAD',
  );
  const authorityEnvelope = parseStrict(
    authorityEnvelopeSchema,
    await strictFile(authorityPath, 'AUTHORIZATION_UNAVAILABLE'),
    'INVALID_AUTHORIZATION',
  );
  const trust = (await strictFile(trustPath, 'TRUST_ROOT_UNAVAILABLE')) as AuthorityTrust;
  const authority = await verifyAuthorityEnvelope(authorityEnvelope, trust, now);
  assert(payload.authority_id === authority.authority_id, 'AUTHORITY_MISMATCH', 409);
  assert(payload.authority_revision === authority.revision, 'AUTHORITY_REVISION_CONFLICT', 409);
  assert(payload.approval_ref === authority.approval_ref, 'APPROVAL_REFERENCE_MISMATCH', 409);
  assert(payload.environment === authority.environment, 'ENVIRONMENT_MISMATCH', 409);
  assert(payload.policy_version === authority.policy_version, 'POLICY_VERSION_MISMATCH', 409);
  assert(
    Date.parse(payload.expires_at) <= Date.parse(authority.expires_at),
    'SIGNATURE_OUTLIVES_AUTHORIZATION',
    409,
  );
  const payloadStart = Date.parse(payload.not_before);
  const payloadEnd = Date.parse(payload.expires_at);
  assert(now.getTime() >= payloadStart, 'SIGNATURE_NOT_YET_VALID', 409);
  assert(now.getTime() < payloadEnd, 'SIGNATURE_EXPIRED', 409);

  const key = await loadLocalSigningKey(keyPath);
  const member = await assertSigningKeyAuthorized(key, authority);
  assert(member.status === 'active', 'SIGNING_KEY_REVOKED', 403);
  assert(member.capabilities.includes('role.revoke'), 'SIGNING_KEY_UNAUTHORIZED', 403);
  assert(member.scope.role_ids.includes(payload.grant_id), 'SIGNING_KEY_OUT_OF_SCOPE', 403);
  assert(Date.parse(member.not_before) <= now.getTime(), 'SIGNING_KEY_NOT_YET_VALID', 403);
  assert(Date.parse(member.expires_at) > now.getTime(), 'SIGNING_KEY_EXPIRED', 403);

  let envelope: UnsignedGovernanceEnvelope;
  if (inputEnvelopePath) {
    envelope = parseStrict(
      unsignedGovernanceEnvelopeSchema,
      await strictFile(inputEnvelopePath, 'ENVELOPE_UNAVAILABLE'),
      'INVALID_ENVELOPE',
    );
    assert(canonical(envelope.signed) === canonical(payload), 'ENVELOPE_PAYLOAD_MISMATCH', 409);
    await verifyExistingSignatures(envelope, authority, now);
  } else {
    envelope = await createUnsignedGovernanceEnvelope(payload);
  }
  const eventId = await businessEventId(payload);
  assert(envelope.event_id === eventId, 'EVENT_ID_MISMATCH', 409);
  const review = formatSigningReview(payload, authority, eventId);
  console.error(review);
  const confirmation = await askForConfirmation(eventId, suppliedConfirmation);
  if (confirmation === undefined) throw new DomainError('CONFIRMATION_REQUIRED', 400);
  assert(confirmation === eventId, 'CONFIRMATION_DIGEST_MISMATCH', 400);
  const signed = await appendGovernanceSignature(envelope, await signGovernanceEvent(payload, key));
  let complete = false;
  if (signed.signatures.length >= 2) {
    await verifyGovernanceEnvelope(signed, authority, {
      now,
      environment: payload.environment,
      policyVersion: payload.policy_version,
      proposalId: payload.proposal_id,
      proposalRevision: payload.proposal_revision,
      grantId: payload.grant_id,
      grantRevision: payload.grant_revision,
    });
    complete = true;
  }
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, canonical(signed), { flag: 'wx', mode: 0o600 });
  const keyId = 'key_id' in key ? key.key_id : key.id;
  console.log(
    JSON.stringify({
      signed_envelope: outputPath,
      event_id: eventId,
      key_id: keyId,
      signature_count: signed.signatures.length,
      complete,
      state: complete ? 'complete' : 'partial',
    }),
  );
}

try {
  await main();
} catch (error) {
  const code = error instanceof DomainError ? error.code : 'SIGNING_TOOL_FAILED';
  console.error(JSON.stringify({ ok: false, code }));
  process.exitCode = 1;
}
