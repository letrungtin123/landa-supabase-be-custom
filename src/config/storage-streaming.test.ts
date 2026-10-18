import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

// H5: uploadFileFromPath() streams a temp file to Storage (a 300 MB library
// document is no longer read whole into the heap) with the request the SDK
// sends for a Buffer; openStorageObjectStream() downloads without buffering.
// A local fake stands in for Supabase Storage; paths without a tenant id
// need no quota rows, so no database is used.

interface Received { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }

async function fakeStorage(answer?: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => boolean) {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (answer?.(req, res, body)) return;
      if ((req.url ?? '').includes('/storage/v1/bucket/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'landa-storage', name: 'landa-storage', public: true }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Key: 'landa-storage/x', Id: 'id-1' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    received,
    close: () => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

/** Sends every Supabase Storage request to the fake (SUPABASE_URL is read from .env). */
function routeStorageTo(t: TestContext, origin: string): void {
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.pathname.startsWith('/storage/v1/')) return realFetch(`${origin}${url.pathname}${url.search}`, init);
    return realFetch(input, init);
  });
}

function tempFile(content: Buffer): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'landa-storage-test-'));
  const file = path.join(dir, 'upload.tmp');
  writeFileSync(file, content);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a temp file is streamed to Storage with the same request the SDK sends for a Buffer', async (t) => {
  const storage = await fakeStorage();
  routeStorageTo(t, storage.origin);
  const content = Buffer.from(Array.from({ length: 200_000 }, (_v, i) => i % 251));
  const { file, cleanup } = tempFile(content);
  try {
    const { uploadFileFromPath } = await import('./storage.js');
    assert.equal(await uploadFileFromPath('library/doc.pdf', file, 'application/pdf'), 'library/doc.pdf');
    const upload = storage.received.find((item) => item.method === 'POST')!;
    assert.equal(upload.url, '/storage/v1/object/landa-storage/library/doc.pdf');
    assert.equal(upload.headers['content-type'], 'application/pdf');
    assert.equal(upload.headers['content-length'], String(content.length));
    assert.equal(upload.headers['x-upsert'], 'false');
    assert.equal(upload.headers['cache-control'], 'max-age=3600');
    assert.ok(upload.headers.authorization, 'authenticated with the service key');
    assert.ok(upload.body.equals(content), 'the file arrives byte for byte');
    // The file handle is closed: the caller can remove the temp file at once.
    unlinkSync(file);

    // Same request as the former Buffer upload through the SDK.
    const { uploadFile } = await import('./storage.js');
    await uploadFile('library/sdk.pdf', content, 'application/pdf');
    const viaSdk = storage.received.find((item) => item.method === 'POST' && item.url.endsWith('/sdk.pdf'))!;
    assert.equal(viaSdk.url, '/storage/v1/object/landa-storage/library/sdk.pdf');
    for (const header of ['content-type', 'x-upsert', 'cache-control', 'content-length']) {
      assert.equal(upload.headers[header], viaSdk.headers[header], header);
    }
    assert.ok(viaSdk.body.equals(upload.body));
  } finally {
    cleanup();
    await storage.close();
  }
});

test('a Storage refusal is an upload error with its message; an empty file still uploads', async (t) => {
  const storage = await fakeStorage((req, res) => {
    if (req.method === 'POST' && (req.url ?? '').endsWith('/refused.pdf')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }));
      return true;
    }
    return false;
  });
  routeStorageTo(t, storage.origin);
  const refused = tempFile(Buffer.from('abc'));
  const empty = tempFile(Buffer.alloc(0));
  try {
    const { uploadFileFromPath } = await import('./storage.js');
    await assert.rejects(uploadFileFromPath('library/refused.pdf', refused.file, 'application/pdf'),
      /\[Storage\] Upload failed \(library\/refused\.pdf\): The resource already exists/);
    unlinkSync(refused.file);

    assert.equal(await uploadFileFromPath('library/empty.txt', empty.file, 'text/plain'), 'library/empty.txt');
    const upload = storage.received.find((item) => item.method === 'POST' && item.url.endsWith('/empty.txt'))!;
    assert.equal(upload.body.length, 0);
  } finally {
    refused.cleanup();
    empty.cleanup();
    await storage.close();
  }
});

test('a Storage object is opened as a stream with its type and length, uncompressed', async (t) => {
  const content = Buffer.from('assignment file body');
  const storage = await fakeStorage((req, res) => {
    if (req.method !== 'GET' || !(req.url ?? '').includes('/storage/v1/object/')) return false;
    if ((req.url ?? '').endsWith('/missing.pdf')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': content.length });
    res.end(content);
    return true;
  });
  routeStorageTo(t, storage.origin);
  try {
    const { openStorageObjectStream } = await import('./storage.js');
    const opened = await openStorageObjectStream('t/assignments/a.pdf');
    assert.equal(opened.contentType, 'application/pdf');
    assert.equal(opened.contentLength, content.length);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.body) chunks.push(chunk as Buffer);
    assert.ok(Buffer.concat(chunks).equals(content));
    const request = storage.received.find((item) => item.url === '/storage/v1/object/landa-storage/t/assignments/a.pdf')!;
    assert.equal(request.headers['accept-encoding'], 'identity');
    assert.ok(request.headers.authorization);

    await assert.rejects(openStorageObjectStream('t/assignments/missing.pdf'),
      /\[Storage\] Download failed \(t\/assignments\/missing\.pdf\): Object not found/);
  } finally {
    await storage.close();
  }
});

test('opening a Storage object gives up when Storage does not answer, or when the caller aborts', async (t) => {
  const storage = await fakeStorage((req) => (req.method === 'GET' && (req.url ?? '').includes('/storage/v1/object/')));
  routeStorageTo(t, storage.origin);
  try {
    const { openStorageObjectStream } = await import('./storage.js');
    await assert.rejects(openStorageObjectStream('t/hang.pdf', { headersTimeoutMs: 100 }));
    const caller = new AbortController();
    setTimeout(() => caller.abort(new Error('client left')), 50);
    await assert.rejects(openStorageObjectStream('t/hang.pdf', { signal: caller.signal, headersTimeoutMs: 10_000 }));
  } finally {
    await storage.close();
  }
});
