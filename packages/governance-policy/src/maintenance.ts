import type { Database } from '../../db/src/adapter';
import { NodeRegistry } from '../../node-observer/src/index';

export const retentionPolicy = Object.freeze({
  version: 'wfd-retention-1',
  sourceClosedDays: 90,
  previewMaxDays: 30,
  previewClosedDays: 7,
});

/** Private main-database cleanup only; backups and isolated processor storage need their own expiry jobs. */
export async function maintainGovernance(db: Database, now = new Date()) {
  const stamp = now.toISOString();
  const ago = (days: number) => new Date(+now - days * 86400000).toISOString();
  const hold = `NOT EXISTS(SELECT 1 FROM review_cases c JOIN retention_holds h ON h.item_id=c.submission_id WHERE c.id=sanitized_previews.case_id AND h.expires_at>?)`;
  await db.batch([
    {
      sql: "UPDATE qualification_applications SET status='expired',version=version+1,updated_at=? WHERE status='approved' AND valid_until<=?",
      params: [stamp, stamp],
    },
    {
      sql: "UPDATE role_grants SET status='expired',grant_revision=grant_revision+1,updated_at=? WHERE status='active' AND expires_at<=?",
      params: [stamp, stamp],
    },
    {
      sql: "UPDATE case_assignments SET status='revoked',assignment_revision=assignment_revision+1 WHERE status IN ('assigned','accepted','in_progress') AND (expires_at<=? OR grant_id IN (SELECT grant_id FROM role_grants WHERE status!='active' OR revocation_status!='not_revoked'))",
      params: [stamp],
    },
    { sql: 'DELETE FROM session_assurance WHERE expires_at<=?', params: [stamp] },
    { sql: 'DELETE FROM webauthn_challenges WHERE expires_at<=?', params: [stamp] },
    {
      sql: `DELETE FROM sanitized_previews WHERE ${hold} AND (expires_at<=? OR created_at<=? OR EXISTS(SELECT 1 FROM review_cases c WHERE c.id=sanitized_previews.case_id AND c.state IN ('rejected','approved_for_publication') AND c.updated_at<=?))`,
      params: [
        stamp,
        stamp,
        ago(retentionPolicy.previewMaxDays),
        ago(retentionPolicy.previewClosedDays),
      ],
    },
    {
      sql: "UPDATE source_fetch_jobs SET state='expired',revision=revision+1,claim_token=NULL,updated_at=? WHERE expires_at<=? AND state!='expired'",
      params: [stamp, stamp],
    },
    {
      sql: `UPDATE source_fetch_jobs SET source_url='[retention expired]',revision=revision+1 WHERE source_url!='[retention expired]' AND EXISTS(SELECT 1 FROM review_cases c WHERE c.id=source_fetch_jobs.case_id AND c.state IN ('rejected','approved_for_publication') AND c.updated_at<=? AND NOT EXISTS(SELECT 1 FROM retention_holds h WHERE h.item_id=c.submission_id AND h.expires_at>?))`,
      params: [ago(retentionPolicy.sourceClosedDays), stamp],
    },
  ]);
  await new NodeRegistry(db, undefined, () => now).maintenance();
  return { policy_version: retentionPolicy.version, ran_at: stamp };
}
