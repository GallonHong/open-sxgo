import { z } from 'zod';
import type { Database, Query } from '../../db/src/adapter';
import { assert } from '../../domain/src/index';
import { canonical, hash, utf8 } from '../../verifier/src/crypto';

const label = z.string().min(1).max(100);
export const nodeInput = z.strictObject({
  url: z.url().refine((raw) => {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (!u.port || u.port === '443') &&
      !/^\[|^[\d.]+$/.test(u.hostname)
    );
  }, '节点地址必须是无凭据的 HTTPS 域名'),
  kind: z.enum(['static_mirror', 'readonly_api', 'web_mirror', 'domain', 'ipfs', 'observer']),
  control_group: label,
  fault_domain: label,
  expires_at: z.iso.datetime(),
});
type Node = z.infer<typeof nodeInput> & {
  id: string;
  owner_id: string;
  state: string;
  revision: number;
  challenge_hash: string | null;
  challenge_expires_at: string | null;
  challenge_consumed_at: string | null;
  created_at: string;
};
export type NodeProbe = (target: {
  origin: string;
  path: string;
  maxBytes: number;
  timeoutMs: number;
}) => Promise<string>;
const guard: Query[] = [
  { sql: 'INSERT INTO mutation_guard VALUES(changes())' },
  { sql: 'DELETE FROM mutation_guard' },
];
const id = () => crypto.randomUUID();

