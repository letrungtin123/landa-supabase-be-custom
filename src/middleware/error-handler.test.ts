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
// was before error bodies got a mandatory code.

type Body = Record<string, unknown>;

interface Case {
  name: string;
  error: () => unknown;
  status: number;
  legacy: (error: unknown) => Body;
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
  },
  {
    name: 'AppError without a code, 401',
    error: () => new AppError('Chưa xác thực', 401),
    status: 401,
    legacy: () => ({ success: false, message: 'Chưa xác thực' }),
  },
  {
    name: 'AppError without a code, 403',
    error: () => new AppError('Không có quyền truy cập', 403),
    status: 403,
    legacy: () => ({ success: false, message: 'Không có quyền truy cập' }),
  },
  {
    name: 'AppError without a code, 404',
    error: () => new AppError('Khóa học không tồn tại', 404),
    status: 404,
    legacy: () => ({ success: false, message: 'Khóa học không tồn tại' }),
  },
  {
    name: 'AppError without a code, 409',
    error: () => new AppError('Email đã tồn tại', 409),
    status: 409,
    legacy: () => ({ success: false, message: 'Email đã tồn tại' }),
  },
  {
    name: 'AppError without a code, 422',
    error: () => new AppError('Không xử lý được nội dung', 422),
    status: 422,
    legacy: () => ({ success: false, message: 'Không xử lý được nội dung' }),
  },
  {
    name: 'AppError without a code, 429',
    error: () => new AppError('Quá nhiều yêu cầu', 429),
    status: 429,
    legacy: () => ({ success: false, message: 'Quá nhiều yêu cầu' }),
  },
  {
    name: 'AppError without a code, 500',
    error: () => new AppError('Không tạo được tệp', 500),
    status: 500,
    legacy: () => ({ success: false, message: 'Không tạo được tệp' }),
  },
  {
    name: 'AppError without a code, 503',
    error: () => new AppError('Dịch vụ tạm thời không sẵn sàng', 503),
    status: 503,
    legacy: () => ({ success: false, message: 'Dịch vụ tạm thời không sẵn sàng' }),
  },
  {
    name: 'AppError without a code, 504',
    error: () => new AppError('Hết thời gian chờ', 504),
    status: 504,
    legacy: () => ({ success: false, message: 'Hết thời gian chờ' }),
  },
  {
    name: 'AppError with an empty code',
    error: () => new AppError('Không tìm thấy', 404, ''),
    status: 404,
    legacy: () => ({ success: false, message: 'Không tìm thấy' }),
  },
  {
    name: 'quota trigger: data limit reached',
    error: () => errorOf('raw trigger text', { code: TENANT_DATA_LIMIT_REACHED_SQLSTATE }),
    status: 409,
    legacy: () => ({ success: false, code: TENANT_DATA_LIMIT_REACHED_CODE, message: TENANT_DATA_LIMIT_REACHED_MESSAGE }),
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
  {
    name: 'JSON body over the route limit',
    error: () => errorOf('request entity too large', { type: 'entity.too.large', status: 413 }),
    status: 413,
    legacy: () => ({
      success: false,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Dữ liệu gửi lên quá lớn. Vui lòng gửi ít nội dung hơn.',
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
  },
  {
    name: 'database error with a SQLSTATE',
    error: () => errorOf('duplicate key value violates unique constraint', { code: '23505' }),
    status: 500,
    legacy: error => ({ success: false, message: 'duplicate key value violates unique constraint', stack: stackOf(error) }),
  },
  {
    name: 'malformed JSON body (body-parser 400, answered 500 as before)',
    error: () => errorOf('Unexpected token } in JSON', { type: 'entity.parse.failed', status: 400 }),
    status: 500,
    legacy: error => ({ success: false, message: 'Unexpected token } in JSON', stack: stackOf(error) }),
  },
  {
    name: 'thrown plain object',
    error: () => ({ status: 400, message: 'Khoảng ngày không hợp lệ' }),
    status: 500,
    legacy: () => ({ success: false, message: 'Khoảng ngày không hợp lệ' }),
  },
  {
    name: 'thrown string',
    error: () => 'boom',
    status: 500,
    legacy: () => ({ success: false }),
  },
];

const PRODUCTION_MESSAGE = 'Lỗi hệ thống, vui lòng thử lại sau';

function respond(error: unknown): { status?: number; body?: Body } {
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
  const req = { get: () => undefined } as unknown as Request;
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
  return item.legacy(error);
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
    assert.deepEqual(out.body, expected({ ...item, legacy: () => ({ success: false, message: PRODUCTION_MESSAGE }) }, error));
    assert.doesNotMatch(JSON.stringify(out.body), /boom|duplicate|23505|JSON|stack|Khoảng/);
    assert.equal(logged.length, 1);
  });
}
