import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import multer from 'multer';

// What the upload routes rely on from multer (>= 2.3.0): the MulterError codes
// their error mapping reads (library, course assets, lesson-author video, bot
// avatar, KB), the size-limit boundary, temp-file cleanup when a request fails,
// and how field names and file names arrive. No network, no database.

const { createKbTempUpload, withKbTempUploadCleanup } = await import('../modules/ai-chatbot/kb/kb-upload-storage.js');
const { fixMulterFilename } = await import('../config/storage.js');

interface Outcome {
  status: number;
  body: Record<string, unknown>;
}

async function serve(middleware: express.RequestHandler, handler?: express.RequestHandler) {
  const app = express();
  app.post('/upload', middleware, handler ?? ((req, res) => {
    const files = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];
    res.json({ files: files.map((file) => ({ field: file.fieldname, name: file.originalname, size: file.size })), fields: req.body });
  }));
  app.use((error: Error & { code?: string; field?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ multer: error instanceof multer.MulterError, code: error.code ?? null, field: error.field ?? null });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    post: async (form: FormData): Promise<Outcome> => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`, { method: 'POST', body: form });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function formWith(...files: Array<[field: string, bytes: number, name?: string]>): FormData {
  const form = new FormData();
  for (const [field, bytes, name] of files) form.append(field, new Blob([new Uint8Array(bytes)]), name ?? `${field}.bin`);
  return form;
}

/** Disk storage like the upload routes' (random name in a temp dir), in a directory of its own. */
function diskUpload(limits: multer.Options['limits'] = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'landa-multipart-test-'));
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, directory),
      filename: (_req, _file, cb) => cb(null, `${Date.now()}-${randomUUID()}.upload`),
    }),
    limits,
  });
  return { upload, directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('the size limit is inclusive: a file of exactly the limit is accepted, one byte more is LIMIT_FILE_SIZE', async () => {
  // multer < 2.2 refused a file of exactly `fileSize` bytes (busboy reports the
  // limit when it is reached); the bot avatar used to work around it with limit + 1.
  const limit = 64 * 1024;
  const upload = createKbTempUpload({ fileSize: limit });
  const seen: string[] = [];
  const handleWithCleanup = withKbTempUploadCleanup(async (req, res) => {
    seen.push(req.file!.path);
    res.json({ size: req.file!.size });
  });
  const server = await serve(upload.single('file'), (req, res, next) => {
    handleWithCleanup(req, res).catch(next);
  });
  try {
    assert.deepEqual(await server.post(formWith(['file', limit - 1])), { status: 200, body: { size: limit - 1 } });
    assert.deepEqual(await server.post(formWith(['file', limit])), { status: 200, body: { size: limit } });
    assert.deepEqual(await server.post(formWith(['file', limit + 1])), {
      status: 400, body: { multer: true, code: 'LIMIT_FILE_SIZE', field: 'file' },
    });
    assert.equal(seen.length, 2);
    for (const file of seen) assert.equal(existsSync(file), false, 'the KB temp file is removed when the request ends');
  } finally {
    await server.close();
  }
});

test('a limit that is not a whole number is refused when the upload is created (multer >= 2.4)', () => {
  // busboy silently ignored such a limit. Every route limit is a whole number
  // of bytes or files (LESSON_AUTHOR_VIDEO_MAX_UPLOAD_MB is a bounded integer).
  assert.throws(() => multer({ limits: { fileSize: 1024.5 } }), TypeError);
  assert.throws(() => multer({ limits: { files: -1 } }), TypeError);
  assert.doesNotThrow(() => multer({ limits: { fileSize: 300 * 1024 * 1024, files: 20 } }));
});

test('the count and field errors the upload routes map keep their MulterError codes', async () => {
  const upload = createKbTempUpload({ fileSize: 1024, files: 2 });
  const tooMany = await serve(upload.array('files', 5));
  const overMaxCount = await serve(upload.array('files', 1));
  const wrongField = await serve(upload.single('file'));
  try {
    assert.deepEqual(await tooMany.post(formWith(['files', 1], ['files', 1], ['files', 1])), {
      status: 400, body: { multer: true, code: 'LIMIT_FILE_COUNT', field: null },
    });
    assert.deepEqual(await overMaxCount.post(formWith(['files', 1], ['files', 1])), {
      status: 400, body: { multer: true, code: 'LIMIT_UNEXPECTED_FILE', field: 'files' },
    });
    assert.deepEqual(await wrongField.post(formWith(['other', 1])), {
      status: 400, body: { multer: true, code: 'LIMIT_UNEXPECTED_FILE', field: 'other' },
    });
  } finally {
    await Promise.all([tooMany.close(), overMaxCount.close(), wrongField.close()]);
  }
});

test('a file over the limit after an accepted one leaves no temp file behind', async () => {
  const { upload, directory, remove } = diskUpload({ fileSize: 64 * 1024 });
  const server = await serve(upload.array('files', 5));
  try {
    assert.deepEqual(await server.post(formWith(['files', 1_000], ['files', 200 * 1024])), {
      status: 400, body: { multer: true, code: 'LIMIT_FILE_SIZE', field: 'files' },
    });
    await waitFor(() => readdirSync(directory).length === 0);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    await server.close();
    remove();
  }
});

test('an upload the client aborts reaches the error callback as an abort and its partial file is removed', async () => {
  const { upload, directory, remove } = diskUpload();
  let settle: (value: { message: string | null; destroyed: boolean }) => void = () => {};
  const failed = new Promise<{ message: string | null; destroyed: boolean }>((resolve) => { settle = resolve; });
  const server = await serve((req, res, next) => {
    upload.single('file')(req, res, (error?: unknown) => {
      // The fields the routes' isClientUploadAbort() checks.
      settle({ message: error instanceof Error ? error.message : null, destroyed: req.destroyed });
      if (!error) next();
    });
  });
  try {
    const boundary = '----landa-abort-test';
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n`;
    const request = http.request({
      host: '127.0.0.1', port: server.port, path: '/upload', method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(head.length + 50_000_000) },
    });
    request.on('error', () => {});
    request.write(head);
    request.write(Buffer.alloc(256 * 1024));
    await waitFor(() => readdirSync(directory).length > 0);
    assert.equal(readdirSync(directory).length, 1, 'the partial file was being written');
    request.destroy();

    assert.deepEqual(await failed, { message: 'Request aborted', destroyed: true });
    await waitFor(() => readdirSync(directory).length === 0);
    assert.deepEqual(readdirSync(directory), [], 'multer removes the partial file of an aborted upload');
  } finally {
    await server.close();
    remove();
  }
});

