import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { NextFunction, Request, Response } from 'express';

// Staff and profile routes answer a missing or malformed JSON body with a 400,
// a fixed Vietnamese message and a stable code, never a 500, and read nothing
// before refusing: course category create, course notification send,
// enrollment create and delete, own profile update (users and auth routes), password
// change (auth and users routes), help docs folder and page create/update, and
// email template update. Each handler runs as Express runs it: an error passed
// to next (or a rejected promise) goes to the global error handler. pg double;
// no database, no Redis, no network.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const pg = await import('pg');
const redis = await import('../config/redis.js');
const { pool } = await import('../config/database.js');
const { errorHandler } = await import('../middleware/error-handler.js');
const categories = await import('./course-categories/course-categories.controller.js');
const notifications = await import('./notifications/notifications.controller.js');
const enrollments = await import('./enrollments/enrollments.controller.js');
const users = await import('./users/users.controller.js');
const auth = await import('./auth/auth.controller.js');
const helpDocs = await import('./help-docs/help-docs.controller.js');
const emailTemplates = await import('./email-templates/email-templates.controller.js');
const { updateOwnProfileSchema } = await import('./users/users.validator.js');
const { updateProfileSchema } = await import('./auth/auth.validator.js');
const { createCourseCategoryBodySchema } = await import('./course-categories/course-categories.validator.js');
const { sendNotificationBodySchema } = await import('./notifications/notifications.validator.js');
const { createHelpFolderSchema, createHelpPageSchema } = await import('./help-docs/help-docs.validator.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const FOLDER = 'f0000000-0000-4000-8000-000000000001';
const PAGE = 'f0000000-0000-4000-8000-000000000002';
const COURSE = 'course-v1:Landa+C1+2026';

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

interface FakeResponse {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  setHeader(): void;
}

/** No body parser ran (no body, or not JSON), or the body is not an object. */
const NOT_AN_OBJECT: unknown[] = [undefined, null, [], 'title=x', 42];

/** The handler, then the global error handler for whatever reached next (as Express 5 does). */
async function respond(handler: Handler, body: unknown, params: Record<string, string> = {}): Promise<FakeResponse> {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      this.headersSent = true;
      return this;
    },
    setHeader() {},
  };
  const req = {
    user: { id: USER, tenantId: TENANT, role: 'superadmin', username: 'admin01', sessionMode: 'normal' },
    query: {},
    params,
    body,
    method: 'POST',
    originalUrl: '/api/test',
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  } as unknown as Request;
  let passed: unknown;
  try {
    await handler(req, res as unknown as Response, (error?: unknown) => {
      passed = error;
    });
  } catch (error) {
    passed = error;
  }
  if (passed !== undefined) errorHandler(passed as Error, req, res as unknown as Response, () => undefined);
  return res;
}

function installDb(t: TestContext): string[] {
  const statements: string[] = [];
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string) => {
    statements.push(text);
    return { rows: [], rowCount: 0 };
  });
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({
    query: async (text: string) => {
      statements.push(text);
      return { rows: [], rowCount: 0 };
    },
    release() {},
  }));
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'warn', () => undefined);
  return statements;
}

