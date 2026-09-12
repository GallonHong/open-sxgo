import { assert } from '../../domain/src/index';
import { manifestSchema, type Manifest } from '../../protocol/src/public';
import { canonical, hash, strictJSON } from '../../verifier/src/crypto';
import { decode, rootSchema, threshold, type Envelope } from '../../verifier/src/index';

/** Only immutable, validated history is copied. No timestamp or private archive is accepted. */
export async function collectReleaseHistory(
  manifest: Manifest,
  currentRoot: Envelope,
  read: (path: string, maxBytes: number) => Promise<Uint8Array | null>,
) {
  const files = new Map<string, Uint8Array>();
  let remaining = 32 * 1024 * 1024;
  const get = async (path: string) => {
    const bytes = await read(path, Math.min(remaining, 4 * 1024 * 1024));
    assert(bytes, 'PUBLICATION_HISTORY_MISSING');
    assert(bytes.length <= 4 * 1024 * 1024 && bytes.length <= remaining, 'HISTORY_LIMIT');
    remaining -= bytes.length;
    files.set(path, bytes);
    return bytes;
  };
  assert(manifest.sequence <= 4096, 'HISTORY_LIMIT');
  let cursor = manifest;
  while (cursor.sequence > 1) {
    assert(cursor.previous_release_hash, 'HISTORY_GAP');
    const bytes = await get(`targets/${cursor.previous_release_hash}.manifest.json`);
    assert((await hash(bytes)) === cursor.previous_release_hash, 'HASH_MISMATCH');
    const older = manifestSchema.parse(strictJSON(new TextDecoder().decode(bytes)));
    assert(
      older.sequence === cursor.sequence - 1 &&
        older.epoch === cursor.epoch &&
        older.demo === cursor.demo &&
        Date.parse(older.issued_at) <= Date.parse(cursor.issued_at),
      'HISTORY_GAP',
    );
    cursor = older;
  }
  assert(cursor.previous_release_hash === null, 'HISTORY_GAP');
  const root = rootSchema.parse(currentRoot.signed);
  assert(root.version <= 1024, 'HISTORY_LIMIT');
  let prior: ReturnType<typeof rootSchema.parse> | undefined;
  for (let version = 1; version <= root.version; version++) {
    const envelope =
      version === root.version ? currentRoot : decode(await get(`metadata/${version}.root.json`));
    const next = rootSchema.parse(envelope.signed);
    assert(next.version === version, 'ROOT_VERSION');
    if (prior) {
      assert(
        canonical(next.custom ?? {}) === canonical(prior.custom ?? {}),
        'ROOT_ENVIRONMENT_CHANGED',
      );
      await threshold(envelope, prior, 'root');
    }
    await threshold(envelope, next, 'root');
    prior = next;
  }
  return files;
}
