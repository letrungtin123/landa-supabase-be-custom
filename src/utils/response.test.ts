import assert from 'node:assert/strict';
import test from 'node:test';
import type { Response } from 'express';
import { sendError, sendSuccess } from './response.js';

// Characterization of sendError/sendSuccess: the status and the JSON body the
// client receives. `legacy` is the error body as it was before error bodies
// got a mandatory code; the body now is `legacy` plus `code`, nothing else.

type Body = Record<string, unknown>;

function capture(): { res: Response; out: { status?: number; body?: Body } } {
  const out: { status?: number; body?: Body } = {};
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: unknown) {
      out.body = JSON.parse(JSON.stringify(body)) as Body;
      return this;
    },
  } as unknown as Response;
  return { res, out };
}

const ERROR_CASES: Array<{ name: string; send: (res: Response) => void; status: number; legacy: Body; code: string }> =
  [
    {
      name: 'default status 400',
      send: res => sendError(res, 'Dữ liệu không hợp lệ'),
      status: 400,
      legacy: { success: false, message: 'Dữ liệu không hợp lệ' },
      code: 'BAD_REQUEST',
    },
    {
      name: '401',
      send: res => sendError(res, 'Token không được cung cấp', 401),
      status: 401,
      legacy: { success: false, message: 'Token không được cung cấp' },
      code: 'UNAUTHORIZED',
    },
    {
      name: '403',
      send: res => sendError(res, 'Không có quyền truy cập', 403),
      status: 403,
      legacy: { success: false, message: 'Không có quyền truy cập' },
      code: 'FORBIDDEN',
    },
    {
      name: '404',
      send: res => sendError(res, 'Tenant không tồn tại', 404),
      status: 404,
      legacy: { success: false, message: 'Tenant không tồn tại' },
      code: 'NOT_FOUND',
    },
    {
      name: '413',
      send: res => sendError(res, 'File quá lớn', 413),
      status: 413,
      legacy: { success: false, message: 'File quá lớn' },
      code: 'PAYLOAD_TOO_LARGE',
    },
    {
      name: '500',
      send: res => sendError(res, 'Lỗi kiểm tra quyền', 500),
      status: 500,
      legacy: { success: false, message: 'Lỗi kiểm tra quyền' },
      code: 'INTERNAL_ERROR',
    },
    {
      name: 'with an error code (4th argument)',
      send: res => sendError(res, 'Tính năng chưa được bật cho doanh nghiệp này', 403, 'MODULE_DISABLED'),
      status: 403,
      legacy: { success: false, message: 'Tính năng chưa được bật cho doanh nghiệp này', error: 'MODULE_DISABLED' },
      code: 'MODULE_DISABLED',
    },
    {
      name: 'with an empty error code',
      send: res => sendError(res, 'Chưa xác thực', 401, ''),
      status: 401,
      legacy: { success: false, message: 'Chưa xác thực' },
      code: 'UNAUTHORIZED',
    },
  ];

for (const item of ERROR_CASES) {
  test(`sendError: ${item.name}`, () => {
    const { res, out } = capture();
    item.send(res);
    assert.equal(out.status, item.status);
    assert.deepEqual(out.body, { ...item.legacy, code: item.code });
  });
}

test('sendSuccess is unchanged', () => {
  const { res, out } = capture();
  sendSuccess(res, { id: 1 }, 'Đã lưu', 201);
  assert.deepEqual(out, { status: 201, body: { success: true, data: { id: 1 }, message: 'Đã lưu' } });
  const plain = capture();
  sendSuccess(plain.res, null);
  assert.deepEqual(plain.out, { status: 200, body: { success: true, data: null } });
});
