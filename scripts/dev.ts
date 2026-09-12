import { spawn } from 'node:child_process';
const apps = ['web', 'intake', 'admin'];
const children = apps.map((name) =>
  spawn('pnpm', ['exec', 'vite', '--config', `apps/${name}/vite.config.ts`], {
    stdio: 'inherit',
    env: process.env,
  }),
);
children.push(
  spawn('pnpm', ['exec', 'tsx', 'apps/api/src/node.ts'], { stdio: 'inherit', env: process.env }),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit(0);
  });
