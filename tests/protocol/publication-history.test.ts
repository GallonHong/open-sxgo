import { expect, it } from 'vitest';
import { collectReleaseHistory } from '../../packages/builder/src/history';
import { demoTrust, signed } from '../../packages/builder/src/index';
import { manifestSchema } from '../../packages/protocol/src/public';
import { hash, utf8 } from '../../packages/verifier/src/crypto';
import { rootSchema } from '../../packages/verifier/src/index';

const base = {
  protocol: 'wfd-data',
  schema_version: '1.0',
  epoch: 1,
  release_id: 'test-release',
  issued_at: '2026-09-12T08:00:00Z',
  expires_at: '2026-09-13T08:00:00Z',
  minimum_client_protocol: '1.0',
  demo: true,
  artifacts: [
    {
      path: 'directory.json',
      byte_length: 2,
      sha256: 'a'.repeat(64),
      media_type: 'application/json',
    },
  ],
};
it('copies verified predecessor manifests and every continuous root for a new mirror', async () => {
  const trust = await demoTrust();
  const root = rootSchema.parse(trust.root.signed);
  const rotated = await signed({ ...root, version: 2 }, trust.rootKeys.slice(0, 2));
  const first = utf8(JSON.stringify({ ...base, sequence: 1, previous_release_hash: null }));
  const digest = await hash(first);
  const current = manifestSchema.parse({ ...base, sequence: 2, previous_release_hash: digest });
  const rootBytes = utf8(JSON.stringify(trust.root));
  const files = await collectReleaseHistory(current, rotated, async (path) =>
    path === 'metadata/1.root.json'
      ? rootBytes
      : path === `targets/${digest}.manifest.json`
        ? first
        : null,
  );
  expect(files.size).toBe(2);
  await expect(collectReleaseHistory(current, rotated, async () => null)).rejects.toThrow(
    'PUBLICATION_HISTORY_MISSING',
  );
  await expect(collectReleaseHistory(current, rotated, async () => utf8('{}'))).rejects.toThrow(
    'HASH_MISMATCH',
  );
});
it('rejects an incorrectly signed historical root even when current metadata is valid', async () => {
  const trust = await demoTrust();
  const root = rootSchema.parse(trust.root.signed);
  const rotated = await signed({ ...root, version: 2 }, trust.rootKeys.slice(0, 2));
  const incomplete = utf8(
    JSON.stringify({ ...trust.root, signatures: trust.root.signatures.slice(0, 1) }),
  );
  await expect(
    collectReleaseHistory(
      manifestSchema.parse({ ...base, sequence: 1, previous_release_hash: null }),
      rotated,
      async () => incomplete,
    ),
  ).rejects.toThrow();
});
