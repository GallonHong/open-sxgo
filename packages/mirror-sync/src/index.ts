import { mkdir, readFile, writeFile, rename, rm, mkdtemp, open } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { Updater } from 'tuf-js';
import {
  update,
  decode,
  fetchHTTP,
  verifySuspensions,
  type TrustedState,
  type MetadataCheckpoint,
} from '../../verifier/src/index';
import { validateDataset, assert } from '../../domain/src/index';
import { verifyBusinessData } from '../../verifier/src/business';
import { hash, utf8, canonical } from '../../verifier/src/crypto';
async function durableReplace(path: string, text: string) {
  const file = await open(path + '.next', 'w', 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(path + '.next', path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function syncMirror(base: string, directory: string, rootPath: string) {
  const dir = resolve(directory);
  await mkdir(dir, { recursive: true });
  const lock = join(dir, 'sync.lock');
  const handle = await import('node:fs/promises').then((fs) => fs.open(lock, 'wx'));
  let staging = '';
  try {
    let previous: TrustedState | undefined;
    try {
      const current = (await readFile(join(dir, 'CURRENT'), 'utf8')).trim();
      assert(/^[a-z0-9.-]+$/.test(current), 'INVALID_CURRENT');
      previous = JSON.parse(await readFile(join(dir, 'versions', current, 'state.json'), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    staging = await mkdtemp(join(dir, '.stage-'));
    const rootBytes = await readFile(rootPath),
      trusted = decode(rootBytes);
    const anchor = await hash(utf8(canonical(trusted)));
    try {
      assert((await readFile(join(dir, 'trust-anchor.sha256'), 'utf8')).trim() === anchor, 'TRUST_ANCHOR_CHANGED');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      if (previous) assert(await hash(utf8(canonical(previous.root))) === anchor, 'TRUST_ANCHOR_CHANGED');
      await durableReplace(join(dir, 'trust-anchor.sha256'), anchor);
    }

    let checkpoint: MetadataCheckpoint | undefined;
    try {
      checkpoint = JSON.parse(await readFile(join(dir, 'trusted-metadata.json'), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const metaDir = join(staging, 'official');
    await mkdir(metaDir);
    await writeFile(
      join(metaDir, 'root.json'),
      JSON.stringify(checkpoint?.root ?? previous?.root ?? trusted),
    );
    const official = new Updater({
      metadataDir: metaDir,
      metadataBaseUrl: new URL('metadata/', base).href,
      targetBaseUrl: new URL('targets/', base).href,
      targetDir: metaDir,
    });
    const fetcher = async (path: string, max: number) => {
      const b = await fetchHTTP(base, path, max);
      if (b) {
        const target = join(staging, 'public', path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, b);
      }
      return b;
    };
    const result = await update(fetcher, trusted, previous, Date.now(), {
      metadataCheckpoint: checkpoint,
      saveCheckpoint: async (accepted) => {
        await durableReplace(join(dir, 'trusted-metadata.json'), JSON.stringify(accepted));
      },
    });
    await official.refresh();
    const info = await official.getTargetInfo('manifest.json');
    assert(info, 'MISSING_MANIFEST');
    await official.downloadTarget(info);
    for (const [role, raw] of Object.entries(result.state.metadata ?? {})) {
      const meta = decode(new TextEncoder().encode(raw));
      const path = join(
        staging,
        'public',
        'metadata',
        role === 'timestamp'
          ? 'timestamp.json'
          : String(meta.signed.version) + '.' + encodeURIComponent(role) + '.json',
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, raw);
    }
    for (const a of result.manifest.artifacts) await result.artifact(a.path);
    const data = validateDataset(
      JSON.parse(new TextDecoder().decode(await result.artifact('directory.json'))),
    );
    if (!data.demo)
      await verifyBusinessData(
        data,
        JSON.parse(new TextDecoder().decode(await result.artifact('approvals.json'))),
        decode(await result.artifact('reviewer-authority.json')),
        result.root,
      );
    const sb = await fetcher('suspensions.json', 1024 * 1024);
    assert(sb, 'MISSING_SUSPENSIONS');
    const suspension = await verifySuspensions(
      decode(sb),
      result.root,
      0,
      Date.now(),
      previous?.suspensions,
      result.state.sequence > (previous?.sequence ?? 0) ? result.state.releaseHash : undefined,
    );
    result.state.suspensions = {
      version: suspension.version,
      scope_ids: suspension.scope_ids,
      hash: suspension.hash,
    };
    await writeFile(join(staging, 'public', 'root.json'), JSON.stringify(result.state.root));
    await writeFile(join(staging, 'state.json'), JSON.stringify(result.state));
    const name =
      result.manifest.release_id +
      '-' +
      result.state.releaseHash.slice(0, 12) +
      '-' +
      suspension.hash.slice(0, 12) +
      '.r' +
      result.root.version +
      '.t' +
      result.state.versions.timestamp;
    await mkdir(join(dir, 'versions'), { recursive: true });
    try {
      await rename(staging, join(dir, 'versions', name));
      staging = '';
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code !== 'ENOTEMPTY' &&
        (e as NodeJS.ErrnoException).code !== 'EEXIST'
      )
        throw e;
      const statePath = join(dir, 'versions', name, 'state.json');
      await durableReplace(statePath, JSON.stringify(result.state));
    }
    await durableReplace(join(dir, 'CURRENT'), name);
    return {
      release: result.manifest.release_id,
      directory: join(dir, 'versions', name),
      hash: result.state.releaseHash,
    };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await handle.close();
    await rm(lock, { force: true });
  }
}
