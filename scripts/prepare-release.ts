import { readFile } from 'node:fs/promises';
import { decode, strictJSON } from '../packages/verifier/src/index';
import {
  prepareRelease,
  type Approval,
  type GateAttestation,
} from '../packages/builder/src/publisher';
const [approvalPath, rootPath, authorityPath, output, sequence, previous, gatesPath] =
  process.argv.slice(2);
if (!approvalPath || !rootPath || !authorityPath || !output || !sequence || !previous)
  throw Error(
    'Usage: pnpm release:prepare <approval.json> <trusted-root.json> <reviewer-authority.json> <output-dir> <sequence> <previous-hash|null> [gates.json]',
  );
const approval = strictJSON(await readFile(approvalPath, 'utf8')) as Approval;
const result = await prepareRelease(
  approval,
  decode(await readFile(rootPath)),
  decode(await readFile(authorityPath)),
  output,
  Number(sequence),
  previous === 'null' ? null : previous,
  gatesPath ? (decode(await readFile(gatesPath)) as GateAttestation) : undefined,
);
console.log(
  JSON.stringify({
    release: result.manifest.release_id,
    manifest_hash: result.manifestHash,
    targets_payload: output + '/targets.unsigned.json',
    published: false,
  }),
);
