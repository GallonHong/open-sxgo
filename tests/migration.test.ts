import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/db/src/node';
import { migrate } from '../packages/db/src/migrate';
let directory: string, database: ReturnType<typeof openDatabase>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wfd-migration-'));
  database = openDatabase(':memory:');
});
afterEach(async () => {
  database.sqlite.close();
  await rm(directory, { recursive: true, force: true });
});
it('applied migration changes are rejected without altering existing data', async () => {
  const path = join(directory, '0001_test.sql');
  await writeFile(
    path,
    "CREATE TABLE records(id TEXT PRIMARY KEY); INSERT INTO records VALUES('preserved');",
  );
  await migrate(database.sqlite, directory);
  await migrate(database.sqlite, directory);
  await writeFile(path, 'DROP TABLE records;');
  await expect(migrate(database.sqlite, directory)).rejects.toThrow('MIGRATION_CHANGED');
  expect(database.sqlite.prepare('SELECT id FROM records').all()).toEqual([{ id: 'preserved' }]);
});
it('a failed migration rolls back both schema and migration bookkeeping', async () => {
  await writeFile(
    join(directory, '0001_test.sql'),
    'CREATE TABLE transient(id TEXT); INSERT INTO missing VALUES(1);',
  );
  await expect(migrate(database.sqlite, directory)).rejects.toThrow();
  expect(
    database.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='transient'").all(),
  ).toEqual([]);
  expect(database.sqlite.prepare('SELECT * FROM wfd_migrations').all()).toEqual([]);
});
