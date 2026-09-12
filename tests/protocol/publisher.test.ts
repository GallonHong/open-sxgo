import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { demoTrust, newKey, signed, publishDemo } from '../../packages/builder/src/index';
import { prepareRelease, distributeRelease } from '../../packages/builder/src/publisher';
import { filesystemStore } from '../../packages/builder/src/stores';
import { verifyBusinessData } from '../../packages/verifier/src/business';
import { fixtureDataset } from '../../scripts/fixtures';
import { sign } from '../../packages/verifier/src/crypto';
import { rootSchema, update, verifySuspensions } from '../../packages/verifier/src/index';
import { createRecovery } from '../../packages/mirror-sync/src/recovery';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wfd-publish-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));
async function candidate() {
  const trust = await demoTrust();
  const reviewers = await Promise.all([newKey(), newKey()]);
  const root = rootSchema.parse(trust.root.signed);
  root.roles.reviewers = { keyids: reviewers.map((k) => k.id), threshold: 2 };
  for (const k of reviewers)
    root.keys[k.id] = { keytype: 'ed25519', scheme: 'ed25519', keyval: { public: k.publicHex } };
  const envelope = await signed(root, trust.rootKeys.slice(0, 2));
  const auth = await signed(
    {
      purpose: 'wfd-reviewer-authority-v1',
      expires: root.expires,
      reviewers: reviewers.map((k, i) => ({
        keyid: k.id,
        person_id: 'person_' + i,
        company_ids: ['*'],
      })),
    },
    trust.rootKeys.slice(0, 2),
  );
  const data = fixtureDataset();
  const approval = {
    payload: data,
    signatures: await Promise.all(
      reviewers.map(async (k) => ({ keyid: k.id, sig: await sign(data, k.privateKey, true) })),
    ),
  };
  return { trust, reviewers, root, envelope, auth, data, approval };
}
it('业务签名同时验证独立人员与企业授权', async () => {
  const c = await candidate();
  await expect(verifyBusinessData(c.data, c.approval, c.auth, c.root)).resolves.toBeDefined();
  const auth = structuredClone(c.auth.signed);
  (auth.reviewers as { person_id: string }[])[1].person_id = 'person_0';
  await expect(
    verifyBusinessData(
      c.data,
      c.approval,
      await signed(auth, c.trust.rootKeys.slice(0, 2)),
      c.root,
    ),
  ).rejects.toThrow('INDEPENDENT_REVIEW_THRESHOLD');
  (auth.reviewers as { person_id: string; company_ids: string[] }[])[1] = {
    ...(auth.reviewers as any[])[1],
    person_id: 'person_1',
    company_ids: ['co_other'],
  };
  await expect(
    verifyBusinessData(
      c.data,
      c.approval,
      await signed(auth, c.trust.rootKeys.slice(0, 2)),
      c.root,
    ),
  ).rejects.toThrow('INDEPENDENT_REVIEW_THRESHOLD');
});
it('两份完整读回后才切换发现元数据；其中一份失败保留旧指针', async () => {
  const c = await candidate();
  const prepared = await prepareRelease(
    c.approval,
    c.envelope,
    c.auth,
    join(dir, 'stage'),
    1,
    null,
  );
  const targets = await signed(prepared.targetsPayload, c.trust.targetKeys.slice(0, 2));
  const suspensions = await signed(
    { version: 1, expires: prepared.manifest.expires_at, scope_ids: [], action: 'suppress' },
    [c.trust.suspension],
  );
  const a = filesystemStore(join(dir, 'a'), 'operator-a', 'provider-a'),
    b = filesystemStore(join(dir, 'b'), 'operator-b', 'provider-b');
  await a.activateTimestamp(new TextEncoder().encode('old-pointer'));
  const failing = {
    ...b,
    async putImmutable() {
      throw Error('UPLOAD_FAILED');
    },
  };
  await expect(
    distributeRelease(
      prepared,
      c.envelope,
      targets,
      c.trust.snapshot,
      c.trust.timestamp,
      [a, failing],
      suspensions,
    ),
  ).rejects.toThrow('UPLOAD_FAILED');
  expect(new TextDecoder().decode(await a.read('metadata/timestamp.json'))).toBe('old-pointer');
  await distributeRelease(
    prepared,
    c.envelope,
    targets,
    c.trust.snapshot,
    c.trust.timestamp,
    [a, b],
    suspensions,
  );
  for (const store of [a, b]) {
    const result = await update(async (path, max) => {
      try {
        const bytes = await store.read(path);
        expect(bytes.length).toBeLessThanOrEqual(max);
        return bytes;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    }, c.envelope);
    expect(result.state.releaseHash).toBe(prepared.manifestHash);
    for (const file of result.manifest.artifacts) await result.artifact(file.path);
  }
});
it('正式数据没有十项门槛签署不能准备发布', async () => {
  const c = await candidate();
  c.root.custom!.environment = 'production';
  c.data.demo = false;
  c.data.rules.forEach((r) => (r.demo = false));
  c.approval.signatures = await Promise.all(
    c.reviewers.map(async (k) => ({ keyid: k.id, sig: await sign(c.data, k.privateKey, true) })),
  );
  await expect(
    prepareRelease(
      c.approval,
      await signed(c.root, c.trust.rootKeys.slice(0, 2)),
      c.auth,
      join(dir, 'production'),
      1,
      null,
    ),
  ).rejects.toThrow('GATES_REQUIRED');
});
it('暂停清单重放、分叉和单钥恢复均被拒绝', async () => {
  const c = await candidate();
  const payload = {
    version: 1,
    expires: c.root.expires,
    scope_ids: ['sc_demo_0'],
    action: 'suppress',
  };
  const initial = await verifySuspensions(await signed(payload, [c.trust.suspension]), c.root);
  const changed = await signed({ ...payload, scope_ids: [] }, [c.trust.suspension]);
  await expect(verifySuspensions(changed, c.root, 0, Date.now(), initial)).rejects.toThrow(
    'SUSPENSION_FORK',
  );
  await expect(
    verifySuspensions(
      await signed({ ...payload, version: 2, scope_ids: [] }, [c.trust.suspension]),
      c.root,
      0,
      Date.now(),
      initial,
    ),
  ).rejects.toThrow('RESTORATION_REQUIRES_RELEASE');
});
it('AC-038 根轮换同时要求旧根和新根的阈值', async () => {
  const c = await candidate();
  const replacement = await demoTrust();
  const newer = rootSchema.parse(c.envelope.signed);
  newer.version = 2;
  newer.roles.root = rootSchema.parse(replacement.root.signed).roles.root;
  Object.assign(newer.keys, rootSchema.parse(replacement.root.signed).keys);
  const both = await signed(newer, [
    ...c.trust.rootKeys.slice(0, 2),
    ...replacement.rootKeys.slice(0, 2),
  ]);
  const oldOnly = await signed(newer, c.trust.rootKeys.slice(0, 2));
  const fetcher = (root: any) => async (path: string) =>
    path === 'metadata/2.root.json' ? new TextEncoder().encode(JSON.stringify(root)) : null;
  await expect(update(fetcher(oldOnly), c.envelope)).rejects.toThrow('SIGNATURE_THRESHOLD');
  await expect(update(fetcher(both), c.envelope)).rejects.toThrow('MISSING_METADATA');
});
it('AC-054 恢复包不复制清单外的私密诱饵', async () => {
  const source = join(dir, 'source');
  await mkdir(source);
  const { root } = await publishDemo(fixtureDataset(), source);
  await writeFile(join(source, 'private-secrets.json'), 'WFD_PRIVATE_CANARY');
  const result = await createRecovery(source, root, join(dir, 'recovery'));
  await expect(
    readFile(join(result.directory, 'public', 'private-secrets.json')),
  ).rejects.toThrow();
  expect(result.files).toBeGreaterThan(10);
});
