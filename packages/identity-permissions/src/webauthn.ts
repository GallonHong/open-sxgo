import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import type { Database } from '../../db/src/adapter';
import { PermissionError, SESSION_IDLE_TIMEOUT_MS, SESSION_MAX_AGE_MS } from './index';

const challengeIdSchema = z.string().regex(/^challenge_[a-z0-9_-]{8,120}$/);
const principalIdSchema = z.string().regex(/^principal_[a-z0-9_-]{8,120}$/);
const userIdSchema = z.string().min(1).max(200);
const sessionIdSchema = z.string().min(1).max(200);

export type WebAuthnConfig = {
  rpID: string;
  origin: string | string[];
  rpName?: string;
  challengeTtlSeconds?: number;
  assuranceTtlSeconds?: number;
};

type SessionInput = {
  user_id: string;
  session_id: string;
  principal_id: string;
};

type StoredCredential = {
  credential_id: string;
  principal_id: string;
  user_id: string;
  rp_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string;
  status: 'active' | 'revoked' | 'frozen';
};

const nowIso = (now = new Date()) => now.toISOString();
const randomId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const bytes = (value: Uint8Array) => new Uint8Array(value);

function assertSessionShape(input: SessionInput) {
  userIdSchema.parse(input.user_id);
  sessionIdSchema.parse(input.session_id);
  principalIdSchema.parse(input.principal_id);
}

