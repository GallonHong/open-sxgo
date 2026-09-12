import { chromium, firefox, webkit } from '@playwright/test';
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { publishDemo } from '../packages/builder/src/index';
import { fixtureDataset } from './fixtures';
import { update, type Envelope } from '../packages/verifier/src/index';
const dir = await mkdtemp(join(tmpdir(), 'wfd-differential-'));
const now = Date.now();
try {
  const { root } = await publishDemo(fixtureDataset(new Date(now)), dir, new Date(now));
  const files: Record<string, number[]> = {};
  async function walk(path = '') {
    for (const e of await readdir(join(dir, path), { withFileTypes: true })) {
      const name = path ? path + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(name);
      else files[name] = Array.from(await readFile(join(dir, name)));
    }
  }
  await walk();
  const fetcher = async (path: string, max: number) => {
    const data = files[path];
    if (data && data.length > max) throw Error('DOWNLOAD_TOO_LARGE');
    return data ? new Uint8Array(data) : null;
  };
  const trusted = await update(fetcher, root, undefined, now);
  const cases = ['valid', 'tampered', 'expired', 'rollback', 'fork', 'signature_threshold'];
  const results = [];
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.addInitScript('globalThis.__name = (fn) => fn;');
      await page.goto('http://127.0.0.1:5173');
      for (const testCase of cases) {
        const expected: Record<string, string> = {
          valid: 'valid',
          tampered: 'HASH_MISMATCH',
          expired: 'EXPIRED',
          rollback: 'ROLLBACK',
          fork: 'FORK',
          signature_threshold: 'SIGNATURE_THRESHOLD',
        };
        let nodeResult = 'valid';
        try {
          const previous =
            testCase === 'rollback'
              ? { ...trusted.state, sequence: trusted.state.sequence + 1 }
              : testCase === 'fork'
                ? { ...trusted.state, releaseHash: '0'.repeat(64) }
                : undefined;
          const nodeTrust =
            testCase === 'signature_threshold'
              ? { ...root, signatures: root.signatures.slice(0, 1) }
              : root;
          const result = await update(
            async (path, max) => {
              const b = await fetcher(path, max);
              if (b && testCase === 'tampered' && path.endsWith('/directory.json')) b[0] ^= 1;
              return b;
            },
            nodeTrust,
            previous,
            testCase === 'expired' ? now + 49 * 3600000 : now,
          );
          await result.artifact('directory.json');
        } catch (e) {
          nodeResult = (e as Error).message;
        }
        if (nodeResult !== expected[testCase]) throw Error('Node outcome mismatch');
        const actual = await page.evaluate(
          async ({ files, root, state, now, testCase, moduleURL }) => {
            const verifier = await import(moduleURL);
            const fetcher = async (path: string, max: number) => {
              if (!files[path]) return null;
              const bytes = new Uint8Array(files[path]);
              if (bytes.length > max) throw Error('DOWNLOAD_TOO_LARGE');
              if (testCase === 'tampered' && path.endsWith('/directory.json')) bytes[0] ^= 1;
              return bytes;
            };
            try {
              let previous =
                testCase === 'rollback'
                  ? { ...state, sequence: state.sequence + 1 }
                  : testCase === 'fork'
                    ? { ...state, releaseHash: '0'.repeat(64) }
                    : undefined;
              const trust =
                testCase === 'signature_threshold'
                  ? { ...root, signatures: root.signatures.slice(0, 1) }
                  : root;
              const result = await verifier.update(
                fetcher,
                trust,
                previous,
                testCase === 'expired' ? now + 49 * 3600000 : now,
              );
              await result.artifact('directory.json');
              return 'valid';
            } catch (e) {
              return (e as Error).message;
            }
          },
          {
            files,
            root,
            state: trusted.state,
            now,
            testCase,
            moduleURL: '/@fs/' + resolve('packages/verifier/src/index.ts'),
          },
        );
        if (actual !== nodeResult) throw Error(name + ' ' + testCase + ': ' + actual);
        results.push({ browser: name, test: testCase, actual });
      }
    } finally {
      await browser.close();
    }
  }
  await mkdir('.runtime/reports', { recursive: true });
  await writeFile(
    '.runtime/reports/browser-differential.json',
    JSON.stringify({ passed: results.length, results, at: new Date().toISOString() }, null, 2),
  );
  console.log(JSON.stringify({ browser_protocol_assertions: results.length, passed: true }));
} finally {
  await rm(dir, { recursive: true, force: true });
}
