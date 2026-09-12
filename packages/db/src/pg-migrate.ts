import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PostgresQueryResult = { rows: Array<Record<string, unknown>> };

/** The small part of pg's Client/PoolClient used by the migration runner. */
export interface PostgresQueryClient {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResult>;
}

export type PostgresMigrationOptions = {
  /** Directory containing ordered PostgreSQL migration files. */
  directory?: string;
  /** PostgreSQL schema to create/use. Omit to preserve the connection search_path. */
  schema?: string;
  /** Alias accepted by callers that call this value a schema path. */
  schemaPath?: string;
};

export const DEFAULT_POSTGRES_MIGRATIONS = fileURLToPath(
  new URL('../../../migrations-postgres/', import.meta.url),
);

function quoteIdentifier(value: string): string {
  // A schema name is an identifier, never SQL. Restricting it here also keeps
  // SET search_path and the privilege hardening in migration SQL injectable.
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error('INVALID_POSTGRES_SCHEMA: ' + value);
  }
  return '"' + value + '"';
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveOptions(
  directoryOrOptions?: string | PostgresMigrationOptions,
  schemaArgument?: string,
): Promise<{ directory: string; schema?: string }> {
  if (directoryOrOptions && typeof directoryOrOptions === 'object') {
    return {
      directory: directoryOrOptions.directory
        ? resolve(directoryOrOptions.directory)
        : DEFAULT_POSTGRES_MIGRATIONS,
      schema: directoryOrOptions.schema ?? directoryOrOptions.schemaPath,
    };
  }

  if (typeof directoryOrOptions === 'string') {
    const candidate = isAbsolute(directoryOrOptions)
      ? directoryOrOptions
      : resolve(process.cwd(), directoryOrOptions);
    // The historical two-argument form used the second value for the
    // migrations directory.  Also accept a schema name in that position so a
    // test can call migratePostgres(client, 'isolated_schema').
    if (await isDirectory(candidate)) {
      return { directory: candidate, schema: schemaArgument };
    }
    return {
      directory: DEFAULT_POSTGRES_MIGRATIONS,
      schema: directoryOrOptions,
    };
  }

  return { directory: DEFAULT_POSTGRES_MIGRATIONS, schema: schemaArgument };
}

/**
 * Apply PostgreSQL migrations with the same immutable-digest contract as the
 * SQLite runner. Each migration runs in its own transaction, and an advisory
 * transaction lock serializes concurrent runners for the selected schema.
 *
 * Pass a dedicated `pg` Client/PoolClient. A `Pool` itself must not be passed:
 * its individual queries may use different connections and cannot share a
 * transaction.
 */
export async function migratePostgres(
  client: PostgresQueryClient,
  directoryOrOptions?: string | PostgresMigrationOptions,
  schemaArgument?: string,
): Promise<void> {
  const { directory, schema } = await resolveOptions(directoryOrOptions, schemaArgument);
  const files = (await readdir(directory)).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
  const quotedSchema = schema === undefined ? undefined : quoteIdentifier(schema);

  for (const name of files) {
    const sql = await readFile(join(directory, name), 'utf8');
    const digest = createHash('sha256').update(sql).digest('hex');
    let committed = false;
    await client.query('BEGIN');
    try {
      const lockNamespace = `wfd-postgres-migrations:${schema ?? '<search_path>'}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
        lockNamespace,
      ]);
      if (quotedSchema) {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
        await client.query(`SET LOCAL search_path TO ${quotedSchema}, public`);
      }
      await client.query(
        'CREATE TABLE IF NOT EXISTS wfd_migrations (name TEXT PRIMARY KEY, digest TEXT NOT NULL)',
      );
      const previous = await client.query('SELECT digest FROM wfd_migrations WHERE name=$1', [
        name,
      ]);
      const oldDigest = previous.rows[0]?.digest;
      if (oldDigest !== undefined) {
        if (oldDigest !== digest) throw new Error('MIGRATION_CHANGED: ' + name);
      } else {
        await client.query(sql);
        await client.query('INSERT INTO wfd_migrations (name, digest) VALUES ($1, $2)', [
          name,
          digest,
        ]);
      }
      await client.query('COMMIT');
      committed = true;
    } catch (error) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the migration error; the connection is unusable if
          // rollback itself failed and the caller should discard it.
        }
      }
      throw error;
    }
  }
}