function guards() {
  // `mutation_guard` is part of the existing SQLite/D1 contract. An UPDATE
  // with no matching row inserts zero and causes the whole batch to roll back.
  return [
    { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
    { sql: 'DELETE FROM mutation_guard' },
  ];
}

async function sessionIsActive(db: Database, input: SessionInput, now: Date) {
  assertSessionShape(input);
  const [row] = await db.all<{ status: string; expires_at: number }>(
    `SELECT pi.status,s.expiresAt AS expires_at
       FROM principal_accounts pa
       JOIN principal_identities pi ON pi.principal_id=pa.principal_id
       JOIN session s ON s.id=? AND s.userId=pa.user_id AND s.expiresAt>?
      WHERE pa.user_id=? AND pa.principal_id=? AND pa.status='active'
        AND s.createdAt>? AND s.updatedAt>?`,
    [
      input.session_id,
      now.getTime(),
      input.user_id,
      input.principal_id,
      now.getTime() - SESSION_MAX_AGE_MS,
      now.getTime() - SESSION_IDLE_TIMEOUT_MS,
    ],
  );
  if (!row || row.status !== 'active') throw new PermissionError('AUTHENTICATION_REQUIRED', 401);
  return row.expires_at;
}

async function activeCredentials(
  db: Database,
  input: SessionInput,
  config: WebAuthnConfig,
  now: Date,
) {
  await sessionIsActive(db, input, now);
  return db.all<StoredCredential>(
    `SELECT credential_id,principal_id,user_id,rp_id,public_key,counter,transports,status
       FROM webauthn_credentials
      WHERE principal_id=? AND user_id=? AND rp_id=? AND status='active'`,
    [input.principal_id, input.user_id, config.rpID],
  );
}

async function requireCredentialRegistrationPermission(
  db: Database,
  input: SessionInput,
  config: WebAuthnConfig,
  now: Date,
) {
  const credentials = await activeCredentials(db, input, config, now);
  const [link] = await db.all<{ linked_by: string }>(
    `SELECT linked_by FROM principal_accounts
      WHERE user_id=? AND principal_id=? AND status='active'`,
    [input.user_id, input.principal_id],
  );
  // The first authenticator is only enrolled for a staff-approved active
  // binding. Subsequent authenticators require a fresh existing WebAuthn
  // step-up, so a password-only session cannot add a new high-trust key.
  if (!link || link.linked_by === 'self' || link.linked_by === 'user')
    throw new PermissionError('CAPABILITY_DENIED', 403);
  if (!credentials.length) return credentials;
  const [proof] = await db.all<{ assurance: string }>(
    `SELECT assurance FROM session_assurance
      WHERE session_id=? AND user_id=? AND assurance='webauthn_step_up' AND expires_at>?
      ORDER BY verified_at DESC LIMIT 1`,
    [input.session_id, input.user_id, nowIso(now)],
  );
  if (!proof) throw new PermissionError('WEBAUTHN_STEP_UP_REQUIRED', 403);
  return credentials;
}

/** Create browser registration options and persist the server challenge. */
export async function beginWebAuthnRegistration(
  db: Database,
  input: SessionInput,
  config: WebAuthnConfig,
  now = new Date(),
) {
  await sessionIsActive(db, input, now);
  const existing = await requireCredentialRegistrationPermission(db, input, config, now);
  const options = await generateRegistrationOptions({
    rpName: config.rpName ?? 'WFD 审核',
    rpID: config.rpID,
    userName: input.user_id,
    userID: new TextEncoder().encode(input.principal_id),
    timeout: 60_000,
    attestationType: 'none',
    excludeCredentials: existing.map((credential) => ({
      id: credential.credential_id,
      transports: credential.transports ? JSON.parse(credential.transports) : undefined,
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  const challengeId = randomId('challenge');
  const created = nowIso(now);
  const expires = new Date(now.getTime() + (config.challengeTtlSeconds ?? 60) * 1000).toISOString();
  await db.batch([
    {
      sql: `INSERT INTO webauthn_challenges
        (challenge_id,session_id,user_id,purpose,credential_id,challenge,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`,
      params: [
        challengeId,
        input.session_id,
        input.user_id,
        'registration',
        null,
        options.challenge,
        created,
        expires,
      ],
    },
    ...guards(),
  ]);
  return { challenge_id: challengeId, options, expires_at: expires };
}

/** Verify a registration response with SimpleWebAuthn and persist its public key. */
export async function finishWebAuthnRegistration(
  db: Database,
  input: SessionInput & { challenge_id: string; response: RegistrationResponseJSON },
  config: WebAuthnConfig,
  now = new Date(),
) {
  const sessionExpires = await sessionIsActive(db, input, now);
  await requireCredentialRegistrationPermission(db, input, config, now);
  const challengeId = challengeIdSchema.parse(input.challenge_id);
  const [challenge] = await db.all<{
    challenge_id: string;
    challenge: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT challenge_id,challenge,expires_at,consumed_at FROM webauthn_challenges
      WHERE challenge_id=? AND session_id=? AND user_id=? AND purpose='registration'`,
    [challengeId, input.session_id, input.user_id],
  );
  if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at) <= now.getTime())
    throw new PermissionError('WEBAUTHN_CHALLENGE_INVALID', 400);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserPresence: true,
      requireUserVerification: true,
    });
  } catch {
    // Do not expose parser details (origin, challenge, or credential data) to
    // the caller. The API contract has one stable failure code for all failed
    // registration ceremonies.
    throw new PermissionError('WEBAUTHN_VERIFICATION_FAILED', 403);
  }
  if (!verification.verified || !verification.registrationInfo?.userVerified)
    throw new PermissionError('WEBAUTHN_VERIFICATION_FAILED', 403);
  const info = verification.registrationInfo;
  const credential = info.credential;
  const at = nowIso(now);
  const credentialId = credential.id;
  const transports = JSON.stringify(input.response.response.transports ?? []);
  await db.batch([
    {
      sql: `UPDATE webauthn_challenges SET consumed_at=?
             WHERE challenge_id=? AND consumed_at IS NULL AND expires_at>?`,
      params: [at, challengeId, at],
    },
    ...guards(),
    {
      sql: `INSERT INTO webauthn_credentials
        (credential_id,principal_id,user_id,rp_id,public_key,counter,transports,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
      params: [
        credentialId,
        input.principal_id,
        input.user_id,
        config.rpID,
        bytes(credential.publicKey),
        credential.counter,
        transports,
        'active',
        at,
      ],
    },
    ...guards(),
  ]);
  return {
    credential_id: credentialId,
    session_id: input.session_id,
    session_expires_at: new Date(sessionExpires).toISOString(),
    user_verified: info.userVerified,
  };
}

/** Create a short-lived, session-bound step-up challenge. */
export async function beginWebAuthnStepUp(
  db: Database,
  input: SessionInput,
  config: WebAuthnConfig,
  now = new Date(),
) {
  const credentials = await activeCredentials(db, input, config, now);
  if (!credentials.length) throw new PermissionError('WEBAUTHN_REQUIRED', 403);
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credential_id,
      transports: credential.transports ? JSON.parse(credential.transports) : undefined,
    })),
    userVerification: 'required',
    timeout: 60_000,
  });
  const challengeId = randomId('challenge');
  const created = nowIso(now);
  const expires = new Date(now.getTime() + (config.challengeTtlSeconds ?? 60) * 1000).toISOString();
  await db.batch([
    {
      sql: `INSERT INTO webauthn_challenges
        (challenge_id,session_id,user_id,purpose,credential_id,challenge,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`,
      params: [
        challengeId,
        input.session_id,
        input.user_id,
        'step_up',
        null,
        options.challenge,
        created,
        expires,
      ],
    },
    ...guards(),
  ]);
  return { challenge_id: challengeId, options, expires_at: expires };
}

