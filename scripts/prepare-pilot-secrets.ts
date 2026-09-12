import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
// New staging only: never replace an existing authentication or invitation secret.
const directory = resolve('.runtime/private/cloudflare-pilot');
await mkdir(directory, { mode: 0o700 });
const invitations = Array.from({ length: 10 }, (_, i) => ({
  label: `tester-${i + 1}`,
  code: randomBytes(32).toString('base64url'),
}));
const secrets = {
  BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
  PILOT_COOKIE_SECRET: randomBytes(48).toString('base64url'),
  PILOT_INVITE_HASHES: invitations
    .map(({ code }) => createHash('sha256').update(code).digest('hex'))
    .join(','),
};
await writeFile(resolve(directory, 'secrets.json'), JSON.stringify(secrets, null, 2), {
  mode: 0o600,
  flag: 'wx',
});
await writeFile(resolve(directory, 'invitations.json'), JSON.stringify(invitations, null, 2), {
  mode: 0o600,
  flag: 'wx',
});
console.log(
  'Prepared private staging credentials in .runtime/private/cloudflare-pilot; no invitations sent.',
);
