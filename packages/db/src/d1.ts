import type { D1Database } from '@cloudflare/workers-types';
import type { Database } from './adapter';
export function d1Database(binding: D1Database): Database {
  return {
    async all<T>(sql: string, params: unknown[] = []) {
      const r = await binding
        .prepare(sql)
        .bind(...params)
        .all<T>();
      return r.results;
    },
    async batch(queries) {
      await binding.batch(queries.map((q) => binding.prepare(q.sql).bind(...(q.params ?? []))));
    },
  };
}
