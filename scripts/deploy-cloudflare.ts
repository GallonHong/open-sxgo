import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
// Configuration contains resource identifiers only. Secrets are installed with Wrangler.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const hyperdrive = process.env.CLOUDFLARE_HYPERDRIVE_ID;
const origin = process.env.WFD_PUBLIC_ORIGIN;
if (
  !account ||
  !/^[a-f0-9]{32}$/.test(account) ||
  !hyperdrive ||
  !/^[a-f0-9]{32}$/.test(hyperdrive) ||
  /^0+$/.test(hyperdrive)
)
  throw Error('Real Cloudflare account and Hyperdrive IDs required');
if (
  !origin ||
  new URL(origin).origin !== origin ||
  !origin.startsWith('https://') ||
  new URL(origin).hostname.endsWith('.invalid')
)
  throw Error('A real HTTPS staging origin is required');
const config = JSON.parse(await readFile('apps/cloudflare/wrangler.jsonc', 'utf8'));
config.account_id = account;
config.main = resolve('apps/cloudflare/src/worker.ts');
config.assets.directory = resolve('dist/client');
config.hyperdrive[0].id = hyperdrive;
config.vars = {
  ...config.vars,
  ADMIN_ORIGIN: origin,
  INTAKE_ORIGIN: origin,
  INTAKE_ENABLED: 'false',
};
const hostname = new URL(origin).hostname;
if (hostname.endsWith('.workers.dev')) {
  if (hostname.split('.').length !== 4 || hostname.split('.')[0] !== config.name)
    throw Error('Workers origin must match configured Worker name');
  config.workers_dev = true;
  delete config.routes;
} else config.routes = [{ pattern: hostname, custom_domain: true }];
await mkdir('.runtime/cloudflare', { recursive: true, mode: 0o700 });
const path = resolve('.runtime/cloudflare/wrangler.json');
await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
// --dry-run prepares the exact configuration without publishing. Never create paid resources here.
execFileSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'deploy',
    '--config',
    path,
    ...(process.argv.includes('--dry-run') ? ['--dry-run'] : []),
  ],
  { stdio: 'inherit' },
);
