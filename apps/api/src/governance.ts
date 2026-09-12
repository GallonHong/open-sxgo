import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../../../packages/db/src/adapter';
import type { Principal } from '../../../packages/protocol/src/private';
import { assert, DomainError } from '../../../packages/domain/src/index';
import { strictJSON, hash, utf8, canonical } from '../../../packages/verifier/src/crypto';
import {
  resolveIdentity,
  authorize,
  PermissionError,
  type Identity,
  type AuthorizeInput,
} from '../../../packages/identity-permissions/src/index';
import {
  beginWebAuthnRegistration,
  finishWebAuthnRegistration,
  beginWebAuthnStepUp,
  finishWebAuthnStepUp,
} from '../../../packages/identity-permissions/src/webauthn';
import { NodeRegistry, nodeInput } from '../../../packages/node-observer/src/index';
import {
  ContributionLedger,
  contributionInputSchema,
  assessmentSchema,
  qualificationInputSchema,
  qualificationAssessmentSchema,
  appealInputSchema,
} from '../../../packages/contribution-ledger/src/index';
import { defaultPolicy } from '../../../packages/governance-policy/src/index';

import { resultView } from './response-projections';

export function governanceRoutes(
  db: Database,
  resolve: (headers: Headers) => Promise<Principal | null>,
  adminOrigin?: string,
) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: { code: 'INVALID_SCHEMA' } }, 400);
    if (error instanceof DomainError || error instanceof PermissionError)
      return new Response(JSON.stringify({ error: { code: error.code } }), {
        status: error.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    if (/mutation_guard|CHECK constraint|UNIQUE constraint/.test(error.message))
      return c.json({ error: { code: 'REVISION_CONFLICT' } }, 409);
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE' } }, 503);
  });
  const nodes = new NodeRegistry(db);
  const ledger = new ContributionLedger(db);
  async function identity(headers: Headers): Promise<Identity> {
    const session = await resolve(headers);
    assert(session?.session_id, 'AUTHENTICATION_REQUIRED', 401);
    const current = await resolveIdentity(db, {
      user_id: session.user_id,
      session_id: session.session_id,
    });
    assert(current && current.status === 'active', 'CAPABILITY_DENIED', 403);
    return current;
  }
  async function permit(current: Identity, input: AuthorizeInput) {
    const decision = await authorize(db, current, {
      required_assurance: 'webauthn_step_up',
      ...input,
    });
    assert(decision.allowed, decision.code, 403);
    return decision;
  }
  const body = async (c: { req: { text(): Promise<string> } }) => strictJSON(await c.req.text());
  const key = (c: { req: { header(name: string): string | undefined } }) =>
    z.string().min(16).max(128).parse(c.req.header('idempotency-key'));
  const webauthnConfig = adminOrigin
    ? { rpID: new URL(adminOrigin).hostname, origin: adminOrigin }
    : null;
  const registrationResponse = z.strictObject({
    id: z.string(),
    rawId: z.string(),
    type: z.literal('public-key'),
    response: z.object({
      clientDataJSON: z.string(),
      attestationObject: z.string(),
      transports: z
        .array(z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']))
        .optional(),
      publicKeyAlgorithm: z.number().optional(),
      publicKey: z.string().optional(),
      authenticatorData: z.string().optional(),
    }),
    clientExtensionResults: z.object({}).passthrough(),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  });
  const authenticationResponse = z.strictObject({
    id: z.string(),
    rawId: z.string(),
    type: z.literal('public-key'),
    response: z.strictObject({
      clientDataJSON: z.string(),
      authenticatorData: z.string(),
      signature: z.string(),
      userHandle: z.string().optional(),
    }),
    clientExtensionResults: z.object({}).passthrough(),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  });
  for (const kind of ['registration', 'step-up'] as const) {
    app.post(`/admin/v1/security/webauthn/${kind}/options`, async (c) => {
      assert(webauthnConfig, 'AUTHENTICATION_NOT_CONFIGURED', 503);
      const p = await identity(c.req.raw.headers);
      z.strictObject({}).parse(await body(c));
      return c.json(
        await (kind === 'registration'
          ? beginWebAuthnRegistration(db, p, webauthnConfig)
          : beginWebAuthnStepUp(db, p, webauthnConfig)),
      );
    });
    app.post(`/admin/v1/security/webauthn/${kind}/verify`, async (c) => {
      assert(webauthnConfig, 'AUTHENTICATION_NOT_CONFIGURED', 503);
      const p = await identity(c.req.raw.headers);
      if (kind === 'registration') {
        const input = z
          .strictObject({ challenge_id: z.string(), response: registrationResponse })
          .parse(await body(c));
        return c.json(await finishWebAuthnRegistration(db, { ...p, ...input }, webauthnConfig));
      }
      const input = z
        .strictObject({ challenge_id: z.string(), response: authenticationResponse })
        .parse(await body(c));
      return c.json(await finishWebAuthnStepUp(db, { ...p, ...input }, webauthnConfig));
    });
  }
  app.get('/private/v1/member', async (c) => {
    const p = await identity(c.req.raw.headers);
    return c.json({
      principal_id: p.principal_id,
      assurance: p.assurance,
      grants: p.grants.map((g) => ({
        grant_id: g.grant_id,
        role: g.role,
        capabilities: g.capabilities,
        scope: g.scope,
        expires_at: g.expires_at,
        status: g.status,
      })),
    });
  });
  app.get('/private/v1/contributions/mine', async (c) => {
    const p = await identity(c.req.raw.headers);
    return c.json({ items: (await ledger.listContributions(p.principal_id)).map(resultView) });
  });
  app.post('/private/v1/contributions', async (c) => {
    const p = await identity(c.req.raw.headers);
    const input = contributionInputSchema
      .omit({ principal_id: true, contribution_id: true, idempotency_key: true })
      .parse(await body(c));
    return c.json(
      resultView(
        await ledger.submit({
          ...input,
          principal_id: p.principal_id,
          idempotency_key: p.principal_id + ':' + key(c),
        }),
      ),
      201,
    );
  });
  app.post('/private/v1/contributions/claim', async (c) => {
    const p = await identity(c.req.raw.headers);
    const input = z
      .strictObject({
        contribution_id: z.string().min(1),
        confirm_link: z.literal(true),
        consent_version: z.literal('claim-1'),
        expected_revision: z.number().int().positive(),
      })
      .parse(await body(c));
    const receipt = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(c.req.header('x-wfd-receipt'));
    const requestKey = await hash(utf8(p.principal_id + ':' + key(c)));
    const [item] = await db.all<{ id: string }>(
      'SELECT id FROM work_items WHERE receipt_hash=? AND state<>?',
      [await hash(utf8(receipt)), 'withdrawn'],
    );
    assert(item, 'INVALID_RECEIPT', 403);
    const requestHash = await hash(utf8(canonical({ ...input, submission_id: item.id })));
    const [old] = await db.all<{ request_hash: string }>(
      'SELECT request_hash FROM contribution_claims WHERE request_key=?',
      [requestKey],
    );
    if (old) {
      assert(old.request_hash === requestHash, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      return c.json({ linked: true, replayed: true });
    }
    await db.batch([
      {
        sql: 'INSERT INTO contribution_claims SELECT ?,id,principal_id,?,?,?,? FROM contributions WHERE id=? AND principal_id=? AND version=?',
        params: [
          item.id,
          input.consent_version,
          new Date().toISOString(),
          requestKey,
          requestHash,
          input.contribution_id,
          p.principal_id,
          input.expected_revision,
        ],
      },
      { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
      { sql: 'DELETE FROM mutation_guard' },
    ]);
    return c.json({ linked: true, publicly_identified: false }, 201);
  });
  app.post('/private/v1/contributions/:id/challenge', async (c) => {
    const p = await identity(c.req.raw.headers);
    key(c);
    const input = z
      .strictObject({
        reason: z.string().min(1).max(500),
        expected_revision: z.number().int().positive(),
      })
      .parse(await body(c));
    const row = await ledger.getContribution(c.req.param('id'));
    assert(row?.principal_id === p.principal_id, 'CAPABILITY_DENIED', 403);
    return c.json(
      resultView(
        await ledger.challenge(row.id, p.principal_id, input.reason, input.expected_revision),
      ),
    );
  });
  app.get('/private/v1/qualifications/mine', async (c) => {
    const p = await identity(c.req.raw.headers);
    return c.json({
      items: await db.all(
        'SELECT id,target_role,status,decision_reason,valid_until,version FROM qualification_applications WHERE principal_id=? ORDER BY created_at DESC LIMIT 100',
        [p.principal_id],
      ),
    });
  });
  app.post('/private/v1/qualifications/apply', async (c) => {
    const p = await identity(c.req.raw.headers);
    const input = qualificationInputSchema
      .omit({
        principal_id: true,
        application_id: true,
        idempotency_key: true,
        project_started_at: true,
      })
      .parse(await body(c));
    return c.json(
      resultView(
        await ledger.applyQualification({
          ...input,
          principal_id: p.principal_id,
          idempotency_key: p.principal_id + ':' + key(c),
        }),
      ),
      201,
    );
  });
  app.post('/private/v1/appeals', async (c) => {
    const p = await identity(c.req.raw.headers);
    const input = appealInputSchema
      .omit({ appellant_principal_id: true, appeal_id: true, idempotency_key: true })
      .parse(await body(c));
    const row =
      input.subject_type === 'contribution'
        ? await ledger.getContribution(input.subject_id)
        : await ledger.getQualification(input.subject_id);
    assert(row?.principal_id === p.principal_id, 'CAPABILITY_DENIED', 403);
    return c.json(
      resultView(
        await ledger.openAppeal({
          ...input,
          appellant_principal_id: p.principal_id,
          idempotency_key: p.principal_id + ':' + key(c),
        }),
      ),
      201,
    );
  });
  app.post('/admin/v1/contributions/:id/assess', async (c) => {
    const p = await identity(c.req.raw.headers);
    key(c);
    const row = await ledger.getContribution(c.req.param('id'));
    assert(row, 'CAPABILITY_DENIED', 403);
    await permit(p, {
      capability: 'contribution.assess',
      object_type: 'contribution',
      object_id: row.domain,
      scope: { contribution_domains: [row.domain] },
    });
    const input = assessmentSchema
      .omit({
        contribution_id: true,
        assessor_principal_id: true,
        conflicted: true,
        policy_version: true,
      })
      .parse(await body(c));
    return c.json(
      resultView(
        await ledger.assess({
          ...input,
          contribution_id: c.req.param('id'),
          assessor_principal_id: p.principal_id,
          conflicted: false,
          policy_version: defaultPolicy().policy_version,
        }),
      ),
    );
  });
  app.get('/admin/v1/contributions', async (c) => {
    const p = await identity(c.req.raw.headers);
    const domain = z
      .enum(['data', 'review', 'code_doc', 'infrastructure', 'security_governance'])
      .parse(c.req.query('domain'));
    await permit(p, {
      capability: 'contribution.assess',
      object_type: 'contribution',
      object_id: domain,
      scope: { contribution_domains: [domain] },
    });
    return c.json({
      items: await db.all(
        'SELECT id,domain,work_type,status,version,created_at FROM contributions WHERE domain=? ORDER BY created_at DESC LIMIT 100',
        [domain],
      ),
    });
  });
  app.post('/admin/v1/contributions/:id/begin', async (c) => {
    const p = await identity(c.req.raw.headers);
    key(c);
    const input = z
      .strictObject({ expected_revision: z.number().int().positive() })
      .parse(await body(c));
    const row = await ledger.getContribution(c.req.param('id'));
    assert(row, 'CAPABILITY_DENIED', 403);
    await permit(p, {
      capability: 'contribution.assess',
      object_type: 'contribution',
      object_id: row.domain,
      scope: { contribution_domains: [row.domain] },
    });
    return c.json(
      resultView(await ledger.beginAssessment(row.id, p.principal_id, input.expected_revision)),
    );
  });
  app.get('/private/v1/nodes/mine', async (c) =>
    c.json({ items: await nodes.mine((await identity(c.req.raw.headers)).person_id) }),
  );
  app.post('/private/v1/nodes', async (c) => {
    const p = await identity(c.req.raw.headers);
    return c.json(await nodes.propose(p.person_id, nodeInput.parse(await body(c)), key(c)), 201);
  });
  app.post('/private/v1/nodes/:id/challenge', async (c) => {
    const p = await identity(c.req.raw.headers);
    key(c);
    const input = z
      .strictObject({ expected_revision: z.number().int().positive() })
      .parse(await body(c));
    return c.json(
      await nodes.verifyControl(p.person_id, c.req.param('id'), input.expected_revision),
    );
  });
  app.post('/private/v1/nodes/:id/exit', async (c) => {
    const p = await identity(c.req.raw.headers);
    key(c);
    const input = z
      .strictObject({
        expected_revision: z.number().int().positive(),
        reason: z.string().min(1).max(500),
      })
      .parse(await body(c));
    return c.json(
      await nodes.decide(
        p.person_id,
        '',
        c.req.param('id'),
        input.expected_revision,
        'exit',
        input.reason,
      ),
    );
  });
  app.post('/admin/v1/nodes/:id/decision', async (c) => {
    const p = await identity(c.req.raw.headers);
    await permit(p, {
      capability: 'node.approve_listing',
      object_type: 'node',
      object_id: c.req.param('id'),
    });
    key(c);
    const input = z
      .strictObject({
        expected_revision: z.number().int().positive(),
        action: z.enum(['approve', 'reject']),
        reason: z.string().min(1).max(500),
      })
      .parse(await body(c));
    // Control group independence must be assessed privately before approval.
    assert(input.action === 'reject', 'CONTROL_GROUP_REVIEW_REQUIRED', 409);
    return c.json(
      await nodes.decide(
        p.principal_id,
        p.person_id,
        c.req.param('id'),
        input.expected_revision,
        input.action,
        input.reason,
      ),
    );
  });
  app.post('/admin/v1/incidents', async (c) => {
    const p = await identity(c.req.raw.headers);
    const input = z
      .strictObject({
        kind: z.enum([
          'privacy',
          'phishing',
          'credential_risk',
          'source_risk',
          'authorization_risk',
        ]),
        object_type: z.enum(['case', 'role', 'source', 'node']),
        object_id: z.string().min(1).max(120),
        private_summary: z.string().min(1).max(500),
      })
      .parse(await body(c));
    await permit(p, {
      capability: 'incident.manage',
      object_type: 'incident',
      object_id: input.object_id,
    });
    const requestKey = await hash(utf8(p.principal_id + ':' + key(c))),
      digest = await hash(utf8(canonical(input)));
    const [old] = await db.all<{ id: string; request_hash: string }>(
      'SELECT id,request_hash FROM security_incidents WHERE request_key=?',
      [requestKey],
    );
    if (old) {
      assert(old.request_hash === digest, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      return c.json({ id: old.id, replayed: true });
    }
    const incidentId = 'incident_' + crypto.randomUUID().replaceAll('-', ''),
      now = new Date();
    await db.batch([
      {
        sql: 'INSERT INTO security_incidents(id,reporter_id,kind,object_type,object_id,private_summary,created_at,review_due_at,request_key,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?)',
        params: [
          incidentId,
          p.principal_id,
          input.kind,
          input.object_type,
          input.object_id,
          input.private_summary,
          now.toISOString(),
          new Date(+now + 86400000).toISOString(),
          requestKey,
          digest,
        ],
      },
    ]);
    return c.json({ id: incidentId, state: 'open' }, 201);
  });
  app.post('/admin/v1/roles/:id/suspend', async (c) => {
    const p = await identity(c.req.raw.headers);
    key(c);
    const input = z
      .strictObject({
        expected_revision: z.number().int().positive(),
        incident_id: z.string().min(1),
        reason: z.string().min(1).max(500),
      })
      .parse(await body(c));
    const grantId = c.req.param('id');
    await permit(p, { capability: 'role.suspend', object_type: 'role', object_id: grantId });
    const [incident] = await db.all(
      'SELECT id FROM security_incidents WHERE id=? AND object_type=? AND object_id=? AND state=?',
      [input.incident_id, 'role', grantId, 'open'],
    );
    assert(incident, 'CAPABILITY_DENIED', 403);
    const now = new Date().toISOString();
    await db.batch([
      {
        sql: "UPDATE role_grants SET status='suspended',revocation_status='suspended',grant_revision=grant_revision+1,updated_at=?,revocation_reason=? WHERE grant_id=? AND grant_revision=? AND status='active'",
        params: [now, input.reason, grantId, input.expected_revision],
      },
      { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
      { sql: 'DELETE FROM mutation_guard' },
      {
        sql: 'DELETE FROM session WHERE userId IN (SELECT user_id FROM principal_accounts WHERE principal_id=(SELECT principal_id FROM role_grants WHERE grant_id=?))',
        params: [grantId],
      },
      {
        sql: "UPDATE case_assignments SET status='revoked',assignment_revision=assignment_revision+1 WHERE grant_id=? AND status IN ('assigned','accepted','in_progress')",
        params: [grantId],
      },
      {
        sql: "UPDATE authorization_jobs SET state='blocked_by_revocation',version=version+1,updated_at=? WHERE grant_id=? AND state IN ('queued','running')",
        params: [now, grantId],
      },
      {
        sql: 'INSERT INTO audit VALUES(?,?,?,?,?,?)',
        params: [
          'audit_' + crypto.randomUUID(),
          grantId,
          p.person_id,
          'emergency_suspend',
          input.incident_id,
          now,
        ],
      },
    ]);
    return c.json({
      state: 'suspended',
      revision: input.expected_revision + 1,
      automatic_restoration: false,
    });
  });
  app.post('/admin/v1/evidence/:id/access', (c) => c.json({ error: { code: 'P1_DISABLED' } }, 403));
  return app;
}
