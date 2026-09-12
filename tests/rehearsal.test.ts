import { it, expect } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/db/src/node';
import { Service } from '../apps/api/src/service';
import { publishApprovedDemo } from '../packages/builder/src/approved-demo';
import { fixtureDataset } from '../scripts/fixtures';
import { decode, update } from '../packages/verifier/src/index';
import type { Principal } from '../packages/protocol/src/private';
it('匿名投稿至双人审批、签名演示发布与私密到期清理', async () => {
  const n = openDatabase(':memory:'),
    dir = await mkdtemp(join(tmpdir(), 'wfd-rehearsal-'));
  try {
    n.sqlite.exec(await readFile('migrations/0001_init.sql', 'utf8'));
    const service = new Service(n.db);
    const p: Principal = {
      person_id: 'person_a',
      user_id: 'u_a',
      roles: ['reviewer', 'builder'],
      company_ids: ['*'],
      conflicts: [],
      verified: true,
      two_factor: true,
    };
    const submission = await service.submit(
      {
        legal_name: '虚构测试公司',
        city: '长沙',
        scope: '研发',
        employment_type: 'full_time_employee',
        conditions: [{ dimension: 'rest_schedule', value: 'known', description: '公开制度' }],
        source_type: 'company',
        source_urls: ['https://example.org/policy'],
        notes: '原始私密线索',
      },
      'key'.repeat(32),
    );
    await expect(
      service.readable({ ...p, company_ids: ['co_other'] }, submission.id),
    ).rejects.toThrow('OUTSIDE_AUTHORIZED_SCOPE');
    await service.triage(p, submission.id, 1, 'triaged', '分流');
    await service.triage(p, submission.id, 2, 'in_review', '初审');
    const data = fixtureDataset();
    for (const key of [
      'companies',
      'sources',
      'brands',
      'relations',
      'stores',
      'products',
    ] as const)
      (data as any)[key] = data[key].slice(0, 1);
    data.links = data.links.slice(0, 2);
    const proposal = await service.proposal(p, {
      submission_id: submission.id,
      company: data.companies[0],
      public_data: data,
      expected_revision: 0,
      reason: '公开制度与主体核对',
    });
    await service.review(
      { ...p, person_id: 'person_b', user_id: 'u_b' },
      proposal.id,
      'approve',
      '独立复核',
    );
    const result = await publishApprovedDemo(n.db, dir);
    expect((await service.status(submission.receipt!)).state).toBe('published');
    const root = decode(await readFile(join(result.directory, 'public/root.json')));
    const release = await update(async (path, max) => {
      try {
        const bytes = await readFile(join(result.directory, 'public', path));
        expect(bytes.length).toBeLessThanOrEqual(max);
        return bytes;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    }, root);
    const published = new TextDecoder().decode(await release.artifact('directory.json'));
    expect(published).not.toContain('原始私密线索');
    expect(published).not.toContain(submission.receipt!);
    await n.db.batch([
      {
        sql: 'UPDATE work_items SET closed_at=? WHERE id=?',
        params: ['2020-01-01T00:00:00Z', submission.id],
      },
    ]);
    await service.maintenance();
    await expect(service.status(submission.receipt!)).rejects.toThrow('INVALID_RECEIPT');
    expect(await n.db.all('SELECT * FROM public_records')).toHaveLength(1);
  } finally {
    n.sqlite.close();
    await rm(dir, { recursive: true, force: true });
  }
});
