import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

// H5: Knowledge Base uploads (20 x 50 MB per request) arrive as temp files,
// not in the heap, and are removed when the request ends; the text kept for
// .txt/.md/.csv sources is read from the temp file with exactly the result
// of the former in-memory extraction. No network, no database.

const { KB_UPLOAD_TEMP_DIR, createKbTempUpload, withKbTempUploadCleanup } = await import('./kb-upload-storage.js');
const { extractLocalSourceContent, extractLocalSourceContentFromFile, MAX_STORED_SOURCE_CONTENT_CHARS } = await import('./kb-local-source-content.js');

async function serve(handler: (req: express.Request, res: express.Response) => Promise<void>, single = false) {
  const app = express();
  const upload = createKbTempUpload();
  app.post('/upload', single ? upload.single('file') : upload.array('files', 20), withKbTempUploadCleanup(handler));
  app.use((error: Error & { code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ code: error.code ?? error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('KB files land in the temp dir, not in memory, and are removed when the request ends', async () => {
  let seen: Express.Multer.File[] = [];
  let contents: string[] = [];
  const server = await serve(async (req, res) => {
    seen = req.files as Express.Multer.File[];
    contents = seen.map((item) => readFileSync(item.path, 'utf8'));
    res.json({ ok: true });
  });
  try {
    const form = new FormData();
    form.append('files', new Blob(['policy text']), 'policy.txt');
    form.append('files', new Blob(['%PDF-1.4']), 'guide.pdf');
    const response = await fetch(server.url, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 2);
    for (const item of seen) {
      assert.equal(path.dirname(item.path), KB_UPLOAD_TEMP_DIR);
      assert.equal(item.buffer, undefined, 'no copy of the file in the heap');
      assert.equal(existsSync(item.path), false, 'the temp file is gone after the request');
    }
    assert.deepEqual(contents, ['policy text', '%PDF-1.4']);
  } finally {
    await server.close();
  }
});

test('the FAQ temp file is removed even when the handler fails', async () => {
  let seenPath = '';
  const server = await serve(async (req) => {
    seenPath = req.file!.path;
    throw new Error('HANDLER_FAILED');
  }, true);
  try {
    const form = new FormData();
    form.append('file', new Blob(['xlsx bytes']), 'faq.xlsx');
    const response = await fetch(server.url, { method: 'POST', body: form });
    assert.equal(response.status, 400);
    assert.ok(seenPath);
    assert.equal(existsSync(seenPath), false);
  } finally {
    await server.close();
  }
});

test('a file over 50 MB is refused as before and leaves no temp file behind', async () => {
  const before = existsSync(KB_UPLOAD_TEMP_DIR) ? readdirSync(KB_UPLOAD_TEMP_DIR).length : 0;
  const server = await serve(async (_req, res) => { res.json({ ok: true }); });
  try {
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(50 * 1024 * 1024 + 1)]), 'big.pdf');
    const response = await fetch(server.url, { method: 'POST', body: form });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: 'LIMIT_FILE_SIZE' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(readdirSync(KB_UPLOAD_TEMP_DIR).length, before);
  } finally {
    await server.close();
  }
});

// ── Local source content: the file version equals the buffer version ──

const dir = mkdtempSync(path.join(os.tmpdir(), 'landa-kb-content-test-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let fileIndex = 0;

async function bothWays(ext: string, bytes: Buffer, chunkBytes?: number) {
  const file = path.join(dir, `source-${fileIndex += 1}${ext}`);
  writeFileSync(file, bytes);
  return {
    expected: extractLocalSourceContent(ext, bytes),
    actual: await extractLocalSourceContentFromFile(ext, file, MAX_STORED_SOURCE_CONTENT_CHARS, chunkBytes),
  };
}

test('kept text from a temp file equals the in-memory extraction (edge cases)', async () => {
  const limit = MAX_STORED_SOURCE_CONTENT_CHARS;
  const cases: Array<[string, Buffer]> = [
    ['.txt', Buffer.from('  hello world \n')],
    ['.md', Buffer.from('﻿# Title\n\nBody with tiếng Việt và emoji 😀\n')],
    ['.csv', Buffer.from('a,b\n1,2\n\u0000\u0000\n')],
    ['.txt', Buffer.alloc(0)],
    ['.txt', Buffer.from(' \n\t \u0000 \r\n')],
    ['.pdf', Buffer.from('not kept for this type')],
    ['.txt', Buffer.from(`${' '.repeat(70_000)}${'x'.repeat(limit + 10)}`)],
    ['.txt', Buffer.from(`${'y'.repeat(limit - 1)}${' '.repeat(5_000)}z`)],
    ['.txt', Buffer.from(`${'y'.repeat(limit - 1)}${' '.repeat(5_000)}`)],
    ['.txt', Buffer.from(`${'ế'.repeat(limit + 3)}`)],
    ['.txt', Buffer.from(`${'😀'.repeat(limit)}`)],
    ['.txt', Buffer.from([0xe1, 0xba, 0xbf, 0xff, 0xc3, 0x28, 0xf0, 0x9f, 0x98, 0x80, 0xe2, 0x82])],
  ];
  for (const [ext, bytes] of cases) {
    for (const chunkBytes of [1, 3, 7, 64 * 1024]) {
      if (chunkBytes < 64 && bytes.length > 50_000) continue;
      const { expected, actual } = await bothWays(ext, bytes, chunkBytes);
      assert.equal(actual, expected, `${ext} ${bytes.length} bytes, chunk ${chunkBytes}`);
    }
  }
});

test('kept text from a temp file equals the in-memory extraction (random bytes and text)', async () => {
  let seed = 12345;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const alphabet = [' ', '\n', '\t', 'a', 'Z', 'đ', 'ệ', '😀', '\u0000', '﻿', ' '];
  for (let round = 0; round < 60; round += 1) {
    let bytes: Buffer;
    if (round % 2 === 0) {
      bytes = Buffer.from(Array.from({ length: Math.floor(random() * 4_000) }, () => Math.floor(random() * 256)));
    } else {
      bytes = Buffer.from(Array.from({ length: Math.floor(random() * 3_000) }, () => alphabet[Math.floor(random() * alphabet.length)]).join(''));
    }
    const chunkBytes = 1 + Math.floor(random() * 40);
    const { expected, actual } = await bothWays('.txt', bytes, chunkBytes);
    assert.equal(actual, expected, `round ${round}`);
  }
});
