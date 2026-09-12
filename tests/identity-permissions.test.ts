import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign as signData } from 'node:crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { testDatabase } from './support/database';
import type { Database } from '../packages/db/src/adapter';
import {
  assignCase,
  authorize,
  enqueueAuthorizedJob,
  grantScopeSchema,
  PermissionError,
  reauthorizeJob,
  resolveIdentity,
  revokeGrant,
  roleGrantSchema,
  type Capability,
  type GrantScope,
} from '../packages/identity-permissions/src/index';
import {
  beginWebAuthnRegistration,
  beginWebAuthnStepUp,
  finishWebAuthnStepUp,
  type WebAuthnConfig,
} from '../packages/identity-permissions/src/webauthn';

const NOW = new Date('2026-09-12T00:00:00.000Z');
const later = new Date('2026-09-13T12:00:00.000Z').toISOString();

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

type IdentitySeed = {
  user_id: string;
  principal_id: string;
  person_id: string;
  grant_id: string;
  session_id: string;
  capabilities?: Capability[];
  scope?: Partial<GrantScope>;
  status?: 'active' | 'demo_only';
  linked_by?: string;
  assurance?: boolean;
};

async function seedIdentity(db: Database, input: IdentitySeed) {
  const at = NOW.toISOString();
  const scope = { ...emptyScope(), ...(input.scope ?? {}) };
  grantScopeSchema.parse(scope);
  const capabilities = input.capabilities ?? ['case.submit_decision'];
  await db.batch([
    {
      sql: 'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
      params: [
        input.user_id,
        input.user_id,
        `${input.user_id}@example.org`,
        1,
        NOW.getTime(),
        NOW.getTime(),
      ],
    },
    {
      sql: 'INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
      params: [
        input.session_id,
        Date.parse(later),
        `token-${input.session_id}`,
        NOW.getTime(),
        NOW.getTime(),
        input.user_id,
      ],
    },
    {
      sql: 'INSERT INTO principal_identities(principal_id,person_id,status,privacy_preferences,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      params: [input.principal_id, input.person_id, input.status ?? 'active', '{}', at, at],
    },
    {
      sql: 'INSERT INTO principal_accounts(user_id,principal_id,status,linked_at,linked_by,account_revision) VALUES(?,?,?,?,?,?)',
      params: [input.user_id, input.principal_id, 'active', at, input.linked_by ?? 'staff', 1],
    },
    {
      sql: `INSERT INTO role_grants
        (grant_id,principal_id,person_id,role,capabilities,scope,issued_at,not_before,expires_at,policy_version,approval_ref,grant_revision,status,revocation_status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        input.grant_id,
        input.principal_id,
        input.person_id,
        'reviewer',
        JSON.stringify(capabilities),
        JSON.stringify(scope),
        at,
        at,
        later,
        'policy-test-1',
        'approval-test-1',
        1,
        'active',
        'not_revoked',
        at,
        at,
      ],
    },
    ...(input.assurance === false
      ? []
      : [
          {
            sql: `INSERT INTO session_assurance
              (assurance_id,session_id,user_id,method,assurance,challenge_id,verified_at,expires_at)
              VALUES(?,?,?,?,?,?,?,?)`,
            params: [
              `assurance_${input.session_id}`,
              input.session_id,
              input.user_id,
              'webauthn',
              'basic',
              `challenge_old_${input.session_id}`,
              new Date(NOW.getTime() - 60_000).toISOString(),
              later,
            ],
          },
          {
            sql: `INSERT INTO session_assurance
              (assurance_id,session_id,user_id,method,assurance,challenge_id,verified_at,expires_at)
              VALUES(?,?,?,?,?,?,?,?)`,
            params: [
              `assurance_step_${input.session_id}`,
              input.session_id,
              input.user_id,
              'webauthn',
              'webauthn_step_up',
              `challenge_step_${input.session_id}`,
              NOW.toISOString(),
              later,
            ],
          },
        ]),
  ]);
}

async function seedReviewCase(db: Database, caseId = 'case_assignment_1') {
  await db.batch([
    {
      sql: 'INSERT INTO review_cases(id,submission_id,current_revision,state,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      params: [caseId, `submission_${caseId}`, 0, 'open', NOW.toISOString(), NOW.toISOString()],
    },
  ]);
  return caseId;
}

function makeCosePublicKey(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']) {
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey & { x: string; y: string };
  return isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, isoBase64URL.toBuffer(jwk.x)],
      [-3, isoBase64URL.toBuffer(jwk.y)],
    ]),
  );
}

function makeAssertion(
  challenge: string,
  origin: string,
  rpId: string,
  credentialId: string,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  counter: number,
  flags = 0x05,
): AuthenticationResponseJSON {
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge, origin }),
    'utf8',
  );
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  const authenticatorData = Buffer.concat([
    createHash('sha256').update(rpId).digest(),
    Buffer.from([flags]),
    counterBytes,
  ]);
  const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
  const signature = signData('sha256', Buffer.concat([authenticatorData, clientDataHash]), {
    key: privateKey,
    dsaEncoding: 'der',
  });
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: clientDataJSON.toString('base64url'),
      authenticatorData: authenticatorData.toString('base64url'),
      signature: signature.toString('base64url'),
    },
    clientExtensionResults: {},
  };
}

for (const adapter of ['sqlite', 'd1'] as const) {
  describe(`identity permissions (${adapter})`, () => {
    let db: Database;
    let close: () => Promise<void>;

    beforeEach(async () => {
      const opened = await testDatabase(adapter);
      db = opened.db;
      close = opened.close;
    });
    afterEach(async () => close?.());

    it('resolver returns the bound session and latest assurance, never storage bookkeeping', async () => {
      await seedIdentity(db, {
        user_id: 'user_resolve',
        principal_id: 'principal_resolve1',
        person_id: 'person_resolve',
        grant_id: 'grant_resolve1',
        session_id: 'session_resolve',
        scope: { case_ids: ['case_resolve_1'] },
      });
      const identity = await resolveIdentity(db, {
        user_id: 'user_resolve',
        session_id: 'session_resolve',
        now: NOW,
      });
      expect(identity?.session_id).toBe('session_resolve');
      expect(identity?.assurance).toBe('webauthn_step_up');
      expect(identity?.grants).toHaveLength(1);
      expect(identity?.grants[0]).not.toHaveProperty('created_at');
      expect(identity?.grants[0]).not.toHaveProperty('updated_at');
    });

    it('hard and idle session windows reject expired sessions and cannot be refreshed by a rejected request', async () => {
      await seedIdentity(db, {
        user_id: 'user_timeout',
        principal_id: 'principal_timeout1',
        person_id: 'person_timeout',
        grant_id: 'grant_timeout1',
        session_id: 'session_timeout',
        scope: { case_ids: ['case_timeout_1'] },
      });
      const identity = (await resolveIdentity(db, {
        user_id: 'user_timeout',
        session_id: 'session_timeout',
        now: NOW,
      }))!;
      await db.batch([
        {
          sql: 'UPDATE session SET updatedAt=? WHERE id=?',
          params: [NOW.getTime() - 31 * 60_000, 'session_timeout'],
        },
      ]);
      expect(
        await resolveIdentity(db, {
          user_id: 'user_timeout',
          session_id: 'session_timeout',
          now: NOW,
        }),
      ).toBeNull();
      expect(
        (
          await authorize(db, identity, {
            capability: 'case.submit_decision',
            object_type: 'case',
            object_id: 'case_timeout_1',
            now: NOW,
          })
        ).allowed,
      ).toBe(false);
      const [afterRejectedRequest] = await db.all<{ updatedAt: number }>(
        'SELECT updatedAt FROM session WHERE id=?',
        ['session_timeout'],
      );
      expect(afterRejectedRequest.updatedAt).toBe(NOW.getTime() - 31 * 60_000);
      await db.batch([
        {
          sql: 'UPDATE session SET updatedAt=?,createdAt=? WHERE id=?',
          params: [NOW.getTime(), NOW.getTime() - 9 * 3600_000, 'session_timeout'],
        },
      ]);
      expect(
        await resolveIdentity(db, {
          user_id: 'user_timeout',
          session_id: 'session_timeout',
          now: NOW,
        }),
      ).toBeNull();
    });

    it('scope authorization is fail-closed for missing IDs, empty requested lists, and contribution domains', async () => {
      await seedIdentity(db, {
        user_id: 'user_scope',
        principal_id: 'principal_scope001',
        person_id: 'person_scope',
        grant_id: 'grant_scope_001',
        session_id: 'session_scope',
        capabilities: ['contribution.assess'],
        scope: { contribution_domains: ['data'] },
      });
      const identity = (await resolveIdentity(db, {
        user_id: 'user_scope',
        session_id: 'session_scope',
        now: NOW,
      }))!;
      const allowed = await authorize(db, identity, {
        capability: 'contribution.assess',
        object_type: 'contribution',
        object_id: 'data',
        scope: { contribution_domains: ['data'] },
        now: NOW,
      });
      expect(allowed.allowed).toBe(true);
      expect(
        (
          await authorize(db, identity, {
            capability: 'contribution.assess',
            object_type: 'contribution',
            scope: { contribution_domains: ['data'] },
            now: NOW,
          })
        ).allowed,
      ).toBe(false);
      expect(
        (
          await authorize(db, identity, {
            capability: 'contribution.assess',
            object_type: 'contribution',
            object_id: 'data',
            scope: { contribution_domains: [] },
            now: NOW,
          })
        ).allowed,
      ).toBe(false);
      expect(() =>
        grantScopeSchema.parse({ ...emptyScope(), contribution_domains: ['*'] }),
      ).toThrow();
    });

    it('demo-only identities resolve for display but can never authorize a capability', async () => {
      await seedIdentity(db, {
        user_id: 'user_demo',
        principal_id: 'principal_demo001',
        person_id: 'person_demo',
        grant_id: 'grant_demo_001',
        session_id: 'session_demo',
        status: 'demo_only',
        scope: { case_ids: ['case_demo_1'] },
      });
      const identity = (await resolveIdentity(db, {
        user_id: 'user_demo',
        session_id: 'session_demo',
        now: NOW,
      }))!;
      expect(identity.status).toBe('demo_only');
      expect(
        (
          await authorize(db, identity, {
            capability: 'case.submit_decision',
            object_type: 'case',
            object_id: 'case_demo_1',
            now: NOW,
          })
        ).allowed,
      ).toBe(false);
    });

    it('assignment uses review_cases revision zero and enforces independent person cardinality', async () => {
      const caseId = await seedReviewCase(db);
      await seedIdentity(db, {
        user_id: 'user_primary',
        principal_id: 'principal_primary1',
        person_id: 'person_shared',
        grant_id: 'grant_primary1',
        session_id: 'session_primary',
        scope: { case_ids: [caseId] },
      });
      await seedIdentity(db, {
        user_id: 'user_secondary',
        principal_id: 'principal_secondary1',
        person_id: 'person_shared',
        grant_id: 'grant_secondary1',
        session_id: 'session_secondary',
        capabilities: ['case.independent_review'],
        scope: { case_ids: [caseId] },
      });
      const first = await assignCase(db, {
        case_id: caseId,
        candidate_revision: 1,
        stage: 'primary',
        principal_id: 'principal_primary1',
        person_id: 'person_shared',
        grant_id: 'grant_primary1',
        expires_at: later,
        expected_case_revision: 0,
      });
      expect(first.candidate_revision).toBe(1);
      await expect(
        assignCase(db, {
          case_id: caseId,
          candidate_revision: 1,
          stage: 'secondary',
          principal_id: 'principal_secondary1',
          person_id: 'person_shared',
          grant_id: 'grant_secondary1',
          expires_at: later,
          expected_case_revision: 0,
        }),
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
      await expect(
        assignCase(db, {
          case_id: caseId,
          candidate_revision: 2,
          stage: 'secondary',
          principal_id: 'principal_secondary1',
          person_id: 'person_shared',
          grant_id: 'grant_secondary1',
          expires_at: later,
          expected_case_revision: 1,
        }),
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });
      const [row] = await db.all<{ count: number }>(
        'SELECT COUNT(*) AS count FROM case_assignments',
      );
      expect(row.count).toBe(1);
    });

    it('revocation atomically removes access and blocks queued work with a hashed outbox event', async () => {
      const caseId = await seedReviewCase(db, 'case_revoke_1');
      await seedIdentity(db, {
        user_id: 'user_revoke',
        principal_id: 'principal_revoke001',
        person_id: 'person_revoke',
        grant_id: 'grant_revoke001',
        session_id: 'session_revoke',
        scope: { case_ids: [caseId] },
      });
      await assignCase(db, {
        case_id: caseId,
        candidate_revision: 1,
        stage: 'primary',
        principal_id: 'principal_revoke001',
        person_id: 'person_revoke',
        grant_id: 'grant_revoke001',
        expires_at: later,
        expected_case_revision: 0,
      });
      await db.batch([
        {
          sql: `INSERT INTO principal_api_credentials
            (credential_id,principal_id,grant_id,secret_hash,status,issued_at,expires_at)
            VALUES(?,?,?,?,?,?,?)`,
          params: [
            'api_revoke_1',
            'principal_revoke001',
            'grant_revoke001',
            'hash',
            'active',
            NOW.toISOString(),
            later,
          ],
        },
        {
          sql: `INSERT INTO principal_keys
            (key_id,principal_id,purpose,public_key,algorithm,valid_from,status,created_at)
            VALUES(?,?,?,?,?,?,?,?)`,
          params: [
            'key_revoke_1',
            'principal_revoke001',
            'business',
            'pub',
            'Ed25519',
            NOW.toISOString(),
            'active',
            NOW.toISOString(),
          ],
        },
      ]);
      const identity = (await resolveIdentity(db, {
        user_id: 'user_revoke',
        session_id: 'session_revoke',
        now: NOW,
      }))!;
      const job = await enqueueAuthorizedJob(db, identity, {
        job_id: 'job_revoke_1',
        kind: 'source-fetch',
        capability: 'case.submit_decision',
        object_type: 'case',
        object_id: caseId,
        scope: { case_ids: [caseId] },
        input_ref: 'input-revoke-1',
        now: NOW,
      });
      expect(job.state).toBe('queued');
      const result = await revokeGrant(db, {
        grant_id: 'grant_revoke001',
        expected_revision: 1,
        reason: '独立复核发现授权不再适用',
        actor_person_id: 'person_operator',
      });
      expect(result.grant_revision).toBe(2);
      expect(await db.all('SELECT id FROM session WHERE id=?', ['session_revoke'])).toHaveLength(0);
      expect(
        (
          await db.all<{ status: string }>(
            'SELECT status FROM principal_api_credentials WHERE credential_id=?',
            ['api_revoke_1'],
          )
        )[0].status,
      ).toBe('revoked');
      expect(
        (
          await db.all<{ status: string }>('SELECT status FROM principal_keys WHERE key_id=?', [
            'key_revoke_1',
          ])
        )[0].status,
      ).toBe('revoked');
      expect(
        (
          await db.all<{ status: string }>('SELECT status FROM case_assignments WHERE grant_id=?', [
            'grant_revoke001',
          ])
        )[0].status,
      ).toBe('revoked');
      expect(
        (
          await db.all<{ state: string }>('SELECT state FROM authorization_jobs WHERE job_id=?', [
            'job_revoke_1',
          ])
        )[0].state,
      ).toBe('blocked_by_revocation');
      const [event] = await db.all<{ payload_json: string; payload_hash: string }>(
        'SELECT payload_json,payload_hash FROM outbox_events WHERE event_id LIKE ?',
        ['outbox_%'],
      );
      expect(event.payload_hash).toBe(
        createHash('sha256').update(event.payload_json).digest('hex'),
      );
      expect(
        await reauthorizeJob(db, {
          job_id: 'job_revoke_1',
          principal_id: 'principal_revoke001',
          grant_id: 'grant_revoke001',
          expected_grant_revision: 1,
          state: 'queued',
        }),
      ).toBe(false);
      expect(
        (
          await authorize(db, identity, {
            capability: 'case.submit_decision',
            object_type: 'case',
            object_id: caseId,
            now: NOW,
          })
        ).allowed,
      ).toBe(false);
    });

    it('WebAuthn options and verification use the real verifier, session binding, UV and replay checks', async () => {
      const rpID = 'localhost';
      const origin = 'http://localhost:8787';
      const config: WebAuthnConfig = { rpID, origin, rpName: 'WFD test', challengeTtlSeconds: 60 };
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const credentialId = randomBytes(16).toString('base64url');
      await seedIdentity(db, {
        user_id: 'user_webauthn',
        principal_id: 'principal_webauthn1',
        person_id: 'person_webauthn',
        grant_id: 'grant_webauthn1',
        session_id: 'session_webauthn',
        assurance: false,
        scope: { case_ids: ['case_webauthn_1'] },
      });
      await db.batch([
        {
          sql: `INSERT INTO webauthn_credentials
            (credential_id,principal_id,user_id,rp_id,public_key,counter,transports,status,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)`,
          params: [
            credentialId,
            'principal_webauthn1',
            'user_webauthn',
            rpID,
            new Uint8Array(makeCosePublicKey(publicKey)),
            0,
            '["internal"]',
            'active',
            NOW.toISOString(),
          ],
        },
      ]);
      await expect(
        beginWebAuthnRegistration(
          db,
          {
            user_id: 'user_webauthn',
            principal_id: 'principal_webauthn1',
            session_id: 'session_webauthn',
          },
          config,
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'WEBAUTHN_STEP_UP_REQUIRED' });
      const first = await beginWebAuthnStepUp(
        db,
        {
          user_id: 'user_webauthn',
          principal_id: 'principal_webauthn1',
          session_id: 'session_webauthn',
        },
        config,
        NOW,
      );
      expect(first.options.rpId).toBe(rpID);
      const valid = makeAssertion(
        first.options.challenge,
        origin,
        rpID,
        credentialId,
        privateKey,
        1,
      );
      const assurance = await finishWebAuthnStepUp(
        db,
        {
          user_id: 'user_webauthn',
          principal_id: 'principal_webauthn1',
          session_id: 'session_webauthn',
          challenge_id: first.challenge_id,
          response: valid,
        },
        config,
        NOW,
      );
      expect(assurance.assurance).toBe('webauthn_step_up');
      expect(
        (
          await db.all<{ counter: number }>(
            'SELECT counter FROM webauthn_credentials WHERE credential_id=?',
            [credentialId],
          )
        )[0].counter,
      ).toBe(1);
      await expect(
        finishWebAuthnStepUp(
          db,
          {
            user_id: 'user_webauthn',
            principal_id: 'principal_webauthn1',
            session_id: 'session_webauthn',
            challenge_id: first.challenge_id,
            response: valid,
          },
          config,
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'WEBAUTHN_CHALLENGE_INVALID' });

      const wrongOriginChallenge = await beginWebAuthnStepUp(
        db,
        {
          user_id: 'user_webauthn',
          principal_id: 'principal_webauthn1',
          session_id: 'session_webauthn',
        },
        config,
        NOW,
      );
      await expect(
        finishWebAuthnStepUp(
          db,
          {
            user_id: 'user_webauthn',
            principal_id: 'principal_webauthn1',
            session_id: 'session_webauthn',
            challenge_id: wrongOriginChallenge.challenge_id,
            response: makeAssertion(
              wrongOriginChallenge.options.challenge,
              'https://evil.example',
              rpID,
              credentialId,
              privateKey,
              2,
            ),
          },
          config,
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'WEBAUTHN_VERIFICATION_FAILED' });

      const noUvChallenge = await beginWebAuthnStepUp(
        db,
        {
          user_id: 'user_webauthn',
          principal_id: 'principal_webauthn1',
          session_id: 'session_webauthn',
        },
        config,
        NOW,
      );
      await expect(
        finishWebAuthnStepUp(
          db,
          {
            user_id: 'user_webauthn',
            principal_id: 'principal_webauthn1',
            session_id: 'session_webauthn',
            challenge_id: noUvChallenge.challenge_id,
            response: makeAssertion(
              noUvChallenge.options.challenge,
              origin,
              rpID,
              credentialId,
              privateKey,
              2,
              0x01,
            ),
          },
          config,
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'WEBAUTHN_VERIFICATION_FAILED' });

      await db.batch([
        {
          sql: 'INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
          params: [
            'session_webauthn_2',
            NOW.getTime() + 8 * 3600_000,
            'token-session_webauthn_2',
            NOW.getTime(),
            NOW.getTime(),
            'user_webauthn',
          ],
        },
      ]);
      const boundChallenge = await beginWebAuthnStepUp(
        db,
        {
          user_id: 'user_webauthn',
          principal_id: 'principal_webauthn1',
          session_id: 'session_webauthn',
        },
        config,
        NOW,
      );
      await expect(
        finishWebAuthnStepUp(
          db,
          {
            user_id: 'user_webauthn',
            principal_id: 'principal_webauthn1',
            session_id: 'session_webauthn_2',
            challenge_id: boundChallenge.challenge_id,
            response: makeAssertion(
              boundChallenge.options.challenge,
              origin,
              rpID,
              credentialId,
              privateKey,
              2,
            ),
          },
          config,
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'WEBAUTHN_CHALLENGE_INVALID' });
    });

    it('strict grant schema rejects private storage fields', () => {
      expect(() =>
        roleGrantSchema.parse({
          grant_id: 'grant_schema_1',
          principal_id: 'principal_schema1',
          person_id: 'person_schema',
          role: 'reviewer',
          capabilities: ['case.submit_decision'],
          scope: { ...emptyScope(), case_ids: ['case_schema_1'] },
          issued_at: NOW.toISOString(),
          not_before: NOW.toISOString(),
          expires_at: later,
          policy_version: 'policy-test-1',
          approval_ref: 'approval-test-1',
          grant_revision: 1,
          status: 'active',
          revocation_status: 'not_revoked',
          revoked_at: null,
          revocation_reason: null,
          created_at: NOW.toISOString(),
        }),
      ).toThrow();
    });
  });
}

// Keep the imported error type live in generated declaration output and make
// the assertion above explicit for adapters that wrap errors.
void PermissionError;
