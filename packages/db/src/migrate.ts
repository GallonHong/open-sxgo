import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type SQLite from 'better-sqlite3';

/** Local/container migrations. D1 uses the same ordered files via Wrangler. */
export async function migrate(sqlite: SQLite.Database, directory = 'migrations') {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS wfd_migrations (name TEXT PRIMARY KEY, digest TEXT NOT NULL)',
  );
  const files = (await readdir(directory)).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
  for (const name of files) {
    const sql = await readFile(join(directory, name), 'utf8');
    const digest = createHash('sha256').update(sql).digest('hex');
    const old = sqlite.prepare('SELECT digest FROM wfd_migrations WHERE name=?').get(name) as
      { digest: string } | undefined;
    if (old) {
      if (old.digest !== digest) throw new Error('MIGRATION_CHANGED: ' + name);
      continue;
    }
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO wfd_migrations VALUES(?,?)').run(name, digest);
    })();
  }
}
