import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database, Proposal, Query } from '../../db/src/adapter';
import type { Dataset } from '../../protocol/src/public';
import { assert, validateDataset } from '../../domain/src/index';
import { canonical } from '../../verifier/src/crypto';
import { publishDemo } from './index';
/** Local rehearsal only. Real releases must use independent business and Targets signatures. */
export async function publishApprovedDemo(db: Database, outputBase: string) {
  const proposals = await db.all<Proposal>(
    "SELECT * FROM proposals WHERE state='approved_for_publication' ORDER BY created_at,id",
  );
  assert(proposals.length, 'NO_APPROVED_PROPOSALS');
  const ids = new Set<string>();
  const records = await db.all<{ id: string; revision: number; body: string }>(
    'SELECT * FROM public_records',
  );
  const byCompany = new Map(records.map((r) => [r.id, validateDataset(JSON.parse(r.body))]));
  for (const p of proposals) {
    assert(!ids.has(p.company_id), 'COMPETING_PROPOSALS');
    ids.add(p.company_id);
    assert(
      p.reviewer_person && p.reviewer_person !== p.author_person,
      'INDEPENDENT_REVIEW_THRESHOLD',
    );
    assert(
      (records.find((r) => r.id === p.company_id)?.revision ?? 0) === p.expected_revision,
      'REVISION_CONFLICT',
      409,
    );
    const data = validateDataset(JSON.parse(p.body));
    assert(data.demo, 'DEMO_ONLY');
    byCompany.set(p.company_id, data);
  }
  const documents = [...byCompany.values()];
  const merged = structuredClone(documents[0]);
  for (const kind of [
    'companies',
    'sources',
    'brands',
    'relations',
    'stores',
    'products',
    'links',
    'rules',
    'decisions',
    'mirrors',
  ] as const) {
    const values = new Map<string, unknown>();
    for (const data of documents) {
      assert(data.demo, 'DEMO_ONLY');
      for (const row of data[kind]) {
        const key =
          kind === 'companies'
            ? 'company_id'
            : kind === 'rules'
              ? 'rule_version'
              : kind === 'decisions'
                ? 'decision_id'
                : kind === 'mirrors'
                  ? 'node_id'
                  : kind.slice(0, -1) + '_id';
        const record = row as unknown as Record<string, unknown>;
        const identifier = String(record[key] ?? canonical(row));
        assert(
          !values.has(identifier) || canonical(values.get(identifier)) === canonical(row),
          'PUBLIC_ID_CONFLICT',
        );
        values.set(identifier, row);
      }
    }
    (merged as unknown as Record<string, unknown>)[kind] = [...values.values()];
  }
  validateDataset(merged);
  await mkdir(outputBase, { recursive: true });
  const dir = await mkdtemp(join(outputBase, 'approved-'));
  try {
    const published = await publishDemo(merged, join(dir, 'public'));
    const queries: Query[] = [];
    const guard: Query[] = [
      { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
      { sql: 'DELETE FROM mutation_guard' },
    ];
    for (const p of proposals) {
      queries.push(
        {
          sql: "UPDATE proposals SET state='published' WHERE id=? AND state='approved_for_publication'",
          params: [p.id],
        },
        ...guard,
        {
          sql: "UPDATE work_items SET state='published',version=version+1,closed_at=?,updated_at=? WHERE id=? AND state='approved_for_publication'",
          params: [new Date().toISOString(), new Date().toISOString(), p.submission_id],
        },
        ...guard,
      );
      if (p.expected_revision === 0)
        queries.push({
          sql: 'INSERT INTO public_records VALUES(?,?,?,?)',
          params: [p.company_id, 1, p.body, 'active'],
        });
      else
        queries.push(
          {
            sql: 'UPDATE public_records SET revision=revision+1,body=?,state=? WHERE id=? AND revision=?',
            params: [p.body, 'active', p.company_id, p.expected_revision],
          },
          ...guard,
        );
      queries.push({
        sql: 'INSERT INTO audit VALUES(?,?,?,?,?,?)',
        params: [
          'au_' + crypto.randomUUID().replaceAll('-', ''),
          p.id,
          'local_demo_builder',
          'demo_publish',
          '独立演示信任根，不能作为生产发布',
          new Date().toISOString(),
        ],
      });
    }
    await db.batch(queries);
    return {
      directory: dir,
      release: published.manifest.release_id,
      proposals: proposals.length,
      demo: true,
    };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}
