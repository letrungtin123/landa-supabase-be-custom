import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import {
  TENANT_DATA_LIMIT_REACHED_CODE,
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_LIMIT_REACHED_SQLSTATE,
  TENANT_DATA_QUOTA_RECONCILING_CODE,
  TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_SQLSTATE,
} from '../modules/tenants/tenant-data-quota.constants.js';
import { AppError, errorHandler } from './error-handler.js';

// Characterization of the global error handler: for every kind of error, the
// status and the JSON body the client receives. `legacy` is the body as it
// was before error bodies got a mandatory code; `added` is the code the body
// now carries on top of it, for a body that had none. Nothing else changed.

type Body = Record<string, unknown>;

interface Case {
  name: string;
  error: () => unknown;
  status: number;
  legacy: (error: unknown) => Body;
  /** The code a body without one now gets (from its status). */
  added?: string;
}

class DomainRefusal extends AppError {
  constructor() {
    super('Bạn không có quyền đổi vai trò của chính mình', 403, 'DOMAIN_SELF_ROLE_CHANGE');
    this.name = 'DomainRefusal';
  }
}

function errorOf(message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), fields);
}

const stackOf = (error: unknown) => (error as { stack?: string }).stack;

/** Cases whose answer is the same in production and elsewhere. */
const EXPECTED_CASES: Case[] = [
  {
    name: 'AppError with its own code',
    error: () => new AppError('Bot không tồn tại', 404, 'BOT_NOT_FOUND'),
    status: 404,
    legacy: () => ({ success: false, message: 'Bot không tồn tại', code: 'BOT_NOT_FOUND' }),
  },
  {
    name: 'AppError subclass with its own code',
    error: () => new DomainRefusal(),
    status: 403,
    legacy: () => ({
      success: false,
      message: 'Bạn không có quyền đổi vai trò của chính mình',
      code: 'DOMAIN_SELF_ROLE_CHANGE',
    }),
  },
  {
    name: 'AppError without a code, default status 400',
    error: () => new AppError('Dữ liệu không hợp lệ'),
    status: 400,
    legacy: () => ({ success: false, message: 'Dữ liệu không hợp lệ' }),
    added: 'BAD_REQUEST',
  },
  {
    name: 'AppError without a code, 401',
    error: () => new AppError('Chưa xác thực', 401),
    status: 401,
    legacy: () => ({ success: false, message: 'Chưa xác thực' }),
    added: 'UNAUTHORIZED',
  },
  {
    name: 'AppError without a code, 403',
    error: () => new AppError('Không có quyền truy cập', 403),
    status: 403,
    legacy: () => ({ success: false, message: 'Không có quyền truy cập' }),
    added: 'FORBIDDEN',
  },
  {
    name: 'AppError without a code, 404',
    error: () => new AppError('Khóa học không tồn tại', 404),
    status: 404,
    legacy: () => ({ success: false, message: 'Khóa học không tồn tại' }),
    added: 'NOT_FOUND',
  },
  {
    name: 'AppError without a code, 409',
    error: () => new AppError('Email đã tồn tại', 409),
    status: 409,
    legacy: () => ({ success: false, message: 'Email đã tồn tại' }),
    added: 'CONFLICT',
  },
  {
    name: 'AppError without a code, 422',
    error: () => new AppError('Không xử lý được nội dung', 422),
    status: 422,
    legacy: () => ({ success: false, message: 'Không xử lý được nội dung' }),
    added: 'UNPROCESSABLE_ENTITY',
  },
  {
    name: 'AppError without a code, 429',
    error: () => new AppError('Quá nhiều yêu cầu', 429),
    status: 429,
    legacy: () => ({ success: false, message: 'Quá nhiều yêu cầu' }),
    added: 'TOO_MANY_REQUESTS',
  },
  {
    name: 'AppError without a code, 500',
    error: () => new AppError('Không tạo được tệp', 500),
    status: 500,
    legacy: () => ({ success: false, message: 'Không tạo được tệp' }),
    added: 'INTERNAL_ERROR',
  },
  {
    name: 'AppError without a code, 503',
    error: () => new AppError('Dịch vụ tạm thời không sẵn sàng', 503),
    status: 503,
    legacy: () => ({ success: false, message: 'Dịch vụ tạm thời không sẵn sàng' }),
    added: 'SERVICE_UNAVAILABLE',
  },
  {
    name: 'AppError without a code, 504',
    error: () => new AppError('Hết thời gian chờ', 504),
    status: 504,
    legacy: () => ({ success: false, message: 'Hết thời gian chờ' }),
    added: 'GATEWAY_TIMEOUT',
  },
  {
    name: 'AppError with an empty code',
    error: () => new AppError('Không tìm thấy', 404, ''),
    status: 404,
    legacy: () => ({ success: false, message: 'Không tìm thấy' }),
    added: 'NOT_FOUND',
  },
  {
    name: 'quota trigger: data limit reached',
    error: () => errorOf('raw trigger text', { code: TENANT_DATA_LIMIT_REACHED_SQLSTATE }),
    status: 409,
    legacy: () => ({
      success: false,
      code: TENANT_DATA_LIMIT_REACHED_CODE,
      message: TENANT_DATA_LIMIT_REACHED_MESSAGE,
    }),
  },
  {
    name: 'quota trigger: reconciling',
    error: () => errorOf('raw trigger text', { code: TENANT_DATA_QUOTA_RECONCILING_SQLSTATE }),
    status: 503,
    legacy: () => ({
      success: false,
      code: TENANT_DATA_QUOTA_RECONCILING_CODE,
      message: TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
    }),
  },
];

