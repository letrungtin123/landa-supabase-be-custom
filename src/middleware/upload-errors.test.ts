import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import express from 'express';
import multer from 'multer';
import { MULTIPART_FIELD_NAME_LIMITS } from './body-limits.js';
import { describeErrorResponse, errorHandler } from './error-handler.js';

// A multipart upload multer refuses (file too large, too many files, parts or
// fields, an unexpected file field, a field name nested too deep or with too
// large an array index) is a 413 or 400 with a stable code and a
// fixed message from the global handler, not a 500. About nine routes
// (assignments, badges, branding, mentor logo, help docs, news, prompt
// templates, user avatar, KB documents) hand multer's error to the global
// handler. Routes that answer it themselves keep their exact answers. The
// file content, field names and field values are never sent or logged.

const { BOT_AVATAR_MAX_BYTES, BOT_AVATAR_SIZE_MESSAGE, parseBotAvatarUpload } =
  await import('../modules/ai-chatbot/chat/bot-avatar-upload.js');
const { submissionUpload } = await import('../modules/assignments/assignments.routes.js');

const FAKE_SECRET = 'FAKE-SECRET-3b8e1d70-do-not-log';
const FAKE_FIELD = 'fieldFAKEMARK';
const LEAK = /FAKE-SEC|FAKEMARK/;
const BOT_ID = '0b9f6c7e-2f43-4d55-9a54-6f0c1d2e3a4b';

const BAD_REQUEST_CASES = {
  UPLOAD_TOO_MANY_FILES: 'Bạn đã chọn quá nhiều tệp. Vui lòng chọn ít tệp hơn và thử lại.',
  UPLOAD_UNEXPECTED_FILE:
    'Tệp gửi lên không đúng chỗ hoặc nhiều hơn số tệp cho phép. Vui lòng kiểm tra lại và thử lại.',
  UPLOAD_TOO_MANY_PARTS: 'Dữ liệu gửi lên có quá nhiều phần. Vui lòng gửi ít nội dung hơn.',
  UPLOAD_FIELD_NAME_TOO_LONG: 'Tên một mục gửi lên quá dài. Vui lòng tải lại trang và thử lại.',
  UPLOAD_FIELD_VALUE_TOO_LONG: 'Một mục gửi lên quá dài. Vui lòng gửi ít nội dung hơn.',
  UPLOAD_TOO_MANY_FIELDS: 'Dữ liệu gửi lên có quá nhiều mục. Vui lòng gửi ít nội dung hơn.',
  UPLOAD_FIELD_NAME_MISSING: 'Dữ liệu gửi lên thiếu tên mục. Vui lòng tải lại trang và thử lại.',
  UPLOAD_FIELD_NESTING_TOO_DEEP: 'Tên một mục gửi lên có quá nhiều cấp. Vui lòng tải lại trang và thử lại.',
  UPLOAD_FIELD_ARRAY_INDEX_TOO_LARGE: 'Tên một mục gửi lên có số thứ tự quá lớn. Vui lòng tải lại trang và thử lại.',
} as const;
const TOO_LARGE_BODY = {
  success: false,
  message: 'Tệp tải lên quá lớn. Vui lòng chọn tệp nhỏ hơn.',
  code: 'PAYLOAD_TOO_LARGE',
};

function badRequest(code: keyof typeof BAD_REQUEST_CASES) {
  return { success: false, message: BAD_REQUEST_CASES[code], code };
}

const memory = (limits: multer.Options['limits']) => multer({ storage: multer.memoryStorage(), limits });

async function serve(): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = express();
  const ok = (_req: express.Request, res: express.Response) => {
    res.json({ success: true });
  };
  app.post('/api/size', memory({ fileSize: 16 }).single('file'), ok);
  app.post('/api/files', memory({ files: 2 }).array('files', 5), ok);
  app.post('/api/unexpected', memory({}).single('file'), ok);
  app.post('/api/max-count', memory({}).array('files', 1), ok);
  app.post('/api/parts', memory({ parts: 3 }).single('file'), ok);
  app.post('/api/field-key', memory({ fieldNameSize: 8 }).single('file'), ok);
  app.post('/api/field-value', memory({ fieldSize: 8 }).single('file'), ok);
  app.post('/api/fields', memory({ fields: 2 }).single('file'), ok);
  app.post('/api/field-nesting', memory({ fields: 5, ...MULTIPART_FIELD_NAME_LIMITS }).single('file'), ok);
  app.post('/api/field-array-index', memory({ fields: 5, ...MULTIPART_FIELD_NAME_LIMITS }).single('file'), ok);
  // Real route parsers: the learner assignment submission, and the bot avatar
  // (which answers a file over its limit itself and hands the rest on).
  app.post('/api/assignments/learner/a1/submit', submissionUpload.array('files', 5), ok);
  app.post('/api/ai-chatbot/bots/:id/avatar', parseBotAvatarUpload, ok);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function captureConsole(t: TestContext): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const method of ['log', 'info', 'debug'] as const) t.mock.method(console, method, () => undefined);
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));
  return { warnings, errors };
}