/** Probe must be hosted outside the private service network and enforce the source egress policy. */
export class NodeRegistry {
  constructor(
    private db: Database,
    private probe?: NodeProbe,
    private clock = () => new Date(),
  ) {}
  async propose(owner: string, input: unknown, key: string) {
    const body = nodeInput.parse(input),
      now = this.clock();
    assert(Date.parse(body.expires_at) > +now, 'INVALID_EXPIRY', 400);
    const requestKey = await hash(utf8(owner + ':' + key)),
      digest = await hash(utf8(canonical(body)));
    const [old] = await this.db.all<Node & { request_hash: string }>(
      'SELECT * FROM node_registrations WHERE request_key=?',
      [requestKey],
    );
    if (old) {
      assert(old.request_hash === digest, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      return {
        id: old.id,
        revision: old.revision,
        state: old.state,
        challenge: null,
        replayed: true,
      };
    }
    const nodeId = id(),
      challenge = id() + id();
    await this.db.batch([
      {
        sql: 'INSERT INTO node_registrations(id,owner_id,url,kind,control_group,fault_domain,state,challenge_hash,challenge_expires_at,revision,created_at,expires_at,request_key,request_hash) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?)',
        params: [
          nodeId,
          owner,
          body.url,
          body.kind,
          body.control_group,
          body.fault_domain,
          'challenge_pending',
          await hash(utf8(challenge)),
          new Date(+now + 15 * 60000).toISOString(),
          now.toISOString(),
          body.expires_at,
          requestKey,
          digest,
        ],
      },
    ]);
    return {
      id: nodeId,
      revision: 1,
      state: 'challenge_pending',
      challenge,
      challenge_path: '/.well-known/wfd-node/' + nodeId,
      replayed: false,
    };
  }
  async mine(owner: string) {
    return this.db.all<Pick<Node, 'id' | 'url' | 'state' | 'revision' | 'expires_at'>>(
      'SELECT id,url,state,revision,expires_at FROM node_registrations WHERE owner_id=? ORDER BY created_at DESC LIMIT 100',
      [owner],
    );
  }
  async verifyControl(owner: string, nodeId: string, revision: number) {
    const [node] = await this.db.all<Node>(
      'SELECT * FROM node_registrations WHERE id=? AND owner_id=?',
      [nodeId, owner],
    );
    assert(node, 'CAPABILITY_DENIED', 403);
    assert(
      node.state === 'challenge_pending' &&
        !node.challenge_consumed_at &&
        node.revision === revision,
      'REVISION_CONFLICT',
      409,
    );
    assert(Date.parse(node.challenge_expires_at ?? '') > +this.clock(), 'CHALLENGE_EXPIRED', 410);
    assert(this.probe, 'SAFE_PROCESSOR_UNAVAILABLE', 503);
    const value = await this.probe({
      origin: new URL(node.url).origin,
      path: '/.well-known/wfd-node/' + nodeId,
      maxBytes: 256,
      timeoutMs: 10000,
    });
    assert(
      value.length <= 256 && (await hash(utf8(value.trim()))) === node.challenge_hash,
      'CONTROL_PROOF_INVALID',
      422,
    );
    const now = this.clock().toISOString();
    await this.db.batch([
      {
        sql: "UPDATE node_registrations SET state='pending_review',revision=revision+1,challenge_consumed_at=?,challenge_hash=NULL WHERE id=? AND owner_id=? AND revision=? AND state='challenge_pending' AND challenge_expires_at>? AND expires_at>?",
        params: [now, nodeId, owner, revision, now, now],
      },
      ...guard,
    ]);
    return { id: nodeId, state: 'pending_review', revision: revision + 1 };
  }
  async decide(
    actor: string,
    controlGroup: string,
    nodeId: string,
    revision: number,
    action: 'approve' | 'reject' | 'exit',
    reason: string,
  ) {
    z.string().min(1).max(500).parse(reason);
    const [node] = await this.db.all<Node>('SELECT * FROM node_registrations WHERE id=?', [nodeId]);
    assert(node, 'CAPABILITY_DENIED', 403);
    if (action === 'exit') assert(node.owner_id === actor, 'CAPABILITY_DENIED', 403);
    else {
      assert(
        node.owner_id !== actor && node.control_group !== controlGroup,
        'CONFLICT_OF_INTEREST',
        403,
      );
      assert(node.state === 'pending_review', 'REVISION_CONFLICT', 409);
    }
    const state =
      action === 'approve'
        ? 'approved_pending_publication'
        : action === 'exit'
          ? 'exited'
          : 'rejected';
    await this.db.batch([
      {
        sql: 'UPDATE node_registrations SET state=?,revision=revision+1 WHERE id=? AND revision=? AND expires_at>?',
        params: [state, nodeId, revision, this.clock().toISOString()],
      },
      ...guard,
      {
        sql: 'INSERT INTO node_decisions VALUES(?,?,?,?,?,?)',
        params: [id(), nodeId, actor, action, reason, this.clock().toISOString()],
      },
    ]);
    return { id: nodeId, state, revision: revision + 1 };
  }
  async observe(nodeId: string, observer: string, group: string, observation: unknown) {
    const value = z
      .strictObject({
        reachable: z.boolean(),
        signature_valid: z.boolean(),
        content_retrieved: z.boolean(),
        release_version: z.string().max(100).nullable(),
        error_code: z.string().max(100).nullable(),
      })
      .parse(observation);
    const [node] = await this.db.all<Node>('SELECT * FROM node_registrations WHERE id=?', [nodeId]);
    assert(
      node && node.owner_id !== observer && node.control_group !== group,
      'CONFLICT_OF_INTEREST',
      403,
    );
    assert(
      !['exited', 'expired', 'rejected'].includes(node.state) &&
        Date.parse(node.expires_at) > +this.clock(),
      'NODE_INACTIVE',
      409,
    );
    await this.db.batch([
      {
        sql: 'INSERT INTO node_observations VALUES(?,?,?,?,?,?,?,?,?,?)',
        params: [
          id(),
          nodeId,
          observer,
          group,
          this.clock().toISOString(),
          +value.reachable,
          +value.signature_valid,
          +value.content_retrieved,
          value.release_version,
          value.error_code,
        ],
      },
    ]);
  }
  async maintenance() {
    await this.db.batch([
      {
        sql: "UPDATE node_registrations SET state='expired',revision=revision+1 WHERE expires_at<=? AND state NOT IN ('exited','expired','rejected')",
        params: [this.clock().toISOString()],
      },
      {
        sql: 'DELETE FROM node_observations WHERE observed_at<?',
        params: [new Date(+this.clock() - 30 * 86400000).toISOString()],
      },
    ]);
  }
}

export function servicePeriod(
  observations: {
    observed_at: string;
    reachable: boolean;
    signature_valid: boolean;
    content_retrieved: boolean;
  }[],
  month?: string,
) {
  const months = new Set(observations.map((o) => o.observed_at.slice(0, 7)));
  const period = month ?? (months.size === 1 ? [...months][0] : undefined);
  // Never combine unrelated months or inflate availability by repeating successful probes.
  if (!period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
    return {
      valid_days: 0,
      availability: null,
      qualifies_for_assessment: false,
      automatically_recognized: false,
    };
  const unique = new Map<string, (typeof observations)[number]>();
  for (const o of observations.filter(
    (o) => Number.isFinite(Date.parse(o.observed_at)) && o.observed_at.slice(0, 7) === period,
  )) {
    const old = unique.get(o.observed_at);
    unique.set(
      o.observed_at,
      old
        ? {
            ...o,
            reachable: old.reachable && o.reachable,
            signature_valid: old.signature_valid && o.signature_valid,
            content_retrieved: old.content_retrieved && o.content_retrieved,
          }
        : o,
    );
  }
  const samples = [...unique.values()];
  const valid = samples.filter((o) => o.reachable && o.signature_valid && o.content_retrieved);
  const validDays = new Set(valid.map((o) => o.observed_at.slice(0, 10))).size;
  const availability = samples.length ? valid.length / samples.length : null;
  return {
    valid_days: validDays,
    availability,
    qualifies_for_assessment: validDays >= 25 && availability !== null && availability >= 0.98,
    automatically_recognized: false,
  };
}