/** Unexpected errors outside production: the raw message and the stack. */
const UNEXPECTED_CASES: Case[] = [
  {
    name: 'plain Error',
    error: () => new Error('boom'),
    status: 500,
    legacy: error => ({ success: false, message: 'boom', stack: stackOf(error) }),
    added: 'INTERNAL_ERROR',
  },
  {
    name: 'database error with a SQLSTATE',
    error: () => errorOf('duplicate key value violates unique constraint', { code: '23505' }),
    status: 500,
    legacy: error => ({
      success: false,
      message: 'duplicate key value violates unique constraint',
      stack: stackOf(error),
    }),
    added: 'INTERNAL_ERROR',
  },
  {
    name: 'thrown plain object',
    error: () => ({ status: 400, message: 'Khoảng ngày không hợp lệ' }),
    status: 500,
    legacy: () => ({ success: false, message: 'Khoảng ngày không hợp lệ' }),
    added: 'INTERNAL_ERROR',
  },
  {
    name: 'thrown string',
    error: () => 'boom',
    status: 500,
    legacy: () => ({ success: false }),
    added: 'INTERNAL_ERROR',
  },
];

const PRODUCTION_MESSAGE = 'Lỗi hệ thống, vui lòng thử lại sau';

function respond(error: unknown, request: Record<string, unknown> = {}): { status?: number; body?: Body } {
  const out: { status?: number; body?: Body } = {};
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: unknown) {
      // What the client receives: undefined fields are not sent.
      out.body = JSON.parse(JSON.stringify(body)) as Body;
      return this;
    },
  } as unknown as Response;
  const req = { get: () => undefined, ...request } as unknown as Request;
  errorHandler(error as Error, req, res, (() => undefined) as NextFunction);
  return out;
}

function inProduction<T>(run: () => T): T {
  const mutableEnv = env as unknown as { NODE_ENV: string };
  const previous = mutableEnv.NODE_ENV;
  mutableEnv.NODE_ENV = 'production';
  try {
    return run();
  } finally {
    mutableEnv.NODE_ENV = previous;
  }
}

function quietConsole(t: TestContext): unknown[][] {
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logged.push(args);
  });
  return logged;
}

function expected(item: Case, error: unknown): Body {
  const legacy = item.legacy(error);
  if (typeof legacy.code === 'string') {
    assert.equal(item.added, undefined, 'a body that had a code keeps it');
    return legacy;
  }
  assert.ok(item.added, 'a body without a code gets one');
  return { ...legacy, code: item.added };
}

for (const item of EXPECTED_CASES) {
  test(`error handler: ${item.name}`, t => {
    const logged = quietConsole(t);
    for (const run of [(fn: () => unknown) => fn(), inProduction]) {
      const error = item.error();
      const out = run(() => respond(error)) as ReturnType<typeof respond>;
      assert.equal(out.status, item.status);
      assert.deepEqual(out.body, expected(item, error));
    }
    assert.equal(logged.length, 0, 'an expected error is not logged as unexpected');
  });
}

for (const item of UNEXPECTED_CASES) {
  test(`error handler, outside production: ${item.name}`, t => {
    const logged = quietConsole(t);
    const error = item.error();
    const out = respond(error);
    assert.equal(out.status, item.status);
    assert.deepEqual(out.body, expected(item, error));
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], '[ERROR]');
  });

  test(`error handler, production: ${item.name}`, t => {
    const logged = quietConsole(t);
    const error = item.error();
    const out = inProduction(() => respond(error));
    assert.equal(out.status, 500);
    assert.deepEqual(
      out.body,
      expected({ ...item, legacy: () => ({ success: false, message: PRODUCTION_MESSAGE }) }, error),
    );
    assert.doesNotMatch(JSON.stringify(out.body), /boom|duplicate|23505|JSON|stack|Khoảng/);
    assert.equal(logged.length, 1);
  });
}

