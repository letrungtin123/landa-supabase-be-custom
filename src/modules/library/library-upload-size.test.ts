import assert from 'node:assert/strict';
import test from 'node:test';
import { callHandler, installDb } from '../../test-support/staff-sql-characterization.js';

// A library file over the per-file upload limit is refused with a message that
// states the limit and the file's size. The refusal used to be a plain Error,
// which the upload answer turns into the generic "Chưa thể hoàn tất thao
// tác..." text, so the user never learned why. pg double; no database, no
// Redis, no Storage.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const { UNEXPECTED_ERROR } = await import('../../utils/client-error.js');
const { LIBRARY_DOCUMENT_MAX_UPLOAD_BYTES, LIBRARY_DOCUMENT_MAX_UPLOAD_LABEL } = await import('../../config/upload-limits.js');
const ctrl = await import('./library.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';

test('a file over the upload limit is refused with the limit, not the generic message', async t => {
  t.mock.method(console, 'error', () => undefined);
  const storage = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const statements = installDb(t, pool, {});
  const size = LIBRARY_DOCUMENT_MAX_UPLOAD_BYTES + 1024 * 1024;

  const outcome = (await callHandler(ctrl.uploadDocumentController, {
    user: { id: USER, tenantId: TENANT, role: 'staff', username: 'staff01', sessionMode: 'normal' },
    files: [{ originalname: 'big.pdf', mimetype: 'application/pdf', size }],
    body: {},
    query: {},
    params: {},
    originalUrl: '/api/library/documents/upload',
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  })) as { status: number; body: { data: { uploaded: number; failed: number; errors: string[] } } };

  assert.equal(outcome.status, 201);
  assert.equal(outcome.body.data.uploaded, 0);
  assert.equal(outcome.body.data.failed, 1);
  assert.deepEqual(outcome.body.data.errors, [
    `big.pdf: vượt quá giới hạn tải lên ${LIBRARY_DOCUMENT_MAX_UPLOAD_LABEL} mỗi tệp. Dung lượng tệp: 301.0MB.`,
  ]);
  assert.doesNotMatch(outcome.body.data.errors[0], new RegExp(UNEXPECTED_ERROR[1].slice(0, 20)));
  assert.equal(storage.mock.callCount(), 0, 'nothing was sent to Storage');
  assert.deepEqual(statements, [], 'nothing was read or written');
});

test('the refusal is a 413 with its own code', () => {
  const error = ctrl.libraryFileTooLargeError(LIBRARY_DOCUMENT_MAX_UPLOAD_BYTES + 1);
  assert.equal(error.statusCode, 413);
  assert.equal(error.code, ctrl.LIBRARY_FILE_TOO_LARGE_CODE);
  assert.match(error.message, new RegExp(LIBRARY_DOCUMENT_MAX_UPLOAD_LABEL));
});
