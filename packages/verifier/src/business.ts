import { z } from 'zod';
import { datasetSchema, type Dataset } from '../../protocol/src/public';
import { assert, validateDataset } from '../../domain/src/index';
import { canonical, verify } from './crypto';
import { threshold, type Root, type Envelope } from './index';
export const authoritySchema = z.strictObject({
  purpose: z.literal('wfd-reviewer-authority-v1'),
  expires: z.iso.datetime(),
  reviewers: z.array(
    z.strictObject({ keyid: z.string(), person_id: z.string(), company_ids: z.array(z.string()) }),
  ),
});
export const approvalSchema = z.strictObject({
  payload: datasetSchema,
  signatures: z.array(z.strictObject({ keyid: z.string(), sig: z.string() })).min(2),
});
export async function verifyBusinessData(
  data: Dataset,
  rawApproval: unknown,
  authorization: Envelope,
  root: Root,
  now = Date.now(),
) {
  await threshold(authorization, root, 'root');
  const auth = authoritySchema.parse(authorization.signed);
  assert(Date.parse(auth.expires) > now, 'AUTHORITY_EXPIRED');
  const approval = approvalSchema.parse(rawApproval);
  assert(canonical(data) === canonical(approval.payload), 'APPROVED_DATA_MISMATCH');
  validateDataset(data, new Date(now));
  const role = root.roles.reviewers;
  assert(role && role.threshold >= 2, 'REVIEWER_AUTHORITY_MISSING');
  const persons = new Set<string>();
  for (const s of approval.signatures) {
    const key = root.keys[s.keyid],
      person = auth.reviewers.find((r) => r.keyid === s.keyid);
    if (
      !key ||
      !person ||
      !role.keyids.includes(s.keyid) ||
      !data.companies.every(
        (c) => person.company_ids.includes('*') || person.company_ids.includes(c.company_id),
      )
    )
      continue;
    if (await verify(data, s.sig, key.keyval.public, true)) persons.add(person.person_id);
  }
  assert(persons.size >= role.threshold, 'INDEPENDENT_REVIEW_THRESHOLD');
  return data;
}
