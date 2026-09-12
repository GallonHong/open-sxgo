import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import type { Database, WorkItem, Proposal } from '../../../packages/db/src/adapter';
import {
  submissionSchema,
  reportSchema,
  proposalSchema,
  type Principal,
} from '../../../packages/protocol/src/private';
import { id, text, httpsURL } from '../../../packages/protocol/src/public';
import { DomainError, assert, validateDataset } from '../../../packages/domain/src/index';
import { hash, utf8, strictJSON } from '../../../packages/verifier/src/crypto';
import { Service, requireRole } from './service';
import { governanceRoutes } from './governance';
import { createReviewRoutes } from './review';
import { governanceActionsRoutes } from './governance-actions';
import { resolveIdentity, authorize } from '../../../packages/identity-permissions/src/index';
export type Config = {
  mode: 'demo' | 'production';
  intakeEnabled: boolean;
  promotionEnabled: boolean;
  productionReleaseEnabled: boolean;
  origins: string[];
  rateSecret: string;
};
type Context = { Variables: { principal: Principal } };
export function createApp(
  db: Database,
  config: Config,
  resolve: (headers: Headers) => Promise<Principal | null>,
  authHandler?: (r: Request) => Promise<Response>,
) {
  const app = new Hono<Context>(),
    service = new Service(db);
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      referrerPolicy: 'no-referrer',
    }),
  );
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (
      [...new URL(c.req.url).searchParams.keys()].some((k) =>
        /receipt|token|password|secret/i.test(k),
      )
    )
      return c.json({ error: { code: 'CREDENTIAL_IN_URL' } }, 400);
    await next();
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 32768,
      onError: (c) => c.json({ error: { code: 'BODY_TOO_LARGE' } }, 413),
    }),
  );
  app.use('*', async (c, next) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && !config.origins.includes(origin))
        return c.json({ error: { code: 'ORIGIN_REJECTED' } }, 403);
      if (c.req.header('sec-fetch-site') === 'cross-site')
        return c.json({ error: { code: 'ORIGIN_REJECTED' } }, 403);
      if (!c.req.header('content-type')?.startsWith('application/json'))
        return c.json({ error: { code: 'JSON_REQUIRED_ATTACHMENTS_DISABLED' } }, 415);
    }
    await next();
  });
  app.onError((e, c) => {
    if (e instanceof z.ZodError)
      return c.json(
        { error: { code: 'INVALID_INPUT', message: '请检查必填字段和公开来源格式。' } },
        400,
      );
    if (e instanceof DomainError)
      return new Response(JSON.stringify({ error: { code: e.code } }), {
        status: e.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    if (/mutation_guard|CHECK constraint|UNIQUE constraint/i.test(e.message))
      return c.json({ error: { code: 'REVISION_CONFLICT' } }, 409);
    return c.json(
      { error: { code: 'SERVICE_UNAVAILABLE', message: '未能完成保存，请稍后重试。' } },
      503,
    );
  });
  app.get('/health', (c) => c.json({ status: 'ok', mode: config.mode }));
  app.get('/private/v1/config', (c) =>
    c.json({
      intake_enabled: config.intakeEnabled,
      promotion_enabled: config.promotionEnabled,
      mode: config.mode,
    }),
  );
  app.use('/private/v1/*', async (c, next) => {
    if (c.req.method === 'POST') {
      if (['/private/v1/submissions', '/private/v1/change-reports'].includes(c.req.path))
        assert(config.intakeEnabled, 'INTAKE_PAUSED', 503);
      const ip = c.req.header('cf-connecting-ip') ?? 'local';
      const key = await hash(
        utf8(config.rateSecret + ':' + new Date().toISOString().slice(0, 10) + ':' + ip),
      );
      await db.batch([
        {
          sql: 'INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',
          params: [key, Date.now() + 86400000],
        },
      ]);
      const [limit] = await db.all<{ count: number }>('SELECT count FROM rate_limits WHERE key=?', [
        key,
      ]);
      if (limit.count > 120) {
        c.header('Retry-After', '3600');
        return c.json({ error: { code: 'RATE_LIMITED' } }, 429);
      }
    }
    await next();
  });
  const input = async (c: { req: { text: () => Promise<string> } }) =>
    strictJSON(await c.req.text());
  const receipt = (c: { req: { header: (name: string) => string | undefined } }) =>
    c.req.header('x-wfd-receipt') ?? '';
  app.post('/private/v1/submissions', async (c) => {
    const body = submissionSchema.parse(await input(c));
    const key = z.string().min(32).max(128).parse(c.req.header('idempotency-key'));
    return c.json(await service.submit(body, key), 201);
  });
  app.post('/private/v1/submissions/status', async (c) => {
    z.strictObject({}).parse(await input(c));
    return c.json(await service.status(receipt(c)));
  });
  app.post('/private/v1/submissions/supplements', async (c) => {
    const body = z
      .strictObject({ message: text, source_urls: z.array(httpsURL).max(10) })
      .parse(await input(c));
    await service.supplement(receipt(c), JSON.stringify(body));
    return c.json({ saved: true });
  });
  app.post('/private/v1/submissions/withdraw', async (c) => {
    z.strictObject({}).parse(await input(c));
    await service.withdraw(receipt(c));
    return c.json({ state: 'withdrawn' });
  });
  for (const path of ['change-reports', 'privacy-requests'])
    app.post('/private/v1/' + path, async (c) => {
      const body = reportSchema.parse(await input(c));
      return c.json(await service.report(body, body.kind), 201);
    });
  app.post('/private/v1/evidence/init', (c) => c.json({ error: { code: 'P1_DISABLED' } }, 403));
  if (authHandler) app.on(['GET', 'POST'], '/admin/v1/auth/*', (c) => authHandler(c.req.raw));
  app.route('/', governanceRoutes(db, resolve, config.origins[0]));
  const resolveMember = async (headers: Headers) => {
    const p = await resolve(headers);
    return p?.session_id
      ? resolveIdentity(db, { user_id: p.user_id, session_id: p.session_id })
      : null;
  };
  app.route(
    '/admin/v1',
    createReviewRoutes(db, resolveMember, {
      mode: config.mode,
      validateCandidate: (candidate) => {
        validateDataset(candidate);
      },
    }),
  );
  app.route(
    '/',
    governanceActionsRoutes(db, resolveMember, {
      authorize: (identity, input) =>
        authorize(db, identity, { ...input, required_assurance: 'webauthn_step_up' }),
      getElectorate: async () => {
        const now = new Date().toISOString();
        const rows = await db.all<{ principal_id: string }>(
          "SELECT DISTINCT pi.principal_id FROM principal_identities pi JOIN role_grants g ON g.principal_id=pi.principal_id WHERE pi.status='active' AND g.role='council_member' AND g.status='active' AND g.revocation_status='not_revoked' AND g.not_before<=? AND g.expires_at>?",
          [now, now],
        );
        return rows.map((row) => ({ ...row, eligible: true }));
      },
      isConflicted: async (identity, _type, objectId) => {
        const rows = await db.all(
          "SELECT conflict_id FROM conflict_declarations WHERE person_id=? AND status='active' AND (expires_at IS NULL OR expires_at>?) AND (object_id=? OR object_id IS NULL)",
          [identity.person_id, new Date().toISOString(), objectId],
        );
        return rows.length > 0;
      },
    }),
  );
  app.use('/admin/v1/*', async (c, next) => {
    assert(config.mode === 'demo', 'LEGACY_AUTHORIZATION_DISABLED', 403);
    const principal = await resolve(c.req.raw.headers);
    assert(principal, 'AUTH_REQUIRED', 401);
    assert(principal.two_factor && principal.verified, 'MFA_REQUIRED', 403);
    c.set('principal', principal);
    await next();
  });
  app.get('/admin/v1/me', (c) => {
    const p = c.get('principal');
    return c.json({ person_id: p.person_id, roles: p.roles });
  });
  app.get('/admin/v1/work-items', async (c) => {
    requireRole(c.get('principal'), 'reviewer');
    const rows = await db.all<WorkItem>(
      'SELECT * FROM work_items ORDER BY created_at DESC LIMIT 100',
    );
    const items = [];
    for (const row of rows)
      if (await service.canRead(c.get('principal'), row))
        items.push({
          id: row.id,
          kind: row.kind,
          state: row.state,
          version: row.version,
          created_at: row.created_at,
        });
    return c.json({ items });
  });
  app.get('/admin/v1/work-items/:id', async (c) => {
    requireRole(c.get('principal'), 'reviewer');
    const row = await service.readable(c.get('principal'), id.parse(c.req.param('id')));
    return c.json({
      id: row.id,
      kind: row.kind,
      state: row.state,
      version: row.version,
      body: JSON.parse(row.body),
    });
  });
  app.post('/admin/v1/work-items/:id/transition', async (c) => {
    const b = z
      .strictObject({
        expected_revision: z.number().int().positive(),
        state: z.string(),
        reason: text,
      })
      .parse(await input(c));
    await service.triage(
      c.get('principal'),
      id.parse(c.req.param('id')),
      b.expected_revision,
      b.state,
      b.reason,
    );
    return c.json({ saved: true });
  });
  app.post('/admin/v1/work-items/:id/message', async (c) => {
    requireRole(c.get('principal'), 'reviewer');
    const b = z.strictObject({ message: text }).parse(await input(c));
    await service.readable(c.get('principal'), id.parse(c.req.param('id')));
    await db.batch([
      {
        sql: 'INSERT INTO messages VALUES(?,?,?,?,?)',
        params: [
          'msg_' + crypto.randomUUID().replaceAll('-', ''),
          id.parse(c.req.param('id')),
          'reviewer',
          b.message,
          new Date().toISOString(),
        ],
      },
    ]);
    return c.json({ saved: true });
  });
  app.get('/admin/v1/proposals', async (c) => {
    requireRole(c.get('principal'), 'reviewer');
    const p = c.get('principal');
    const items = (
      await db.all<Proposal>('SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100')
    ).filter(
      (row) =>
        (p.company_ids.includes('*') || p.company_ids.includes(row.company_id)) &&
        !p.conflicts.includes(row.company_id),
    );
    return c.json({ items });
  });
  app.post('/admin/v1/proposals', async (c) =>
    c.json(await service.proposal(c.get('principal'), proposalSchema.parse(await input(c))), 201),
  );
  app.post('/admin/v1/proposals/:id/review', async (c) => {
    const body = z
      .strictObject({ action: z.enum(['approve', 'return', 'reject']), reason: text })
      .parse(await input(c));
    return c.json(
      await service.review(
        c.get('principal'),
        id.parse(c.req.param('id')),
        body.action,
        body.reason,
      ),
    );
  });
  app.post('/admin/v1/records/:id/suppress', async (c) => {
    const b = z.strictObject({ reason: text }).parse(await input(c));
    await service.suppress(c.get('principal'), id.parse(c.req.param('id')), b.reason);
    return c.json({ state: 'suppressed', distribution: 'requires_signed_status_update' });
  });
  app.post('/admin/v1/releases/build', async (c) => {
    z.strictObject({}).parse(await input(c));
    const approved = await service.publicInput(c.get('principal'));
    return c.json({ approved, publication_enabled: false });
  });
  app.get('/admin/v1/metrics', async (c) => {
    requireRole(c.get('principal'), 'operator');
    return c.json(await service.metrics());
  });
  app.get('/admin/v1/audit', async (c) => {
    requireRole(c.get('principal'), 'operator');
    return c.json({
      items: await db.all('SELECT * FROM audit ORDER BY created_at DESC LIMIT 100'),
    });
  });
  app.post('/admin/v1/governance/proposals', async (c) => {
    requireRole(c.get('principal'), 'governor');
    const b = z
      .strictObject({
        kind: z.enum(['root_rotation', 'epoch_change', 'rule_change']),
        reason: text,
        payload: z.record(z.string(), z.unknown()),
      })
      .parse(await input(c));
    const proposalId = 'gov_' + crypto.randomUUID().replaceAll('-', '');
    await db.batch([
      {
        sql: 'INSERT INTO governance VALUES(?,?,?,?)',
        params: [
          proposalId,
          JSON.stringify(b),
          'awaiting_offline_threshold',
          new Date().toISOString(),
        ],
      },
    ]);
    return c.json({ id: proposalId, state: 'awaiting_offline_threshold' }, 201);
  });
  app.post('/admin/v1/releases/:id/publish', () => {
    throw new DomainError('PRODUCTION_GATE_CLOSED', 403);
  });
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND' } }, 404));
  return app;
}
