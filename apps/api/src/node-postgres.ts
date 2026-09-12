import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createPostgresApp } from './postgres-app';
const connectionString = process.env.DATABASE_URL;
const secret = process.env.BETTER_AUTH_SECRET;
const adminOrigin = process.env.WFD_ADMIN_ORIGIN;
const intakeOrigin = process.env.WFD_INTAKE_ORIGIN;
if (!connectionString || !secret || secret.length < 32 || !adminOrigin || !intakeOrigin)
  throw Error(
    'DATABASE_URL, BETTER_AUTH_SECRET (32+ characters), WFD_ADMIN_ORIGIN and WFD_INTAKE_ORIGIN required',
  );
const pool = new Pool({
  connectionString,
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000,
});
pool.on('error', () => console.error('POSTGRES_CONNECTION_ERROR'));
const { app } = createPostgresApp(pool, {
  secret,
  adminOrigin,
  intakeOrigin,
  intakeEnabled: process.env.WFD_INTAKE_ENABLED === 'true',
});
const server = serve({
  fetch: app.fetch,
  hostname: process.env.WFD_BIND_HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 8788),
});
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
console.log('PostgreSQL backend started; production publication disabled.');