/** Verify a browser assertion and bind the proof to this exact session. */
export async function finishWebAuthnStepUp(
  db: Database,
  input: SessionInput & { challenge_id: string; response: AuthenticationResponseJSON },
  config: WebAuthnConfig,
  now = new Date(),
) {
  const sessionExpires = await sessionIsActive(db, input, now);
  const challengeId = challengeIdSchema.parse(input.challenge_id);
  const [challenge] = await db.all<{
    challenge_id: string;
    challenge: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT challenge_id,challenge,expires_at,consumed_at FROM webauthn_challenges
      WHERE challenge_id=? AND session_id=? AND user_id=? AND purpose='step_up'`,
    [challengeId, input.session_id, input.user_id],
  );
  if (!challenge || challenge.consumed_at || Date.parse(challenge.expires_at) <= now.getTime())
    throw new PermissionError('WEBAUTHN_CHALLENGE_INVALID', 400);
  const [credential] = await db.all<StoredCredential>(
    `SELECT credential_id,principal_id,user_id,rp_id,public_key,counter,transports,status
       FROM webauthn_credentials
      WHERE credential_id=? AND principal_id=? AND user_id=? AND rp_id=? AND status='active'`,
    [input.response.id, input.principal_id, input.user_id, config.rpID],
  );
  if (!credential) throw new PermissionError('WEBAUTHN_CREDENTIAL_NOT_FOUND', 403);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
      credential: {
        id: credential.credential_id,
        publicKey: bytes(credential.public_key),
        counter: credential.counter,
        transports: credential.transports ? JSON.parse(credential.transports) : undefined,
      },
    });
  } catch {
    // Parser errors include attacker-controlled origin/challenge text. Keep a
    // stable, non-sensitive protocol error for both browser and CLI callers.
    throw new PermissionError('WEBAUTHN_VERIFICATION_FAILED', 403);
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified)
    throw new PermissionError('WEBAUTHN_VERIFICATION_FAILED', 403);
  const at = nowIso(now);
  const assuranceExpires = new Date(
    Math.min(sessionExpires, now.getTime() + (config.assuranceTtlSeconds ?? 600) * 1000),
  ).toISOString();
  await db.batch([
    {
      sql: `UPDATE webauthn_challenges SET consumed_at=?
             WHERE challenge_id=? AND consumed_at IS NULL AND expires_at>?`,
      params: [at, challengeId, at],
    },
    ...guards(),
    {
      sql: `UPDATE webauthn_credentials SET counter=?,last_used_at=?
             WHERE credential_id=? AND status='active' AND counter=?`,
      params: [
        verification.authenticationInfo.newCounter,
        at,
        credential.credential_id,
        credential.counter,
      ],
    },
    ...guards(),
    {
      sql: `INSERT INTO session_assurance
        (assurance_id,session_id,user_id,method,assurance,credential_id,challenge_id,verified_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
      params: [
        randomId('assurance'),
        input.session_id,
        input.user_id,
        'webauthn',
        'webauthn_step_up',
        credential.credential_id,
        challengeId,
        at,
        assuranceExpires,
      ],
    },
    ...guards(),
  ]);
  return {
    session_id: input.session_id,
    credential_id: credential.credential_id,
    assurance: 'webauthn_step_up' as const,
    expires_at: assuranceExpires,
  };
}