function secretFile(bytes = 64, type = 'application/octet-stream'): Blob {
  return new Blob([Buffer.from(FAKE_SECRET.repeat(Math.ceil(bytes / FAKE_SECRET.length)).slice(0, bytes))], { type });
}

async function post(url: string, form: FormData): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { method: 'POST', body: form });
  return { status: response.status, text: await response.text() };
}

test('a refused upload is a 413 or 400 with a fixed message, and nothing of the upload is sent or logged', async t => {
  const { warnings, errors } = captureConsole(t);
  const server = await serve();
  const forms: Array<[string, () => FormData, number, Record<string, unknown>, string]> = [
    [
      '/api/size',
      () => {
        const form = new FormData();
        form.append('file', secretFile(), 'secret.bin');
        return form;
      },
      413,
      TOO_LARGE_BODY,
      'LIMIT_FILE_SIZE',
    ],
    [
      '/api/files',
      () => {
        const form = new FormData();
        for (let i = 0; i < 3; i += 1) form.append('files', secretFile(8), `secret-${i}.bin`);
        return form;
      },
      400,
      badRequest('UPLOAD_TOO_MANY_FILES'),
      'LIMIT_FILE_COUNT',
    ],
    [
      '/api/unexpected',
      () => {
        const form = new FormData();
        form.append(FAKE_FIELD, secretFile(8), 'secret.bin');
        return form;
      },
      400,
      badRequest('UPLOAD_UNEXPECTED_FILE'),
      'LIMIT_UNEXPECTED_FILE',
    ],
    [
      '/api/max-count',
      () => {
        const form = new FormData();
        form.append('files', secretFile(8), 'one.bin');
        form.append('files', secretFile(8), 'two.bin');
        return form;
      },
      400,
      badRequest('UPLOAD_UNEXPECTED_FILE'),
      'LIMIT_UNEXPECTED_FILE',
    ],
    [
      '/api/parts',
      () => {
        const form = new FormData();
        for (let i = 0; i < 4; i += 1) form.append(`note${i}`, FAKE_SECRET);
        return form;
      },
      400,
      badRequest('UPLOAD_TOO_MANY_PARTS'),
      'LIMIT_PART_COUNT',
    ],
    [
      '/api/field-key',
      () => {
        const form = new FormData();
        form.append(`${FAKE_FIELD}-long-name`, FAKE_SECRET);
        return form;
      },
      400,
      badRequest('UPLOAD_FIELD_NAME_TOO_LONG'),
      'LIMIT_FIELD_KEY',
    ],
    [
      '/api/field-value',
      () => {
        const form = new FormData();
        form.append(FAKE_FIELD, FAKE_SECRET);
        return form;
      },
      400,
      badRequest('UPLOAD_FIELD_VALUE_TOO_LONG'),
      'LIMIT_FIELD_VALUE',
    ],
    [
      '/api/fields',
      () => {
        const form = new FormData();
        for (let i = 0; i < 3; i += 1) form.append(`${FAKE_FIELD}${i}`, FAKE_SECRET);
        return form;
      },
      400,
      badRequest('UPLOAD_TOO_MANY_FIELDS'),
      'LIMIT_FIELD_COUNT',
    ],
    [
      '/api/field-nesting',
      () => {
        const form = new FormData();
        form.append(`${FAKE_FIELD}[a][b][c][d][e][f]`, FAKE_SECRET);
        return form;
      },
      400,
      badRequest('UPLOAD_FIELD_NESTING_TOO_DEEP'),
      'LIMIT_FIELD_NESTING',
    ],
    [
      '/api/field-array-index',
      () => {
        const form = new FormData();
        form.append(`${FAKE_FIELD}[101]`, FAKE_SECRET);
        return form;
      },
      400,
      badRequest('UPLOAD_FIELD_ARRAY_INDEX_TOO_LARGE'),
      'LIMIT_FIELD_ARRAY_INDEX',
    ],
  ];
  try {
    for (const [path, form, status, body] of forms) {
      const out = await post(`${server.origin}${path}?token=${FAKE_SECRET}`, form());
      assert.equal(out.status, status, path);
      assert.deepEqual(JSON.parse(out.text), body, path);
      assert.doesNotMatch(out.text, LEAK, path);
    }
  } finally {
    await server.close();
  }
  assert.deepEqual(errors, [], 'never logged as an unexpected error');
  assert.equal(warnings.length, forms.length);
  forms.forEach(([path, , status, , multerCode], index) => {
    assert.doesNotMatch(warnings[index], LEAK, 'no file content, field name, field value or query string');
    assert.deepEqual(JSON.parse(warnings[index].replace(/^\[Upload\] /, '')), {
      event: 'upload_refused',
      multer_code: multerCode,
      status,
      method: 'POST',
      path,
    });
  });
});

