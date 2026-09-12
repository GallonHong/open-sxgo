import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import SQLite from 'better-sqlite3';
import { validateDataset, assert } from '../../domain/src/index';
import { type Dataset, type Manifest, publicSchemas } from '../../protocol/src/public';
import { hash, utf8, hex, sign, canonical } from '../../verifier/src/crypto';
import type { Envelope, Root } from '../../verifier/src/index';
export type SigningKey = { id: string; privateKey: CryptoKey; publicHex: string };
export async function newKey(): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const publicHex = hex(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { id: await hash(utf8(publicHex)), privateKey: pair.privateKey, publicHex };
}
export async function signed(
  payload: Record<string, unknown>,
  keys: SigningKey[],
): Promise<Envelope> {
  return {
    signed: payload,
    signatures: await Promise.all(
      keys.map(async (k) => ({ keyid: k.id, sig: await sign(payload, k.privateKey) })),
    ),
  };
}
export async function demoTrust(now = new Date()) {
  const rootKeys = await Promise.all([newKey(), newKey(), newKey()]),
    targetKeys = await Promise.all([newKey(), newKey(), newKey()]),
    snapshot = await newKey(),
    timestamp = await newKey(),
    suspension = await newKey();
  const keys = [...rootKeys, ...targetKeys, snapshot, timestamp, suspension];
  const root: Root = {
    _type: 'root',
    spec_version: '1.0.31',
    version: 1,
    expires: new Date(now.getTime() + 365 * 86400000).toISOString(),
    consistent_snapshot: true,
    keys: Object.fromEntries(
      keys.map((k) => [
        k.id,
        { keytype: 'ed25519', scheme: 'ed25519', keyval: { public: k.publicHex } },
      ]),
    ),
    roles: {
      root: { keyids: rootKeys.map((k) => k.id), threshold: 2 },
      targets: { keyids: targetKeys.map((k) => k.id), threshold: 2 },
      snapshot: { keyids: [snapshot.id], threshold: 1 },
      timestamp: { keyids: [timestamp.id], threshold: 1 },
      suspensions: { keyids: [suspension.id], threshold: 1 },
    },
    custom: { environment: 'demo', epoch: 1 },
  };
  return {
    root: await signed(root, rootKeys.slice(0, 2)),
    rootKeys,
    targetKeys,
    snapshot,
    timestamp,
    suspension,
  };
}
export async function buildArtifacts(
  input: unknown,
  dir: string,
  sequence = 1,
  previousHash: string | null = null,
  now = new Date(),
  authorized = false,
) {
  const data = validateDataset(input, now);
  assert(data.demo || authorized, 'PRODUCTION_BUILD_REQUIRES_APPROVAL_EXPORT');
  const release_id = `${now.toISOString().slice(0, 10)}.${sequence}`;
  const out = join(dir, 'releases', release_id);
  await mkdir(join(out, 'index'), { recursive: true });
  await mkdir(join(out, 'shards'), { recursive: true });
  const artifacts: Manifest['artifacts'] = [];
  async function put(path: string, value: Uint8Array, type: string) {
    await writeFile(join(out, path), value);
    artifacts.push({
      path,
      sha256: await hash(value),
      byte_length: value.length,
      media_type: type,
    });
  }
  const json = async (path: string, value: unknown) =>
    put(path, utf8(canonical(value)), 'application/json');
  const shards: Record<string, string> = {};
  for (const company of data.companies) {
    const bytes = utf8(canonical(company)),
      digest = await hash(bytes),
      path = `shards/${digest}.json`;
    await put(path, bytes, 'application/json');
    shards[company.company_id] = path;
  }
  await json('index/companies.json', { companies: data.companies, shards });
  await json('directory.json', data);
  await json('rules.json', data.rules);
  await json('mirrors.json', data.mirrors);
  await put(
    'companies.jsonl',
    utf8(data.companies.map((c) => canonical(c)).join('\n') + '\n'),
    'application/x-ndjson',
  );
  await put(
    'public-changes.jsonl',
    utf8(data.decisions.map((c) => canonical(c)).join('\n') + '\n'),
    'application/x-ndjson',
  );
  const sqlitePath = join(out, 'directory.sqlite');
  const db = new SQLite(sqlitePath);
  db.exec(
    'CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));DELETE FROM records;',
  );
  const insert = db.prepare('INSERT INTO records VALUES(?,?,?)');
  db.transaction(() => {
    for (const [kind, records] of Object.entries(data)) {
      if (!Array.isArray(records)) continue;
      for (const [index, row] of records.entries()) insert.run(kind, String(index), canonical(row));
    }
  })();
  db.close();
  await put('directory.sqlite', await readFile(sqlitePath), 'application/vnd.sqlite3');
  const manifest: Manifest = {
    protocol: 'wfd-data',
    schema_version: '1.0',
    epoch: 1,
    sequence,
    release_id,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 47 * 3600000).toISOString(),
    previous_release_hash: previousHash,
    minimum_client_protocol: '1.0',
    demo: data.demo,
    artifacts,
  };
  await writeFile(join(out, 'manifest.json'), canonical(manifest));
  return { manifest, data };
}
export async function publishDemo(input: Dataset, dir: string, now = new Date()) {
  assert(input.demo, 'DEMO_ONLY');
  const trust = await demoTrust(now);
  const { manifest } = await buildArtifacts(input, dir, 1, null, now);
  await mkdir(join(dir, 'metadata'), { recursive: true });
  await mkdir(join(dir, 'targets'), { recursive: true });
  const mb = utf8(canonical(manifest)),
    mh = await hash(mb);
  await writeFile(join(dir, 'targets', mh + '.manifest.json'), mb);
  await writeFile(join(dir, 'root.json'), JSON.stringify(trust.root));
  await writeFile(join(dir, 'metadata', '1.root.json'), JSON.stringify(trust.root));
  const meta = (type: string) => ({
    _type: type,
    spec_version: '1.0.31',
    version: 1,
    expires: manifest.expires_at,
  });
  const targets = await signed(
    {
      ...meta('targets'),
      targets: { 'manifest.json': { length: mb.length, hashes: { sha256: mh } } },
    },
    trust.targetKeys.slice(0, 2),
  );
  const tb = utf8(JSON.stringify(targets));
  await writeFile(join(dir, 'metadata', '1.targets.json'), tb);
  await writeFile(join(dir, 'metadata', 'targets.json'), tb);
  const snapshot = await signed(
    {
      ...meta('snapshot'),
      meta: {
        'targets.json': { version: 1, length: tb.length, hashes: { sha256: await hash(tb) } },
      },
    },
    [trust.snapshot],
  );
  const sb = utf8(JSON.stringify(snapshot));
  await writeFile(join(dir, 'metadata', '1.snapshot.json'), sb);
  await writeFile(join(dir, 'metadata', 'snapshot.json'), sb);
  const timestamp = await signed(
    {
      ...meta('timestamp'),
      meta: {
        'snapshot.json': { version: 1, length: sb.length, hashes: { sha256: await hash(sb) } },
      },
    },
    [trust.timestamp],
  );
  await writeFile(join(dir, 'metadata', 'timestamp.json.next'), JSON.stringify(timestamp));
  await rename(
    join(dir, 'metadata', 'timestamp.json.next'),
    join(dir, 'metadata', 'timestamp.json'),
  );
  const suspensions = await signed(
    { version: 1, expires: manifest.expires_at, scope_ids: [], action: 'suppress' },
    [trust.suspension],
  );
  await writeFile(join(dir, 'suspensions.json'), JSON.stringify(suspensions));
  return { root: trust.root, manifest };
}
