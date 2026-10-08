// Static site delivery: in-memory cache, ETag revalidation and br/gzip compression.
// No extra dependency; compressed variants are built once per file version.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const cache = new Map();
const COMPRESSIBLE = /^(text\/|application\/(json|javascript)|image\/svg)/;

export const SITE_FONT_FILES = new Set([
  'Geist-Variable.woff2', 'GeistMono-Variable.woff2', 'InstrumentSerif-Regular.woff2', 'InstrumentSerif-Italic.woff2'
]);

export function pickEncoding(acceptEncoding = '') {
  const weights = new Map();
  for (const part of String(acceptEncoding).toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';').map((item) => item.trim());
    if (!name) continue;
    const q = params.find((item) => item.startsWith('q='));
    const quality = q ? Number(q.slice(2)) : 1;
    weights.set(name, Number.isFinite(quality) ? Math.max(0, Math.min(1, quality)) : 0);
  }
  const wildcard = weights.get('*');
  const br = weights.get('br') ?? wildcard ?? 0;
  const gzip = weights.get('gzip') ?? wildcard ?? 0;
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return null;
}

async function loadEntry(file) {
  const info = await stat(file);
  const current = cache.get(file);
  if (current && current.mtimeMs === info.mtimeMs && current.size === info.size) return current;
  const raw = await readFile(file);
  const entry = { mtimeMs: info.mtimeMs, size: info.size, raw, br: null, gzip: null,
    etag: `"${createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"` };
  cache.set(file, entry);
  return entry;
}

export async function sendSiteFile(request, reply, siteRoot, relativePath, { type, cacheControl = 'no-cache' }) {
  const entry = await loadEntry(path.join(siteRoot, relativePath));
  reply.header('Content-Type', type);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cache-Control', cacheControl);
  reply.header('ETag', entry.etag);
  const compressible = COMPRESSIBLE.test(type) && entry.raw.length > 1024;
  if (compressible) reply.header('Vary', 'Accept-Encoding');
  if (request.headers['if-none-match'] === entry.etag) return reply.code(304).send();
  const encoding = compressible ? pickEncoding(request.headers['accept-encoding']) : null;
  if (encoding === 'br') {
    entry.br ??= brotliCompressSync(entry.raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: entry.raw.length } });
    reply.header('Content-Encoding', 'br');
    return reply.send(entry.br);
  }
  if (encoding === 'gzip') {
    entry.gzip ??= gzipSync(entry.raw, { level: 9 });
    reply.header('Content-Encoding', 'gzip');
    return reply.send(entry.gzip);
  }
  return reply.send(entry.raw);
}

// Compress JSON API responses (e.g. the polled /local/map-data payload) when the client accepts it.
export function compressJsonOnSend(request, reply, payload, done) {
  const type = String(reply.getHeader('content-type') || '');
  if (typeof payload !== 'string' || payload.length < 2048 || !type.startsWith('application/json') || reply.getHeader('content-encoding')) {
    return done(null, payload);
  }
  const encoding = pickEncoding(request.headers['accept-encoding']);
  if (!encoding) return done(null, payload);
  reply.header('Vary', 'Accept-Encoding');
  reply.header('Content-Encoding', encoding);
  reply.removeHeader('content-length');
  const body = encoding === 'br'
    ? brotliCompressSync(payload, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
    : gzipSync(payload, { level: 6 });
  return done(null, body);
}
