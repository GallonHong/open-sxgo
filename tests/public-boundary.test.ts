import { expect, it } from 'vitest';
import { build } from 'vite';
import { relative } from 'node:path';

it('public bundle does not include private services or database models', async () => {
  const result = await build({
    configFile: 'apps/web/vite.config.ts',
    logLevel: 'silent',
    build: { write: false, copyPublicDir: false },
  });
  const forbidden =
    /^(?:apps\/(?:api|admin|intake)\/|packages\/(?:db|identity-permissions|review-workflow|evidence-gateway|contribution-ledger|governance-policy|governance-signing|node-observer)\/|packages\/protocol\/src\/private\.ts$)/;
  const outputs = Array.isArray(result) ? result : [result];
  const modules: string[] = [];
  for (const output of outputs)
    if ('output' in output)
      for (const chunk of output.output)
        if (chunk.type === 'chunk') modules.push(...Object.keys(chunk.modules));
  expect(modules.length).toBeGreaterThan(10);
  for (const path of modules) expect(relative(process.cwd(), path)).not.toMatch(forbidden);
});
