import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
const base = resolve('dist/web');
const types: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.sqlite': 'application/vnd.sqlite3',
};
createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://preview').pathname;
    let file = resolve(base, '.' + path);
    if (!file.startsWith(base + '/')) file = join(base, 'index.html');
    try {
      if (!(await stat(file)).isFile()) throw Error();
    } catch {
      if (path.startsWith('/public/') || extname(path)) {
        res.writeHead(404).end();
        return;
      }
      file = join(base, 'index.html');
    }
    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(await readFile(file));
  } catch {
    res.writeHead(500).end();
  }
}).listen(4173, '127.0.0.1');
