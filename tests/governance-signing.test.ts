import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Database } from '../packages/db/src/adapter';
import { newKey } from '../packages/builder/src/index';
import { testDatabase, databaseAdapters } from './support/database';
import {
  appendAuthoritySignature,
  appendGovernanceSignature,
  businessEventId,
  createRoleRevokeExecutor,
  createUnsignedAuthorityEnvelope,
  createUnsignedGovernanceEnvelope,
  finalizeAuthorityEnvelope,
  finalizeGovernanceEnvelope,
  formatSigningReview,
  governanceEnvelopeSchema,
  governanceAuthorityPayloadSchema,
  governanceScopeSchema,
  requireConfirmation,
  signAuthorityEvent,
  signGovernanceEvent,
  verifyAuthorityEnvelope,
  verifyGovernanceEnvelope,
  type AuthorityTrust,
  type GovernanceAuthorityPayload,
  type GovernanceScope,
  type RoleRevokePayload,
} from '../packages/governance-signing/src';
import { canonical, hash, strictJSON, utf8 } from '../packages/verifier/src/crypto';

const execFileAsync = promisify(execFile);

const now = new Date('2026-09-12T08:00:00.000Z');
const notBefore = '2026-09-12T00:00:00.000Z';
const expiresAt = '2026-09-13T00:00:00.000Z';
const targetExpiresAt = '2026-12-11T00:00:00.000Z';
const grantId = 'grant_revoke_target';
const proposalId = 'gov_revoke_proposal';

