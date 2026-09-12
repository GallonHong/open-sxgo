export type Query = { sql: string; params?: unknown[] };
export interface Database {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  batch(queries: Query[]): Promise<void>;
}
export type WorkItem = {
  id: string;
  kind: string;
  state: string;
  body: string;
  receipt_hash: string | null;
  idempotency_hash: string | null;
  request_hash: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};
export type Proposal = {
  id: string;
  submission_id: string;
  company_id: string;
  body: string;
  expected_revision: number;
  state: string;
  author_person: string;
  reviewer_person: string | null;
  reason: string;
  created_at: string;
};
