// Production-like static server for the exported app (local preview + E2E).
// Applies the same hash-based CSP and security headers the CDN must serve.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATIC_HEADERS, cspForHtml } from './csp.mjs';

const root = fileURLToPath(new URL('../out', import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
// Local custom RPC (Anvil) is allowed only in this preview server.
const extraConnect = (process.env.EXTRA_CONNECT_SRC ?? 'http://127.0.0.1:8545 http://localhost:8545').split(' ');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function resolve(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const candidates = [clean, `${clean}.html`, join(clean, 'index.html')];
  for (const c of candidates) {
    const p = join(root, c);
    if (!p.startsWith(root)) return null;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

createServer((req, res) => {
  const file = resolve(req.url ?? '/') ?? join(root, '404.html');
  const ext = extname(file);
  const body = readFileSync(file);
  const headers = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', ...STATIC_HEADERS };
  delete headers['Strict-Transport-Security']; // not meaningful on http://localhost
  if (ext === '.html') {
    headers['Content-Security-Policy'] = cspForHtml(body.toString('utf8'), { apiOrigin, extraConnect }).replace('; upgrade-insecure-requests', '');
    headers['Cache-Control'] = 'no-cache';
  } else if (file.includes(`${join('_next', 'static')}`)) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  }
  res.writeHead(existsSync(file) && resolve(req.url ?? '/') ? 200 : 404, headers);
  res.end(body);
}).listen(port, () => console.log(`QD Wallet static preview on http://localhost:${port}`));
