import { beforeEach, afterEach, expect, it } from 'vitest';
import { openDatabase } from '../packages/db/src/node';
import { migrate } from '../packages/db/src/migrate';
import { NodeRegistry, servicePeriod } from '../packages/node-observer/src/index';
let database: ReturnType<typeof openDatabase>;
beforeEach(async () => {
  database = openDatabase(':memory:');
  await migrate(database.sqlite);
});
afterEach(() => database.sqlite.close());
const input = {
  url: 'https://mirror.example.org',
  kind: 'static_mirror',
  control_group: 'owner-group',
  fault_domain: 'provider-account-one',
  expires_at: '2099-01-01T00:00:00Z',
};
it('AC2-088 challenge is target-bound and single-use, with independent review', async () => {
  let challenge = '';
  const registry = new NodeRegistry(database.db, async (target) => {
    expect(target.origin).toBe(input.url);
    expect(target.path).toContain('/.well-known/wfd-node/');
    return challenge;
  });
  const proposed = await registry.propose('owner', input, 'key');
  challenge = proposed.challenge!;
  expect((await registry.propose('owner', input, 'key')).challenge).toBeNull();
  await expect(
    registry.propose('owner', { ...input, fault_domain: 'changed' }, 'key'),
  ).rejects.toThrow('IDEMPOTENCY_PAYLOAD_MISMATCH');
  await registry.verifyControl('owner', proposed.id, 1);
  await expect(registry.verifyControl('owner', proposed.id, 1)).rejects.toThrow(
    'REVISION_CONFLICT',
  );
  await expect(
    registry.decide('owner', 'owner-group', proposed.id, 2, 'approve', 'self'),
  ).rejects.toThrow('CONFLICT_OF_INTEREST');
  expect(
    (await registry.decide('reviewer', 'independent', proposed.id, 2, 'approve', '已核验')).state,
  ).toBe('approved_pending_publication');
  expect(
    (await registry.decide('owner', 'owner-group', proposed.id, 3, 'exit', '退出')).state,
  ).toBe('exited');
});
it('AC2-105 unavailable processor fails rather than verifying a node', async () => {
  const registry = new NodeRegistry(database.db);
  const node = await registry.propose('owner', input, 'key');
  await expect(registry.verifyControl('owner', node.id, 1)).rejects.toThrow(
    'SAFE_PROCESSOR_UNAVAILABLE',
  );
  expect((await registry.mine('owner'))[0].state).toBe('challenge_pending');
});
it('AC2-087 valid service days only open independent assessment', () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({
    observed_at: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    reachable: true,
    signature_valid: true,
    content_retrieved: true,
  }));
  expect(servicePeriod(entries)).toMatchObject({
    qualifies_for_assessment: true,
    automatically_recognized: false,
  });
  expect(
    servicePeriod(entries.map((x) => ({ ...x, content_retrieved: false })))
      .qualifies_for_assessment,
  ).toBe(false);
  expect(
    servicePeriod([
      ...entries.slice(0, 20),
      ...entries
        .slice(20)
        .map((o) => ({ ...o, observed_at: o.observed_at.replace('-08-', '-09-') })),
    ]).qualifies_for_assessment,
  ).toBe(false);
  const failed = { ...entries[0], content_retrieved: false };
  expect(
    servicePeriod([...entries, ...Array(100).fill(entries[0]), failed]).qualifies_for_assessment,
  ).toBe(false);
});
