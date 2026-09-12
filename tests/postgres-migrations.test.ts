import { it, expect } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migratePostgres } from '../packages/db/src/pg-migrate';
it.skipIf(!process.env.TEST_POSTGRES_URL)(
  'Postgres migrations serialize, reject changed history and roll back failed DDL',
  async () => {
    const pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URL });
    const schema = 'migration_' + randomUUID().replaceAll('-', '');
    const directory = await mkdtemp(join(tmpdir(), 'sxgo-pg-migration-'));
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await writeFile(
        join(directory, '0001_init.sql'),
        'CREATE TABLE example (id TEXT PRIMARY KEY);',
      );
      await Promise.all([
        migratePostgres(first, { directory, schema }),
        migratePostgres(second, { directory, schema }),
      ]);
      expect(
        (await first.query(`SELECT count(*)::int AS count FROM "${schema}".wfd_migrations`)).rows[0]
          .count,
      ).toBe(1);
      await writeFile(join(directory, '0001_init.sql'), 'CREATE TABLE changed (id TEXT);');
      await expect(migratePostgres(first, { directory, schema })).rejects.toThrow(
        'MIGRATION_CHANGED',
      );
      await writeFile(
        join(directory, '0001_init.sql'),
        'CREATE TABLE example (id TEXT PRIMARY KEY);',
      );
      await writeFile(
        join(directory, '0002_failed.sql'),
        'CREATE TABLE rollback_probe (id TEXT); SELECT * FROM nonexistent_migration_table;',
      );
      await expect(migratePostgres(first, { directory, schema })).rejects.toThrow();
      expect(
        (await first.query('SELECT to_regclass($1) AS name', [`${schema}.rollback_probe`])).rows[0]
          .name,
      ).toBeNull();
      expect(
        (await first.query(`SELECT count(*)::int AS count FROM "${schema}".wfd_migrations`)).rows[0]
          .count,
      ).toBe(1);
    } finally {
      await first.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      first.release();
      second.release();
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
