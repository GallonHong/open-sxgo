import { syncMirror } from './index';
const [base, dir, root] = process.argv.slice(2);
if (!base || !dir || !root) {
  console.error('Usage: pnpm mirror <source-public-url> <mirror-directory> <trusted-root.json>');
  process.exit(1);
}
console.log(await syncMirror(base, dir, root));
