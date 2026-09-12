import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, validateDataset } from '../../domain/src/index';
import { hash, utf8, canonical, verify } from '../../verifier/src/crypto';
import {
  rootSchema,
  threshold,
  checkBytes,
  verifySuspensions,
  type Envelope,
  type Root,
} from '../../verifier/src/index';
import { buildArtifacts, signed, type SigningKey } from './index';
import type { Dataset, Manifest } from '../../protocol/src/public';
import { verifyBusinessData } from '../../verifier/src/business';
import { collectReleaseHistory } from './history';
export type Approval = { payload: Dataset; signatures: { keyid: string; sig: string }[] };
export type ReviewerAuthority = { keyid: string; person_id: string; company_ids: string[] };
export async function verifyApproval(
  approval: Approval,
  root: Root,
  reviewers: ReviewerAuthority[],
) {
  const data = validateDataset(approval.payload);
  const role = root.roles.reviewers;
  assert(role && role.threshold >= 2, 'REVIEWER_AUTHORITY_MISSING');
  const persons = new Set<string>();
  for (const signature of approval.signatures) {
    const key = root.keys[signature.keyid],
      authority = reviewers.find((r) => r.keyid === signature.keyid);
    if (!key || !authority || !role.keyids.includes(signature.keyid)) continue;
    if (
      !data.companies.every(
        (c) => authority.company_ids.includes('*') || authority.company_ids.includes(c.company_id),
      )
    )
      continue;
    if (await verify(data, signature.sig, key.keyval.public, true))
      persons.add(authority.person_id);
  }
  assert(persons.size >= role.threshold, 'INDEPENDENT_REVIEW_THRESHOLD');
  return data;
}
export type GateAttestation = {
  signed: Record<string, unknown>;
  signatures: Envelope['signatures'];
};
export async function verifyGates(attestation: GateAttestation, root: Root, now = Date.now()) {
  await threshold(attestation, root, 'root');
  assert(attestation.signed.purpose === 'wfd-production-gates-v1', 'INVALID_GATE_ATTESTATION');
  assert(
    typeof attestation.signed.expires === 'string' && Date.parse(attestation.signed.expires) > now,
    'GATES_EXPIRED',
  );
  const gates = attestation.signed.gates;
  assert(gates && typeof gates === 'object', 'GATES_MISSING');
  for (let i = 1; i <= 10; i++)
    assert(
      (gates as Record<string, unknown>)[`GATE-${String(i).padStart(2, '0')}`] === true,
      'GATE_NOT_PASSED',
    );
}
export type Prepared = {
  manifest: Manifest;
  targetsPayload: Record<string, unknown>;
  manifestHash: string;
  directory: string;
};
export async function prepareRelease(
  input: Approval,
  rootEnvelope: Envelope,
  reviewerAuthorization: Envelope,
  directory: string,
  sequence: number,
  previousHash: string | null,
  gates?: GateAttestation,
) {
  const root = rootSchema.parse(rootEnvelope.signed);
  await threshold(rootEnvelope, root, 'root');
  await threshold(reviewerAuthorization, root, 'root');
  assert(
    reviewerAuthorization.signed.purpose === 'wfd-reviewer-authority-v1',
    'INVALID_REVIEW_AUTHORITY',
  );
  assert(
    typeof reviewerAuthorization.signed.expires === 'string' &&
      Date.parse(reviewerAuthorization.signed.expires) > Date.now(),
    'AUTHORITY_EXPIRED',
  );
  const reviewers = reviewerAuthorization.signed.reviewers;
  assert(Array.isArray(reviewers), 'INVALID_REVIEW_AUTHORITY');
  const authorities: ReviewerAuthority[] = reviewers.map((r) => {
    assert(
      r &&
        typeof r === 'object' &&
        typeof r.keyid === 'string' &&
        typeof r.person_id === 'string' &&
        Array.isArray(r.company_ids) &&
        r.company_ids.every((c: unknown) => typeof c === 'string'),
      'INVALID_REVIEW_AUTHORITY',
    );
    return { keyid: r.keyid, person_id: r.person_id, company_ids: r.company_ids };
  });
  const data = await verifyBusinessData(input.payload, input, reviewerAuthorization, root);
  assert(data.demo === (root.custom?.environment === 'demo'), 'ENVIRONMENT_MISMATCH');
  if (!data.demo) {
    assert(gates, 'GATES_REQUIRED');
    await verifyGates(gates, root);
  }
  const { manifest } = await buildArtifacts(
    data,
    directory,
    sequence,
    previousHash,
    new Date(),
    true,
  );
  const approvalBytes = utf8(canonical(input)),
    authBytes = utf8(canonical(reviewerAuthorization));
  for (const [path, bytes] of [
    ['approvals.json', approvalBytes],
    ['reviewer-authority.json', authBytes],
  ] as const) {
    await writeFile(join(directory, 'releases', manifest.release_id, path), bytes);
    manifest.artifacts.push({
      path,
      sha256: await hash(bytes),
      byte_length: bytes.length,
      media_type: 'application/json',
    });
  }
  const manifestBytes = utf8(canonical(manifest)),
    manifestHash = await hash(manifestBytes);
  await mkdir(join(directory, 'targets'), { recursive: true });
  await writeFile(join(directory, 'targets', manifestHash + '.manifest.json'), manifestBytes);
  await writeFile(join(directory, 'releases', manifest.release_id, 'manifest.json'), manifestBytes);
  const targetsPayload = {
    _type: 'targets',
    spec_version: '1.0.31',
    version: sequence,
    expires: manifest.expires_at,
    targets: {
      'manifest.json': { length: manifestBytes.length, hashes: { sha256: manifestHash } },
    },
  };
  await writeFile(join(directory, 'targets.unsigned.json'), canonical(targetsPayload));
  return { manifest, targetsPayload, manifestHash, directory };
}
export async function addTargetSignature(
  prepared: Prepared,
  root: Root,
  keyid: string,
  sig: string,
  existing: Envelope['signatures'] = [],
) {
  assert(root.roles.targets?.keyids.includes(keyid) && root.keys[keyid], 'TARGETS_ROLE_REQUIRED');
  assert(
    await verify(prepared.targetsPayload, sig, root.keys[keyid].keyval.public),
    'INVALID_SIGNATURE',
  );
  const signatures = [...existing.filter((s) => s.keyid !== keyid), { keyid, sig }];
  return { signed: prepared.targetsPayload, signatures };
}
export interface PublicStore {
  operator: string;
  provider: string;
  putImmutable(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  activateTimestamp(bytes: Uint8Array): Promise<void>;
  activateSuspensions(bytes: Uint8Array): Promise<void>;
}
export async function distributeRelease(
  prepared: Prepared,
  rootEnvelope: Envelope,
  targets: Envelope,
  snapshotKey: SigningKey,
  timestampKey: SigningKey,
  stores: PublicStore[],
  suspensions: Envelope,
  historySource?: (path: string, maxBytes: number) => Promise<Uint8Array | null>,
) {
  const root = rootSchema.parse(rootEnvelope.signed);
  await threshold(rootEnvelope, root, 'root');
  await verifySuspensions(suspensions, root);
  await threshold(targets, root, 'targets');
  assert(canonical(targets.signed) === canonical(prepared.targetsPayload), 'CANDIDATE_CHANGED');
  assert(
    stores.length >= 2 &&
      stores.some((a) =>
        stores.some((b) => a.operator !== b.operator && a.provider !== b.provider),
      ),
    'INDEPENDENT_COPIES_REQUIRED',
  );
  const base = {
    spec_version: '1.0.31',
    version: prepared.manifest.sequence,
    expires: prepared.manifest.expires_at,
  };
  const tb = utf8(JSON.stringify(targets));
  const snapshot = await signed(
    {
      ...base,
      _type: 'snapshot',
      meta: {
        'targets.json': {
          version: base.version,
          length: tb.length,
          hashes: { sha256: await hash(tb) },
        },
      },
    },
    [snapshotKey],
  );
  await threshold(snapshot, root, 'snapshot');
  const sb = utf8(JSON.stringify(snapshot));
  const timestamp = await signed(
    {
      ...base,
      _type: 'timestamp',
      meta: {
        'snapshot.json': {
          version: base.version,
          length: sb.length,
          hashes: { sha256: await hash(sb) },
        },
      },
    },
    [timestampKey],
  );
  await threshold(timestamp, root, 'timestamp');
  const files = await collectReleaseHistory(prepared.manifest, rootEnvelope, async (path, max) => {
    if (historySource) {
      const bytes = await historySource(path, max);
      if (bytes) return bytes;
    }
    try {
      return await readFile(join(prepared.directory, path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    for (const store of stores) {
      try {
        return await store.read(path);
      } catch {
        /* Other replicas may retain history. */
      }
    }
    return null;
  });
  files.set(`metadata/${root.version}.root.json`, utf8(JSON.stringify(rootEnvelope)));
  files.set(`metadata/${base.version}.targets.json`, tb);
  files.set(`metadata/${base.version}.snapshot.json`, sb);
  files.set(
    `targets/${prepared.manifestHash}.manifest.json`,
    await readFile(join(prepared.directory, 'targets', prepared.manifestHash + '.manifest.json')),
  );
  for (const a of prepared.manifest.artifacts) {
    const bytes = await readFile(
      join(prepared.directory, 'releases', prepared.manifest.release_id, a.path),
    );
    await checkBytes(bytes, a);
    files.set(`releases/${prepared.manifest.release_id}/${a.path}`, bytes);
  }
  // Never switch discovery metadata before two complete, read-back verified copies exist.
  for (const store of stores)
    for (const [path, bytes] of files) {
      await store.putImmutable(path, bytes);
      await checkBytes(await store.read(path), {
        byte_length: bytes.length,
        sha256: await hash(bytes),
      });
    }
  const suspensionBytes = utf8(JSON.stringify(suspensions));
  for (const store of stores) {
    await store.activateSuspensions(suspensionBytes);
    await checkBytes(await store.read('suspensions.json'), {
      byte_length: suspensionBytes.length,
      sha256: await hash(suspensionBytes),
    });
  }
  const timeBytes = utf8(JSON.stringify(timestamp));
  for (const store of stores) await store.activateTimestamp(timeBytes);
  return { release_id: prepared.manifest.release_id, copies: stores.length };
}
