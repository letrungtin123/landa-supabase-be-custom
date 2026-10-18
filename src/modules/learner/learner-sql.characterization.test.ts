import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';

// Characterization of the learner routes: every SQL statement (text without
// whitespace differences, parameters) and the answer (status, body, or the
// error passed to next) of every learner handler, for learners, staff and
// demo iframe sessions over a matrix of queries, bodies and empty results.
// The golden file was written by the code before the learner repositories
// existed; moving SQL into repositories must keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with
// one fixed row (or none, per case). Rewrite the golden file only for an
// intended change:
//   LEARNER_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/learner/learner-sql.characterization.test.ts
// LEARNER_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const pg = await import('pg');
const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./learner.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'learner-sql.characterization.golden.json');
const WRITE_GOLDEN = process.env.LEARNER_SQL_GOLDEN_WRITE === '1';
const FULL_OUT = process.env.LEARNER_SQL_FULL_OUT?.trim() || '';
const NOW = Date.parse('2026-10-18T03:04:05.000Z');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:Landa+L1+2026';
const BLOCK = 'b0000000-0000-4000-8000-000000000001';
const BLOCK_2 = 'b0000000-0000-4000-8000-000000000002';
const SECTION = 'c0000000-0000-4000-8000-000000000001';

/** One row with every column a learner statement reads. */
const ROW = {
  id: 'row-1', course_id: COURSE, block_id: BLOCK, section_id: SECTION, user_id: USER, enrollment_id: 'enr-1',
  display_name: 'Khóa học A.pdf', org: 'Landa', image_url: 'img.png', start_date: '2026-01-01T00:00:00.000Z', end_date: null,
  visible_to_staff_only: false, is_public: true, created_at: '2026-02-01T00:00:00.000Z', full_count: '3',
  name: 'Danh mục 1', slug: 'dm-1', sort_order: 1, count: '4',
  mentor_id: 'm-1', mentor_full_name: 'Mentor', mentor_email: 'm@example.test', mentor_phone: '0900', mentor_avatar: null,
  mentor_bio: 'bio', mentor_role: 'staff', mentor_section_description: 'desc', mentor_section_logo_light: null, mentor_section_logo_dark: null,
  parent_id: null, block_type: 'vertical', data: '<p>x</p>', metadata: { a: 1 }, is_published: true,
  content_type: 'application/pdf', file_size: '2048', url: 'tenant/a.pdf', is_locked: false, is_reference: true,
  title: 'Tài liệu', extension: 'pdf', file_url: 'tenant/doc.pdf', category_id: 'cat-1', is_visible: true,
  category_name: 'Danh mục 1', category_slug: 'dm-1', uploaded_by_name: 'Admin',
  enrolled_at: '2026-03-01T00:00:00.000Z', is_active: true, progress: '42.50', is_completed: false,
  completed_at: null, last_activity_at: null, completed: false,
  message: 'Xin chào', type: 'info', read_at: null, is_read: false, sent_by_name: 'Admin', unread_full_count: '2',
  welcome_enabled: true, welcome_title: 'Chào', welcome_description: '', confirm_enabled: false, confirm_title: '',
  confirm_description: '', confirm_checkbox_text: '', completion_enabled: true, completion_title: '', completion_description: '',
  completion_social_type: null, completion_social_link: null, welcome_shown: false, confirm_shown: true, complete_shown: false,
  description: 'Mô tả', total: '4', completed_count: '1',
};

type Answer = (text: string, index: number) => { rows: unknown[] } | undefined;

interface Statement {
  text: string;
  params: unknown[];
}

function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function installDb(t: TestContext, answer?: Answer): Statement[] {
  const statements: Statement[] = [];
  const reply = (text: string) => {
    const custom = answer?.(text, statements.length - 1);
    const rows = custom?.rows ?? (/^\s*(BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE)/i.test(text) ? [] : [ROW]);
    return { rows, rowCount: rows.length };
  };
  const handle = async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
    const text = typeof config === 'string' ? config : config.text;
    // A copy, as sent: the service may push onto the same array for its next statement.
    statements.push({ text, params: [...(typeof config === 'string' ? values : (config.values ?? []))] });
    return reply(text);
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release() {} }));
  return statements;
}

