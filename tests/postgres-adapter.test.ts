import { describe, expect, it, vi } from 'vitest';
import {
  PostgresDatabaseError,
  postgresDatabase,
  translateSql,
  type PostgresQueryable,
} from '../packages/db/src/postgres';

type RecordedQuery = { text: string; values?: unknown[] };

class FakeClient implements PostgresQueryable {
  readonly calls: RecordedQuery[] = [];

  constructor(
    private readonly respond: (query: RecordedQuery) => {
      rows?: unknown[];
      rowCount?: number | null;
      command?: string;
    } = () => ({ rows: [], rowCount: 0 }),
  ) {}

  async query(query: RecordedQuery) {
    this.calls.push(query);
    return this.respond(query);
  }
}

function commandFor(text: string) {
  return text
    .trimStart()
    .match(/^[A-Za-z]+/)?.[0]
    .toUpperCase();
}

describe('PostgreSQL adapter SQL boundary', () => {
  it('rewrites only executable SQLite syntax and preserves literals, comments, and identifiers', async () => {
    const client = new FakeClient((query) => ({
      rows: [{ bound: query.values?.[0] }],
      rowCount: 1,
      command: 'SELECT',
    }));
    const db = postgresDatabase(client);

    const rows = await db.all<{ bound: string }>(
      `SELECT '?' AS literal, "?" AS "?", ? AS bound,
              '-- ?' AS line_literal /* ? */ -- ?
       `,
      ['value'],
    );

    expect(rows).toEqual([{ bound: 'value' }]);
    expect(client.calls[0]).toEqual({
      text: `SELECT '?' AS literal, "?" AS "?", $1 AS bound,
              '-- ?' AS line_literal /* ? */ -- ?
       `,
      values: ['value'],
    });
  });

  it('translates INSERT OR IGNORE, scalar MAX, JSON paths, time helpers, and sqlite_master probes', () => {
    const insert = translateSql(
      "INSERT OR IGNORE INTO records(id,note) VALUES(?, 'INSERT OR IGNORE ?') RETURNING id",
    );
    expect(insert).toMatch(/INSERT\s+INTO records/i);
    expect(insert).toContain("'INSERT OR IGNORE ?'");
    expect(insert).toContain('$1');
    expect(insert).toMatch(/ON CONFLICT DO NOTHING\s+RETURNING id/i);

    expect(translateSql('SELECT MAX(updatedAt,?) FROM records')).toMatch(
      /GREATEST\(\"updatedAt\",\$1\)/,
    );
    expect(translateSql('SELECT MAX(value),MIN(value) FROM records')).toContain('MAX(value)');
    expect(
      translateSql(
        'INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',
      ),
    ).toContain('SET count=rate_limits.count+1');
    expect(translateSql("SELECT json_extract(payload, '$.owner.id') FROM records")).toContain(
      "#>> ARRAY['owner','id']::text[]",
    );
    expect(translateSql("SELECT datetime('now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')")).toContain(
      "to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')",
    );
    expect(translateSql("SELECT name FROM sqlite_master WHERE type='table' AND name=?")).toMatch(
      /information_schema\.tables[\s\S]*table_type='BASE TABLE'[\s\S]*table_name=\$1/i,
    );
  });

  it('turns a successful changes() guard into a checked one-row mutation', async () => {
    const client = new FakeClient((query) => {
      const command = commandFor(query.text);
      if (command === 'UPDATE') return { rows: [], rowCount: 1, command };
      if (command === 'INSERT') return { rows: [], rowCount: 1, command };
      if (command === 'DELETE') return { rows: [], rowCount: 1, command };
      return { rows: [], rowCount: 0, command };
    });
    const db = postgresDatabase(client);

    await db.batch([
      { sql: 'UPDATE records SET state=? WHERE id=?', params: ['active', 'record-1'] },
      { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
      { sql: 'DELETE FROM mutation_guard' },
    ]);

    expect(client.calls.map((query) => query.text)).toEqual([
      'BEGIN',
      'UPDATE records SET state=$1 WHERE id=$2',
      'INSERT INTO mutation_guard VALUES(1)',
      'DELETE FROM mutation_guard',
      'COMMIT',
    ]);
  });

  it('rolls the transaction back when a CAS update changes zero rows', async () => {
    const client = new FakeClient((query) => {
      const command = commandFor(query.text);
      if (command === 'UPDATE') return { rows: [], rowCount: 0, command };
      return { rows: [], rowCount: 0, command };
    });
    const db = postgresDatabase(client);

    await expect(
      db.batch([
        { sql: 'UPDATE records SET version=version+1 WHERE id=? AND version=?', params: ['r', 7] },
        { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
        { sql: 'INSERT INTO audit VALUES(?,?,?)', params: ['r', 'actor', 'should-rollback'] },
      ]),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/mutation_guard/i),
    });

    expect(client.calls.map((query) => query.text)).toEqual([
      'BEGIN',
      'UPDATE records SET version=version+1 WHERE id=$1 AND version=$2',
      'ROLLBACK',
    ]);
    expect(client.calls.map((query) => query.values)).toEqual([[], ['r', 7], []]);
  });

  it('uses one pooled connection for every statement in a batch', async () => {
    const connection = new FakeClient((query) => ({
      rows: [],
      rowCount: commandFor(query.text) === 'UPDATE' ? 1 : 0,
      command: commandFor(query.text),
    }));
    const pool = {
      totalCount: 0,
      query: vi.fn(),
      connect: vi.fn(async () => ({ ...connection, release: vi.fn() })),
    };
    const pooledConnection = await pool.connect();
    // The spread above would copy the call array but retain the same query
    // method; use an explicit fake below so assertions inspect the live list.
    pool.connect.mockImplementation(
      async () =>
        ({
          query: connection.query.bind(connection),
          release: vi.fn(),
        }) as never,
    );
    const db = postgresDatabase(pool as never);

    await db.batch([{ sql: 'UPDATE records SET state=? WHERE id=?', params: ['active', 'r'] }]);

    expect(pool.query).not.toHaveBeenCalled();
    expect(connection.calls.map((query) => query.text)).toEqual([
      'BEGIN',
      'UPDATE records SET state=$1 WHERE id=$2',
      'COMMIT',
    ]);
    expect(pooledConnection.release).toBeTypeOf('function');
  });

  it('normalizes constraint and retryable SQLSTATE errors without row details', async () => {
    const duplicate = Object.assign(new Error('duplicate key contains secret-value'), {
      code: '23505',
      detail: 'Key (id)=(secret-value) already exists.',
    });
    const client = new FakeClient(() => {
      throw duplicate;
    });
    const db = postgresDatabase(client);

    await expect(db.all('SELECT 1')).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof PostgresDatabaseError &&
        error.message === 'UNIQUE constraint violation' &&
        !error.message.includes('secret-value') &&
        error.sqlState === '23505'
      );
    });

    const retry = Object.assign(new Error('deadlock involving private row'), { code: '40P01' });
    const retryingClient = new FakeClient(() => {
      throw retry;
    });
    await expect(postgresDatabase(retryingClient).all('SELECT 1')).rejects.toMatchObject({
      message: 'TRANSACTION_RETRYABLE',
      sqlState: '40P01',
      retryable: true,
    });
  });
});
