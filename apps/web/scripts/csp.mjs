// Builds a strict, hash-based Content-Security-Policy for each exported page
// (spec §7.5 / ADR-005). No 'unsafe-inline' or 'unsafe-eval' for scripts.
//
//   node scripts/csp.mjs            → writes out/_headers (Netlify / Cloudflare Pages format)
//   import { cspForHtml } from ...  → used by scripts/serve-static.mjs
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

export function inlineScriptHashes(html) {
  const hashes = new Set();
  for (const m of html.matchAll(INLINE_SCRIPT)) {
    const body = m[1] ?? '';
    if (body.length === 0) continue;
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return [...hashes];
}

export function cspForHtml(html, { apiOrigin, extraConnect = [] } = {}) {
  const hashes = inlineScriptHashes(html);
  return [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    // Framer Motion and Next set inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin ?? ''} ${extraConnect.join(' ')}`.replace(/\s+/g, ' ').trim(),
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export const STATIC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
};

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL('../out', import.meta.url));
  const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? 'https://api.qdwallet.example';
  const lines = [];
  for (const file of walk(out).filter((f) => f.endsWith('.html'))) {
    const rel = relative(out, file).split(sep).join('/');
    const route = '/' + rel.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '');
    lines.push(route, `  Content-Security-Policy: ${cspForHtml(readFileSync(file, 'utf8'), { apiOrigin })}`);
    for (const [k, v] of Object.entries(STATIC_HEADERS)) lines.push(`  ${k}: ${v}`);
    lines.push('');
  }
  writeFileSync(join(out, '_headers'), lines.join('\n'));
  console.log(`wrote ${join(out, '_headers')} for ${lines.filter((l) => l.startsWith('/')).length} routes`);
}
