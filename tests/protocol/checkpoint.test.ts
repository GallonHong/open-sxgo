import { expect, it } from 'vitest';
import { demoTrust, signed } from '../../packages/builder/src/index';
import {
  update,
  verifyReleaseHistory,
  type MetadataCheckpoint,
} from '../../packages/verifier/src/index';
import { utf8, hash } from '../../packages/verifier/src/crypto';
it('persists verified timestamp before a dependent download fails, then rejects replay', async () => {
  const now = new Date('2026-09-12T08:00:00Z'),
    trust = await demoTrust(now);
  const timestamp = async (version: number) =>
    utf8(
      JSON.stringify(
        await signed(
          {
            _type: 'timestamp',
            spec_version: '1.0.31',
            version,
            expires: new Date(+now + 3600000).toISOString(),
            meta: { 'snapshot.json': { version } },
          },
          [trust.timestamp],
        ),
      ),
    );
  const newer = await timestamp(2),
    older = await timestamp(1);
  let checkpoint: MetadataCheckpoint | undefined;
  await expect(
    update(
      async (path) => (path === 'metadata/timestamp.json' ? newer : null),
      trust.root,
      undefined,
      +now,
      {
        saveCheckpoint: async (accepted) => {
          checkpoint = structuredClone(accepted);
        },
      },
    ),
  ).rejects.toThrow('MISSING_METADATA');
  expect(checkpoint?.versions.timestamp).toBe(2);
  expect(checkpoint?.metadata?.timestamp).toContain('"version":2');
  await expect(
    update(
      async (path) => (path === 'metadata/timestamp.json' ? older : null),
      trust.root,
      undefined,
      +now,
      { metadataCheckpoint: checkpoint },
    ),
  ).rejects.toThrow('ROLLBACK');
});
it('checks every immutable manifest when catching up several versions', async () => {
  const base = {
    protocol: 'wfd-data',
    schema_version: '1.0',
    epoch: 1,
    release_id: 'test-release',
    issued_at: '2026-09-12T08:00:00Z',
    expires_at: '2026-09-13T08:00:00Z',
    minimum_client_protocol: '1.0' as const,
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
  const firstHash = '1'.repeat(64),
    second = { ...base, sequence: 2, previous_release_hash: firstHash };
  const bytes = utf8(JSON.stringify(second)),
    digest = await hash(bytes);
  // Use the same strict manifest contract as production to construct the chain.
  const { manifestSchema } = await import('../../packages/protocol/src/public');
  const candidate = manifestSchema.parse({ ...base, sequence: 3, previous_release_hash: digest });
  const previous = { epoch: 1, sequence: 1, releaseHash: firstHash };
  await verifyReleaseHistory(candidate, previous, async (path) =>
    path === `targets/${digest}.manifest.json` ? bytes : null,
  );
  await expect(verifyReleaseHistory(candidate, previous, async () => utf8('{}'))).rejects.toThrow(
    'HASH_MISMATCH',
  );
  await expect(verifyReleaseHistory(candidate, previous, async () => null)).rejects.toThrow(
    'HISTORY_GAP',
  );
});
