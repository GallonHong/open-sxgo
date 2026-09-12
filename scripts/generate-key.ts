import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { newKey } from '../packages/builder/src/index';
const [output] = process.argv.slice(2);
if (!output) throw Error('Usage: pnpm key:new <new-private-jwk.json>');
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const key = await newKey();
await writeFile(
  output,
  JSON.stringify(
    { keyid: key.id, jwk: await crypto.subtle.exportKey('jwk', key.privateKey) },
    null,
    2,
  ),
  { flag: 'wx', mode: 0o600 },
);
await writeFile(
  output + '.public.json',
  JSON.stringify(
    {
      keyid: key.id,
      key: { keytype: 'ed25519', scheme: 'ed25519', keyval: { public: key.publicHex } },
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(
  JSON.stringify({
    keyid: key.id,
    public_file: output + '.public.json',
    private_file_created: true,
  }),
);
