import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import express from 'express';

// H5: GET /api/assignments/files/:fileId streams the file from Storage with
// the same status and headers as the former in-memory download, answers
// HEAD without a body, keeps errors as before and releases Storage when the
// client leaves. pg double for the access check, a local fake for Storage.

const TENANT = '11111111-1111-4111-8111-111111111111';
const FILE_ID = 'f0000000-0000-4000-8000-000000000001';
const BODY = Buffer.from(Array.from({ length: 100_000 }, (_v, i) => i % 251));

function installAttachmentRow(t: TestContext, db: typeof import('../../config/database.js'), storagePath: string) {
  t.mock.method(db.pool, 'query', async (text: string) => {
    if (text.includes("ca.attachment_file ->> 'storage_path'")) {
      return {
        rows: [{ assignment_id: 'a1', tenant_id: TENANT, course_id: 'course-1', storage_path: storagePath,
          original_name: 'Bài tập 1.pdf', mime_type: 'application/pdf' }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
}

async function fakeStorage() {
  const closedEarly: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.includes('/storage/v1/bucket/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"landa-storage"}'); return; }
    const name = url.split('/').pop() ?? '';
    req.socket.once('close', () => { if (!res.writableFinished) closedEarly.push(name); });
    if (name === 'a.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': BODY.length });
      res.end(BODY);
      return;
    }
    if (name === 'endless.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      const timer = setInterval(() => res.write(Buffer.alloc(16 * 1024)), 5);
      req.socket.once('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"statusCode":"404","error":"not_found","message":"Object not found"}');
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    closedEarly,
    close: () => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

async function serveDownloads(t: TestContext, storageOrigin: string) {
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    return realFetch(`${storageOrigin}${url.pathname}${url.search}`, init);
  });
  const { downloadFile } = await import('./assignments.controller.js');
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'u1', role: 'superuser', tenantId: TENANT, username: 'admin', sessionMode: 'normal' } as never;
    next();
  });
  app.get('/files/:fileId', downloadFile);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, message: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

function request(port: number, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/files/${FILE_ID}`, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('a file is streamed with the former status and headers', async (t) => {
  const db = await import('../../config/database.js');
  installAttachmentRow(t, db, `${TENANT}/assignments/course-1/a.pdf`);
  const storage = await fakeStorage();
  const app = await serveDownloads(t, storage.origin);
  try {
    const got = await request(app.port);
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-type'], 'application/pdf', 'the stored mime type wins, as before');
    assert.equal(got.headers['content-length'], String(BODY.length));
    assert.equal(got.headers['content-disposition'], `attachment; filename*=UTF-8''${encodeURIComponent('Bài tập 1.pdf')}`);
    assert.ok(got.body.equals(BODY));

    const head = await request(app.port, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(BODY.length));
    assert.equal(head.body.length, 0);
  } finally {
    await app.close();
    await storage.close();
  }
});

test('a Storage failure before the body is still passed to the error handler', async (t) => {
  const db = await import('../../config/database.js');
  installAttachmentRow(t, db, `${TENANT}/assignments/course-1/missing.pdf`);
  const storage = await fakeStorage();
  const app = await serveDownloads(t, storage.origin);
  t.mock.method(console, 'error', () => undefined);
  try {
    const got = await request(app.port);
    assert.equal(got.status, 500);
    assert.match(JSON.parse(got.body.toString()).message, /\[Storage\] Download failed/);
  } finally {
    await app.close();
    await storage.close();
  }
});

test('the Storage connection is released when the client leaves mid-download', async (t) => {
  const db = await import('../../config/database.js');
  installAttachmentRow(t, db, `${TENANT}/assignments/course-1/endless.pdf`);
  const storage = await fakeStorage();
  const app = await serveDownloads(t, storage.origin);
  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: app.port, path: `/files/${FILE_ID}` }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => undefined);
      req.once('error', reject);
      req.end();
    });
    for (let i = 0; i < 50 && storage.closedEarly.length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(storage.closedEarly, ['endless.pdf']);
  } finally {
    await app.close();
    await storage.close();
  }
});
