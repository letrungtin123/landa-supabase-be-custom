import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { registerCharacterization, type Case } from '../../test-support/sql-characterization.js';

// Characterization of the Storage proxy (GET and HEAD /api/storage/*): for
// every request, the answer the client gets (status, the content and cache
// headers, a digest of the body) and every request the proxy sends to
// Storage (URL and forwarded headers), over plain and Range requests, path
// checks, upstream errors, a Storage that never answers and a failing fetch.
// The golden file was written by the code before the proxy handler moved out
// of storage.routes.ts; the move must keep every entry equal.
//
// No network: the proxy runs on 127.0.0.1 with a fetch double standing in
// for Supabase Storage. Rewrite the golden file only for an intended change:
//   STORAGE_PROXY_GOLDEN_WRITE=1 npx tsx --test src/modules/storage/storage-proxy.characterization.test.ts
// STORAGE_PROXY_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const { pool } = await import('../../config/database.js');
const { createStorageProxyRouter } = await import('./storage.routes.js');

const VIDEO = Buffer.from(Array.from({ length: 4096 }, (_v, i) => i % 251));
const IMAGE = Buffer.from('small-image-bytes');
const upstream: string[] = [];

const fakeFetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  upstream.push(`GET ${url} ${JSON.stringify(init?.headers ?? null)}`);
  const name = decodeURIComponent(url.split('/').pop() ?? '');
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (name === 'hang.png' || name === 'hang.mp4') {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  }
  if (name === 'throw.png') throw new TypeError('fetch failed');
  if (name === 'missing.png') return new globalThis.Response('{"error":"not found"}', { status: 404 });
  if (name === 'error.png' || name === 'error.mp4') return new globalThis.Response('boom', { status: 500 });
  if (name === 'empty.txt') return new globalThis.Response(null, { status: 200 });
  if (name.endsWith('.mp4') || name.endsWith('.pdf')) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers.Range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : VIDEO.length - 1;
      if (start >= VIDEO.length) {
        return new globalThis.Response(null, { status: 416, headers: { 'Content-Range': `bytes */${VIDEO.length}` } });
      }
      return new globalThis.Response(VIDEO.subarray(start, end + 1), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${VIDEO.length}`,
          'Content-Length': String(end - start + 1),
          ETag: '"vid-1"',
          'Last-Modified': 'Wed, 01 Oct 2026 00:00:00 GMT',
        },
      });
    }
    return new globalThis.Response(VIDEO, { status: 200, headers: { 'Content-Length': String(VIDEO.length), ETag: '"vid-1"' } });
  }
  return new globalThis.Response(IMAGE, {
    status: 200,
    headers: { 'Content-Length': String(IMAGE.length), ETag: '"img-1"', 'Last-Modified': 'Wed, 01 Oct 2026 00:00:00 GMT' },
  });
}) as typeof fetch;

const app = express();
app.use(
  '/api/storage',
  createStorageProxyRouter({
    publicUrlFor: storagePath => `https://storage.example.test/storage/v1/object/public/landa-storage/${storagePath}`,
    fetch: fakeFetch,
    headersTimeoutMs: 50,
  }),
);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', () => resolve()));
const port = (server.address() as AddressInfo).port;

const { after } = await import('node:test');
after(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
});

const KEPT_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'content-disposition',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
  'x-content-type-options',
];

function request(method: string, urlPath: string, headers: Record<string, string> = {}) {
  return new Promise<unknown>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: Object.fromEntries(KEPT_HEADERS.filter(name => res.headers[name] !== undefined).map(name => [name, res.headers[name]])),
          bodyLength: body.length,
          body: body.length <= 200 ? body.toString('utf8') : createHash('sha256').update(body).digest('hex'),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>) => cases.push({ name, run });
const T = '11111111-1111-4111-8111-111111111111';

for (const method of ['GET', 'HEAD']) {
  add(`${method} image`, () => request(method, `/api/storage/${T}/course-assets/a.png`));
  add(`${method} avatar`, () => request(method, `/api/storage/${T}/avatars/u.png`));
  add(`${method} branding`, () => request(method, `/api/storage/${T}/branding/logo.svg`));
  add(`${method} video`, () => request(method, `/api/storage/${T}/courses/c/lesson.mp4`));
  add(`${method} video range`, () => request(method, `/api/storage/${T}/courses/c/lesson.mp4`, { Range: 'bytes=10-99' }));
  add(`${method} pdf range`, () => request(method, encodeURI(`/api/storage/${T}/library/Hợp đồng.pdf`), { Range: 'bytes=0-' }));
  add(`${method} document`, () => request(method, `/api/storage/${T}/library/report.docx`));
  add(`${method} download`, () => request(method, `/api/storage/${T}/course-assets/a.png?download=1`));
}
add('image range ignored', () => request('GET', `/api/storage/${T}/course-assets/a.png`, { Range: 'bytes=0-3' }));
add('range with if-range', () =>
  request('GET', `/api/storage/${T}/courses/c/lesson.mp4`, { Range: 'bytes=-500', 'If-Range': ' "vid-1" ' }),
);
add('range too long if-range', () =>
  request('GET', `/api/storage/${T}/courses/c/lesson.mp4`, { Range: 'bytes=5-9', 'If-Range': 'x'.repeat(300) }),
);
add('range not satisfiable', () => request('GET', `/api/storage/${T}/courses/c/lesson.mp4`, { Range: 'bytes=999999-' }));
add('range multiple', () => request('GET', `/api/storage/${T}/courses/c/lesson.mp4`, { Range: 'bytes=0-1,5-6' }));
add('range malformed', () => request('GET', `/api/storage/${T}/course-assets/a.png`, { Range: 'items=0-1' }));
add('range upstream error', () => request('GET', `/api/storage/${T}/courses/c/error.mp4`, { Range: 'bytes=0-1' }));
add('range upstream hangs', () => request('GET', `/api/storage/${T}/courses/c/hang.mp4`, { Range: 'bytes=0-1' }));
add('missing', () => request('GET', `/api/storage/${T}/missing.png`));
add('upstream error', () => request('GET', `/api/storage/${T}/error.png`));
add('upstream hangs', () => request('GET', `/api/storage/${T}/hang.png`));
add('upstream throws', () => request('GET', `/api/storage/${T}/throw.png`));
add('empty body', () => request('GET', `/api/storage/${T}/empty.txt`));
add('unknown extension', () => request('GET', `/api/storage/${T}/file.bin`));
add('no extension', () => request('GET', `/api/storage/${T}/README`));
add('path traversal', () => request('GET', `/api/storage/${T}/..%2F..%2Fetc/passwd`));
add('double slash', () => request('GET', `/api/storage/${T}//a.png`));
add('bad characters', () => request('GET', `/api/storage/${T}/a%3C.png`));
add('no path', () => request('GET', '/api/storage/'));

registerCharacterization({
  title: 'storage proxy characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'storage-proxy.characterization.golden.json'),
  writeEnv: 'STORAGE_PROXY_GOLDEN_WRITE',
  fullOutEnv: 'STORAGE_PROXY_FULL_OUT',
  pool,
  defaultRow: {},
  cases,
  fixedIds: [T],
  now: Date.parse('2026-10-18T03:04:05.000Z'),
  storage: upstream,
});
