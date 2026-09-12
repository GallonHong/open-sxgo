import SQLite from 'better-sqlite3';
import type { Database, Query } from './adapter';
export function openDatabase(path: string) {
  const sqlite = new SQLite(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db: Database = {
    async all<T>(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    async batch(queries: Query[]) {
      sqlite.transaction(() => {
        for (const q of queries) sqlite.prepare(q.sql).run(...(q.params ?? []));
      })();
    },
  };
  return { db, sqlite };
}
