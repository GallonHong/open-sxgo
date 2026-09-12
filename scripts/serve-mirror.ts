import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { createReadStream } from 'node:fs';
import { syncMirror } from '../packages/mirror-sync/src/index';
const dir = resolve(process.env.MIRROR_DATA_DIR ?? '.runtime/mirror'),
  base = process.env.MIRROR_SOURCE,
  root = process.env.MIRROR_ROOT ?? 'bootstrap/demo-root.json';
let syncing = false;
async function sync() {
  if (!base || syncing) return;
  syncing = true;
  try {
    const result = await syncMirror(base, dir, root);
    console.log(JSON.stringify({ event: 'mirror_updated', release: result.release }));
  } catch {
    console.error(JSON.stringify({ event: 'mirror_update_failed', action: 'retain_previous' }));
  } finally {
    syncing = false;
  }
}
await sync();
const interval = setInterval(() => void sync(), 15 * 60 * 1000);
const mime: Record<string, string> = {
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.sqlite': 'application/vnd.sqlite3',
};
const server = createServer(async (req, res) => {
  try {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://mirror');
    if (url.pathname === '/health') {
      const current = (await readFile(join(dir, 'CURRENT'), 'utf8')).trim();
      if (!/^[a-z0-9.-]+$/.test(current)) throw Error('INVALID_CURRENT');
      const state = JSON.parse(await readFile(join(dir, 'versions', current, 'state.json'), 'utf8'));
      const timestamp = JSON.parse(state.metadata.timestamp);
      const historical = Date.parse(timestamp.signed.expires) <= Date.now();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ state: historical ? 'historical' : 'serving', release: current, read_only: true, expires_at: timestamp.signed.expires, updating: syncing }));
      return;
    }
    if (!url.pathname.startsWith('/public/') || url.pathname.split('/').includes('..')) {
      res.writeHead(404).end();
      return;
    }
    const current = (await readFile(join(dir, 'CURRENT'), 'utf8')).trim();
    if (!/^[a-z0-9.-]+$/.test(current)) throw Error('INVALID_CURRENT');
    const baseDir = join(dir, 'versions', current, 'public'),
      path = resolve(baseDir, '.' + url.pathname.slice('/public'.length));
    if (!path.startsWith(baseDir + '/')) {
      res.writeHead(404).end();
      return;
    }
    const info = await stat(path);
    if (!info.isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    res.setHeader('Content-Length', info.size);
    res.setHeader(
      'Cache-Control',
      url.pathname.includes('/releases/') ? 'public,max-age=31536000,immutable' : 'no-store',
    );
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(req.url === '/health' ? 503 : 404).end(req.url === '/health' ? 'No verified snapshot' : 'Not found');
  }
});
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    clearInterval(interval);
    server.close(() => process.exit(0));
  });
