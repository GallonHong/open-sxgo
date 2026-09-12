import { z } from 'zod';
import { manifestSchema, type Manifest } from '../../protocol/src/public';
import { assert, DomainError } from '../../domain/src/index';
import { strictJSON, hash, verify, verifyTufKey, utf8 } from './crypto';
const keySchema = z.object({
  keytype: z.string(),
  scheme: z.string(),
  keyval: z.object({ public: z.string().max(16384) }),
});
const roleSchema = z.object({
  keyids: z.array(z.string()).min(1),
  threshold: z.number().int().positive(),
});
export const rootSchema = z.object({
  _type: z.literal('root'),
  spec_version: z.string().regex(/^1\./),
  version: z.number().int().positive(),
  expires: z.iso.datetime(),
  consistent_snapshot: z.boolean(),
  keys: z.record(z.string(), keySchema),
  roles: z.record(z.string(), roleSchema),
  custom: z
    .strictObject({
      environment: z.enum(['demo', 'production']),
      epoch: z.number().int().positive().default(1),
    })
    .optional(),
});
const envelopeSchema = z.strictObject({
  signed: z.record(z.string(), z.unknown()),
  signatures: z
    .array(z.strictObject({ keyid: z.string(), sig: z.string() }))
    .min(1)
    .max(30),
});
export type Envelope = z.infer<typeof envelopeSchema>;
export type Root = z.infer<typeof rootSchema>;
export type TrustedState = {
  root: Envelope;
  versions: Record<string, number>;
  epoch: number;
  sequence: number;
  releaseHash: string;
  lastTime: number;
  metadata?: Record<string, string>;
  suspensions?: { version: number; scope_ids: string[]; hash: string };
};
export type MetadataCheckpoint = Pick<TrustedState, 'root' | 'versions' | 'lastTime' | 'metadata'>;
export type UpdateOptions = {
  metadataCheckpoint?: MetadataCheckpoint;
  saveCheckpoint?: (checkpoint: MetadataCheckpoint) => Promise<void>;
};
export async function verifyReleaseHistory(
  manifest: Manifest,
  previous: Pick<TrustedState, 'epoch' | 'sequence' | 'releaseHash'>,
  fetcher: FetchBytes,
) {
  assert(manifest.epoch === previous.epoch, 'EPOCH_ROLLBACK');
  assert(
    manifest.sequence > previous.sequence && manifest.sequence - previous.sequence <= 64,
    'HISTORY_LIMIT',
  );
  let cursor = manifest,
    total = 0;
  while (cursor.sequence > previous.sequence + 1) {
    const digest = cursor.previous_release_hash;
    assert(digest && /^[a-f0-9]{64}$/.test(digest), 'HISTORY_GAP');
    const bytes = await fetcher(`targets/${digest}.manifest.json`, 4 * 1024 * 1024);
    assert(bytes, 'HISTORY_GAP');
    total += bytes.length;
    assert(bytes.length <= 4 * 1024 * 1024 && total <= 16 * 1024 * 1024, 'DOWNLOAD_TOO_LARGE');
    assert((await hash(bytes)) === digest, 'HASH_MISMATCH');
    const older = manifestSchema.parse(strictJSON(new TextDecoder().decode(bytes)));
    assert(
      older.epoch === cursor.epoch &&
        older.sequence === cursor.sequence - 1 &&
        older.demo === cursor.demo,
      'HISTORY_GAP',
    );
    assert(Date.parse(older.issued_at) <= Date.parse(cursor.issued_at), 'HISTORY_TIME_ORDER');
    cursor = older;
  }
  assert(cursor.previous_release_hash === previous.releaseHash, 'FORK');
}
export type FetchBytes = (path: string, maxBytes: number) => Promise<Uint8Array | null>;
export const decode = (bytes: Uint8Array) =>
  envelopeSchema.parse(strictJSON(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
export async function threshold(e: Envelope, root: Root, role: string) {
  assert(
    new Set(e.signatures.map((s) => s.keyid)).size === e.signatures.length,
    'SIGNATURE_THRESHOLD',
  );
  const auth = root.roles[role];
  assert(auth && auth.threshold <= new Set(auth.keyids).size, 'INVALID_ROLE');
  let count = 0;
  for (const keyid of new Set(e.signatures.map((s) => s.keyid))) {
    if (!auth.keyids.includes(keyid) || !root.keys[keyid]) continue;
    const signatures = e.signatures.filter((s) => s.keyid === keyid);
    if (await verifyTufKey(e.signed, signatures[0].sig, root.keys[keyid])) count++;
  }
  assert(count >= auth.threshold, 'SIGNATURE_THRESHOLD');
}
export async function fetchHTTP(
  base: string,
  path: string,
  max: number,
): Promise<Uint8Array | null> {
  assert(
    !path.split('/').includes('..') && !path.startsWith('/') && !path.includes('\\'),
    'INVALID_PATH',
  );
  const baseURL = new URL(base.endsWith('/') ? base : base + '/');
  const targetURL = new URL(path, baseURL);
  assert(
    targetURL.origin === baseURL.origin && targetURL.pathname.startsWith(baseURL.pathname),
    'INVALID_PATH',
  );
  const response = await fetch(targetURL, {
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  assert(response.ok, 'DOWNLOAD_FAILED');
  assert(Number(response.headers.get('content-length') ?? 0) <= max, 'DOWNLOAD_TOO_LARGE');
  const reader = response.body?.getReader();
  assert(reader, 'EMPTY_DOWNLOAD');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      assert(size <= max, 'DOWNLOAD_TOO_LARGE');
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}
export async function checkBytes(
  bytes: Uint8Array,
  info: { length?: number; hashes?: Record<string, string>; byte_length?: number; sha256?: string },
) {
  const length = info.length ?? info.byte_length;
  assert(length === undefined || bytes.length === length, 'LENGTH_MISMATCH');
  const digests = info.hashes ?? (info.sha256 ? { sha256: info.sha256 } : {});
  let checked = false;
  for (const [algorithm, digest] of Object.entries(digests)) {
    if (!['sha256', 'sha512'].includes(algorithm)) continue;
    const actual =
      algorithm === 'sha256'
        ? await hash(bytes)
        : Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-512', new Uint8Array(bytes))),
            (b) => b.toString(16).padStart(2, '0'),
          ).join('');
    assert(actual === digest, 'HASH_MISMATCH');
    checked = true;
  }
  assert(checked, 'HASH_MISMATCH');
}
const metaInfo = z.object({
  version: z.number().int().positive(),
  length: z.number().int().positive().optional(),
  hashes: z.record(z.string(), z.string()).optional(),
});
const fileInfo = z.object({
  length: z.number().int().nonnegative(),
  hashes: z.record(z.string(), z.string()),
});
const metadataSchema = z.object({
  _type: z.enum(['timestamp', 'snapshot', 'targets']),
  spec_version: z.string().regex(/^1\./),
  version: z.number().int().positive(),
  expires: z.iso.datetime(),
  meta: z.record(z.string(), metaInfo).optional(),
  targets: z.record(z.string(), fileInfo).optional(),
});
function fresh(expires: string, now: number) {
  assert(Number.isFinite(Date.parse(expires)) && Date.parse(expires) > now, 'EXPIRED');
}
export async function refreshMetadata(
  fetcher: FetchBytes,
  trustedRoot: Envelope,
  previous?: Pick<TrustedState, 'root' | 'versions' | 'lastTime' | 'metadata'>,
  now = Date.now(),
  onTrusted?: (role: string, envelope: Envelope, bytes: Uint8Array) => Promise<void>,
) {
  assert(Number.isFinite(now), 'CLOCK_UNTRUSTED');
  if (previous) assert(now >= previous.lastTime - 300000, 'CLOCK_ROLLBACK');
  let envelope = previous?.root ?? trustedRoot;
  let root = rootSchema.parse(envelope.signed);
  await threshold(envelope, root, 'root');
  for (let n = 0; n < 32; n++) {
    const next = await fetcher(`metadata/${root.version + 1}.root.json`, 1024 * 1024);
    if (!next) break;
    const e = decode(next);
    await threshold(e, root, 'root');
    const r = rootSchema.parse(e.signed);
    assert(r.version === root.version + 1, 'ROOT_VERSION');
    await threshold(e, r, 'root');
    root = r;
    envelope = e;
    await onTrusted?.('root', e, next);
    if (n === 31) throw new DomainError('ROOT_ROTATION_LIMIT');
  }
  fresh(root.expires, now);
  const rotated = previous && root.version > rootSchema.parse(previous.root.signed).version;
  const versions: Record<string, number> = rotated ? {} : { ...previous?.versions };
  const metadata: Record<string, string> = rotated ? {} : { ...previous?.metadata };
  async function load(role: 'timestamp' | 'snapshot' | 'targets', info?: z.infer<typeof metaInfo>) {
    const path = `metadata/${info && root.consistent_snapshot ? info.version + '.' : ''}${role}.json`;
    assert(!info?.length || info.length <= 1024 * 1024, 'DOWNLOAD_TOO_LARGE');
    const oldRaw = metadata[role];
    const old = oldRaw ? decode(utf8(oldRaw)) : undefined;
    const useCache = role !== 'timestamp' && old && old.signed.version === info?.version;
    let bytes = useCache ? utf8(oldRaw!) : await fetcher(path, info?.length ?? 1024 * 1024);
    assert(bytes, 'MISSING_METADATA');
    if (info?.hashes) await checkBytes(bytes, info);
    let e = decode(bytes);
    if (role === 'timestamp' && old && old.signed.version === e.signed.version) {
      e = old;
      bytes = utf8(oldRaw!);
    }
    await threshold(e, root, role);
    const m = metadataSchema.parse(e.signed);
    assert(m._type === role, 'ROLE_MISMATCH');
    fresh(m.expires, now);
    assert(m.version >= (versions[role] ?? 0), 'ROLLBACK');
    if (info) assert(m.version === info.version, 'METADATA_VERSION');
    if (role === 'snapshot' && old) {
      const older = metadataSchema.parse(old.signed);
      for (const [name, entry] of Object.entries(older.meta ?? {}))
        assert(m.meta?.[name] && m.meta[name].version >= entry.version, 'SNAPSHOT_ROLLBACK');
    }
    if (role === 'timestamp') {
      const oldSnapshot = old
        ? metadataSchema.parse(old.signed).meta?.['snapshot.json'].version
        : 0;
      assert(
        m.meta?.['snapshot.json'] &&
          m.meta['snapshot.json'].version >= Math.max(oldSnapshot ?? 0, versions.snapshot ?? 0),
        'ROLLBACK',
      );
    }
    versions[role] = m.version;
    metadata[role] = new TextDecoder().decode(bytes);
    await onTrusted?.(role, e, bytes);
    return m;
  }
  const timestamp = await load('timestamp');
  assert(timestamp.meta?.['snapshot.json'], 'MISSING_SNAPSHOT');
  const snapshot = await load('snapshot', timestamp.meta['snapshot.json']);
  assert(snapshot.meta?.['targets.json'], 'MISSING_TARGETS');
  const targets = await load('targets', snapshot.meta['targets.json']);
  // Validate top-level Targets before any explicitly authorized delegation traversal.
  assert(targets.targets, 'MISSING_TARGETS');
  return { root, envelope, versions, targets, metadata };
}
export async function update(
  fetcher: FetchBytes,
  trustedRoot: Envelope,
  previous?: TrustedState,
  now = Date.now(),
  options: UpdateOptions = {},
) {
  let checkpoint: MetadataCheckpoint = options.metadataCheckpoint ?? {
    root: previous?.root ?? trustedRoot,
    versions: { ...previous?.versions },
    metadata: { ...previous?.metadata },
    lastTime: previous?.lastTime ?? now,
  };
  const { root, envelope, versions, targets, metadata } = await refreshMetadata(
    fetcher,
    trustedRoot,
    options.metadataCheckpoint ?? previous,
    now,
    async (role, accepted, bytes) => {
      checkpoint =
        role === 'root'
          ? { root: accepted, versions: {}, metadata: {}, lastTime: now }
          : {
              ...checkpoint,
              lastTime: now,
              versions: {
                ...checkpoint.versions,
                [role]: z.number().int().positive().parse(accepted.signed.version),
              },
              metadata: { ...checkpoint.metadata, [role]: new TextDecoder().decode(bytes) },
            };
      // Persist accepted trust before fetching dependent metadata/artifacts.
      await options.saveCheckpoint?.(checkpoint);
    },
  );
  assert(targets.targets, 'MISSING_TARGETS');
  assert(now >= Date.UTC(2026, 0, 1), 'CLOCK_UNTRUSTED');
  assert(root.consistent_snapshot, 'CONSISTENT_SNAPSHOT_REQUIRED');
  const mi = await findTarget('manifest.json', root, metadata, fetcher, now);
  assert(mi, 'MISSING_MANIFEST');
  assert(mi.length <= 4 * 1024 * 1024, 'DOWNLOAD_TOO_LARGE');
  const bytes = await fetcher(`targets/${mi.hashes.sha256}.manifest.json`, mi.length);
  assert(bytes, 'MISSING_MANIFEST');
  await checkBytes(bytes, mi);
  const manifest = manifestSchema.parse(strictJSON(new TextDecoder().decode(bytes)));
  fresh(manifest.expires_at, now);
  assert(Date.parse(manifest.issued_at) <= now + 300000, 'CLOCK_UNTRUSTED');
  assert(
    Date.parse(manifest.expires_at) - Date.parse(manifest.issued_at) <= 48 * 3600000,
    'TTL_EXCEEDED',
  );
  assert(manifest.demo === (root.custom?.environment === 'demo'), 'ENVIRONMENT_MISMATCH');
  assert(manifest.epoch === (root.custom?.epoch ?? 1), 'EPOCH_NOT_AUTHORIZED');
  const releaseHash = await hash(bytes);
  if (previous) {
    assert(manifest.epoch >= previous.epoch, 'EPOCH_ROLLBACK');
    if (manifest.epoch === previous.epoch) {
      assert(manifest.sequence >= previous.sequence, 'ROLLBACK');
      if (manifest.sequence === previous.sequence)
        assert(releaseHash === previous.releaseHash, 'FORK');
      else await verifyReleaseHistory(manifest, previous, fetcher);
    } else
      assert(root.version > rootSchema.parse(previous.root.signed).version, 'EPOCH_NOT_AUTHORIZED');
  }
  const state: TrustedState = {
    root: envelope,
    versions,
    epoch: manifest.epoch,
    sequence: manifest.sequence,
    releaseHash,
    lastTime: now,
    metadata,
  };
  async function artifact(path: string) {
    const a = manifest.artifacts.find((x) => x.path === path);
    assert(a, 'UNKNOWN_ARTIFACT');
    const data = await fetcher(`releases/${manifest.release_id}/${path}`, a.byte_length);
    assert(data, 'MISSING_ARTIFACT');
    await checkBytes(data, a);
    return data;
  }
  return { manifest, state, artifact, root };
}
export async function verifySuspensions(
  envelope: Envelope,
  root: Root,
  previousVersion = 0,
  now = Date.now(),
  previous?: TrustedState['suspensions'],
  restoredRelease?: string,
) {
  await threshold(envelope, root, 'suspensions');
  const s = z
    .strictObject({
      version: z.number().int().positive(),
      expires: z.iso.datetime(),
      scope_ids: z.array(z.string()),
      action: z.literal('suppress'),
      restored_in_release: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .parse(envelope.signed);
  fresh(s.expires, now);
  assert(s.version >= Math.max(previousVersion, previous?.version ?? 0), 'ROLLBACK');
  const digest = await hash(utf8(JSON.stringify(envelope.signed)));
  if (previous) {
    if (s.version === previous.version) assert(digest === previous.hash, 'SUSPENSION_FORK');
    if (previous.scope_ids.some((id) => !s.scope_ids.includes(id))) {
      assert(
        restoredRelease && s.restored_in_release === restoredRelease,
        'RESTORATION_REQUIRES_RELEASE',
      );
      await threshold(envelope, root, 'targets');
    }
  }
  return { ...s, hash: digest };
}
export { hash, utf8, strictJSON };

const delegatedSchema = z.object({
  keys: z.record(z.string(), keySchema),
  roles: z
    .array(
      roleSchema.extend({
        name: z.string(),
        terminating: z.boolean(),
        paths: z.array(z.string()).optional(),
        path_hash_prefixes: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  succinct_roles: roleSchema
    .extend({ bit_length: z.number().int().min(1).max(32), name_prefix: z.string() })
    .optional(),
});
function pathMatches(pattern: string, target: string) {
  let expression = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') expression += '[^/]*';
    else if (c === '?') expression += '[^/]';
    else if (c === '[' && pattern.indexOf(']', i + 1) > i + 1) {
      const end = pattern.indexOf(']', i + 1);
      expression +=
        '[' +
        pattern
          .slice(i + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\') +
        ']';
      i = end;
    } else expression += c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(expression + '$', 'u').test(target);
}
/** DFS delegation traversal. A cached child is re-authorized for every current parent. */
export async function findTarget(
  target: string,
  root: Root,
  metadata: Record<string, string>,
  fetcher: FetchBytes,
  now = Date.now(),
  onTrusted?: (role: string, envelope: Envelope, bytes: Uint8Array) => Promise<void>,
) {
  assert(
    target.length <= 2048 && !target.startsWith('/') && !target.split('/').includes('..'),
    'INVALID_PATH',
  );
  const snapshot = metadataSchema.parse(decode(utf8(metadata.snapshot)).signed);
  const visited = new Set<string>();
  let count = 0;
  type Result = { info?: z.infer<typeof fileInfo>; terminate?: boolean };
  async function traverse(envelope: Envelope, name: string): Promise<Result> {
    if (visited.has(name) || count >= 32) return {};
    visited.add(name);
    count++;
    const value = metadataSchema.parse(envelope.signed);
    const direct = value.targets?.[target];
    if (direct) return { info: direct };
    if (!envelope.signed.delegations) return {};
    const delegation = delegatedSchema.parse(envelope.signed.delegations);
    assert(!(delegation.roles && delegation.succinct_roles), 'INVALID_DELEGATIONS');
    let roles = delegation.roles ?? [];
    if (delegation.succinct_roles) {
      const succinct = delegation.succinct_roles,
        digest = await hash(utf8(target)),
        bin = Math.floor(parseInt(digest.slice(0, 8), 16) / 2 ** (32 - succinct.bit_length));
      roles = [
        {
          name:
            succinct.name_prefix +
            '-' +
            bin.toString(16).padStart(Math.ceil(succinct.bit_length / 4), '0'),
          keyids: succinct.keyids,
          threshold: succinct.threshold,
          terminating: true,
          path_hash_prefixes: [''],
        },
      ];
    }
    for (const role of roles) {
      if (visited.has(role.name)) continue;
      assert(
        role.name.length <= 1024 &&
          !['root', 'timestamp', 'snapshot', 'targets'].includes(role.name),
        'INVALID_DELEGATION_NAME',
      );
      let matches = false;
      if (role.paths) matches = role.paths.some((pattern) => pathMatches(pattern, target));
      else if (role.path_hash_prefixes) {
        const digest = await hash(utf8(target));
        matches = role.path_hash_prefixes.some((prefix) => digest.startsWith(prefix));
      }
      if (!matches) continue;
      if (count >= 32) return {};
      const expected = snapshot.meta?.[role.name + '.json'];
      assert(expected, 'MISSING_DELEGATION');
      assert((expected.length ?? 0) <= 1024 * 1024, 'DOWNLOAD_TOO_LARGE');
      const cached = metadata[role.name];
      let bytes =
        cached && decode(utf8(cached)).signed.version === expected.version
          ? utf8(cached)
          : await fetcher(
              'metadata/' +
                (root.consistent_snapshot ? expected.version + '.' : '') +
                encodeURIComponent(role.name) +
                '.json',
              expected.length ?? 1024 * 1024,
            );
      assert(bytes, 'MISSING_DELEGATION');
      if (expected.hashes) await checkBytes(bytes, expected);
      const child = decode(bytes);
      await threshold(
        child,
        { ...root, keys: delegation.keys, roles: { [role.name]: role } },
        role.name,
      );
      const parsed = metadataSchema.parse(child.signed);
      assert(parsed._type === 'targets' && parsed.version === expected.version, 'METADATA_VERSION');
      fresh(parsed.expires, now);
      if (cached) assert(parsed.version >= Number(decode(utf8(cached)).signed.version), 'ROLLBACK');
      metadata[role.name] = new TextDecoder().decode(bytes);
      await onTrusted?.(role.name, child, bytes);
      const result = await traverse(child, role.name);
      if (result.info || result.terminate) return result;
      if (role.terminating) return { terminate: true };
    }
    return {};
  }
  return (await traverse(decode(utf8(metadata.targets)), 'targets')).info;
}
