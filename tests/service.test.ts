import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { openDatabase } from '../packages/db/src/node';
import { d1Database } from '../packages/db/src/d1';
import type { Database } from '../packages/db/src/adapter';
import { Service } from '../apps/api/src/service';
import { createApp } from '../apps/api/src/app';
import type { Principal, SubmissionInput } from '../packages/protocol/src/private';
import { testDatabase, databaseAdapters } from './support/database';
import { fixtureDataset } from '../scripts/fixtures';
const p: Principal = {
  user_id: 'u1',
  person_id: 'person_one',
  roles: ['reviewer', 'builder', 'operator', 'suppressor'],
  company_ids: ['*'],
  conflicts: [],
  verified: true,
  two_factor: true,
};
const body: SubmissionInput = {
  legal_name: '演示科技有限公司',
  city: '长沙',
  scope: '研发',
  employment_type: 'full_time_employee',
  conditions: [{ dimension: 'rest_schedule', value: 'known', description: '双休' }],
  source_type: 'company',
  source_urls: ['https://example.org/policy'],
  notes: '',
};
for (const adapter of databaseAdapters)
  describe(adapter + ' 业务契约', () => {
    let db: Database, service: Service, close: () => Promise<void>;
    beforeEach(async () => {
      const sql = await readFile('migrations/0001_init.sql', 'utf8');
      if (adapter === 'postgres') {
        const fixture = await testDatabase('postgres');
        db = fixture.db;
        close = fixture.close;
      } else if (adapter === 'sqlite') {
        const n = openDatabase(':memory:');
        n.sqlite.exec(sql);
        db = n.db;
        close = async () => {
          n.sqlite.close();
        };
      } else {
        const mf = new Miniflare({
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: ['DB'],
          compatibilityDate: '2026-07-30',
        });
        const binding = await mf.getD1Database('DB');
        await binding.exec(sql);
        db = d1Database(binding);
        close = () => mf.dispose();
      }
      service = new Service(db);
    });
    afterEach(async () => {
      await close?.();
    });
    it('AC-017/018 私密回执独立于公开工单号', async () => {
      const r = await service.submit(body, 'a'.repeat(64));
      expect(r.receipt).toHaveLength(64);
      await expect(service.status(r.id)).rejects.toThrow('INVALID_RECEIPT');
      expect((await service.status(r.receipt!)).state).toBe('submitted');
      const [stored] = await db.all<{ receipt_hash: string }>(
        'SELECT receipt_hash FROM work_items',
      );
      expect(stored.receipt_hash).not.toBe(r.receipt);
    });
    it('幂等请求不重复写入，不复存回执明文', async () => {
      await service.submit(body, 'a'.repeat(64));
      const retry = await service.submit(body, 'a'.repeat(64));
      expect(retry.replayed).toBe(true);
      expect(retry.receipt).toBeNull();
      await expect(service.submit({ ...body, city: '深圳' }, 'a'.repeat(64))).rejects.toThrow(
        'IDEMPOTENCY_CONFLICT',
      );
      expect(await db.all('SELECT * FROM work_items')).toHaveLength(1);
    });
    it('AC-020 撤回清理正文与对话', async () => {
      const r = await service.submit(body, 'a'.repeat(64));
      await service.supplement(r.receipt!, '补充');
      await service.withdraw(r.receipt!);
      expect((await service.status(r.receipt!)).state).toBe('withdrawn');
      expect(await db.all('SELECT * FROM messages')).toHaveLength(0);
      expect((await db.all<{ body: string }>('SELECT body FROM work_items'))[0].body).toBe('{}');
    });
    it('AC-041 版本冲突使事务整体回滚', async () => {
      const r = await service.submit(body, 'a'.repeat(64));
      await service.triage(p, r.id, 1, 'triaged', '已分流');
      await expect(service.triage(p, r.id, 1, 'in_review', '过期版本')).rejects.toThrow();
      expect((await service.status(r.receipt!)).state).toBe('triaged');
      expect(await db.all('SELECT * FROM audit')).toHaveLength(1);
    });
    it('AC-008 双账号同自然人不能复核；不同人完成闭环', async () => {
      const r = await service.submit(body, 'a'.repeat(64));
      await service.triage(p, r.id, 1, 'triaged', '分流');
      await service.triage(p, r.id, 2, 'in_review', '初审');
      const data = fixtureDataset();
      data.companies = data.companies.slice(0, 1);
      data.sources = data.sources.slice(0, 1);
      data.brands = data.brands.slice(0, 1);
      data.relations = data.relations.slice(0, 1);
      data.stores = data.stores.slice(0, 1);
      data.products = data.products.slice(0, 1);
      data.links = data.links.slice(0, 2);
      const proposal = await service.proposal(p, {
        submission_id: r.id,
        company: data.companies[0],
        public_data: data,
        expected_revision: 0,
        reason: '主体与范围资料已核对',
      });
      await expect(
        service.review({ ...p, user_id: 'u2' }, proposal.id, 'approve', '第二账号'),
      ).rejects.toThrow('SELF_REVIEW');
      await service.review(
        { ...p, user_id: 'u3', person_id: 'person_two' },
        proposal.id,
        'approve',
        '独立复核通过',
      );
      expect((await service.status(r.receipt!)).state).toBe('approved_for_publication');
      expect(await service.publicInput(p)).toHaveLength(1);
    });
    it('AC-009 利益冲突不能提交候选', async () => {
      const data = fixtureDataset();
      await expect(
        service.proposal(
          { ...p, conflicts: ['co_demo_0'] },
          {
            submission_id: 'sub_example',
            company: data.companies[0],
            public_data: data,
            expected_revision: 0,
            reason: 'test',
          },
        ),
      ).rejects.toThrow('CONFLICT_OF_INTEREST');
    });
    it('MFA 缺失不能查看后台', async () => {
      const app = createApp(
        db,
        {
          mode: 'demo',
          intakeEnabled: true,
          promotionEnabled: false,
          productionReleaseEnabled: false,
          origins: [],
          rateSecret: 'test',
        },
        async () => ({ ...p, two_factor: false }),
      );
      expect((await app.request('/admin/v1/me')).status).toBe(403);
    });
    it('AC-021 API 拒绝附件且不落盘', async () => {
      const app = createApp(
        db,
        {
          mode: 'demo',
          intakeEnabled: true,
          promotionEnabled: false,
          productionReleaseEnabled: false,
          origins: [],
          rateSecret: 'test',
        },
        async () => null,
      );
      const r = await app.request('/private/v1/evidence/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(r.status).toBe(403);
      const multipart = await app.request('/private/v1/submissions', {
        method: 'POST',
        body: new FormData(),
      });
      expect(multipart.status).toBe(415);
      expect(await db.all('SELECT * FROM work_items')).toHaveLength(0);
    });
    it('AC-018 URL 中回执被拒绝', async () => {
      const app = createApp(
        db,
        {
          mode: 'demo',
          intakeEnabled: true,
          promotionEnabled: false,
          productionReleaseEnabled: false,
          origins: [],
          rateSecret: 'test',
        },
        async () => null,
      );
      expect((await app.request('/private/v1/config?receipt=abc')).status).toBe(400);
    });
  });
