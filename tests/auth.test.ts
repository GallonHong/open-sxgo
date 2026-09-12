import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { hashPassword } from 'better-auth/crypto';
import { openDatabase } from '../packages/db/src/node';
import { migrate } from '../packages/db/src/migrate';
import * as schema from '../packages/db/src/schema';
import { createAuth, resolvePrincipal } from '../apps/api/src/auth';
function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, ''))
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hmac = createHmac('sha1', bytes).update(counter).digest(),
    offset = hmac.at(-1)! & 15;
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
it('实际 Better Auth 密码 + TOTP 注册和强制登录', async () => {
  const { db, sqlite } = openDatabase(':memory:');
  try {
    await migrate(sqlite);
    const now = Date.now(),
      password = 'fixture-password-not-production-12345';
    await db.batch([
      {
        sql: 'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
        params: ['test-user', 'Test', 'test@example.org', 1, now, now],
      },
      {
        sql: 'INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)',
        params: [
          'test-account',
          'test-user',
          'credential',
          'test-user',
          await hashPassword(password),
          now,
          now,
        ],
      },
      {
        sql: 'INSERT INTO principals VALUES(?,?,?,?,?,?)',
        params: ['test-user', 'person_test', '["reviewer"]', '["*"]', '[]', 1],
      },
    ]);
    const auth = createAuth(
      drizzle(sqlite, { schema }),
      'test-only-long-secret-not-production-1234567890',
      'http://localhost:8787',
    );
    const cookies = new Map<string, string>();
    const headers = () =>
      new Headers({
        Origin: 'http://localhost:8787',
        'Content-Type': 'application/json',
        Cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; '),
      });
    async function post(path: string, body: unknown) {
      const r = await auth.handler(
        new Request('http://localhost:8787/admin/v1/auth/' + path, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(body),
        }),
      );
      for (const s of r.headers.getSetCookie()) {
        const first = s.split(';')[0],
          eq = first.indexOf('=');
        cookies.set(first.slice(0, eq), first.slice(eq + 1));
      }
      return { status: r.status, body: JSON.parse(await r.text()) };
    }
    expect(
      (await post('sign-up/email', { email: 'other@example.org', password, name: 'Other' })).status,
    ).not.toBe(200);
    expect((await post('sign-in/email', { email: 'test@example.org', password })).status).toBe(200);
    expect((await resolvePrincipal(auth, db, headers()))?.two_factor).toBe(false);
    const setup = await post('two-factor/enable', { password, method: 'totp' });
    expect(setup.status).toBe(200);
    const secret = new URL(setup.body.totpURI).searchParams.get('secret')!;
    expect((await post('two-factor/verify-totp', { code: totp(secret) })).status).toBe(200);
    expect((await resolvePrincipal(auth, db, headers()))?.two_factor).toBe(true);
    await post('sign-out', {});
    const next = await post('sign-in/email', { email: 'test@example.org', password });
    expect(next.body.twoFactorRedirect).toBe(true);
    expect(await resolvePrincipal(auth, db, headers())).toBeNull();
    expect((await post('two-factor/verify-totp', { code: totp(secret) })).status).toBe(200);
  } finally {
    sqlite.close();
  }
});
