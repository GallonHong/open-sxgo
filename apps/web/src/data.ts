import trust from '../../../bootstrap/demo-root.json';
import {
  update,
  fetchHTTP,
  decode,
  verifySuspensions,
  type TrustedState,
  type Envelope,
  type MetadataCheckpoint,
} from '../../../packages/verifier/src/index';
import { verifyBusinessData } from '../../../packages/verifier/src/business';
import { validateDataset } from '../../../packages/domain/src/index';
import type { Dataset, Manifest } from '../../../packages/protocol/src/public';
type Cache = { state: TrustedState; files: Record<string, Uint8Array>; verifiedAt: number };
export type Loaded = { data: Dataset; manifest: Manifest; historical: boolean; notice: string };
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('wfd-public-v1-' + Object.keys(trust.signed.keys)[0].slice(0, 16), 1);
    r.onupgradeneeded = () => r.result.createObjectStore('cache');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function cached<T = Cache>(key = 'current') {
  const db = await database();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction('cache');
    const r = tx.objectStore('cache').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    tx.oncomplete = () => db.close();
  });
}
async function save(value: Cache | MetadataCheckpoint, key = 'current') {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction('cache', 'readwrite');
    const store = tx.objectStore('cache');
    const read = store.get(key);
    read.onsuccess = () => {
      if (key === 'trusted-metadata' && 'root' in value) {
        const old = read.result as MetadataCheckpoint | undefined;
        if (
          old &&
          (Number(old.root.signed.version) > Number(value.root.signed.version) ||
            (Number(old.root.signed.version) === Number(value.root.signed.version) &&
              Object.entries(old.versions).some(
                ([role, version]) => version > (value.versions[role] ?? 0),
              )))
        ) {
          tx.abort();
          return;
        }
      }
      store.put(value, key);
    };
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(Error('CHECKPOINT_CONFLICT'));
    };
  });
}
export async function loadDirectory(): Promise<Loaded> {
  let previous: Cache | undefined;
  let checkpoint: MetadataCheckpoint | undefined;
  try {
    previous = await cached();
    checkpoint = await cached<MetadataCheckpoint>('trusted-metadata');
  } catch {
    /* Browsing remains possible when storage is unavailable. */
  }
  async function read(files: Record<string, Uint8Array>, offline: boolean) {
    const fetcher = async (path: string, max: number) => {
      if (offline) {
        const b = files[path];
        if (b && b.length > max) throw Error('DOWNLOAD_TOO_LARGE');
        return b ?? null;
      }
      const bytes = await fetchHTTP(location.origin + '/public/', path, max);
      if (bytes) files[path] = bytes;
      return bytes;
    };
    const result = await update(
      fetcher,
      trust as Envelope,
      offline ? undefined : previous?.state,
      offline ? previous!.verifiedAt : Date.now(),
      offline
        ? {}
        : {
            metadataCheckpoint: checkpoint,
            saveCheckpoint: async (accepted) => {
              await save(accepted, 'trusted-metadata');
              checkpoint = accepted;
            },
          },
    );
    for (const [role, raw] of Object.entries(result.state.metadata ?? {})) {
      const bytes = new TextEncoder().encode(raw);
      const version = decode(bytes).signed.version;
      files[
        `metadata/${role === 'timestamp' ? 'timestamp' : version + '.' + encodeURIComponent(role)}.json`
      ] = bytes;
    }
    const bytes = await result.artifact('directory.json');
    await result.artifact('index/companies.json');
    const data = validateDataset(
      JSON.parse(new TextDecoder().decode(bytes)),
      offline ? new Date(previous!.verifiedAt) : new Date(),
    );
    if (!data.demo)
      await verifyBusinessData(
        data,
        JSON.parse(new TextDecoder().decode(await result.artifact('approvals.json'))),
        decode(await result.artifact('reviewer-authority.json')),
        result.root,
        offline ? previous!.verifiedAt : Date.now(),
      );
    const suspensionBytes = await fetcher('suspensions.json', 1024 * 1024);
    if (!suspensionBytes) throw Error('MISSING_SUSPENSIONS');
    const suspension = await verifySuspensions(
      decode(suspensionBytes),
      result.root,
      0,
      offline ? previous!.verifiedAt : Date.now(),
      previous?.state.suspensions,
      !offline && result.state.sequence > (previous?.state.sequence ?? 0)
        ? result.state.releaseHash
        : undefined,
    );
    result.state.suspensions = {
      version: suspension.version,
      scope_ids: suspension.scope_ids,
      hash: suspension.hash,
    };
    for (const co of data.companies)
      for (const scope of co.scopes)
        if (suspension.scope_ids.includes(scope.scope_id)) scope.listing_state = 'suppressed';
    if (!offline) {
      try {
        await save({ state: result.state, files, verifiedAt: Date.now() });
      } catch {
        return {
          data,
          manifest: result.manifest,
          historical: false,
          notice: '数据验证通过；此浏览器无法保存离线副本。',
        };
      }
    }
    return {
      data,
      manifest: result.manifest,
      historical: offline,
      notice: offline
        ? '当前来源无法通过验证或连接，正在显示上次验证的历史副本。'
        : '签名与数据完整性验证通过',
    };
  }
  try {
    return await read(
      Object.fromEntries(
        Object.entries(previous?.files ?? {}).filter(([path]) => path.startsWith('metadata/')),
      ),
      false,
    );
  } catch (error) {
    if (previous) {
      const historical = await read(previous.files, true);
      return {
        ...historical,
        notice: historical.notice + `（${error instanceof Error ? error.message : '更新失败'}）`,
      };
    }
    throw error;
  }
}
