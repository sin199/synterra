import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import Fastify from 'fastify';
import { compressJsonOnSend, pickEncoding, sendSiteFile, SITE_FONT_FILES } from '../src/static-assets.js';

const SITE = new URL('../site/', import.meta.url).pathname;

test('pickEncoding prefers br, honours q=0', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br');
  assert.equal(pickEncoding('gzip, br;q=0'), 'gzip');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(undefined), null);
});

test('site files are compressed, cached by ETag and decompress to the original', async () => {
  const app = Fastify();
  app.get('/app.js', (request, reply) => sendSiteFile(request, reply, SITE, 'app.js', { type: 'text/javascript; charset=utf-8' }));
  const original = await readFile(new URL('../site/app.js', import.meta.url));
  const br = await app.inject({ url: '/app.js', headers: { 'accept-encoding': 'br' } });
  assert.equal(br.headers['content-encoding'], 'br');
  assert.ok(br.rawPayload.length < original.length / 2);
  assert.deepEqual(brotliDecompressSync(br.rawPayload), original);
  const gz = await app.inject({ url: '/app.js', headers: { 'accept-encoding': 'gzip' } });
  assert.deepEqual(gunzipSync(gz.rawPayload), original);
  const plain = await app.inject({ url: '/app.js' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.rawPayload, original);
  const revalidate = await app.inject({ url: '/app.js', headers: { 'if-none-match': plain.headers.etag } });
  assert.equal(revalidate.statusCode, 304);
  await app.close();
});

test('JSON responses are compressed only when accepted', async () => {
  const app = Fastify();
  app.addHook('onSend', compressJsonOnSend);
  const big = { rows: Array.from({ length: 400 }, (_, i) => ({ i, name: `resident-${i}` })) };
  app.get('/data', async () => big);
  const gz = await app.inject({ url: '/data', headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(gz.rawPayload)), big);
  const plain = await app.inject({ url: '/data' });
  assert.deepEqual(plain.json(), big);
  await app.close();
});

test('every font and the share image referenced by the site exist and are served by server.js', async () => {
  const [html, css, server] = await Promise.all(['../site/index.html', '../site/styles.css', '../src/server.js']
    .map((file) => readFile(new URL(file, import.meta.url), 'utf8')));
  assert.ok(!html.includes('fonts.googleapis.com'), 'no third-party font CDN');
  const fonts = [...css.matchAll(/url\(\/fonts\/([^)]+)\)/g)].map((match) => match[1]);
  assert.ok(fonts.length >= 4);
  for (const font of fonts) {
    assert.ok(SITE_FONT_FILES.has(font), `${font} allowlisted`);
    await readFile(new URL(`../site/fonts/${font}`, import.meta.url));
  }
  await readFile(new URL('../site/og.jpg', import.meta.url));
  assert.match(server, /app\.get\('\/og\.jpg'/);
  assert.match(server, /pathOnly\.startsWith\('\/fonts\/'\)/);
});
