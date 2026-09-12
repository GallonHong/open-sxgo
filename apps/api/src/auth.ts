import { APIError, betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import type { Principal } from '../../../packages/protocol/src/private';
import type { Database } from '../../../packages/db/src/adapter';
import { resolveIdentity as resolveAuthorizedIdentity } from '../../../packages/identity-permissions/src/index';
export function createAuth(
  db: Parameters<typeof drizzleAdapter>[0],
  secret: string,
  origin: string,
  identityDb?: Database,
  provider: 'sqlite' | 'pg' = 'sqlite',
) {
  const authOrigin = new URL(origin);
  return betterAuth({
    database: drizzleAdapter(db, { provider }),
    secret,
    baseURL: origin,
    basePath: '/admin/v1/auth',
    trustedOrigins: [origin],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 14 },
    plugins: [
      twoFactor({ issuer: 'WFD 审核' }),
      passkey({
        rpID: authOrigin.hostname,
        rpName: 'WFD 审核',
        origin,
        registration: {
          requireSession: true,
          afterVerification: async ({ ctx, user, verification }) => {
            // Better Auth's passkey plugin performs real WebAuthn ceremony
            // verification. We still apply WFD's identity policy here: the
            // first key requires a staff-approved active binding, and adding
            // another key requires a fresh existing WebAuthn step-up.
            if (!identityDb || !ctx.context.session)
              throw new APIError('FORBIDDEN', { message: 'WFD identity binding required' });
            if (!verification.verified || !verification.registrationInfo?.userVerified)
              throw new APIError('FORBIDDEN', { message: 'WebAuthn user verification required' });
            const sessionId = ctx.context.session.session.id;
            const [binding] = await identityDb.all<{ status: string; linked_by: string }>(
              `SELECT pi.status,pa.linked_by FROM principal_accounts pa
                JOIN principal_identities pi ON pi.principal_id=pa.principal_id
               WHERE pa.user_id=? AND pa.status='active'`,
              [user.id],
            );
            if (
              !binding ||
              binding.status !== 'active' ||
              ['self', 'user'].includes(binding.linked_by)
            )
              throw new APIError('FORBIDDEN', { message: 'approved identity binding required' });
            const [existing] = await identityDb.all<{ count: number }>(
              `SELECT
                (SELECT COUNT(*) FROM webauthn_credentials WHERE user_id=? AND status='active') +
                (SELECT COUNT(*) FROM passkey WHERE userId=?) AS count`,
              [user.id, user.id],
            );
            if ((existing?.count ?? 0) > 0) {
              const [proof] = await identityDb.all<{ assurance: string }>(
                `SELECT assurance FROM session_assurance
                  WHERE session_id=? AND user_id=? AND assurance='webauthn_step_up'
                    AND expires_at>? ORDER BY verified_at DESC LIMIT 1`,
                [sessionId, user.id, new Date().toISOString()],
              );
              if (!proof)
                throw new APIError('FORBIDDEN', { message: 'fresh WebAuthn step-up required' });
            }
          },
        },
      }),
    ],
    session: { expiresIn: 8 * 3600, updateAge: 1800 },
    advanced: { disableCSRFCheck: false, ipAddress: { disableIpTracking: true } },
    rateLimit: { enabled: true, storage: 'database' },
  });
}
export type Auth = ReturnType<typeof createAuth>;
export async function resolvePrincipal(
  auth: Auth,
  db: Database,
  headers: Headers,
): Promise<Principal | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const [p] = await db.all<{
    user_id: string;
    person_id: string;
    roles: string;
    company_ids: string;
    conflicts: string;
    verified: number;
  }>('SELECT * FROM principals WHERE user_id=?', [session.user.id]);
  const [binding] = await db.all<{
    person_id: string;
    status: string;
  }>(
    `SELECT pi.person_id,pi.status FROM principal_accounts pa
      JOIN principal_identities pi ON pi.principal_id=pa.principal_id
      WHERE pa.user_id=? AND pa.status='active'`,
    [session.user.id],
  );
  const fallbackPerson =
    binding?.person_id ?? 'person_pending_' + session.user.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const principal = p
    ? {
        ...p,
        roles: JSON.parse(p.roles),
        company_ids: JSON.parse(p.company_ids),
        conflicts: JSON.parse(p.conflicts),
        verified: !!p.verified,
      }
    : {
        user_id: session.user.id,
        person_id: fallbackPerson,
        roles: [],
        company_ids: [],
        conflicts: [],
        // A new account can resolve to a least-privilege principal, but it
        // must still be explicitly linked and granted before privileged work.
        verified: binding?.status === 'active',
      };
  return {
    ...principal,
    // Better Auth's account flag only records that TOTP is enabled. It is
    // retained for the legacy closed-demo guard; high-privilege routes must
    // use resolveAuthorizedPrincipal/Identity.assurance, which is a current
    // session-bound proof and is never inferred from this boolean.
    two_factor: !!session.user.twoFactorEnabled,
    session_id: session.session.id,
  } as Principal;
}

/**
 * New PRD2 routes must use this resolver. It returns only the private identity
 * binding and current grant snapshot; it never reads legacy role arrays.
 */
export async function resolveAuthorizedPrincipal(auth: Auth, db: Database, headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  return resolveAuthorizedIdentity(db, {
    user_id: session.user.id,
    session_id: session.session.id,
  });
}
