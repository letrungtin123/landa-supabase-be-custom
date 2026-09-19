import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../middleware/error-handler.js';
import { describeKbDocumentDeletionFailure } from './kb-document-deletion.logic.js';

test('preserves an expected KB deletion conflict as a stable UI response', () => {
  const result = describeKbDocumentDeletionFailure(
    new AppError('Tài liệu đang được huấn luyện.', 409, 'KB_DOCUMENT_LEARNING'),
  );

  assert.deepEqual(result, {
    statusCode: 409,
    code: 'KB_DOCUMENT_LEARNING',
    message: 'Tài liệu đang được huấn luyện.',
  });
});

test('does not expose a raw PostgreSQL error to the UI', () => {
  const result = describeKbDocumentDeletionFailure(
    Object.assign(new Error('violates foreign key constraint'), { code: '23503' }),
  );

  assert.equal(result.statusCode, 409);
  assert.equal(result.code, 'KB_DOCUMENT_DELETE_CONFLICT');
  assert.doesNotMatch(result.message, /foreign key/i);
});

test('maps an unknown deletion failure to a safe server response', () => {
  const result = describeKbDocumentDeletionFailure(new Error('internal database detail'));

  assert.equal(result.statusCode, 500);
  assert.equal(result.code, 'KB_DOCUMENT_DELETE_FAILED');
  assert.doesNotMatch(result.message, /database detail/i);
});
