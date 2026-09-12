import { retentionPolicy } from '../../../packages/domain/src/retention';
import type { Database, WorkItem, Proposal, Query } from '../../../packages/db/src/adapter';
import type {
  Principal,
  SubmissionInput,
  ProposalInput,
} from '../../../packages/protocol/src/private';
import { assert, validateDataset } from '../../../packages/domain/src/index';
import { hash, utf8, canonical, hex } from '../../../packages/verifier/src/crypto';
const randomId = (prefix: string) => prefix + '_' + crypto.randomUUID().replaceAll('-', '');
const now = () => new Date().toISOString();
const audit = (id: string, actor: string, action: string, reason: string): Query => ({
  sql: 'INSERT INTO audit VALUES(?,?,?,?,?,?)',
  params: [randomId('au'), id, actor, action, reason, now()],
});
const guard: Query[] = [
  { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
  { sql: 'DELETE FROM mutation_guard' },
];
export function requireRole(p: Principal, role: string, company?: string) {
  assert(p.verified && p.two_factor, 'MFA_REQUIRED', 403);
  assert(p.roles.includes(role), 'FORBIDDEN', 403);
  if (company) {
    assert(
      p.company_ids.includes('*') || p.company_ids.includes(company),
      'OUTSIDE_AUTHORIZED_SCOPE',
      403,
    );
    assert(!p.conflicts.includes(company), 'CONFLICT_OF_INTEREST', 403);
  }
}
export class Service {
  constructor(public db: Database) {}
  async canRead(p: Principal, item: WorkItem) {
    requireRole(p, 'reviewer');
    const proposals = await this.db.all<{ company_id: string }>(
      'SELECT company_id FROM proposals WHERE submission_id=?',
      [item.id],
    );
    const record = JSON.parse(item.body).record_id;
    const ids = proposals.map((row) => row.company_id);
    if (typeof record === 'string' && record.startsWith('co_')) ids.push(record);
    if (item.kind === 'appeal' && typeof record === 'string') {
      const decisions = await this.db.all<Proposal>('SELECT * FROM proposals');
      if (
        decisions.some(
          (d) =>
            (d.company_id === record || d.id === record || d.body.includes('\"' + record + '\"')) &&
            (d.author_person === p.person_id || d.reviewer_person === p.person_id),
        )
      )
        return false;
    }
    if (ids.some((id) => p.conflicts.includes(id))) return false;
    return (
      p.company_ids.includes('*') ||
      (ids.length > 0 && ids.every((id) => p.company_ids.includes(id)))
    );
  }
  async readable(p: Principal, id: string) {
    const [item] = await this.db.all<WorkItem>('SELECT * FROM work_items WHERE id=?', [id]);
    assert(item, 'NOT_FOUND', 404);
    assert(await this.canRead(p, item), 'OUTSIDE_AUTHORIZED_SCOPE', 403);
    return item;
  }
  async submit(body: SubmissionInput, key: string) {
    const ih = await hash(utf8(key)),
      rh = await hash(utf8(canonical(body)));
    const [existing] = await this.db.all<WorkItem>(
      'SELECT * FROM work_items WHERE idempotency_hash=?',
      [ih],
    );
    if (existing) {
      assert(existing.request_hash === rh, 'IDEMPOTENCY_CONFLICT', 409);
      return { id: existing.id, state: existing.state, replayed: true, receipt: null };
    }
    const receipt = hex(crypto.getRandomValues(new Uint8Array(32))),
      id = randomId('sub'),
      time = now();
    await this.db.batch([
      {
        sql: 'INSERT INTO work_items(id,kind,state,body,receipt_hash,idempotency_hash,request_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        params: [
          id,
          'submission',
          'submitted',
          JSON.stringify(body),
          await hash(utf8(receipt)),
          ih,
          rh,
          time,
          time,
        ],
      },
    ]);
    return { id, state: 'submitted', receipt, replayed: false };
  }
  async byReceipt(receipt: string) {
    assert(/^[a-f0-9]{64}$/.test(receipt), 'INVALID_RECEIPT', 401);
    const [item] = await this.db.all<WorkItem>('SELECT * FROM work_items WHERE receipt_hash=?', [
      await hash(utf8(receipt)),
    ]);
    assert(item, 'INVALID_RECEIPT', 401);
    return item;
  }
  async status(receipt: string) {
    const item = await this.byReceipt(receipt);
    const messages = await this.db.all<{ author: string; body: string; created_at: string }>(
      'SELECT author,body,created_at FROM messages WHERE item_id=? ORDER BY created_at',
      [item.id],
    );
    return { id: item.id, state: item.state, version: item.version, messages };
  }
  async supplement(receipt: string, body: string) {
    const item = await this.byReceipt(receipt);
    assert(!['withdrawn', 'rejected', 'published'].includes(item.state), 'ITEM_CLOSED', 409);
    await this.db.batch([
      {
        sql: 'UPDATE work_items SET version=version+1,updated_at=? WHERE id=? AND version=?',
        params: [now(), item.id, item.version],
      },
      ...guard,
      {
        sql: 'INSERT INTO messages VALUES(?,?,?,?,?)',
        params: [randomId('msg'), item.id, 'contributor', body, now()],
      },
    ]);
  }
  async withdraw(receipt: string) {
    const item = await this.byReceipt(receipt);
    assert(item.state !== 'published', 'PUBLIC_CORRECTION_REQUIRED', 409);
    await this.db.batch([
      {
        sql: "UPDATE work_items SET state='withdrawn',body='{}',version=version+1,closed_at=?,updated_at=? WHERE id=? AND version=?",
        params: [now(), now(), item.id, item.version],
      },
      ...guard,
      {
        sql: "UPDATE proposals SET state='withdrawn' WHERE submission_id=? AND state!='published'",
        params: [item.id],
      },
      { sql: 'DELETE FROM messages WHERE item_id=?', params: [item.id] },
      audit(item.id, 'contributor', 'withdraw', '用户撤回未发布投稿'),
    ]);
  }
  async report(body: unknown, kind: string) {
    const id = randomId('rep'),
      time = now();
    await this.db.batch([
      {
        sql: 'INSERT INTO work_items(id,kind,state,body,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        params: [id, kind, 'submitted', JSON.stringify(body), time, time],
      },
    ]);
    return { id, state: 'submitted' };
  }
  async triage(p: Principal, id: string, expected: number, state: string, reason: string) {
    requireRole(p, 'reviewer');
    const item = await this.readable(p, id);
    const transitions: Record<string, string[]> = {
      submitted: ['triaged', 'out_of_scope', 'rejected'],
      triaged: ['in_review', 'needs_info', 'out_of_scope', 'rejected'],
      in_review: ['needs_info', 'rejected'],
      needs_info: ['in_review', 'rejected'],
      returned: ['in_review'],
    };
    assert(transitions[item.state]?.includes(state), 'INVALID_TRANSITION', 409);
    await this.db.batch([
      {
        sql: 'UPDATE work_items SET state=?,version=version+1,updated_at=?,closed_at=? WHERE id=? AND version=?',
        params: [
          state,
          now(),
          ['rejected', 'out_of_scope'].includes(state) ? now() : null,
          id,
          expected,
        ],
      },
      ...guard,
      audit(id, p.person_id, state, reason),
    ]);
  }
  async proposal(p: Principal, input: ProposalInput) {
    requireRole(p, 'reviewer', input.company.company_id);
    const d = validateDataset(input.public_data);
    assert(
      d.companies.length === 1 && canonical(d.companies[0]) === canonical(input.company),
      'PROPOSAL_DATA_MISMATCH',
    );
    const submission = await this.readable(p, input.submission_id);
    assert(submission?.state === 'in_review', 'INVALID_TRANSITION', 409);
    const [record] = await this.db.all<{ revision: number }>(
      'SELECT revision FROM public_records WHERE id=?',
      [input.company.company_id],
    );
    assert((record?.revision ?? 0) === input.expected_revision, 'REVISION_CONFLICT', 409);
    const id = randomId('prop');
    await this.db.batch([
      {
        sql: "UPDATE work_items SET state='second_review',version=version+1,updated_at=? WHERE id=? AND version=?",
        params: [now(), submission.id, submission.version],
      },
      ...guard,
      {
        sql: 'INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?,?,?)',
        params: [
          id,
          submission.id,
          input.company.company_id,
          JSON.stringify(d),
          input.expected_revision,
          'second_review',
          p.person_id,
          null,
          input.reason,
          now(),
        ],
      },
      audit(id, p.person_id, 'propose', input.reason),
    ]);
    return { id };
  }
  async review(p: Principal, id: string, action: string, reason: string) {
    const [proposal] = await this.db.all<Proposal>('SELECT * FROM proposals WHERE id=?', [id]);
    assert(proposal, 'NOT_FOUND', 404);
    requireRole(p, 'reviewer', proposal.company_id);
    assert(proposal.author_person !== p.person_id, 'SELF_REVIEW', 403);
    assert(proposal.state === 'second_review', 'INVALID_TRANSITION', 409);
    const [submission] = await this.db.all<WorkItem>('SELECT * FROM work_items WHERE id=?', [
      proposal.submission_id,
    ]);
    assert(submission?.state === 'second_review', 'INVALID_TRANSITION', 409);
    const state =
      action === 'approve'
        ? 'approved_for_publication'
        : action === 'reject'
          ? 'rejected'
          : 'returned';
    if (action === 'approve') {
      validateDataset(JSON.parse(proposal.body));
      const [current] = await this.db.all<{ revision: number }>(
        'SELECT revision FROM public_records WHERE id=?',
        [proposal.company_id],
      );
      assert((current?.revision ?? 0) === proposal.expected_revision, 'REVISION_CONFLICT', 409);
    }
    const updates: Query[] = [
      {
        sql: 'UPDATE proposals SET state=?,reviewer_person=? WHERE id=? AND state=?',
        params: [state, p.person_id, id, 'second_review'],
      },
      ...guard,
      {
        sql: 'UPDATE work_items SET state=?,version=version+1,updated_at=?,closed_at=? WHERE id=? AND version=?',
        params: [
          state,
          now(),
          state === 'rejected' ? now() : null,
          submission.id,
          submission.version,
        ],
      },
      ...guard,
      audit(id, p.person_id, action, reason),
    ];
    await this.db.batch(updates);
    return { state };
  }
  async suppress(p: Principal, id: string, reason: string) {
    requireRole(p, 'suppressor', id);
    const [record] = await this.db.all<{ revision: number }>(
      'SELECT revision FROM public_records WHERE id=?',
      [id],
    );
    assert(record, 'NOT_FOUND', 404);
    await this.db.batch([
      {
        sql: "UPDATE public_records SET state='suppressed',revision=revision+1 WHERE id=? AND revision=?",
        params: [id, record.revision],
      },
      ...guard,
      audit(id, p.person_id, 'suppress', reason),
    ]);
  }
  async publicInput(p: Principal) {
    requireRole(p, 'builder');
    const approved = await this.db.all<Proposal>(
      "SELECT * FROM proposals WHERE state='approved_for_publication' ORDER BY created_at,id",
    );
    assert(approved.length, 'NO_APPROVED_PROPOSALS', 409);
    return approved.map((row) => ({
      proposal_id: row.id,
      expected_revision: row.expected_revision,
      public_data: validateDataset(JSON.parse(row.body)),
    }));
  }
  async maintenance() {
    const cutoff = new Date(
      Date.now() - retentionPolicy.closedSubmissionDays * 86400000,
    ).toISOString();
    const expired = await this.db.all<{ id: string }>(
      'SELECT id FROM work_items WHERE closed_at<? AND receipt_hash IS NOT NULL AND id NOT IN (SELECT item_id FROM retention_holds WHERE expires_at>?)',
      [cutoff, now()],
    );
    const cleanup: Query[] = [];
    for (const row of expired)
      cleanup.push(
        {
          sql: "UPDATE work_items SET body='{}',receipt_hash=NULL,idempotency_hash=NULL,request_hash=NULL WHERE id=?",
          params: [row.id],
        },
        { sql: 'DELETE FROM messages WHERE item_id=?', params: [row.id] },
        audit(row.id, 'retention_worker', 'private_content_deleted', retentionPolicy.version),
      );
    await this.db.batch([
      ...cleanup,
      { sql: 'DELETE FROM rate_limits WHERE expires_at<?', params: [Date.now()] },
    ]);
  }
  async metrics() {
    const records = await this.db.all<{ body: string }>('SELECT body FROM public_records');
    const warnings = records.flatMap((row) => {
      const data = validateDataset(JSON.parse(row.body));
      return data.companies.flatMap((co) =>
        co.scopes.flatMap((scope) =>
          scope.claims
            .filter(
              (claim) =>
                claim.valid_until && Date.parse(claim.valid_until) < Date.now() + 30 * 86400000,
            )
            .map((claim) => ({
              company_id: co.company_id,
              scope_id: scope.scope_id,
              valid_until: claim.valid_until,
            })),
        ),
      );
    });
    const queue = await this.db.all<{ state: string; count: number }>(
      'SELECT state,COUNT(*) AS count FROM work_items GROUP BY state',
    );
    const [age] = await this.db.all<{ oldest: string | null }>(
      "SELECT MIN(created_at) AS oldest FROM work_items WHERE state IN ('submitted','triaged','in_review','second_review')",
    );
    return {
      retention_policy: retentionPolicy.version,
      expiry_warnings: warnings,
      queue,
      oldest_pending: age?.oldest,
      production_release_enabled: false,
    };
  }
}
