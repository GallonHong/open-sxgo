import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { Updater } from 'tuf-js';
import {
  decode,
  refreshMetadata,
  findTarget,
  fetchHTTP,
  checkBytes,
  type TrustedState,
} from '../../packages/verifier/src/index';
const { values, positionals } = parseArgs({
  options: {
    'metadata-dir': { type: 'string' },
    'metadata-url': { type: 'string' },
    'target-name': { type: 'string', multiple: true },
    'target-base-url': { type: 'string' },
    'target-dir': { type: 'string' },
  },
  allowPositionals: true,
});
const dir = values['metadata-dir']!;
const official = process.env.WFD_CONFORMANCE_CLIENT === 'official';
try {
  await mkdir(dir, { recursive: true });
  if (positionals[0] === 'init') {
    await writeFile(join(dir, 'root.json'), await readFile(positionals[1]));
    process.exit(0);
  }
  if (official) {
    const client = new Updater({
      metadataDir: dir,
      metadataBaseUrl: values['metadata-url']!,
      targetBaseUrl: values['target-base-url'],
      targetDir: values['target-dir'],
    });
    await client.refresh();
    if (positionals[0] === 'download')
      for (const name of values['target-name'] ?? []) {
        const info = await client.getTargetInfo(name);
        if (!info) throw Error('MISSING_TARGET');
        if (!(await client.findCachedTarget(info))) await client.downloadTarget(info);
      }
    process.exit(0);
  }
  const root = decode(await readFile(join(dir, 'root.json')));
  let previous: Pick<TrustedState, 'root' | 'versions' | 'lastTime' | 'metadata'> | undefined;
  try {
    previous = JSON.parse(await readFile(join(dir, 'wfd.state'), 'utf8'));
  } catch {}
  const result = await refreshMetadata(
    (path, max) => fetchHTTP(values['metadata-url']!, path.replace(/^metadata\//, ''), max),
    root,
    previous,
    Date.now(),
    async (role, e, bytes) => {
      await writeFile(join(dir, role + '.json'), bytes);
    },
  );
  await writeFile(
    join(dir, 'wfd.state'),
    JSON.stringify({
      root: result.envelope,
      versions: result.versions,
      metadata: result.metadata,
      lastTime: Date.now(),
    }),
  );
  if (positionals[0] === 'download')
    for (const name of values['target-name'] ?? []) {
      if (name.includes('..') || name.startsWith('/')) throw Error('INVALID_PATH');
      const info = await findTarget(
        name,
        result.root,
        result.metadata,
        (path, max) => fetchHTTP(values['metadata-url']!, path.replace(/^metadata\//, ''), max),
        Date.now(),
        async (role, _e, bytes) => {
          await writeFile(join(dir, encodeURIComponent(role) + '.json'), bytes);
        },
      );
      if (!info) throw Error('MISSING_TARGET');
      const target = join(values['target-dir']!, name);
      try {
        await checkBytes(await readFile(target), info);
        continue;
      } catch {}
      const split = name.lastIndexOf('/'),
        path = result.root.consistent_snapshot
          ? name.slice(0, split + 1) + Object.values(info.hashes)[0] + '.' + name.slice(split + 1)
          : name;
      const bytes = await fetchHTTP(
        values['target-base-url']!,
        path,
        Math.min(info.length, 256 * 1024 * 1024),
      );
      if (!bytes) throw Error('MISSING_TARGET');
      await checkBytes(bytes, info);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