function emptyScope(roleIds: string[] = []): GovernanceScope {
  return governanceScopeSchema.parse({
    source_types: [],
    regions: [],
    labor_rule_fields: [],
    contribution_domains: [],
    contribution_ids: [],
    policy_ids: [],
    role_ids: roleIds,
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
}

async function authorityFixture() {
  const roots = await Promise.all([newKey(), newKey(), newKey()]);
  const members = await Promise.all([newKey(), newKey(), newKey()]);
  const targetScope = emptyScope();
  targetScope.case_ids = ['case_target'];
  const authorityScope = emptyScope([grantId]);
  const authority: GovernanceAuthorityPayload = governanceAuthorityPayloadSchema.parse({
    protocol: 'wfd-governance-authority',
    schema_version: '2.0',
    event_type: 'authority.delegated',
    purpose: 'governance-execution',
    environment: 'demo',
    authority_id: 'authority_demo',
    policy_version: 'wfd-gov-1-0',
    revision: 1,
    threshold: 2,
    members: members.map((key, index) => ({
      key_id: key.id,
      person_id: `person_signer_${index}`,
      public_key: key.publicHex,
      capabilities: ['role.revoke'],
      scope: authorityScope,
      not_before: notBefore,
      expires_at: expiresAt,
      status: 'active',
    })),
    approval_ref: 'approval_revoke_demo',
    issued_at: notBefore,
    not_before: notBefore,
    expires_at: expiresAt,
    status: 'active',
  });
  let unsigned = await createUnsignedAuthorityEnvelope(authority);
  unsigned = await appendAuthoritySignature(
    unsigned,
    await signAuthorityEvent(authority, roots[0]),
  );
  unsigned = await appendAuthoritySignature(
    unsigned,
    await signAuthorityEvent(authority, roots[1]),
  );
  const trust: AuthorityTrust = {
    environment: 'demo',
    key_ids: roots.map((key) => key.id),
    threshold: 2,
    keys: Object.fromEntries(roots.map((key) => [key.id, key.publicHex])),
  };
  return {
    authority,
    authorityEnvelope: finalizeAuthorityEnvelope(unsigned),
    trust,
    members,
    targetScope,
    roots,
  };
}

function roleRevokePayload(
  fixture: Awaited<ReturnType<typeof authorityFixture>>,
): RoleRevokePayload {
  return {
    protocol: 'wfd-governance',
    schema_version: '2.0',
    event_type: 'role.revoke',
    purpose: 'governance-execution',
    environment: 'demo',
    authority_id: fixture.authority.authority_id,
    authority_revision: fixture.authority.revision,
    policy_version: fixture.authority.policy_version,
    proposal_id: proposalId,
    revision: 7,
    proposal_revision: 7,
    grant_id: grantId,
    grant_revision: 3,
    target_principal_id: 'principal_target',
    target_role: 'public_reviewer',
    target_capabilities: ['case.read_public_source'],
    target_scope: fixture.targetScope,
    target_not_before: notBefore,
    target_expires_at: targetExpiresAt,
    approval_ref: fixture.authority.approval_ref,
    reason: '撤销超出治理范围的授权',
    issued_at: now.toISOString(),
    not_before: notBefore,
    expires_at: expiresAt,
  };
}

async function signedRoleRevokeFixture() {
  const fixture = await authorityFixture();
  const payload = roleRevokePayload(fixture);
  let unsigned = await createUnsignedGovernanceEnvelope(payload);
  unsigned = await appendGovernanceSignature(
    unsigned,
    await signGovernanceEvent(payload, fixture.members[0]),
  );
  unsigned = await appendGovernanceSignature(
    unsigned,
    await signGovernanceEvent(payload, fixture.members[1]),
  );
  return { ...fixture, payload, envelope: finalizeGovernanceEnvelope(unsigned) };
}

async function seedExecutorRows(
  db: Database,
  fixture: Awaited<ReturnType<typeof signedRoleRevokeFixture>>,
) {
  const at = now.toISOString();
  await db.batch([
    ...fixture.members.slice(0, 2).flatMap((key, index) => {
      const principalId = `principal_signer_${index}`;
      const personId = `person_signer_${index}`;
      return [
        {
          sql: 'INSERT INTO principal_identities(principal_id,person_id,status,privacy_preferences,created_at,updated_at) VALUES(?,?,?,?,?,?)',
          params: [principalId, personId, 'active', '{}', at, at],
        },
        {
          sql: `INSERT INTO principal_keys
            (key_id,principal_id,purpose,public_key,algorithm,valid_from,expires_at,status,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)`,
          params: [
            key.id,
            principalId,
            'business',
            key.publicHex,
            'Ed25519',
            notBefore,
            expiresAt,
            'active',
            at,
          ],
        },
        {
          sql: `INSERT INTO role_grants
            (grant_id,principal_id,person_id,role,capabilities,scope,issued_at,not_before,expires_at,policy_version,approval_ref,grant_revision,status,revocation_status,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          params: [
            `grant_signer_${index}`,
            principalId,
            personId,
            'governance_authority',
            JSON.stringify(['role.revoke']),
            canonical(fixture.authority.members[index].scope),
            at,
            notBefore,
            expiresAt,
            'wfd-gov-1-0',
            'authority-approval',
            1,
            'active',
            'not_revoked',
            at,
            at,
          ],
        },
      ];
    }),
    {
      sql: 'INSERT INTO principal_identities(principal_id,person_id,status,privacy_preferences,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      params: ['principal_target', 'person_target', 'active', '{}', at, at],
    },
    {
      sql: `INSERT INTO role_grants
        (grant_id,principal_id,person_id,role,capabilities,scope,issued_at,not_before,expires_at,policy_version,approval_ref,grant_revision,status,revocation_status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        grantId,
        'principal_target',
        'person_target',
        'public_reviewer',
        JSON.stringify(['case.read_public_source']),
        canonical(fixture.targetScope),
        at,
        notBefore,
        targetExpiresAt,
        'wfd-gov-1-0',
        'role-approval',
        3,
        'active',
        'not_revoked',
        at,
        at,
      ],
    },
  ]);
}

async function seedReadyProposal(db: Database, body: Record<string, unknown>, digest: string) {
  const at = now.toISOString();
  await db.batch([
    {
      sql: `INSERT INTO governance_proposals
        (id,proposer_principal_id,proposal_type,title,body_json,public_summary,payload_digest,policy_version,state,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [
        proposalId,
        'principal_proposer',
        'role_revoke',
        '撤销授权',
        canonical(body),
        '撤销一项授权',
        digest,
        'wfd-gov-1-0',
        'ready_to_execute',
        7,
        at,
        at,
      ],
    },
  ]);
}

describe('governance signing v2 role revoke', () => {
  it('round-trips independent offline CLI signatures with digest confirmation', async () => {
    const fixture = await signedRoleRevokeFixture();
    const directory = await mkdtemp(join(tmpdir(), 'wfd-governance-signing-'));
    try {
      const payloadPath = join(directory, 'payload.json');
      const authorityPath = join(directory, 'authority.json');
      const trustPath = join(directory, 'trust.json');
      const key0Path = join(directory, 'member-0.jwk.json');
      const key1Path = join(directory, 'member-1.jwk.json');
      const partialPath = join(directory, 'partial.json');
      const completePath = join(directory, 'complete.json');
      await writeFile(payloadPath, canonical(fixture.payload));
      await writeFile(authorityPath, canonical(fixture.authorityEnvelope));
      await writeFile(trustPath, canonical(fixture.trust));
      await writeFile(
        key0Path,
        canonical({
          keyid: fixture.members[0].id,
          jwk: await crypto.subtle.exportKey('jwk', fixture.members[0].privateKey),
        }),
      );
      await writeFile(
        key1Path,
        canonical({
          keyid: fixture.members[1].id,
          jwk: await crypto.subtle.exportKey('jwk', fixture.members[1].privateKey),
        }),
      );
      const eventId = await businessEventId(fixture.payload);
      const cli = (args: string[]) =>
        execFileAsync(
          process.execPath,
          ['node_modules/tsx/dist/cli.mjs', 'scripts/governance-sign.ts', ...args],
          { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 },
        );
      const first = await cli([
        payloadPath,
        authorityPath,
        trustPath,
        key0Path,
        partialPath,
        '--confirm-event-id',
        eventId,
      ]);
      const firstResult = strictJSON(first.stdout) as Record<string, unknown>;
      expect(firstResult.complete).toBe(false);
      expect(firstResult.state).toBe('partial');
      expect(firstResult.signature_count).toBe(1);
      expect(first.stderr).toContain('目标成员标识: principal_target');
      const second = await cli([
        payloadPath,
        authorityPath,
        trustPath,
        key1Path,
        completePath,
        '--input-envelope',
        partialPath,
        `--confirm-event-id=${eventId}`,
      ]);
      const secondResult = strictJSON(second.stdout) as Record<string, unknown>;
      expect(secondResult.complete).toBe(true);
      expect(secondResult.state).toBe('complete');
      expect(secondResult.signature_count).toBe(2);
      const complete = governanceEnvelopeSchema.parse(
        strictJSON(await readFile(completePath, 'utf8')),
      );
      const verifiedAuthority = await verifyAuthorityEnvelope(
        fixture.authorityEnvelope,
        fixture.trust,
        now,
      );
      const verified = await verifyGovernanceEnvelope(complete, verifiedAuthority, {
        now,
        environment: 'demo',
        policyVersion: 'wfd-gov-1-0',
      });
      expect(verified.signer_person_ids).toEqual(['person_signer_0', 'person_signer_1']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the business prefix, binds event_id, and counts canonical people', async () => {
    const fixture = await signedRoleRevokeFixture();
    expect(fixture.envelope.event_id).toBe(await businessEventId(fixture.payload));
    const verifiedAuthority = await verifyAuthorityEnvelope(
      fixture.authorityEnvelope,
      fixture.trust,
      now,
    );
    const result = await verifyGovernanceEnvelope(fixture.envelope, verifiedAuthority, {
      now,
      environment: 'demo',
      policyVersion: 'wfd-gov-1-0',
      proposalId,
      proposalRevision: 7,
      grantId,
      grantRevision: 3,
      targetPersonId: 'person_target',
    });
    expect(result.signer_person_ids).toEqual(['person_signer_0', 'person_signer_1']);
    expect(result.signer_key_ids).toHaveLength(2);

    const tampered = structuredClone(fixture.envelope);
    tampered.signed.reason = '被篡改的撤销原因';
    await expect(verifyGovernanceEnvelope(tampered, verifiedAuthority, { now })).rejects.toThrow(
      'EVENT_ID_MISMATCH',
    );
  });

  it('requires a root threshold and rejects duplicate authority people', async () => {
    const fixture = await signedRoleRevokeFixture();
    const oneSignature = {
      ...fixture.authorityEnvelope,
      signatures: [
        fixture.authorityEnvelope.signatures[0],
        fixture.authorityEnvelope.signatures[0],
      ],
    };
    await expect(verifyAuthorityEnvelope(oneSignature, fixture.trust, now)).rejects.toThrow(
      'AUTHORIZATION_ROOT_THRESHOLD',
    );
    const duplicatePerson = structuredClone(fixture.authority);
    duplicatePerson.members[1].person_id = duplicatePerson.members[0].person_id;
    expect(() => governanceAuthorityPayloadSchema.parse(duplicatePerson)).toThrow(
      'DUPLICATE_AUTHORITY_PERSON',
    );
  });

  it('binds the root trust to its environment before accepting authorization', async () => {
    const fixture = await authorityFixture();
    const productionAuthority = structuredClone(fixture.authority);
    productionAuthority.environment = 'production';
    let unsigned = await createUnsignedAuthorityEnvelope(productionAuthority);
    unsigned = await appendAuthoritySignature(
      unsigned,
      await signAuthorityEvent(productionAuthority, fixture.roots[0]),
    );
    unsigned = await appendAuthoritySignature(
      unsigned,
      await signAuthorityEvent(productionAuthority, fixture.roots[1]),
    );
    await expect(
      verifyAuthorityEnvelope(finalizeAuthorityEnvelope(unsigned), fixture.trust, now),
    ).rejects.toThrow('TRUST_ENVIRONMENT_MISMATCH');
  });

  it('rejects an expired event and an out-of-scope signer', async () => {
    const fixture = await signedRoleRevokeFixture();
    const verifiedAuthority = await verifyAuthorityEnvelope(
      fixture.authorityEnvelope,
      fixture.trust,
      now,
    );
    await expect(
      verifyGovernanceEnvelope(fixture.envelope, verifiedAuthority, {
        now: new Date('2026-09-12T23:30:00.000Z'),
      }),
    ).resolves.toBeDefined();
    const expiredPayload = {
      ...fixture.payload,
      expires_at: '2026-09-12T07:00:00.000Z',
    };
    let expiredUnsigned = await createUnsignedGovernanceEnvelope(expiredPayload);
    expiredUnsigned = await appendGovernanceSignature(
      expiredUnsigned,
      await signGovernanceEvent(expiredPayload, fixture.members[0]),
    );
    expiredUnsigned = await appendGovernanceSignature(
      expiredUnsigned,
      await signGovernanceEvent(expiredPayload, fixture.members[1]),
    );
    await expect(
      verifyGovernanceEnvelope(finalizeGovernanceEnvelope(expiredUnsigned), verifiedAuthority, {
        now,
      }),
    ).rejects.toThrow('SIGNATURE_EXPIRED');

    const wrongEnvironment = structuredClone(verifiedAuthority);
    wrongEnvironment.environment = 'production';
    await expect(
      verifyGovernanceEnvelope(fixture.envelope, wrongEnvironment, { now }),
    ).rejects.toThrow('ENVIRONMENT_MISMATCH');
    const wrongPolicy = structuredClone(verifiedAuthority);
    wrongPolicy.policy_version = 'wfd-gov-2-0';
    await expect(verifyGovernanceEnvelope(fixture.envelope, wrongPolicy, { now })).rejects.toThrow(
      'POLICY_VERSION_MISMATCH',
    );

    const outOfScopeAuthority = structuredClone(fixture.authority);
    outOfScopeAuthority.members[0].scope = emptyScope(['grant_other']);
    await expect(
      verifyGovernanceEnvelope(fixture.envelope, outOfScopeAuthority, { now }),
    ).rejects.toThrow('INDEPENDENT_SIGNATURE_THRESHOLD');
  });

  it('renders the full review fields and only accepts digest-bound confirmation', async () => {
    const fixture = await signedRoleRevokeFixture();
    const review = formatSigningReview(
      fixture.payload,
      fixture.authority,
      fixture.envelope.event_id,
    );
    expect(review).toContain('对象: role_grant/' + grantId);
    expect(review).toContain('权限: public_reviewer');
    expect(review).toContain('范围:');
    expect(review).toContain('授权有效期:');
    expect(review).toContain('依据: approval_revoke_demo');
    expect(review).toContain('完整负载(JCS):');
    expect(() => requireConfirmation('wrong', fixture.envelope.event_id)).toThrow(
      'CONFIRMATION_DIGEST_MISMATCH',
    );
    expect(() =>
      requireConfirmation(fixture.envelope.event_id, fixture.envelope.event_id),
    ).not.toThrow();
  });
});

for (const adapter of databaseAdapters)
  describe(`role revoke executor crash-safe mutation (${adapter})`, () => {
    let db: Database;
    let closeDatabase: () => Promise<void>;

    beforeEach(async () => {
      const opened = await testDatabase(adapter);
      db = opened.db;
      closeDatabase = opened.close;
    });
    afterEach(async () => closeDatabase());

    it('rechecks the live grant and authorization, revokes atomically, and replays a receipt', async () => {
      const fixture = await signedRoleRevokeFixture();
      const actorPerson = 'person_executor';
      const at = now.toISOString();
      await db.batch([
        ...fixture.members.slice(0, 2).flatMap((key, index) => {
          const principalId = `principal_signer_${index}`;
          const personId = `person_signer_${index}`;
          const signerGrantId = `grant_signer_${index}`;
          return [
            {
              sql: 'INSERT INTO principal_identities(principal_id,person_id,status,privacy_preferences,created_at,updated_at) VALUES(?,?,?,?,?,?)',
              params: [principalId, personId, 'active', '{}', at, at],
            },
            {
              sql: `INSERT INTO principal_keys
              (key_id,principal_id,purpose,public_key,algorithm,valid_from,expires_at,status,created_at)
              VALUES(?,?,?,?,?,?,?,?,?)`,
              params: [
                key.id,
                principalId,
                'business',
                key.publicHex,
                'Ed25519',
                notBefore,
                expiresAt,
                'active',
                at,
              ],
            },
            {
              sql: `INSERT INTO role_grants
              (grant_id,principal_id,person_id,role,capabilities,scope,issued_at,not_before,expires_at,
               policy_version,approval_ref,grant_revision,status,revocation_status,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              params: [
                signerGrantId,
                principalId,
                personId,
                'governance_authority',
                JSON.stringify(['role.revoke']),
                canonical(fixture.authority.members[index].scope),
                at,
                notBefore,
                expiresAt,
                'wfd-gov-1-0',
                'authority-approval',
                1,
                'active',
                'not_revoked',
                at,
                at,
              ],
            },
          ];
        }),
        {
          sql: 'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
          params: [
            'user_target',
            'Target',
            'target@example.invalid',
            1,
            now.getTime(),
            now.getTime(),
          ],
        },
        {
          sql: 'INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)',
          params: [
            'session_target',
            now.getTime() + 86400000,
            'token-target',
            now.getTime(),
            now.getTime(),
            'user_target',
          ],
        },
        {
          sql: 'INSERT INTO principal_identities(principal_id,person_id,status,privacy_preferences,created_at,updated_at) VALUES(?,?,?,?,?,?)',
          params: ['principal_target', 'person_target', 'active', '{}', at, at],
        },
        {
          sql: 'INSERT INTO principal_accounts(user_id,principal_id,status,linked_at,linked_by,account_revision) VALUES(?,?,?,?,?,?)',
          params: ['user_target', 'principal_target', 'active', at, 'test', 1],
        },
        {
          sql: `INSERT INTO role_grants
          (grant_id,principal_id,person_id,role,capabilities,scope,issued_at,not_before,expires_at,policy_version,approval_ref,grant_revision,status,revocation_status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          params: [
            grantId,
            'principal_target',
            'person_target',
            'public_reviewer',
            JSON.stringify(['case.read_public_source']),
            canonical(fixture.targetScope),
            at,
            notBefore,
            targetExpiresAt,
            'wfd-gov-1-0',
            'role-approval',
            3,
            'active',
            'not_revoked',
            at,
            at,
          ],
        },
      ]);
      const proposalBody = {
        proposal_type: 'role_revoke',
        title: '撤销授权',
        background: '授权需要重新审查',
        change: '撤销指定角色授权',
        affected_objects: [grantId],
        current_policy_version: 'wfd-gov-1-0',
        proposed_policy_version: 'wfd-gov-1-0',
        risk: '权限可能继续被滥用',
        recusal_refs: [],
        cost_summary: '无需额外成本',
        execution_steps: ['撤销授权并失效会话'],
        rollback_steps: ['重新走授权流程'],
        public_summary: '撤销一项授权',
        discussion_days: 1,
        voting_days: 1,
        timelock_days: 1,
      } as const;
      const payloadDigest = await hash(utf8(canonical(proposalBody)));
      await seedReadyProposal(db, proposalBody, payloadDigest);
      const executionInput = {
        proposal_id: proposalId,
        proposal_revision: 7,
        execution_id: 'exec_revoke_demo',
        actor_principal_id: 'principal_executor',
        payload_digest: payloadDigest,
        body_json: canonical(proposalBody),
      };
      let authorizationCalls = 0;
      const executor = createRoleRevokeExecutor({
        db,
        loadEnvelope: async () => fixture.envelope,
        loadAuthorization: async () => fixture.authorityEnvelope,
        authorityTrust: fixture.trust,
        environment: 'demo',
        clock: () => now,
        resolvePerson: async () => actorPerson,
        authorizeCurrent: async (input) => {
          authorizationCalls++;
          expect(input.capability).toBe('role.execute');
          expect(input.object_id).toBe(grantId);
          return { allowed: true };
        },
      });

      const result = await executor.execute(executionInput);
      expect(result.status).toBe('executed');
      expect(authorizationCalls).toBe(1);
      expect(
        await db.all<{ status: string; revocation_status: string; grant_revision: number }>(
          'SELECT status,revocation_status,grant_revision FROM role_grants WHERE grant_id=?',
          [grantId],
        ),
      ).toEqual([{ status: 'revoked', revocation_status: 'revoked', grant_revision: 4 }]);
      expect(await db.all('SELECT execution_id FROM governance_execution_receipts')).toHaveLength(
        1,
      );

      await db.batch([
        {
          sql: "UPDATE governance_proposals SET state='withdrawn' WHERE id=?",
          params: [proposalId],
        },
      ]);
      const replayed = await executor.execute(executionInput);
      expect(replayed.status).toBe('executed');
      expect(authorizationCalls).toBe(1);
      await expect(
        executor.execute({ ...executionInput, payload_digest: '0'.repeat(64) }),
      ).rejects.toThrow('EXECUTION_ID_PAYLOAD_MISMATCH');
      await expect(
        executor.execute({ ...executionInput, execution_id: 'exec_revoke_other' }),
      ).rejects.toThrow('EXECUTION_RECEIPT_EXISTS');
    });

    it('fails closed when current executor authorization is unavailable or denied', async () => {
      const fixture = await signedRoleRevokeFixture();
      await seedExecutorRows(db, fixture);
      const proposalBody = {
        proposal_type: 'role_revoke',
        title: '撤销授权',
        background: '重新审查',
        change: '撤销指定角色授权',
        affected_objects: [grantId],
        current_policy_version: 'wfd-gov-1-0',
        proposed_policy_version: 'wfd-gov-1-0',
        risk: '权限风险',
        recusal_refs: [],
        cost_summary: '无',
        execution_steps: ['撤销'],
        rollback_steps: ['重走授权'],
        public_summary: '撤销',
        discussion_days: 1,
        voting_days: 1,
        timelock_days: 1,
      } as const;
      await seedReadyProposal(db, proposalBody, await hash(utf8(canonical(proposalBody))));
      const input = {
        proposal_id: proposalId,
        proposal_revision: 7,
        execution_id: 'exec_revoke_denied',
        actor_principal_id: 'principal_executor',
        payload_digest: await hash(utf8(canonical(proposalBody))),
        body_json: canonical(proposalBody),
      };
      const base = {
        db,
        loadEnvelope: async () => fixture.envelope,
        loadAuthorization: async () => fixture.authorityEnvelope,
        authorityTrust: fixture.trust,
        environment: 'demo' as const,
        clock: () => now,
        resolvePerson: async () => 'person_executor',
      };
      await expect(createRoleRevokeExecutor(base).execute(input)).rejects.toThrow(
        'EXECUTOR_AUTHORIZATION_UNAVAILABLE',
      );
      await db.batch([
        {
          sql: "UPDATE governance_proposals SET state='withdrawn' WHERE id=?",
          params: [proposalId],
        },
      ]);
      await expect(
        createRoleRevokeExecutor({
          ...base,
          authorizeCurrent: async () => ({ allowed: true }),
        }).execute({ ...input, execution_id: 'exec_revoke_withdrawn' }),
      ).rejects.toThrow('EXECUTION_NOT_READY');
      await db.batch([
        {
          sql: "UPDATE governance_proposals SET state='ready_to_execute',revision=8 WHERE id=?",
          params: [proposalId],
        },
      ]);
      await expect(
        createRoleRevokeExecutor({
          ...base,
          authorizeCurrent: async () => ({ allowed: true }),
        }).execute({ ...input, execution_id: 'exec_revoke_revision' }),
      ).rejects.toThrow('REVISION_CONFLICT');
      await db.batch([
        {
          sql: 'UPDATE governance_proposals SET revision=7 WHERE id=?',
          params: [proposalId],
        },
      ]);
      const denied = createRoleRevokeExecutor({
        ...base,
        authorizeCurrent: async () => ({ allowed: false, code: 'CAPABILITY_DENIED' }),
      });
      await expect(denied.execute(input)).rejects.toThrow('CAPABILITY_DENIED');
      expect(
        await db.all<{ status: string }>('SELECT status FROM role_grants WHERE grant_id=?', [
          grantId,
        ]),
      ).toEqual([{ status: 'active' }]);
    });
  });
