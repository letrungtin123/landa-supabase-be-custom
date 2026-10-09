import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { AppError } from '../middleware/error-handler.js';
import {
  TENANT_DATA_LIMIT_REACHED_CODE,
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_LIMIT_REACHED_SQLSTATE,
} from '../modules/tenants/tenant-data-quota.constants.js';
import { UNEXPECTED_ERROR, describeClientError, isIsoTimestamp, isUuid, sendClientError } from './client-error.js';

// S2 T9: only errors raised on purpose reach the browser; database, storage
// and provider text never does.

function capture(locale = 'vi') {
  const out: { status?: number; body?: { success: boolean; message: string; code?: string } } = {};
  const res = {
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body as typeof out.body; return this; },
  } as unknown as Response;
  const req = { get: (name: string) => (name === 'X-UI-Locale' ? locale : undefined) } as unknown as Request;
  return { req, res, out };
}

test('AppError keeps its message, status and code', () => {
  const { req, res, out } = capture();
  sendClientError(req, res, new AppError('Bot không tồn tại', 404, 'BOT_NOT_FOUND'), 'Test');
  assert.deepEqual(out, { status: 404, body: { success: false, message: 'Bot không tồn tại', code: 'BOT_NOT_FOUND' } });
});

test('database, storage and provider errors become one plain message in the request language', (t) => {
  t.mock.method(console, 'error', () => undefined);
  const pgError = Object.assign(new Error('invalid input syntax for type uuid: "x"'), { code: '22P02', severity: 'ERROR' });
  const storageError = new Error('[Storage] Upload failed (1111/avatars/a.png): Bucket not found');
  const providerError = Object.assign(new Error('PERMISSION_DENIED: key AIza…'), { status: 403 });
  for (const [error, locale] of [[pgError, 'vi'], [storageError, 'en'], [providerError, 'vi'], ['plain string', 'en']] as const) {
    const { req, res, out } = capture(locale);
    sendClientError(req, res, error, 'Test');
    assert.equal(out.status, 500);
    assert.equal(out.body?.message, locale === 'en' ? UNEXPECTED_ERROR[2] : UNEXPECTED_ERROR[1]);
    assert.equal(out.body?.code, 'REQUEST_FAILED');
    assert.doesNotMatch(JSON.stringify(out.body), /uuid|Storage|Bucket|AIza|PERMISSION/);
  }
});

test('tenant quota triggers keep their fixed answer', () => {
  const described = describeClientError(Object.assign(new Error('raw trigger text'), { code: TENANT_DATA_LIMIT_REACHED_SQLSTATE }), 'vi');
  assert.deepEqual(described, { status: 409, message: TENANT_DATA_LIMIT_REACHED_MESSAGE, code: TENANT_DATA_LIMIT_REACHED_CODE, known: true });
});

test('id and cursor validators', () => {
  assert.equal(isUuid('2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008'), true);
  assert.equal(isUuid('2a1f4063'), false);
  assert.equal(isUuid(['2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008']), false);
  assert.equal(isIsoTimestamp('2026-10-09T03:04:05.678Z'), true);
  assert.equal(isIsoTimestamp('2026-10-09T03:04:05+07:00'), true);
  assert.equal(isIsoTimestamp('2026-13-40T99:04:05Z'), false);
  assert.equal(isIsoTimestamp("2026-10-09'; DROP"), false);
  assert.equal(isIsoTimestamp('yesterday'), false);
});
