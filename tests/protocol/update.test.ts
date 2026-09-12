import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@tufjs/canonical-json';
import { fixtureDataset } from '../../scripts/fixtures';
import { publishDemo, newKey, signed } from '../../packages/builder/src/index';
import {
  update,
  decode,
  verifySuspensions,
  threshold,
  rootSchema,
  type Envelope,
  type FetchBytes,
} from '../../packages/verifier/src/index';
import {
  strictJSON,
  tufCanonical,
  canonical,
  sign,
  verify,
  utf8,
} from '../../packages/verifier/src/crypto';
let dir: string, root: Envelope;
const now = new Date('2026-09-12T08:00:00Z');
const fetcher: FetchBytes = async (path, max) => {
  try {
    const b = await readFile(join(dir, path));
    if (b.length > max) throw Error('DOWNLOAD_TOO_LARGE');
    return b;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wfd-test-'));
  root = (await publishDemo(fixtureDataset(now), dir, now)).root;
});
afterAll(() => rm(dir, { recursive: true, force: true }));
describe('签名与安全更新', () => {
  it('有效包及所有产物能验证', async () => {
    const r = await update(fetcher, root, undefined, now.getTime());
    for (const a of r.manifest.artifacts)
      expect((await r.artifact(a.path)).length).toBe(a.byte_length);
  });
  it('TUF canonical JSON 与官方实现一致', () => {
    const payload = { 中文: '控制\n字符', a: [1, true, null, '"\\'] };
    expect(tufCanonical(payload)).toBe(canonicalize(payload));
    expect(canonical(payload)).not.toBe(tufCanonical(payload));
  });
  it('AC-034 修改 SQLite 一字节被发现', async () => {
    const r = await update(
      async (p, max) => {
        const b = await fetcher(p, max);
        if (b && p.endsWith('.sqlite')) {
          const altered = new Uint8Array(b);
          altered[0] ^= 1;
          return altered;
        }
        return b;
      },
      root,
      undefined,
      now.getTime(),
    );
    await expect(r.artifact('directory.sqlite')).rejects.toThrow('HASH_MISMATCH');
  });
  it('AC-035 超大文件被拒绝', async () => {
    const r = await update(
      async (p, max) => {
        const b = await fetcher(p, max);
        return p.endsWith('.sqlite') ? new Uint8Array(max + 1) : b;
      },
      root,
      undefined,
      now.getTime(),
    );
    await expect(r.artifact('directory.sqlite')).rejects.toThrow('LENGTH_MISMATCH');
  });
  it('AC-036 过期元数据被拒绝', async () => {
    await expect(update(fetcher, root, undefined, now.getTime() + 49 * 3600000)).rejects.toThrow(
      'EXPIRED',
    );
  });
  it('AC-036 序号回退被拒绝', async () => {
    const r = await update(fetcher, root, undefined, now.getTime());
    await expect(update(fetcher, root, { ...r.state, sequence: 2 }, now.getTime())).rejects.toThrow(
      'ROLLBACK',
    );
  });
  it('AC-042 同序号不同摘要为分叉', async () => {
    const r = await update(fetcher, root, undefined, now.getTime());
    await expect(
      update(fetcher, root, { ...r.state, releaseHash: '0'.repeat(64) }, now.getTime()),
    ).rejects.toThrow('FORK');
  });
  it('拒绝时间回退', async () => {
    const r = await update(fetcher, root, undefined, now.getTime());
    await expect(
      update(fetcher, root, { ...r.state, lastTime: now.getTime() + 600000 }, now.getTime()),
    ).rejects.toThrow('CLOCK_ROLLBACK');
  });
  it('AC-039 审核密钥不能签根', async () => {
    const key = await newKey(),
      fake = await signed(root.signed, [key]);
    await expect(threshold(fake, rootSchema.parse(root.signed), 'root')).rejects.toThrow(
      'SIGNATURE_THRESHOLD',
    );
  });
  it('重复签名不能凑阈值', async () => {
    await expect(
      threshold(
        { ...root, signatures: [root.signatures[0], root.signatures[0]] },
        rootSchema.parse(root.signed),
        'root',
      ),
    ).rejects.toThrow('SIGNATURE_THRESHOLD');
  });
  it('AC-051 缺少元数据不切换版本', async () => {
    await expect(
      update(
        async (p, max) => (p.endsWith('snapshot.json') ? null : fetcher(p, max)),
        root,
        undefined,
        now.getTime(),
      ),
    ).rejects.toThrow('MISSING_METADATA');
  });
  it('暂停清单只能停用且需要授权签名', async () => {
    const e = decode((await fetcher('suspensions.json', 1024 * 1024))!);
    expect(
      (await verifySuspensions(e, rootSchema.parse(root.signed), 0, now.getTime())).action,
    ).toBe('suppress');
    e.signed.action = 'activate';
    await expect(
      verifySuspensions(e, rootSchema.parse(root.signed), 0, now.getTime()),
    ).rejects.toThrow();
  });
  it('业务签名用途前缀与 TUF 签名不可混用', async () => {
    const k = await newKey(),
      p = { record: 'example' };
    const signature = await sign(p, k.privateKey, true);
    expect(await verify(p, signature, k.publicHex, true)).toBe(true);
    expect(await verify(p, signature, k.publicHex, false)).toBe(false);
  });
  it.each(['{"a":1,"a":2}', '{"a":{"x":1,"x":2}}', '{"x":1.2}', '{"x":NaN}', '{"x":1}false'])(
    '拒绝模糊 JSON %s',
    (s) => expect(() => strictJSON(s)).toThrow(),
  );
  it('严格解析不允许原型污染', () => {
    const v = strictJSON('{"__proto__":{"polluted":true}}');
    expect(Object.getPrototypeOf(v)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
