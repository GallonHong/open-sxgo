import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  DEFAULT_POSTGRES_MIGRATIONS,
  migratePostgres,
  type PostgresMigrationOptions,
  type PostgresQueryClient,
} from '../packages/db/src/pg-migrate';

export { DEFAULT_POSTGRES_MIGRATIONS, migratePostgres } from '../packages/db/src/pg-migrate';
export type { PostgresMigrationOptions, PostgresQueryClient } from '../packages/db/src/pg-migrate';

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(entry);
}

async function main() {
  const connectionString = process.env.DATABASE_URL ?? process.env.TEST_POSTGRES_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL (or TEST_POSTGRES_URL) is required');
  }

  const directory = process.argv[2];
  const schema = process.env.PG_SCHEMA;
  const options: PostgresMigrationOptions = {
    directory: directory ? resolve(directory) : DEFAULT_POSTGRES_MIGRATIONS,
    ...(schema ? { schema } : {}),
  };
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await migratePostgres(client as unknown as PostgresQueryClient, options);
  } finally {
    client.release();
    await pool.end();
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
