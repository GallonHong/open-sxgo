import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { assert } from '../../domain/src/index';
import { hash } from '../../verifier/src/crypto';
import type { PublicStore } from './publisher';
function safe(path: string) {
  assert(
    /^[a-zA-Z0-9._/-]+$/.test(path) && !path.includes('..') && !path.startsWith('/'),
    'INVALID_PATH',
  );
  return path;
}
export function filesystemStore(
  directory: string,
  operator: string,
  provider: string,
): PublicStore {
  const base = resolve(directory);
  const read = (path: string) => readFile(join(base, safe(path)));
  async function activate(path: string, bytes: Uint8Array) {
    const target = join(base, path);
    await mkdir(dirname(target), { recursive: true });
    const temp = target + '.' + crypto.randomUUID() + '.next';
    try {
      await writeFile(temp, bytes, { flag: 'wx' });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
  }
  return {
    operator,
    provider,
    read,
    async putImmutable(path, bytes) {
      const target = join(base, safe(path));
      await mkdir(dirname(target), { recursive: true });
      try {
        await writeFile(target, bytes, { flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        assert((await hash(await read(path))) === (await hash(bytes)), 'IMMUTABLE_CONFLICT');
      }
    },
    activateTimestamp: (bytes) => activate('metadata/timestamp.json', bytes),
    activateSuspensions: (bytes) => activate('suspensions.json', bytes),
  };
}
/** R2 binding adapter: provision a dedicated public bucket with no private inputs. */
export function r2Store(bucket: R2Bucket, operator: string, provider: string): PublicStore {
  return {
    operator,
    provider,
    async read(path) {
      const object = await bucket.get(safe(path));
      assert(object, 'MISSING_ARTIFACT');
      return new Uint8Array(await object.arrayBuffer());
    },
    async putImmutable(path, bytes) {
      safe(path);
      const old = await bucket.get(path);
      if (old) {
        assert(
          (await hash(new Uint8Array(await old.arrayBuffer()))) === (await hash(bytes)),
          'IMMUTABLE_CONFLICT',
        );
        return;
      }
      const result = await bucket.put(path, bytes, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { cacheControl: 'public,max-age=31536000,immutable' },
      });
      assert(result, 'CONCURRENT_UPLOAD_CONFLICT');
    },
    async activateTimestamp(bytes) {
      await bucket.put('metadata/timestamp.json', bytes, {
        httpMetadata: { cacheControl: 'no-store' },
      });
    },
    async activateSuspensions(bytes) {
      await bucket.put('suspensions.json', bytes, { httpMetadata: { cacheControl: 'no-store' } });
    },
  };
}
