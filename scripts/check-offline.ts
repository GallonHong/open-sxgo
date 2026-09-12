import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4173');
  await page.waitForSelector('.company-card');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector('.company-card');
  await context.setOffline(true);
  await page.reload();
  await page.getByText('历史副本 /', { exact: false }).waitFor();
  const caches = await page.evaluate(async () => {
    const names = await window.caches.keys();
    const paths = [];
    for (const name of names)
      for (const request of await (await window.caches.open(name)).keys())
        paths.push(new URL(request.url).pathname);
    return paths;
  });
  if (
    caches.some(
      (path) =>
        path.startsWith('/private/') || path.startsWith('/admin/') || path.startsWith('/public/'),
    )
  )
    throw Error('UNEXPECTED_SW_CACHE');
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile(
    '.runtime/reports/offline.json',
    JSON.stringify(
      {
        passed: true,
        shell_cached: true,
        historical_reload: true,
        private_cache_entries: 0,
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    'Installed public app reloads offline with historical data; no private resources cached.',
  );
} finally {
  await browser.close();
}
