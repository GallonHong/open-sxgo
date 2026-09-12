import { Hono } from 'hono';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import type { Database, Query } from '../../../packages/db/src/adapter';
import { strictJSON } from '../../../packages/verifier/src/crypto';
import { authorize, type Identity } from '../../../packages/identity-permissions/src/index';

const MAX_BODY_BYTES = 8 * 1024;
const PROVISIONED_ROLE = 'reviewer';
const AUDIT_ACTION = 'account.provision';

export type ResolveAccountIdentity =
  ((headers: Headers) => Promise<Identity | null>) | ((headers: Headers) => Identity | null);

export type ProvisionAccountInput = {
  email: string;
  person_id: string;
  name: string;
};

type NormalizedProvisionAccount = ProvisionAccountInput;

type AccountRow = {
  user_id: string;
  email: string;
  name: string;
  principal_id: string | null;
  person_id: string | null;
  account_status: string | null;
  person_status: string | null;
};

class AccountsError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = 'AccountsError';
  }
}

const accountInputSchema = z.strictObject({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+$/),
  person_id: z
    .string()
    .trim()
    .regex(/^person_[a-z0-9_-]{3,120}$/),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
});

function jsonResponse(status: number, code: string, value?: Record<string, unknown>): Response {
  return new Response(JSON.stringify(value ?? { error: { code } }), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function fail(code: string, status: number): never {
  throw new AccountsError(code, status);
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function randomPassword(): string {
  // 256 bits from the runtime CSPRNG, encoded without shell-sensitive characters.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function bodyLength(request: Request): number | null {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength === null) return null;
  const normalized = contentLength.trim();
  if (!/^\d+$/.test(normalized)) fail('INVALID_INPUT', 400);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) fail('BODY_TOO_LARGE', 413);
  return parsed;
}

async function parseProvisionBody(request: Request): Promise<NormalizedProvisionAccount> {
  const declaredLength = bodyLength(request);
  if (declaredLength !== null && declaredLength > MAX_BODY_BYTES) fail('BODY_TOO_LARGE', 413);

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    fail('INVALID_INPUT', 400);
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) fail('BODY_TOO_LARGE', 413);

  let value: unknown;
  try {
    value = strictJSON(raw);
  } catch {
    fail('INVALID_INPUT', 400);
  }
  const parsed = accountInputSchema.safeParse(value);
  if (!parsed.success) fail('INVALID_INPUT', 400);
  return parsed.data;
}

async function existingConflict(
  db: Database,
  email: string,
  personId: string,
): Promise<'EMAIL_ALREADY_EXISTS' | 'PERSON_ALREADY_EXISTS' | null> {
  const [emailRow] = await db.all<{ id: string }>(
    'SELECT id FROM user WHERE lower(email)=lower(?) LIMIT 1',
    [email],
  );
  if (emailRow) return 'EMAIL_ALREADY_EXISTS';

  const [personRow] = await db.all<{ principal_id: string }>(
    'SELECT principal_id FROM principal_identities WHERE person_id=? LIMIT 1',
    [personId],
  );
  if (personRow) return 'PERSON_ALREADY_EXISTS';

  // A legacy binding still identifies the same natural person. It is never
  // written by this route, but it must prevent a second identity from being
  // provisioned for that person.
  const [legacyPersonRow] = await db.all<{ user_id: string }>(
    'SELECT user_id FROM principals WHERE person_id=? LIMIT 1',
    [personId],
  );
  return legacyPersonRow ? 'PERSON_ALREADY_EXISTS' : null;
}

function mutationGuard(): Query[] {
  return [
    { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
    { sql: 'DELETE FROM mutation_guard' },
  ];
}

function provisioningLocks(email: string, personId: string): Query[] {
  // The PostgreSQL adapter keeps a whole db.batch on one transaction. These
  // locks close the duplicate-person race before the conditional insert. The
  // SQLite/D1 adapters do not expose PostgreSQL functions; they use their
  // serialized/atomic batch behavior.
  return [`email:${email}`, `person:${personId}`].sort().map((key) => ({
    sql: 'SELECT pg_advisory_xact_lock(hashtextextended(?::text,0))',
    params: [`wfd:provision-reviewer:${key}`],
  }));
}

async function hasTwoFactorEnabled(db: Database, userId: string): Promise<boolean> {
  const [row] = await db.all<{ two_factor_enabled: unknown }>(
    'SELECT twoFactorEnabled AS two_factor_enabled FROM user WHERE id=?',
    [userId],
  );
  return row?.two_factor_enabled === true || row?.two_factor_enabled === 1;
}

async function currentAuthorizedActor(
  db: Database,
  resolver: ResolveAccountIdentity,
  request: Request,
): Promise<Identity> {
  const identity = await resolver(request.headers);
  if (!identity) fail('AUTHENTICATION_REQUIRED', 401);
  if (identity.status !== 'active') fail('CAPABILITY_DENIED', 403);
  if (!(await hasTwoFactorEnabled(db, identity.user_id))) fail('MFA_SETUP_REQUIRED', 403);

  const decision = await authorize(db, identity, {
    capability: 'account.provision',
    object_type: 'role',
    object_id: PROVISIONED_ROLE,
    scope: { role_ids: [PROVISIONED_ROLE] },
    required_assurance: 'webauthn_step_up',
  });
  if (!decision.allowed) fail(decision.code, 403);
  return identity;
}

function accountRows(rows: AccountRow[]) {
  return rows.map((row) => ({
    user_id: row.user_id,
    email: row.email,
    name: row.name,
    principal_id: row.principal_id,
    person_id: row.person_id,
    account_status: row.account_status,
    person_status: row.person_status,
  }));
}

async function listAccounts(db: Database): Promise<AccountRow[]> {
  return db.all<AccountRow>(
    `SELECT u.id AS user_id,u.email,u.name,
            pa.principal_id,pi.person_id,
            pa.status AS account_status,pi.status AS person_status
       FROM user u
       LEFT JOIN principal_accounts pa ON pa.user_id=u.id
       LEFT JOIN principal_identities pi ON pi.principal_id=pa.principal_id
      ORDER BY u.createdAt DESC,u.id
      LIMIT 100`,
  );
}

async function createPendingAccount(
  db: Database,
  actor: Identity,
  input: NormalizedProvisionAccount,
): Promise<{ email: string; initial_password: string }> {
  const conflict = await existingConflict(db, input.email, input.person_id);
  if (conflict) fail(conflict, 409);

  const userId = randomId('user');
  const principalId = randomId('principal');
  const accountId = randomId('account');
  const initialPassword = randomPassword();
  const passwordHash = await hashPassword(initialPassword);
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const reason = JSON.stringify({
    email: input.email,
    person_id: input.person_id,
    principal_id: principalId,
    role: PROVISIONED_ROLE,
    status: 'pending',
  });

  const writes: Query[] = [
    {
      sql: `INSERT INTO user
        (id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled)
        VALUES(?,?,?,?,?,?,?)`,
      params: [userId, input.name, input.email, 0, nowMs, nowMs, 0],
    },
    ...mutationGuard(),
    {
      // person_id has no unique index in the existing schema. This
      // conditional insert plus the mutation guard makes the check part of
      // the same transaction as the account rows.
      sql: `INSERT INTO principal_identities
        (principal_id,person_id,status,privacy_preferences,created_at,updated_at)
        SELECT ?,?,'pending','{}',?,?
         WHERE NOT EXISTS (
           SELECT 1 FROM principal_identities WHERE person_id=?
           UNION ALL
           SELECT 1 FROM principals WHERE person_id=?
         )`,
      params: [principalId, input.person_id, nowIso, nowIso, input.person_id, input.person_id],
    },
    ...mutationGuard(),
    {
      sql: `INSERT INTO account
        (id,accountId,providerId,userId,password,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?)`,
      params: [accountId, userId, 'credential', userId, passwordHash, nowMs, nowMs],
    },
    {
      sql: `INSERT INTO principal_accounts
        (user_id,principal_id,status,linked_at,linked_by,account_revision)
        VALUES(?,?,?, ?,?,?)`,
      params: [userId, principalId, 'pending', nowIso, actor.person_id, 1],
    },
    {
      sql: `INSERT INTO audit
        (id,item_id,actor,action,reason,created_at)
        VALUES(?,?,?,?,?,?)`,
      params: [randomId('audit'), principalId, actor.person_id, AUDIT_ACTION, reason, nowIso],
    },
  ];

  try {
    await db.batch([
      ...(db.dialect === 'postgres' ? provisioningLocks(input.email, input.person_id) : []),
      ...writes,
    ]);
  } catch (error) {
    // The adapter rolls back the complete batch. Re-check only conflict
    // state; never surface adapter text, SQL or private request data.
    const racedConflict = await existingConflict(db, input.email, input.person_id).catch(
      () => null,
    );
    if (racedConflict) fail(racedConflict, 409);
    throw error;
  }

  return { email: input.email, initial_password: initialPassword };
}

/**
 * Build the private reviewer-account management routes. Mount the returned
 * router at `/admin/v1` to expose GET/POST `/admin/v1/accounts`.
 *
 * `adminOrigin` is optional for hosts that already enforce the global CORS
 * middleware. When supplied, POST requests also require that exact Origin.
 */
export function createAccountsRoutes(
  db: Database,
  resolveIdentity: ResolveAccountIdentity,
  adminOrigin?: string,
) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.onError((error) => {
    if (error instanceof AccountsError) return jsonResponse(error.status, error.code);
    if (error instanceof z.ZodError) return jsonResponse(400, 'INVALID_INPUT');
    return jsonResponse(503, 'SERVICE_UNAVAILABLE');
  });

  const requireSameOrigin = (request: Request) => {
    if (adminOrigin !== undefined && request.headers.get('Origin') !== adminOrigin)
      fail('ORIGIN_REJECTED', 403);
  };

  app.get('/accounts', async (c) => {
    await currentAuthorizedActor(db, resolveIdentity, c.req.raw);
    return c.json({ items: accountRows(await listAccounts(db)) });
  });

  app.post('/accounts', async (c) => {
    requireSameOrigin(c.req.raw);
    const actor = await currentAuthorizedActor(db, resolveIdentity, c.req.raw);
    const input = await parseProvisionBody(c.req.raw);
    return new Response(JSON.stringify(await createPendingAccount(db, actor, input)), {
      status: 201,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  });

  return app;
}
