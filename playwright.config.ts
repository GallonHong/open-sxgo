import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30000,
  fullyParallel: false,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  use: { baseURL: 'http://127.0.0.1:5173', headless: true, trace: 'off' },
  reporter: [['list']],
  webServer: [
    {
      command: 'pnpm exec vite --config apps/web/vite.config.ts',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
    },
    {
      command: `WFD_DB_PATH=.runtime/private/e2e-${process.pid}.db pnpm exec tsx apps/api/src/node.ts`,
      url: 'http://127.0.0.1:8787/health',
      reuseExistingServer: true,
    },
    {
      command: 'pnpm exec vite --config apps/intake/vite.config.ts',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: true,
    },
  ],
});
