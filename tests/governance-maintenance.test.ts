import { expect, it } from 'vitest';
import { testDatabase, databaseAdapters } from './support/database';
import { maintainGovernance } from '../packages/governance-policy/src/maintenance';

for (const adapter of databaseAdapters)
  it(`${adapter}: preview retention honors bounded holds and is repeatable`, async () => {
    const { db, close } = await testDatabase(adapter);
    const now = new Date('2026-09-12T00:00:00Z'),
      old = '2026-01-01T00:00:00Z';
    const insert = async (table: string, row: Record<string, unknown>) =>
      db.batch([
        {
          sql: `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
            .map(() => '?')
            .join(',')})`,
          params: Object.values(row),
        },
      ]);
    try {
      for (const name of ['expired', 'held']) {
        await insert('review_cases', {
          id: name,
          submission_id: name,
          current_revision: 1,
          state: 'rejected',
          created_at: old,
          updated_at: old,
        });
        await insert('source_fetch_jobs', {
          id: name,
          case_id: name,
          case_revision: 1,
          source_id: name,
          source_url: 'https://example.org/source',
          policy_version: 'test',
          state: 'sanitized_preview_ready',
          grant_id: 'test',
          idempotency_key: name,
          request_hash: 'test',
          created_at: old,
          updated_at: old,
          expires_at: old,
        });
        await insert('sanitized_previews', {
          id: name,
          job_id: name,
          source_id: name,
          case_id: name,
          case_revision: 1,
          state: 'sanitized_preview_ready',
          display_domain: 'example.org',
          final_domain: 'example.org',
          fetch_policy: 'test',
          text_ref: name,
          text_content: 'PRIVATE_RETENTION_CANARY',
          public_destination_enforced: 1,
          network_egress_policy_enforced: 1,
          output_hash: 'test',
          captured_at: old,
          expires_at: old,
          created_at: old,
        });
      }
      await insert('retention_holds', {
        item_id: 'held',
        reason: 'bounded investigation',
        expires_at: '2026-09-13T00:00:00Z',
      });
      await maintainGovernance(db, now);
      await maintainGovernance(db, now);
      expect(await db.all('SELECT id FROM sanitized_previews')).toEqual([{ id: 'held' }]);
      expect(
        await db.all('SELECT source_url FROM source_fetch_jobs WHERE id=?', ['expired']),
      ).toEqual([{ source_url: '[retention expired]' }]);
      expect(await db.all('SELECT source_url FROM source_fetch_jobs WHERE id=?', ['held'])).toEqual(
        [{ source_url: 'https://example.org/source' }],
      );
      await maintainGovernance(db, new Date('2026-09-14T00:00:00Z'));
      expect(await db.all('SELECT id FROM sanitized_previews')).toEqual([]);
    } finally {
      await close();
    }
  });
