import { readFile, writeFile } from 'node:fs/promises';
import { sign, strictJSON, canonical, hex } from '../packages/verifier/src/crypto';
import { assert } from '../packages/domain/src/index';
const [payloadPath, keyPath, output, purpose] = process.argv.slice(2);
if (!payloadPath || !keyPath || !output || !['business', 'tuf'].includes(purpose))
  throw Error(
    'Usage: pnpm sign <payload.json> <private-jwk.json> <new-signature.json> <business|tuf>',
  );
const input = JSON.parse(await readFile(keyPath, 'utf8')) as { keyid: string; jwk: JsonWebKey };
assert(
  input.keyid && input.jwk.kty === 'OKP' && input.jwk.crv === 'Ed25519' && input.jwk.d,
  'INVALID_SIGNING_KEY',
);
const key = await crypto.subtle.importKey('jwk', input.jwk, 'Ed25519', false, ['sign']);
const payload = strictJSON(await readFile(payloadPath, 'utf8'));
const signature = { keyid: input.keyid, sig: await sign(payload, key, purpose === 'business') };
await writeFile(output, canonical(signature), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ signature: output, keyid: input.keyid, purpose }));
