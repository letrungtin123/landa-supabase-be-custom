import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { createStorageProxyRouter } from './storage.routes.js';

// H4: the storage proxy streams every file, keeps video seek (Range) exactly
// as before, gives up when Storage does not start answering, never cuts a
// long body, and releases the Storage connection when the client leaves.
// A local fake stands in for Supabase Storage.

const VIDEO = Buffer.from(Array.from({ length: 64 * 1024 }, (_v, i) => i % 251));
const IMAGE = Buffer.from('small-image-bytes');

interface FakeStorage {
  url: string;
  closedEarly: string[];
  close: () => Promise<void>;
}

async function fakeStorage(): Promise<FakeStorage> {
  const closedEarly: string[] = [];
  const server = http.createServer((req, res) => {
    const name = (req.url ?? '').split('/').pop() ?? '';
    req.socket.once('close', () => { if (!res.writableFinished) closedEarly.push(name); });
    if (name === 'avatar.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': IMAGE.length, ETag: '"img-1"' });
      res.end(IMAGE);
      return;
    }
    if (name === 'missing.png') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); return; }
    if (name === 'hang.png') return; // never answers
    if (name === 'lesson.mp4') {
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : VIDEO.length - 1;
        if (start >= VIDEO.length) { res.writeHead(416, { 'Content-Range': `bytes */${VIDEO.length}` }); res.end(); return; }
        res.writeHead(206, {
          'Content-Type': 'video/mp4', 'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${VIDEO.length}`, 'Accept-Ranges': 'bytes', ETag: '"vid-1"',
        });
        res.end(VIDEO.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': VIDEO.length });
      res.end(VIDEO);
      return;
    }
    if (name === 'slow.mp4') {
      // Headers at once, then the body trickles in for longer than the headers timeout.
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 10 });
      let sent = 0;
      const timer = setInterval(() => {
        res.write('x');
        sent += 1;
        if (sent === 10) { clearInterval(timer); res.end(); }
      }, 40);
      req.socket.once('close', () => clearInterval(timer));
      return;
    }
    if (name === 'endless.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      const timer = setInterval(() => res.write(Buffer.alloc(16 * 1024)), 5);
      req.socket.once('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(500); res.end();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    closedEarly,
    close: () => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

async function proxy(storage: FakeStorage, headersTimeoutMs = 300): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use('/api/storage', createStorageProxyRouter({ publicUrlFor: (path) => `${storage.url}/landa-storage/${path}`, headersTimeoutMs }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/storage`,
    close: () => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test('small files are streamed with their headers; missing files stay 404', async () => {
  const storage = await fakeStorage();
  const api = await proxy(storage);
  try {
    const image = await fetch(`${api.url}/tenant-a/avatars/avatar.png`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('content-length'), String(IMAGE.length));
    assert.equal(image.headers.get('etag'), '"img-1"');
    assert.equal(image.headers.get('cache-control'), 'no-cache, must-revalidate');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), IMAGE);

    const missing = await fetch(`${api.url}/tenant-a/missing.png`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { success: false, message: 'File not found', code: 'NOT_FOUND' });

    const head = await fetch(`${api.url}/tenant-a/avatars/avatar.png`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(IMAGE.length));
  } finally {
    await api.close();
    await storage.close();
  }
});

test('video seek keeps working: 206, Content-Range, Accept-Ranges and the exact bytes', async () => {
  const storage = await fakeStorage();
  const api = await proxy(storage);
  try {
    const part = await fetch(`${api.url}/tenant-a/course/lesson.mp4`, { headers: { Range: 'bytes=1000-1999' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 1000-1999/${VIDEO.length}`);
    assert.equal(part.headers.get('accept-ranges'), 'bytes');
    assert.equal(part.headers.get('content-length'), '1000');
    assert.equal(part.headers.get('cache-control'), 'public, max-age=86400, immutable');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), VIDEO.subarray(1000, 2000));

    const open = await fetch(`${api.url}/tenant-a/course/lesson.mp4`, { headers: { Range: 'bytes=60000-' } });
    assert.equal(open.status, 206);
    assert.deepEqual(Buffer.from(await open.arrayBuffer()), VIDEO.subarray(60000));

    const outside = await fetch(`${api.url}/tenant-a/course/lesson.mp4`, { headers: { Range: `bytes=${VIDEO.length + 10}-` } });
    assert.equal(outside.status, 416);
    assert.equal(outside.headers.get('content-range'), `bytes */${VIDEO.length}`);

    const whole = await fetch(`${api.url}/tenant-a/course/lesson.mp4`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), VIDEO);
  } finally {
    await api.close();
    await storage.close();
  }
});

test('Storage that never starts answering gets a 502 after the headers timeout', async () => {
  const storage = await fakeStorage();
  const api = await proxy(storage, 200);
  try {
    const startedAt = performance.now();
    const response = await fetch(`${api.url}/tenant-a/hang.png`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { success: false, message: 'Upstream error', code: 'BAD_GATEWAY' });
    assert.ok(performance.now() - startedAt < 2_000);
  } finally {
    await api.close();
    await storage.close();
  }
});

test('a body that takes longer than the headers timeout is never cut', async () => {
  const storage = await fakeStorage();
  const api = await proxy(storage, 100);
  try {
    const response = await fetch(`${api.url}/tenant-a/course/slow.mp4`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'xxxxxxxxxx');
  } finally {
    await api.close();
    await storage.close();
  }
});

test('when the client leaves mid-video, the Storage connection is released at once', async () => {
  const storage = await fakeStorage();
  const api = await proxy(storage);
  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.get(`${api.url}/tenant-a/course/endless.mp4`, (res) => {
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > 64 * 1024) { request.destroy(); resolve(); }
        });
      });
      request.on('error', () => undefined);
      setTimeout(() => reject(new Error('no data')), 3_000);
    });
    for (let i = 0; i < 100 && !storage.closedEarly.includes('endless.mp4'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(storage.closedEarly.includes('endless.mp4'), 'the upstream socket was closed, not left open');
  } finally {
    await api.close();
    await storage.close();
  }
});
