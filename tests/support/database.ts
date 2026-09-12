import { readdir, readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { openDatabase } from '../../packages/db/src/node';
import { migrate } from '../../packages/db/src/migrate';
import { d1Database } from '../../packages/db/src/d1';
import type { Database } from '../../packages/db/src/adapter';
import { Pool } from 'pg';
import { postgresDatabase } from '../../packages/db/src/postgres';
import { migratePostgres } from '../../packages/db/src/pg-migrate';
export const databaseAdapters = process.env.TEST_POSTGRES_URL
  ? (['sqlite', 'd1', 'postgres'] as const)
  : (['sqlite', 'd1'] as const);
export async function testDatabase(
  adapter: 'sqlite' | 'd1' | 'postgres',
): Promise<{ db: Database; pool?: Pool; close: () => Promise<void> }> {
  if (adapter === 'postgres') {
    if (!process.env.TEST_POSTGRES_URL) throw Error('TEST_POSTGRES_URL required');
    const admin = new Pool({ connectionString: process.env.TEST_POSTGRES_URL, max: 1 });
    const schema = 'test_' + crypto.randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: process.env.TEST_POSTGRES_URL,
      max: 5,
      options: `-c search_path=${schema},public`,
    });
    const close = async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    };
    try {
      const client = await pool.connect();
      try {
        await migratePostgres(client);
      } finally {
        client.release();
      }
      return { db: postgresDatabase(pool), pool, close };
    } catch (e) {
      await close();
      throw e;
    }
  }
  if (adapter === 'sqlite') {
    const n = openDatabase(':memory:');
    await migrate(n.sqlite);
    return {
      db: n.db,
      close: async () => {
        n.sqlite.close();
      },
    };
  }
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
    compatibilityDate: '2026-07-30',
  });
  const binding = await mf.getD1Database('DB'),
    db = d1Database(binding);
  try {
    for (const name of (await readdir('migrations'))
      .filter((n) => /^\d+_.*\.sql$/.test(n))
      .sort()) {
      // Repository migrations contain no semicolons in SQL string literals.
      const statements = (await readFile('migrations/' + name, 'utf8'))
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && !/^PRAGMA/i.test(s));
      if (statements.length) await db.batch(statements.map((sql) => ({ sql })));
    }
    return { db, close: () => mf.dispose() };
  } catch (e) {
    await mf.dispose();
    throw e;
  }
}
