import { readFile, writeFile } from 'node:fs/promises';
import { validateDataset } from '../packages/domain/src/index';
import { checkLink } from '../packages/link-checker/src/index';
const [input, out] = process.argv.slice(2);
if (!input || !out)
  throw Error('Usage: pnpm links:check <approved-public-dataset.json> <report.json>');
const data = validateDataset(JSON.parse(await readFile(input, 'utf8')));
const results = [];
for (const link of data.links) {
  try {
    results.push({ link_id: link.link_id, ...(await checkLink(link.url)) });
  } catch (e) {
    results.push({ link_id: link.link_id, state: 'blocked', code: (e as Error).message });
  }
}
await writeFile(out, JSON.stringify({ checked_at: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify({ checked: results.length, report: out }));