test('a field name the body cannot hold is a MulterError, not a RangeError from the parser', async () => {
  const server = await serve(createKbTempUpload().none());
  try {
    const form = new FormData();
    form.append('a[4294967294]', 'x');
    form.append('a[]', 'y');
    assert.deepEqual(await server.post(form), { status: 400, body: { multer: true, code: 'INVALID_FIELD_NAME', field: 'a[]' } });

    const ordinary = new FormData();
    ordinary.append('title', 'Tài liệu');
    ordinary.append('tags[]', 'a');
    ordinary.append('tags[]', 'b');
    ordinary.append('meta[lang]', 'vi');
    assert.deepEqual(await server.post(ordinary), {
      status: 200, body: { files: [], fields: { title: 'Tài liệu', tags: ['a', 'b'], meta: { lang: 'vi' } } },
    });
  } finally {
    await server.close();
  }
});

test('file names: the quote a browser sends as %22 arrives as a quote; fixMulterFilename still restores UTF-8', async () => {
  const server = await serve(multer({ storage: multer.memoryStorage() }).single('file'));
  try {
    const outcome = await server.post(formWith(['file', 3, 'Báo cáo "Quý 3".pdf']));
    assert.equal(outcome.status, 200);
    const [file] = outcome.body.files as Array<{ name: string }>;
    assert.equal(fixMulterFilename(file.name), 'Báo cáo "Quý 3".pdf');
  } finally {
    await server.close();
  }
});
