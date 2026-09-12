import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
execFileSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'types',
    'apps/cloudflare/worker-configuration.d.ts',
    '--config',
    'apps/cloudflare/wrangler.jsonc',
    '--env-interface',
    'CloudflarePostgresEnv',
    '--include-runtime',
    'false',
    '--strict-vars',
    'false',
  ],
  { stdio: 'inherit' },
);
await appendFile(
  'apps/cloudflare/worker-configuration.d.ts',
  '\n// Isolate this deployment from the D1 Site Env.\nexport type { CloudflarePostgresEnv };\n',
);
