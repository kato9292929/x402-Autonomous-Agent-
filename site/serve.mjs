/**
 * Dependency-free static server. ES modules require HTTP; file:// will not work.
 *
 *   node serve.mjs        # http://127.0.0.1:8123
 *   PORT=3000 node serve.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname — .pathname leaves spaces percent-encoded and
// every request 404s if the folder name contains a space.
const ROOT = fileURLToPath(new URL('.', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
};

const PORT = Number(process.env.PORT) || 8123;

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = url === '/' ? '/index.html' : url;
    const path = normalize(join(ROOT, rel));

    // directory-traversal guard
    if (!path.startsWith(ROOT)) throw new Error('forbidden');

    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${PORT}`);
});
