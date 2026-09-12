import type { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../../packages/db/src/pg-schema';
import { postgresDatabase } from '../../../packages/db/src/postgres';
import { createApp } from './app';
import { createAuth, resolvePrincipal } from './auth';

export function createPostgresApp(
  client: Client | Pool,
  options: {
    secret: string;
    adminOrigin: string;
    intakeOrigin: string;
    intakeEnabled: boolean;
  },
) {
  const db = postgresDatabase(client);
  const auth = createAuth(
    drizzle(client, { schema }),
    options.secret,
    options.adminOrigin,
    db,
    'pg',
  );
  const app = createApp(
    db,
    {
      mode: 'production',
      intakeEnabled: options.intakeEnabled,
      promotionEnabled: false,
      productionReleaseEnabled: false,
      origins: [options.adminOrigin, options.intakeOrigin],
      rateSecret: options.secret,
    },
    (h) => resolvePrincipal(auth, db, h),
    (r) => auth.handler(r),
  );
  return { app, db, auth };
}