interface FakeResponse {
  statusCode: number;
  body: unknown;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

interface CallOptions {
  role?: string;
  demo?: boolean;
  tenantId?: string | null;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: unknown;
  noUser?: boolean;
}

async function call(handler: Handler, options: CallOptions = {}) {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let passed: unknown;
  const req = {
    user: options.noUser
      ? undefined
      : {
          id: USER,
          tenantId: options.tenantId === undefined ? TENANT : options.tenantId,
          role: options.role ?? 'learner',
          username: 'learner01',
          sessionMode: options.demo ? 'demo_iframe' : 'normal',
        },
    query: options.query ?? {},
    params: { courseId: COURSE, blockId: BLOCK, badgeId: 'badge-1', id: 'notif-1', ...options.params },
    body: 'body' in options ? options.body : {},
    get: () => undefined,
    headers: {},
  } as unknown as Request;
  await handler(req, res as unknown as Response, (error?: unknown) => {
    passed = error;
  });
  if (passed !== undefined) {
    const error = passed as { name?: string; message?: string; statusCode?: unknown };
    return { next: { name: error?.name ?? null, message: error?.message ?? String(passed), statusCode: error?.statusCode ?? null } };
  }
  return { status: res.statusCode, body: res.body };
}

interface Case {
  name: string;
  run: () => Promise<unknown>;
  answer?: Answer;
}

const cases: Case[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const noRowsAt =
  (...indexes: number[]): Answer =>
  (_text, index) =>
    indexes.includes(index) ? { rows: [] } : undefined;
const noRowsWhen =
  (pattern: RegExp): Answer =>
  text =>
    pattern.test(text) ? { rows: [] } : undefined;

const ROLES = ['learner', 'learner_plus', 'staff'];
const H = ctrl;

for (const role of ROLES) {
  const r = { role };
  add(`${role} courses`, () => call(H.listCourses, r));
  add(`${role} courses filtered`, () =>
    call(H.listCourses, { ...r, query: { search: 'Excel', category_id: 'cat-1', page: '2', page_size: '5' } }),
  );
  add(`${role} courses odd query`, () =>
    call(H.listCourses, { ...r, query: { search: ['a', 'b'], page: 'x', page_size: '0' } }),
  );
  add(`${role} courses empty`, () => call(H.listCourses, r), noRowsAt(0));
  add(`${role} course detail`, () => call(H.getCourseDetail, r));
  add(`${role} course detail missing`, () => call(H.getCourseDetail, r), noRowsAt(0));
  add(`${role} course detail no access`, () => call(H.getCourseDetail, r), noRowsAt(1));
  add(`${role} course detail no mentor`, () => call(H.getCourseDetail, r), (text, index) =>
    index === 0 ? { rows: [{ ...ROW, mentor_id: null, mentor_section_description: null }] } : undefined,
  );
  add(`${role} course blocks`, () => call(H.getCourseBlocks, r));
  add(`${role} course blocks demo`, () => call(H.getCourseBlocks, { ...r, demo: true }));
  add(`${role} course blocks no access`, () => call(H.getCourseBlocks, r), noRowsAt(0));
  add(`${role} course files`, () => call(H.getCourseFiles, r));
  add(`${role} course files none`, () => call(H.getCourseFiles, r), noRowsAt(1));
  add(`${role} library categories`, () => call(H.getLibraryCategories, r));
  add(`${role} library documents`, () => call(H.getLibraryDocuments, r));
  for (const ordering of ['title', '-title', 'created_at', 'file_size', 'bogus']) {
    add(`${role} library documents ${ordering}`, () =>
      call(H.getLibraryDocuments, {
        ...r,
        query: { page: '2', page_size: '10', category: 'dm-1', extension: 'pdf', search: 'hợp đồng', ordering },
      }),
    );
  }
  add(`${role} library documents empty`, () => call(H.getLibraryDocuments, r), noRowsAt(1));
  add(`${role} block detail`, () => call(H.getBlockDetail, r));
  add(`${role} block detail missing`, () => call(H.getBlockDetail, r), noRowsAt(0));
  add(`${role} block detail no access`, () => call(H.getBlockDetail, r), noRowsAt(1));
  add(`${role} block submit`, () => call(H.submitBlockAnswer, { ...r, body: { answers: { a: 'b' } } }));
  add(`${role} enrollments`, () => call(H.listEnrollments, r));
  add(`${role} enrollments demo`, () => call(H.listEnrollments, { ...r, demo: true }));
  add(`${role} enroll existing active`, () => call(H.enroll, { ...r, body: { course_id: COURSE } }));
  add(`${role} enroll existing inactive`, () => call(H.enroll, { ...r, body: { course_id: COURSE } }), text =>
    /SELECT id, is_active FROM enrollments/.test(text) ? { rows: [{ id: 'enr-1', is_active: false }] } : undefined,
  );
  add(`${role} enroll new`, () => call(H.enroll, { ...r, body: { course_id: COURSE } }), noRowsWhen(/SELECT id, is_active FROM enrollments|AS exists/));
  add(`${role} enroll no access`, () => call(H.enroll, { ...r, body: { course_id: COURSE } }), noRowsWhen(/SELECT c\.id\s+FROM courses c/));
  add(`${role} enroll demo account`, () => call(H.enroll, { ...r, body: { course_id: COURSE } }), text =>
    /AS exists/.test(text) ? { rows: [{ exists: true }] } : undefined,
  );
  add(`${role} complete blocks`, () =>
    call(H.completeBlocks, { ...r, body: { course_id: COURSE, block_ids: [BLOCK, BLOCK_2] } }),
    text => (/AS completed/.test(text) ? { rows: [{ id: BLOCK, completed: false }, { id: BLOCK_2, completed: true }] } : undefined),
  );
  add(`${role} complete blocks all done`, () =>
    call(H.completeBlocks, { ...r, body: { course_id: COURSE, block_ids: [BLOCK] } }),
    text => (/AS completed/.test(text) ? { rows: [{ id: BLOCK, completed: true }] } : undefined),
  );
  add(`${role} complete blocks race`, () =>
    call(H.completeBlocks, { ...r, body: { course_id: COURSE, block_ids: [BLOCK] } }),
    text => (/RETURNING block_id/.test(text) ? { rows: [] } : undefined),
  );
  add(`${role} complete blocks no enrollment`, () =>
    call(H.completeBlocks, { ...r, body: { course_id: COURSE, block_ids: [BLOCK] } }),
    noRowsWhen(/SELECT e\.id\s+FROM enrollments e/),
  );
  add(`${role} complete blocks empty list`, () => call(H.completeBlocks, { ...r, body: { course_id: COURSE, block_ids: [] } }));
  add(`${role} progress`, () => call(H.getProgress, r));
  add(`${role} progress none`, () => call(H.getProgress, r), noRowsAt(0));
  add(`${role} batch progress`, () => call(H.getBatchProgress, { ...r, query: { courseIds: `${COURSE}, c2,,c3` } }));
  add(`${role} badges`, () => call(H.listBadges, r));
  add(`${role} badge shown`, () => call(H.updateBadgeShown, r));
  add(`${role} badge update`, () => call(H.updateBadge, { ...r, body: { badge_id: 'badge-2' } }));
  add(`${role} notifications`, () => call(H.listNotifications, { ...r, query: { page: '2', page_size: '5' } }));
  add(`${role} notifications past the end`, () => call(H.listNotifications, { ...r, query: { page: '9' } }), noRowsAt(0));
  add(`${role} unread count`, () => call(H.getUnreadCount, r));
  add(`${role} mark read`, () => call(H.markRead, r));
  add(`${role} mark all read`, () => call(H.markAllRead, r));
  add(`${role} modal config`, () => call(H.getCourseModalConfig, r));
  add(`${role} modal config default`, () => call(H.getCourseModalConfig, r), noRowsAt(1));
  add(`${role} modal state created`, () => call(H.getCourseModalState, r));
  add(`${role} modal state existing`, () => call(H.getCourseModalState, r), noRowsWhen(/RETURNING \*/));
  add(`${role} modal state none`, () => call(H.getCourseModalState, r), noRowsWhen(/RETURNING \*|SELECT \* FROM course_modal_states/));
  add(`${role} modal state update`, () =>
    call(H.updateCourseModalState, { ...r, body: { welcome_shown: true, complete_shown: false } }),
  );
  add(`${role} modal state update nothing`, () => call(H.updateCourseModalState, { ...r, body: { other: 1 } }));
  add(`${role} section configs`, () => call(H.getSectionModalConfigs, r));
  add(`${role} section shown`, () => call(H.getSectionModalShown, r));
  add(`${role} section mark`, () => call(H.markSectionModalShown, { ...r, body: { section_id: SECTION } }));
  add(`${role} section mark not a section`, () =>
    call(H.markSectionModalShown, { ...r, body: { section_id: SECTION } }),
    noRowsWhen(/SELECT 1 FROM course_blocks/),
  );
}

// Refusals before any statement, demo iframe sessions, missing tenant or user.
add('no user', () => call(H.listCourses, { noUser: true }));
add('no tenant courses', () => call(H.listCourses, { tenantId: null }));
add('no tenant blocks', () => call(H.getCourseBlocks, { tenantId: null }));
add('no tenant block submit', () => call(H.submitBlockAnswer, { tenantId: null, body: {} }));
add('enroll no course id', () => call(H.enroll, { body: {} }));
add('enroll no body', () => call(H.enroll, { body: undefined }));
add('enroll demo session', () => call(H.enroll, { demo: true, body: { course_id: COURSE } }));
add('complete blocks bad body', () => call(H.completeBlocks, { body: { course_id: COURSE, block_ids: 'x' } }));
add('complete blocks no body', () => call(H.completeBlocks, { body: undefined }));
add('complete blocks too many', () =>
  call(H.completeBlocks, { body: { course_id: COURSE, block_ids: Array.from({ length: 501 }, (_v, i) => `b${i}`) } }),
);
add('complete blocks demo session', () => call(H.completeBlocks, { demo: true, body: { course_id: COURSE, block_ids: [BLOCK] } }));
add('progress demo session', () => call(H.getProgress, { demo: true }));
add('batch progress missing', () => call(H.getBatchProgress, { query: {} }));
add('batch progress blank', () => call(H.getBatchProgress, { query: { courseIds: ' , ' } }));
add('batch progress too many', () =>
  call(H.getBatchProgress, { query: { courseIds: Array.from({ length: 51 }, (_v, i) => `c${i}`).join(',') } }),
);
add('batch progress demo session', () => call(H.getBatchProgress, { demo: true, query: { courseIds: 'c1,c2' } }));
add('badges demo session', () => call(H.listBadges, { demo: true }));
add('badge evaluate demo session', () => call(H.evaluateBadges, { demo: true }));
add('badge save no id', () => call(H.saveBadge, { body: {} }));
add('badge save demo session', () => call(H.saveBadge, { demo: true, body: { badge_id: 'b' } }));
add('badge update no id', () => call(H.updateBadge, { body: {} }));
add('badge update demo session', () => call(H.updateBadge, { demo: true, body: { badge_id: 'b' } }));
add('badge shown demo session', () => call(H.updateBadgeShown, { demo: true }));
add('mark read demo session', () => call(H.markRead, { demo: true }));
add('mark all read demo session', () => call(H.markAllRead, { demo: true }));
add('modal state demo session', () => call(H.getCourseModalState, { demo: true }));
add('modal state update demo session', () => call(H.updateCourseModalState, { demo: true, body: { confirm_shown: true } }));
add('section shown demo session', () => call(H.getSectionModalShown, { demo: true }));
add('section mark demo session', () => call(H.markSectionModalShown, { demo: true, body: { section_id: SECTION } }));
add('section mark no id', () => call(H.markSectionModalShown, { body: {} }));
add('section mark bad id', () => call(H.markSectionModalShown, { body: { section_id: 'not-a-uuid' } }));
add('popup course bad id', () => call(H.getCourseModalConfig, { params: { courseId: '  ' } }));

// Query strings read by the learner query schemas: odd and repeated values.
add('batch progress repeated', () => call(H.getBatchProgress, { query: { courseIds: ['c1', 'c2'] } }));
add('notifications odd pages', () => call(H.listNotifications, { query: { page: 'abc', page_size: ['3', '4'] } }));
add('notifications zero pages', () => call(H.listNotifications, { query: { page: '0', page_size: '' } }));
add('library documents odd query', () =>
  call(H.getLibraryDocuments, { query: { page: 'x', page_size: '-5', category: ['a', 'b'], search: ['x'], ordering: ['title'] } }),
);
add('courses repeated category', () => call(H.listCourses, { role: 'staff', query: { category_id: ['c1', 'c2'], page: '2.7' } }));

// ── Runner ──

function digest(outcome: unknown): string {
  return createHash('sha256').update(JSON.stringify(outcome)).digest('hex');
}

const golden: Record<string, string> = existsSync(GOLDEN_PATH)
  ? (JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, string>)
  : {};
const written: Record<string, string> = {};
const full: Record<string, unknown> = {};

test('the case names are unique', () => {
  assert.equal(new Set(cases.map(item => item.name)).size, cases.length);
});

for (const item of cases) {
  test(`learner characterization: ${item.name}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const statements = installDb(t, item.answer);
    let result: unknown;
    try {
      result = plain(await item.run());
    } catch (error) {
      result = { thrown: (error as Error).name, message: (error as Error).message };
    }
    const outcome = {
      statements: statements.map(s => ({ sql: s.text.replace(/\s+/g, ' ').trim(), params: plain(s.params) })),
      result,
    };
    const value = digest(outcome);
    if (FULL_OUT) full[item.name] = outcome;
    if (WRITE_GOLDEN) {
      written[item.name] = value;
      return;
    }
    assert.ok(golden[item.name], `no golden entry for "${item.name}"`);
    assert.equal(value, golden[item.name], `outcome changed:\n${JSON.stringify(outcome).slice(0, 4000)}`);
  });
}

test('every golden entry still has its case', () => {
  if (FULL_OUT) writeFileSync(FULL_OUT, `${JSON.stringify(full, null, 1)}\n`);
  if (WRITE_GOLDEN) {
    const sorted = Object.fromEntries(
      Object.keys(written)
        .sort()
        .map(name => [name, written[name]]),
    );
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(sorted, null, 1)}\n`);
    return;
  }
  assert.deepStrictEqual(Object.keys(golden).sort(), cases.map(item => item.name).sort());
});
