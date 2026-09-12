import { readdir, readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { openDatabase } from '../../packages/db/src/node';
import { migrate } from '../../packages/db/src/migrate';
import { d1Database } from '../../packages/db/src/d1';
import type { Database } from '../../packages/db/src/adapter';
export async function testDatabase(
  adapter: 'sqlite' | 'd1',
): Promise<{ db: Database; close: () => Promise<void> }> {
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
