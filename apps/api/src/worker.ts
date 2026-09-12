import { drizzle } from 'drizzle-orm/d1';
import { d1Database } from '../../../packages/db/src/d1';
import { createApp } from './app';
import { createAuth, resolvePrincipal } from './auth';
import { Service } from './service';
import * as schema from '../../../packages/db/src/schema';
import type { D1Database } from '@cloudflare/workers-types';
import { maintainGovernance } from '../../../packages/governance-policy/src/maintenance';
type Bindings = Omit<
  Cloudflare.Env,
  | 'MODE'
  | 'INTAKE_ENABLED'
  | 'PROMOTION_ENABLED'
  | 'PRODUCTION_RELEASE_ENABLED'
  | 'ADMIN_ORIGIN'
  | 'INTAKE_ORIGIN'
> & {
  BETTER_AUTH_SECRET: string;
  MODE: string;
  INTAKE_ENABLED: string;
  PROMOTION_ENABLED: string;
  PRODUCTION_RELEASE_ENABLED: string;
  ADMIN_ORIGIN: string;
  INTAKE_ORIGIN: string;
};
export default {
  async fetch(request: Request, env: Bindings) {
    if (!env.BETTER_AUTH_SECRET) return new Response('Service not configured', { status: 503 });
    const db = d1Database(env.DB);
    const auth = createAuth(
      drizzle(env.DB, { schema }),
      env.BETTER_AUTH_SECRET,
      env.ADMIN_ORIGIN,
      db,
    );
    const app = createApp(
      db,
      {
        mode: env.MODE === 'production' ? 'production' : 'demo',
        intakeEnabled: env.INTAKE_ENABLED === 'true',
        promotionEnabled: false,
        productionReleaseEnabled: false,
        origins: [env.ADMIN_ORIGIN, env.INTAKE_ORIGIN],
        rateSecret: env.BETTER_AUTH_SECRET,
      },
      (h) => resolvePrincipal(auth, db, h),
      (r) => auth.handler(r),
    );
    return app.fetch(request);
  },
  async scheduled(_event: unknown, env: Bindings) {
    await new Service(d1Database(env.DB)).maintenance();
    await maintainGovernance(d1Database(env.DB));
  },
};
