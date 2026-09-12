import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { decode } from '../packages/verifier/src/index';
import { createRecovery } from '../packages/mirror-sync/src/recovery';
const [source, rootPath, outArg] = process.argv.slice(2);
if (!source || !rootPath || !outArg)
  throw Error('Usage: pnpm recovery <public-dir> <trusted-root> <new-output-dir>');
const result = await createRecovery(source, decode(await readFile(rootPath)), outArg);
execFileSync('zip', ['-qr', resolve(outArg) + '.zip', '.'], { cwd: result.directory });
console.log(JSON.stringify({ ...result, archive: resolve(outArg) + '.zip' }));
