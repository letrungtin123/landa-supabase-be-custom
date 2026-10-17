import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

// H5: learner submissions are written to a temp file and streamed to Storage
// (never kept whole in the heap); the temp files are removed when the
// request ends. Storage is replaced by recording uploaders; no network.
const { ASSIGNMENT_SUBMISSION_TEMP_DIR, submissionUpload } = await import('./assignments.routes.js');
const { removeTempUploads } = await import('./assignments.controller.js');
const { storeAssignmentFile } = await import('./assignments.service.js');

function recordingUploaders() {
  const calls: string[] = [];
  return {
    calls,
    uploaders: {
      fromPath: async (storagePath: string, filePath: string) => { calls.push(`path:${storagePath}:${path.basename(filePath)}`); },
      fromBuffer: async (storagePath: string, buffer: Buffer) => { calls.push(`buffer:${storagePath}:${buffer.length}`); },
    },
  };
}

test('a file on disk is streamed from its path; a file in memory or an empty file uses the buffer upload', async () => {
  const { calls, uploaders } = recordingUploaders();
  await storeAssignmentFile('t/a.pdf', { path: '/tmp/x.upload', size: 10, mimetype: 'application/pdf' } as never, uploaders);
  await storeAssignmentFile('t/b.pdf', { buffer: Buffer.from('abc'), size: 3, mimetype: 'application/pdf' } as never, uploaders);
  await storeAssignmentFile('t/c.txt', { path: '/tmp/empty.upload', size: 0, mimetype: 'text/plain' } as never, uploaders);
  assert.deepEqual(calls, ['path:t/a.pdf:x.upload', 'buffer:t/b.pdf:3', 'buffer:t/c.txt:0']);
});

async function serve(handler: express.RequestHandler): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.post('/submit', submissionUpload.array('files', 5), handler);
  app.use((error: Error & { code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ code: error.code ?? 'ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/submit`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('submitted files land in the temp dir, not in memory, and are removed when the request ends', async () => {
  let seen: Express.Multer.File[] = [];
  let contents: string[] = [];
  const server = await serve(async (req, res) => {
    seen = req.files as Express.Multer.File[];
    contents = seen.map((item) => readFileSync(item.path, 'utf8'));
    try {
      res.json({ ok: true });
    } finally {
      await removeTempUploads(seen);
    }
  });
  try {
    const form = new FormData();
    form.append('files', new Blob(['first essay']), 'essay.docx');
    form.append('files', new Blob(['second file']), 'notes.pdf');
    const response = await fetch(server.url, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 2);
    for (const item of seen) {
      assert.equal(path.dirname(item.path), ASSIGNMENT_SUBMISSION_TEMP_DIR);
      assert.equal(item.buffer, undefined, 'no copy of the file in the heap');
      assert.equal(existsSync(item.path), false, 'the temp file is gone after the request');
    }
    assert.deepEqual(contents, ['first essay', 'second file']);
  } finally {
    await server.close();
  }
});

test('a file over 25 MB is refused and leaves no temp file behind', async () => {
  const before = existsSync(ASSIGNMENT_SUBMISSION_TEMP_DIR) ? readdirSync(ASSIGNMENT_SUBMISSION_TEMP_DIR).length : 0;
  const server = await serve((_req, res) => { res.json({ ok: true }); });
  try {
    const form = new FormData();
    form.append('files', new Blob([Buffer.alloc(25 * 1024 * 1024 + 1)]), 'too-big.mp4');
    const response = await fetch(server.url, { method: 'POST', body: form });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, 'LIMIT_FILE_SIZE');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(readdirSync(ASSIGNMENT_SUBMISSION_TEMP_DIR).length, before);
  } finally {
    await server.close();
  }
});
