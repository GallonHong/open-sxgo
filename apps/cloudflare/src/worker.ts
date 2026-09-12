import type { CloudflarePostgresEnv } from '../worker-configuration';
import { Client } from 'pg';
import { createPostgresApp } from '../../api/src/postgres-app';
import { Service } from '../../api/src/service';
import { maintainGovernance } from '../../../packages/governance-policy/src/maintenance';

export default {
  async fetch(request: Request, env: CloudflarePostgresEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (
      url.pathname === '/pilot' ||
      url.pathname === '/pilot/' ||
      url.pathname === '/pilot/logout'
    ) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: new URL('/companies', url).href,
          'Cache-Control': 'no-store',
          'Set-Cookie': '__Host-sxgo-pilot=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
        },
      });
    }
    if (
      url.pathname === '/health' ||
      url.pathname.startsWith('/private/v1/') ||
      url.pathname.startsWith('/admin/v1/')
    ) {
      if (
        !env.BETTER_AUTH_SECRET ||
        env.BETTER_AUTH_SECRET.length < 32 ||
        !env.HYPERDRIVE ||
        !env.ADMIN_ORIGIN ||
        !env.INTAKE_ORIGIN
      )
        return Response.json(
          { error: { code: 'SERVICE_NOT_CONFIGURED' } },
          { status: 503, headers: { 'Cache-Control': 'no-store' } },
        );
      const client = new Client({
        connectionString: env.HYPERDRIVE.connectionString,
        connectionTimeoutMillis: 10000,
      });
      try {
        await client.connect();
        const { app } = createPostgresApp(client, {
          secret: env.BETTER_AUTH_SECRET,
          adminOrigin: env.ADMIN_ORIGIN,
          intakeOrigin: env.INTAKE_ORIGIN,
          intakeEnabled: env.INTAKE_ENABLED === 'true',
        });
        return await app.fetch(request);
      } catch {
        // Never include SQL, credentials, submission bodies or receipt headers in logs.
        console.error(JSON.stringify({ code: 'BACKEND_REQUEST_FAILED' }));
        return Response.json(
          { error: { code: 'SERVICE_UNAVAILABLE' } },
          { status: 503, headers: { 'Cache-Control': 'no-store' } },
        );
      } finally {
        ctx.waitUntil(client.end().catch(() => undefined));
      }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    if (
      url.pathname.length > 1 &&
      url.pathname.endsWith('/') &&
      !url.pathname.startsWith('/public/')
    ) {
      url.pathname = url.pathname.replace(/\/+$/, '');
      return Response.redirect(url.href, 308);
    }
    const intake = ['/contribute', '/receipt', '/report'].includes(url.pathname);
    const admin =
      url.pathname === '/admin' ||
      url.pathname.startsWith('/admin/') ||
      ['/member/', '/review/', '/governance/'].some((p) => url.pathname.startsWith(p));
    if (intake) url.pathname = '/intake.html';
    else if (admin) url.pathname = '/admin.html';
    else if (!url.pathname.startsWith('/public/') && !/\.[a-z0-9]+$/i.test(url.pathname))
      url.pathname = '/index.html';
    const response = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(response.headers);
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    if (intake || admin) headers.set('Cache-Control', 'private, no-store');
    else if (!url.pathname.startsWith('/assets/')) headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(_event: ScheduledController, env: CloudflarePostgresEnv) {
    const client = new Client({
      connectionString: env.HYPERDRIVE.connectionString,
      connectionTimeoutMillis: 10000,
    });
    try {
      await client.connect();
      const { db } = createPostgresApp(client, {
        secret: env.BETTER_AUTH_SECRET,
        adminOrigin: env.ADMIN_ORIGIN,
        intakeOrigin: env.INTAKE_ORIGIN,
        intakeEnabled: false,
      });
      await new Service(db).maintenance();
      await maintainGovernance(db);
    } finally {
      await client.end();
    }
  },
};