test('a real route: an assignment submission over 25 MB is a 413, a sixth file a 400', async t => {
  const { warnings, errors } = captureConsole(t);
  const server = await serve();
  try {
    const url = `${server.origin}/api/assignments/learner/a1/submit`;
    const tooLarge = new FormData();
    tooLarge.append('files', secretFile(25 * 1024 * 1024 + 1), 'too-big.mp4');
    const large = await post(url, tooLarge);
    assert.equal(large.status, 413);
    assert.deepEqual(JSON.parse(large.text), TOO_LARGE_BODY);

    const tooMany = new FormData();
    for (let i = 0; i < 6; i += 1) tooMany.append('files', secretFile(8), `file-${i}.pdf`);
    const many = await post(url, tooMany);
    assert.equal(many.status, 400);
    assert.deepEqual(JSON.parse(many.text), badRequest('UPLOAD_TOO_MANY_FILES'));
  } finally {
    await server.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 2);
});

test('a real route: field names at the shared limits pass, one level or one index more is a 400', async t => {
  const { warnings, errors } = captureConsole(t);
  const server = await serve();
  const url = `${server.origin}/api/assignments/learner/a1/submit`;
  const field = (name: string) => {
    const form = new FormData();
    form.append(name, FAKE_SECRET);
    return form;
  };
  try {
    assert.equal((await post(url, field('note[a][b][c][d][e]'))).status, 200, 'five levels');
    assert.equal((await post(url, field('items[100]'))).status, 200, 'array index 100');
    const deep = await post(url, field('note[a][b][c][d][e][f]'));
    assert.equal(deep.status, 400);
    assert.deepEqual(JSON.parse(deep.text), badRequest('UPLOAD_FIELD_NESTING_TOO_DEEP'));
    const index = await post(url, field('items[101]'));
    assert.equal(index.status, 400);
    assert.deepEqual(JSON.parse(index.text), badRequest('UPLOAD_FIELD_ARRAY_INDEX_TOO_LARGE'));
  } finally {
    await server.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 2);
});

test('a route that answers multer itself keeps its answer: bot avatar over its limit', async t => {
  const { warnings, errors } = captureConsole(t);
  const server = await serve();
  try {
    const url = `${server.origin}/api/ai-chatbot/bots/${BOT_ID}/avatar`;
    const form = new FormData();
    form.append('avatar', secretFile(BOT_AVATAR_MAX_BYTES + 1, 'image/png'), 'avatar.png');
    const out = await post(url, form);
    assert.equal(out.status, 400);
    assert.deepEqual(JSON.parse(out.text), { success: false, message: BOT_AVATAR_SIZE_MESSAGE, code: 'BAD_REQUEST' });

    // Any other multer refusal goes on to the global handler (a 500 before).
    const wrongField = new FormData();
    wrongField.append(FAKE_FIELD, secretFile(8, 'image/png'), 'avatar.png');
    const other = await post(url, wrongField);
    assert.equal(other.status, 400);
    assert.deepEqual(JSON.parse(other.text), badRequest('UPLOAD_UNEXPECTED_FILE'));
  } finally {
    await server.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, 'only the refusal the global handler answered');
});

test('describeErrorResponse: every multer code, in production too; an unknown multer code stays a 500', () => {
  const expected: Record<string, [number, Record<string, unknown>]> = {
    LIMIT_FILE_SIZE: [413, TOO_LARGE_BODY],
    LIMIT_FILE_COUNT: [400, badRequest('UPLOAD_TOO_MANY_FILES')],
    LIMIT_UNEXPECTED_FILE: [400, badRequest('UPLOAD_UNEXPECTED_FILE')],
    LIMIT_PART_COUNT: [400, badRequest('UPLOAD_TOO_MANY_PARTS')],
    LIMIT_FIELD_KEY: [400, badRequest('UPLOAD_FIELD_NAME_TOO_LONG')],
    LIMIT_FIELD_VALUE: [400, badRequest('UPLOAD_FIELD_VALUE_TOO_LONG')],
    LIMIT_FIELD_COUNT: [400, badRequest('UPLOAD_TOO_MANY_FIELDS')],
    MISSING_FIELD_NAME: [400, badRequest('UPLOAD_FIELD_NAME_MISSING')],
    LIMIT_FIELD_NESTING: [400, badRequest('UPLOAD_FIELD_NESTING_TOO_DEEP')],
    LIMIT_FIELD_ARRAY_INDEX: [400, badRequest('UPLOAD_FIELD_ARRAY_INDEX_TOO_LARGE')],
  };
  for (const production of [false, true]) {
    for (const [multerCode, [status, body]] of Object.entries(expected)) {
      const error = new multer.MulterError(multerCode as multer.ErrorCode, FAKE_FIELD);
      const out = describeErrorResponse(error, { production });
      assert.equal(out.status, status, multerCode);
      assert.deepEqual(out.body, body, multerCode);
      assert.equal(out.log, 'upload');
      assert.equal(out.uploadErrorCode, multerCode);
    }
    const unknown = Object.assign(new multer.MulterError('LIMIT_FILE_SIZE'), { code: 'LIMIT_SOMETHING_NEW' });
    assert.equal(describeErrorResponse(unknown, { production }).status, 500);
    // Not a MulterError: a plain error that only looks like one is unexpected.
    const lookalike = Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' });
    assert.equal(describeErrorResponse(lookalike, { production }).status, 500);
  }
});
