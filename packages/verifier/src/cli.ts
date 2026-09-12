import { mkdir, readFile, writeFile, rename, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Updater } from 'tuf-js';
import { decode, fetchHTTP, update, hash, verifySuspensions, type TrustedState } from './index';
import { verifyBusinessData } from './business';
import { canonical, utf8 } from './crypto';
import { validateDataset, assert } from '../../domain/src/index';
const [base, rootPath, stateArg] = process.argv.slice(2);
if (!base || !rootPath) {
  console.error(
    'Usage: pnpm verify <https://mirror/public/> <trusted-root.json> [state-directory]',
  );
  process.exit(1);
}
try {
  const rootBytes = await readFile(rootPath),
    root = decode(rootBytes),
    fingerprint = await hash(utf8(canonical(root.signed)));
  const cache = resolve(stateArg ?? '.runtime/verifier/' + fingerprint.slice(0, 24));
  await mkdir(cache, { recursive: true });
  const lock = await open(join(cache, 'verify.lock'), 'wx');
  try {
    let previous: TrustedState | undefined;
    try {
      previous = JSON.parse(await readFile(join(cache, 'state.json'), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await writeFile(join(cache, 'root.json'), JSON.stringify(previous?.root ?? root));
    const official = new Updater({
      metadataDir: cache,
      metadataBaseUrl: new URL('metadata/', base).href,
      targetBaseUrl: new URL('targets/', base).href,
      targetDir: cache,
    });
    await official.refresh();
    const info = await official.getTargetInfo('manifest.json');
    assert(info, 'MISSING_MANIFEST');
    assert(info.length <= 4 * 1024 * 1024, 'DOWNLOAD_TOO_LARGE');
    await official.downloadTarget(info);
    const result = await update((path, max) => fetchHTTP(base, path, max), root, previous);
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
    const sb = await fetchHTTP(base, 'suspensions.json', 1024 * 1024);
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
    await writeFile(join(cache, 'state.next'), JSON.stringify(result.state));
    await rename(join(cache, 'state.next'), join(cache, 'state.json'));
    console.log(
      JSON.stringify(
        {
          valid: true,
          official_tuf: true,
          release: result.manifest.release_id,
          demo: result.manifest.demo,
          expires_at: result.manifest.expires_at,
          high_water_persisted: true,
          trust_fingerprint: fingerprint,
        },
        null,
        2,
      ),
    );
  } finally {
    await lock.close();
    await rm(join(cache, 'verify.lock'), { force: true });
  }
} catch (e) {
  console.error(JSON.stringify({ valid: false, code: (e as Error).message }));
  process.exitCode = 1;
}