async function expectRefused(
  t: TestContext,
  label: string,
  handler: Handler,
  body: unknown,
  code: string,
  message: string,
  params?: Record<string, string>,
): Promise<void> {
  const statements = installDb(t);
  const res = await respond(handler, body, params);
  assert.equal(res.statusCode, 400, `${label}: ${JSON.stringify(body)?.slice(0, 80)} -> ${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body, { success: false, message, code, error: code }, label);
  assert.deepEqual(statements, [], `${label}: nothing was read or written`);
  t.mock.restoreAll();
}

const long = (count: number) => 'x'.repeat(count);

test('POST /api/course-categories without a name is a 400 COURSE_CATEGORY_INPUT_INVALID', async t => {
  const code = 'COURSE_CATEGORY_INPUT_INVALID';
  const required = 'Vui lòng nhập tên danh mục khóa học.';
  for (const body of [...NOT_AN_OBJECT, {}, { name: '' }, { name: '   ' }, { name: 5 }, { description: 'x' }]) {
    await expectRefused(t, 'category create', categories.createController, body, code, required);
  }
  await expectRefused(t, 'category name', categories.createController, { name: long(201) }, code, 'Tên danh mục khóa học tối đa 200 ký tự.');
  await expectRefused(t, 'category order', categories.createController, { name: 'A', sort_order: 'abc' }, code, 'Thứ tự hiển thị của danh mục phải là số nguyên.');
  await expectRefused(t, 'category description', categories.createController, { name: 'A', description: { a: 1 } }, code, 'Mô tả danh mục khóa học không hợp lệ.');
});

test('POST /api/notifications without a JSON object or with a title over 500 characters is a 400 NOTIFICATION_INPUT_INVALID', async t => {
  const code = 'NOTIFICATION_INPUT_INVALID';
  for (const body of NOT_AN_OBJECT) {
    await expectRefused(t, 'notification', notifications.send, body, code, 'Vui lòng chọn khóa học và nhập tiêu đề thông báo.');
  }
  await expectRefused(t, 'notification course', notifications.send, { course_id: 5, title: 'T' }, code, 'Vui lòng chọn khóa học và nhập tiêu đề thông báo.');
  await expectRefused(t, 'notification title', notifications.send, { course_id: COURSE, title: long(501) }, code, 'Tiêu đề thông báo tối đa 500 ký tự.');
  await expectRefused(t, 'notification message', notifications.send, { course_id: COURSE, title: 'T', message: 5 }, code, 'Nội dung thông báo không hợp lệ.');
});

test('POST /api/enrollments without a JSON object or with a course id that is not text is a 400 ENROLLMENT_INPUT_INVALID', async t => {
  const message = 'Vui lòng chọn khóa học và học viên cần ghi danh.';
  for (const body of [...NOT_AN_OBJECT, { course_id: 5, user_id: USER }, { course_id: { id: COURSE }, user_ids: [USER] }]) {
    await expectRefused(t, 'enroll', enrollments.enroll as Handler, body, 'ENROLLMENT_INPUT_INVALID', message);
  }
});

test('DELETE /api/enrollments without a JSON object, with a learner id that is not a UUID or a course id that is not text is a 400 ENROLLMENT_INPUT_INVALID', async t => {
  const message = 'Vui lòng chọn khóa học và học viên cần hủy ghi danh.';
  for (const body of [
    ...NOT_AN_OBJECT,
    { user_id: 'not-a-uuid', course_id: COURSE },
    { user_id: `${USER}x`, course_id: COURSE },
    { user_id: 42, course_id: COURSE },
    { user_id: [USER], course_id: COURSE },
    { user_id: USER, course_id: 5 },
    { user_id: USER, course_id: { id: COURSE } },
  ]) {
    await expectRefused(t, 'unenroll', enrollments.unenroll as Handler, body, 'ENROLLMENT_INPUT_INVALID', message);
  }
});

test('DELETE /api/enrollments keeps its answer for a missing field and still unenrolls a valid body', async t => {
  for (const body of [{}, { user_id: USER }, { course_id: COURSE }, { user_id: '', course_id: COURSE }]) {
    const statements = installDb(t);
    const res = await respond(enrollments.unenroll as Handler, body);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { success: false, message: 'user_id and course_id are required', code: 'BAD_REQUEST' });
    assert.deepEqual(statements, []);
    t.mock.restoreAll();
  }
  const statements = installDb(t);
  const res = await respond(enrollments.unenroll as Handler, { user_id: USER.toUpperCase(), course_id: COURSE });
  // The double has no enrollment: the request reached the service and its database reads.
  assert.equal(res.statusCode, 404);
  assert.ok(statements.some(text => /UPDATE enrollments/.test(text)));
});

test('PATCH /api/users/profile and PATCH /api/auth/profile refuse a missing body, a wrong type or a text over its column', async t => {
  const code = 'PROFILE_INPUT_INVALID';
  for (const handler of [users.updateProfileController, auth.updateProfileController]) {
    for (const body of NOT_AN_OBJECT) {
      await expectRefused(t, 'profile', handler, body, code, 'Không có dữ liệu cần cập nhật');
    }
  }
  const shared: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
    [{ name: long(256) }, { full_name: long(256) }, 'Họ và tên tối đa 255 ký tự.'],
    [{ name: 5 }, { full_name: 5 }, 'Họ và tên không hợp lệ.'],
    [{ phone_number: '0'.repeat(21) }, { phone: '0'.repeat(21) }, 'Số điện thoại tối đa 20 ký tự.'],
    [{ country: long(11) }, { country: long(11) }, 'Quốc gia tối đa 10 ký tự.'],
    [{ language: long(11) }, { language: long(11) }, 'Ngôn ngữ tối đa 10 ký tự.'],
    [{ bio: ['x'] }, { bio: ['x'] }, 'Giới thiệu không hợp lệ.'],
    [{ year_of_birth: '1990' }, { year_of_birth: '1990' }, 'Năm sinh không hợp lệ.'],
    [{ year_of_birth: 1990.5 }, { year_of_birth: 1990.5 }, 'Năm sinh không hợp lệ.'],
    [{ year_of_birth: 2 ** 31 }, { year_of_birth: 2 ** 31 }, 'Năm sinh không hợp lệ.'],
  ];
  for (const [usersBody, authBody, message] of shared) {
    await expectRefused(t, 'users profile', users.updateProfileController, usersBody, code, message);
    await expectRefused(t, 'auth profile', auth.updateProfileController, authBody, code, message);
  }
  // The auth route's service has no value check of its own (the enum used to fail in the database).
  await expectRefused(t, 'auth gender', auth.updateProfileController, { gender: 'x' }, code, 'Giới tính không hợp lệ.');
  await expectRefused(t, 'auth education', auth.updateProfileController, { level_of_education: 'x' }, code, 'Trình độ học vấn không hợp lệ.');
});

test('the profile limits are the users columns, counted in characters as Postgres counts them', () => {
  const emoji = '😀'.repeat(255); // 510 UTF-16 units, 255 characters: VARCHAR(255) stores it.
  for (const body of [{ name: long(255) }, { name: emoji }, { phone_number: '0'.repeat(20) }, { country: 'OTHER' }, { language: 'vi' }]) {
    assert.ok(updateOwnProfileSchema.safeParse(body).success, JSON.stringify(body).slice(0, 40));
  }
  // What the dashboard and the learner app send today.
  const dashboard = { name: 'Tên', bio: long(5000), gender: '', country: 'VN', level_of_education: 'master', phone_number: '0912 345 678', language: 'vi', year_of_birth: 1995 };
  assert.ok(updateOwnProfileSchema.safeParse(dashboard).success);
  assert.ok(updateOwnProfileSchema.safeParse({ gender: '', level_of_education: '', year_of_birth: null }).success);
  const learner = { full_name: 'Tên', bio: long(5000), gender: 'female', country: 'OTHER', level_of_education: 'none', language: 'zh', phone: '+84 (912) 345-678', year_of_birth: 2000 };
  assert.ok(updateProfileSchema.safeParse(learner).success);
  assert.ok(updateProfileSchema.safeParse({ gender: '', level_of_education: '', avatar_url: null }).success);
  assert.equal(updateProfileSchema.safeParse({ full_name: emoji + '😀' }).success, false);
});

test('POST /api/auth/change-password and /api/users/profile/change-password refuse a missing body or a password that is not text', async t => {
  const message = 'Vui lòng nhập mật khẩu hiện tại và mật khẩu mới.';
  for (const handler of [auth.changePasswordController, users.changePasswordController]) {
    for (const body of [
      ...NOT_AN_OBJECT,
      { current_password: 12345678, new_password: 'NewPass#2026' },
      { current_password: 'Current#2026', new_password: ['NewPass#2026'] },
      { current_password: 'Current#2026', new_password: { length: 9 } },
    ]) {
      await expectRefused(t, 'password', handler, body, 'PASSWORD_INPUT_INVALID', message);
    }
  }
});

test('help docs folder and page bodies are checked before anything is read', async t => {
  const code = 'HELP_DOC_INPUT_INVALID';
  for (const body of [...NOT_AN_OBJECT, {}, { title: '' }, { title: '  ' }, { title: 5 }, { icon: 'Star' }]) {
    await expectRefused(t, 'folder create', helpDocs.createFolderController, body, code, 'Vui lòng nhập tên thư mục.');
  }
  await expectRefused(t, 'folder create long', helpDocs.createFolderController, { title: long(201) }, code, 'Tên thư mục tối đa 200 ký tự.');
  await expectRefused(t, 'folder create icon', helpDocs.createFolderController, { title: 'A', icon: 5 }, code, 'Biểu tượng thư mục không hợp lệ.');
  await expectRefused(t, 'folder create icon long', helpDocs.createFolderController, { title: 'A', icon: long(101) }, code, 'Biểu tượng thư mục không hợp lệ.');

  const folderParams = { id: FOLDER };
  for (const body of NOT_AN_OBJECT) {
    await expectRefused(t, 'folder update', helpDocs.updateFolderController, body, code, 'Không có dữ liệu cần cập nhật', folderParams);
  }
  await expectRefused(t, 'folder update title', helpDocs.updateFolderController, { title: null }, code, 'Tên thư mục không hợp lệ.', folderParams);
  await expectRefused(t, 'folder update long', helpDocs.updateFolderController, { title: long(201) }, code, 'Tên thư mục tối đa 200 ký tự.', folderParams);

  for (const body of [...NOT_AN_OBJECT, { folder_id: FOLDER }, { folder_id: FOLDER, title: ' ' }]) {
    await expectRefused(t, 'page create', helpDocs.createPageController, body, code, 'Vui lòng nhập tiêu đề trang.');
  }
  for (const body of [{ title: 'Trang' }, { folder_id: 'not-a-uuid', title: 'Trang' }, { folder_id: 5, title: 'Trang' }]) {
    await expectRefused(t, 'page create folder', helpDocs.createPageController, body, code, 'Vui lòng chọn thư mục cho trang.');
  }
  await expectRefused(t, 'page create long', helpDocs.createPageController, { folder_id: FOLDER, title: long(501) }, code, 'Tiêu đề trang tối đa 500 ký tự.');
  await expectRefused(t, 'page create content', helpDocs.createPageController, { folder_id: FOLDER, title: 'T', content: 5 }, code, 'Nội dung trang không hợp lệ.');

  const pageParams = { id: PAGE };
  for (const body of NOT_AN_OBJECT) {
    await expectRefused(t, 'page update', helpDocs.updatePageController, body, code, 'Không có dữ liệu cần cập nhật', pageParams);
  }
  await expectRefused(t, 'page update title', helpDocs.updatePageController, { title: 5 }, code, 'Tiêu đề trang không hợp lệ.', pageParams);
  await expectRefused(t, 'page update long', helpDocs.updatePageController, { title: long(501) }, code, 'Tiêu đề trang tối đa 500 ký tự.', pageParams);
  await expectRefused(t, 'page update content', helpDocs.updatePageController, { content: null }, code, 'Nội dung trang không hợp lệ.', pageParams);
  await expectRefused(t, 'page update publish', helpDocs.updatePageController, { is_published: 'yes' }, code, 'Trạng thái xuất bản không hợp lệ.', pageParams);
});

test('PUT /api/email-templates/:key without a JSON object is a 400 EMAIL_TEMPLATE_INPUT_INVALID', async t => {
  for (const body of NOT_AN_OBJECT) {
    await expectRefused(t, 'email template', emailTemplates.update, body, 'EMAIL_TEMPLATE_INPUT_INVALID', 'Vui lòng nhập tiêu đề, mô tả ngắn và nội dung email.', { key: 'assignment_created' });
  }
});

test('the bodies the dashboard sends are accepted unchanged', () => {
  const category = { name: 'Kế Toán 101', description: 'Mô tả', sort_order: 3 };
  assert.deepEqual(createCourseCategoryBodySchema.parse(category), category);
  assert.deepEqual(createCourseCategoryBodySchema.parse({ name: '  Excel  ' }), { name: '  Excel  ' });
  assert.ok(createCourseCategoryBodySchema.safeParse({ name: '😀'.repeat(200) }).success);
  const notice = { course_id: COURSE, title: long(500), message: '' };
  assert.deepEqual(sendNotificationBodySchema.parse(notice), notice);
  assert.deepEqual(createHelpFolderSchema.parse({ title: 'FAQ' }), { title: 'FAQ' });
  assert.deepEqual(createHelpPageSchema.parse({ folder_id: FOLDER, title: 'Two' }), { folder_id: FOLDER, title: 'Two' });
});
