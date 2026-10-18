import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError as MiddlewareAppError } from '../middleware/error-handler.js';
import { AppError, HTTP_STATUS_ERROR_CODES, errorBody, errorCodeForStatus, resolveErrorCode } from './errors.js';

const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

test('AppError keeps message, status (default 400) and code', () => {
  const plain = new AppError('Dữ liệu không hợp lệ');
  assert.equal(plain.message, 'Dữ liệu không hợp lệ');
  assert.equal(plain.statusCode, 400);
  assert.equal(plain.code, undefined);
  assert.equal(plain.name, 'AppError');
  assert.ok(plain instanceof Error);
  const coded = new AppError('Bot không tồn tại', 404, 'BOT_NOT_FOUND');
  assert.equal(coded.statusCode, 404);
  assert.equal(coded.code, 'BOT_NOT_FOUND');
});

test('the AppError of middleware/error-handler is the same class', () => {
  assert.equal(MiddlewareAppError, AppError);
  assert.ok(new MiddlewareAppError('x', 409) instanceof AppError);
});

test('status codes: each known status has its own UPPER_SNAKE code', () => {
  assert.equal(errorCodeForStatus(400), 'BAD_REQUEST');
  assert.equal(errorCodeForStatus(401), 'UNAUTHORIZED');
  assert.equal(errorCodeForStatus(403), 'FORBIDDEN');
  assert.equal(errorCodeForStatus(404), 'NOT_FOUND');
  assert.equal(errorCodeForStatus(409), 'CONFLICT');
  assert.equal(errorCodeForStatus(413), 'PAYLOAD_TOO_LARGE');
  assert.equal(errorCodeForStatus(422), 'UNPROCESSABLE_ENTITY');
  assert.equal(errorCodeForStatus(429), 'TOO_MANY_REQUESTS');
  assert.equal(errorCodeForStatus(500), 'INTERNAL_ERROR');
  assert.equal(errorCodeForStatus(502), 'BAD_GATEWAY');
  assert.equal(errorCodeForStatus(503), 'SERVICE_UNAVAILABLE');
  assert.equal(errorCodeForStatus(504), 'GATEWAY_TIMEOUT');
  for (const code of Object.values(HTTP_STATUS_ERROR_CODES)) assert.match(code, UPPER_SNAKE);
  assert.equal(new Set(Object.values(HTTP_STATUS_ERROR_CODES)).size, Object.keys(HTTP_STATUS_ERROR_CODES).length);
});

test('status codes: other 4xx are BAD_REQUEST, anything else INTERNAL_ERROR', () => {
  assert.equal(errorCodeForStatus(418), 'BAD_REQUEST');
  assert.equal(errorCodeForStatus(499), 'BAD_REQUEST');
  assert.equal(errorCodeForStatus(507), 'INTERNAL_ERROR');
  assert.equal(errorCodeForStatus(200), 'INTERNAL_ERROR');
  assert.equal(errorCodeForStatus(Number.NaN), 'INTERNAL_ERROR');
});

test('generic codes never collide with codes or prefixes the frontends branch on', () => {
  // A generic code equal to one of these would change what a frontend shows.
  const reserved = ['AUTH_REQUIRED', 'TENANT_NOT_FOUND', 'WORKSPACE_EXECUTION_DISABLED', 'REQUEST_FAILED'];
  const prefixes = ['USER_AUTHORITY_', 'SSO_LOGIN_', 'REPORT_', 'COURSE_PUBLISH_', 'AI_CREDIT_', 'WORKSPACE_'];
  for (const code of Object.values(HTTP_STATUS_ERROR_CODES)) {
    assert.equal(reserved.includes(code), false, code);
    for (const prefix of prefixes) assert.equal(code.startsWith(prefix), false, code);
  }
});

test('resolveErrorCode: an own code is kept exactly, an empty or missing one comes from the status', () => {
  assert.equal(resolveErrorCode(404, 'BOT_NOT_FOUND'), 'BOT_NOT_FOUND');
  assert.equal(resolveErrorCode(403, 'module_disabled'), 'module_disabled');
  assert.equal(resolveErrorCode(404, ''), 'NOT_FOUND');
  assert.equal(resolveErrorCode(404, '   '), 'NOT_FOUND');
  assert.equal(resolveErrorCode(404, undefined), 'NOT_FOUND');
  assert.equal(resolveErrorCode(404, null), 'NOT_FOUND');
  assert.equal(resolveErrorCode(500, 23505), 'INTERNAL_ERROR');
});

test('errorBody: success, message and code first; extra fields kept but never replace them', () => {
  assert.deepEqual(errorBody(400, 'Dữ liệu không hợp lệ'), {
    success: false,
    message: 'Dữ liệu không hợp lệ',
    code: 'BAD_REQUEST',
  });
  const body = errorBody(400, 'Sai tháng', 'AI_CREDIT_INVALID_INPUT', {
    field: 'month',
    success: true,
    message: 'other',
    code: 'OTHER',
  });
  assert.deepEqual(body, { success: false, message: 'Sai tháng', code: 'AI_CREDIT_INVALID_INPUT', field: 'month' });
  assert.deepEqual(Object.keys(body), ['success', 'message', 'code', 'field']);
});
