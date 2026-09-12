import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { decode, update, verifySuspensions, type Envelope } from '../../verifier/src/index';
import { validateDataset, assert } from '../../domain/src/index';
import { verifyBusinessData } from '../../verifier/src/business';
/** Copy only bytes actually consumed by verification; never copy a source directory wholesale. */
export async function createRecovery(source: string, root: Envelope, output: string) {
  const base = await realpath(source),
    out = resolve(output);
  const verifiedFiles = new Map<string, Uint8Array>();
  const fetcher = async (path: string, max: number) => {
    assert(!path.includes('..') && !path.startsWith('/') && !path.includes('\\'), 'INVALID_PATH');
    const file = join(base, path);
    try {
      assert(!(await lstat(file)).isSymbolicLink(), 'SYMLINK_REJECTED');
      assert((await realpath(file)).startsWith(base + '/'), 'INVALID_PATH');
      const bytes = await readFile(file);
      assert(bytes.length <= max, 'DOWNLOAD_TOO_LARGE');
      verifiedFiles.set(path, bytes);
      return bytes;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  };
  const release = await update(fetcher, root);
  for (const artifact of release.manifest.artifacts) await release.artifact(artifact.path);
  const data = validateDataset(
    JSON.parse(new TextDecoder().decode(await release.artifact('directory.json'))),
  );
  if (!data.demo)
    await verifyBusinessData(
      data,
      JSON.parse(new TextDecoder().decode(await release.artifact('approvals.json'))),
      decode(await release.artifact('reviewer-authority.json')),
      release.root,
    );
  const sb = await fetcher('suspensions.json', 1024 * 1024);
  assert(sb, 'MISSING_SUSPENSIONS');
  await verifySuspensions(decode(sb), release.root);
  await mkdir(out);
  await mkdir(join(out, 'public'));
  for (const [path, bytes] of verifiedFiles) {
    const target = join(out, 'public', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeFile(join(out, 'root.json'), JSON.stringify(root));
  await writeFile(join(out, 'public', 'root.json'), JSON.stringify(release.state.root));
  await writeFile(
    join(out, 'README.txt'),
    'WFD 公开离线恢复包。仅含已验证公共文件，不是私密业务备份。\n根公钥必须通过已有可信渠道比对，包内公钥不能自证可信。\n离线数据仅为历史状态，不保证当前有效。\n',
  );
  return { release: release.manifest.release_id, files: verifiedFiles.size, directory: out };
}