// Request bodies the JSON parser refuses. Deliberately changed (security
// review of wave 1): a malformed body, an unsupported encoding or charset and
// a cut-off body used to be an unexpected 500 whose log line (and, outside
// production, whose answer) carried the parse message, which quotes the body.
// Now each is a 4xx with its own code and a fixed message, logged by type,
// status, method and path only. Too large was already a 413 and keeps its body.
const SECRET = 'FAKE-SECRET-91b2';

const REQUEST_BODY_CASES: Array<{
  type: string;
  status: number;
  body: Body;
  before: { status: number; body: 'unexpected 500' | Body };
}> = [
  {
    type: 'entity.parse.failed',
    status: 400,
    body: {
      success: false,
      message: 'Dữ liệu gửi lên không đúng định dạng. Vui lòng kiểm tra lại và thử lại.',
      code: 'INVALID_JSON',
    },
    before: { status: 500, body: 'unexpected 500' },
  },
  {
    type: 'entity.too.large',
    status: 413,
    body: {
      success: false,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Dữ liệu gửi lên quá lớn. Vui lòng gửi ít nội dung hơn.',
    },
    before: {
      status: 413,
      body: {
        success: false,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Dữ liệu gửi lên quá lớn. Vui lòng gửi ít nội dung hơn.',
      },
    },
  },
  {
    type: 'encoding.unsupported',
    status: 415,
    body: {
      success: false,
      message: 'Dữ liệu gửi lên có định dạng chưa được hỗ trợ. Vui lòng thử lại.',
      code: 'UNSUPPORTED_ENCODING',
    },
    before: { status: 500, body: 'unexpected 500' },
  },
  {
    type: 'charset.unsupported',
    status: 415,
    body: {
      success: false,
      message: 'Dữ liệu gửi lên có định dạng chưa được hỗ trợ. Vui lòng thử lại.',
      code: 'UNSUPPORTED_ENCODING',
    },
    before: { status: 500, body: 'unexpected 500' },
  },
  {
    type: 'request.aborted',
    status: 400,
    body: {
      success: false,
      message: 'Yêu cầu bị gián đoạn trước khi gửi xong. Vui lòng thử lại.',
      code: 'REQUEST_ABORTED',
    },
    before: { status: 500, body: 'unexpected 500' },
  },
];

for (const item of REQUEST_BODY_CASES) {
  test(`error handler: request body refused (${item.type})`, t => {
    const errors = quietConsole(t);
    const warnings: unknown[][] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => {
      warnings.push(args);
    });
    const req = { method: 'POST', originalUrl: `/api/auth/login?token=${SECRET}`, get: () => undefined };
    for (const run of [(fn: () => unknown) => fn(), inProduction]) {
      // What body-parser throws: the message and `body` quote the request body.
      const error = errorOf(`Unexpected token 'F', ..."password":${SECRET}"... is not valid JSON`, {
        type: item.type,
        status: item.status,
        statusCode: item.status,
        expose: true,
        body: `{"password":${SECRET}}`,
      });
      const out = run(() => respond(error, req)) as ReturnType<typeof respond>;
      assert.equal(out.status, item.status);
      assert.deepEqual(out.body, item.body);
      if (item.before.body !== 'unexpected 500') assert.deepEqual(out.body, item.before.body);
    }
    assert.equal(errors.length, 0, 'not logged as an unexpected error');
    assert.equal(warnings.length, 2);
    for (const [line] of warnings) {
      assert.equal(typeof line, 'string');
      assert.doesNotMatch(String(line), /FAKE-SECRET|password|Unexpected|valid JSON/);
      assert.deepEqual(JSON.parse(String(line).replace(/^\[RequestBody\] /, '')), {
        event: 'request_body_refused',
        type: item.type,
        status: item.status,
        method: 'POST',
        path: '/api/auth/login',
      });
    }
  });
}

test('error handler: an error type the body parser does not set is still an unexpected 500', t => {
  const logged = quietConsole(t);
  for (const type of ['constructor', 'toString', 'stream.encoding.set', 'entity.verify.failed']) {
    const out = inProduction(() => respond(errorOf('x', { type })));
    assert.equal(out.status, 500, type);
    assert.deepEqual(out.body, { success: false, message: PRODUCTION_MESSAGE, code: 'INTERNAL_ERROR' });
  }
  assert.equal(logged.length, 4);
});
