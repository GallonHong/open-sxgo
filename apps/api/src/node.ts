import { serve } from '@hono/node-server';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { openDatabase } from '../../../packages/db/src/node';
import { migrate } from '../../../packages/db/src/migrate';
import { createApp } from './app';
import { createAuth, resolvePrincipal } from './auth';
import * as schema from '../../../packages/db/src/schema';
await mkdir('.runtime/private', { recursive: true, mode: 0o700 });
const { db, sqlite } = openDatabase(process.env.WFD_DB_PATH ?? '.runtime/private/intake.db');
await migrate(sqlite);
const secretPath = '.runtime/private/auth-secret';
let secret = process.env.BETTER_AUTH_SECRET;
try {
  secret ??= await readFile(secretPath, 'utf8');
} catch {
  secret = crypto.randomUUID() + crypto.randomUUID();
  await writeFile(secretPath, secret, { mode: 0o600 });
}
const adminOrigin = process.env.WFD_ADMIN_ORIGIN ?? 'http://localhost:5175';
const origins = [adminOrigin, process.env.WFD_INTAKE_ORIGIN ?? 'http://127.0.0.1:5174'];
const auth = createAuth(drizzle(sqlite, { schema }), secret!, adminOrigin, db);
const app = createApp(
  db,
  {
    mode: 'demo',
    intakeEnabled: true,
    promotionEnabled: false,
    productionReleaseEnabled: false,
    origins,
    rateSecret: secret!,
  },
  (h) => resolvePrincipal(auth, db, h),
  (r) => auth.handler(r),
);
const server = serve(
  { fetch: app.fetch, hostname: process.env.WFD_BIND_HOST ?? '127.0.0.1', port: 8787 },
  () => console.log('可信私密服务 http://127.0.0.1:8787'),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () =>
    server.close(() => {
      sqlite.close();
      process.exit(0);
    }),
  );
