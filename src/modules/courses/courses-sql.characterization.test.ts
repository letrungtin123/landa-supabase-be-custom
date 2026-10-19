import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';

// Characterization of the staff course routes (/api/courses): every SQL
// statement (text without whitespace differences, parameters, pool or
// transaction client), every Storage request and the answer (status, body,
// headers, or the error passed to next) of every courses handler, over a
// matrix of roles, queries, bodies and empty results. The golden file was
// written by the code before the courses repository existed; moving SQL into
// repositories must keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or none, per case) and a fetch double answers Storage. Rewrite
// the golden file only for an intended change:
//   COURSES_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/courses/courses-sql.characterization.test.ts
// COURSES_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

// Storage requests: the Supabase client keeps the fetch it finds when it is
// created, so the double is installed before config/storage.ts is imported.
const storageRequests: string[] = [];
globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  storageRequests.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
  return new globalThis.Response(JSON.stringify({ id: 'landa-storage', name: 'landa-storage', Key: 'k', path: 'p' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const pg = await import('pg');
const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./courses.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'courses-sql.characterization.golden.json');
const WRITE_GOLDEN = process.env.COURSES_SQL_GOLDEN_WRITE === '1';
const FULL_OUT = process.env.COURSES_SQL_FULL_OUT?.trim() || '';
const NOW = Date.parse('2026-10-18T03:04:05.000Z');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const MENTOR = 'a0000000-0000-4000-8000-000000000002';
const COURSE = 'course-v1:Landa+C1+2026';
const SECTION = 'c0000000-0000-4000-8000-000000000001';

/** One row with every column a courses statement reads. */
const ROW = {
  id: COURSE, tenant_id: TENANT, display_name: 'Khóa học A', description: 'Mô tả', org: 'Landa',
  visible_to_staff_only: false, image_url: 'img.png', start_date: '2026-01-01T00:00:00.000Z', end_date: null,
  created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-02T00:00:00.000Z', count: '3', full_count: '3',
  category_id: 'cat-1', category_name: 'Danh mục 1', is_public: false, creator_id: USER, creator_display_name: 'Admin',
  mentor_id: MENTOR, mentor_username: 'mentor01', mentor_full_name: 'Mentor', mentor_email: 'm@example.test',
  mentor_phone: '0900', mentor_avatar: null, mentor_role: 'staff', mentor_bio: 'bio', mentor_name: 'Mentor',
  username: 'mentor01', email: 'm@example.test', full_name: 'Mentor', phone: '0900', avatar: null, role: 'staff', bio: 'bio',
  role_label: 'Nhân viên', label: 'Nhân viên', display_name_user: 'Admin',
  course_id: COURSE, logo_light_path: `${TENANT}/courses/${COURSE}/mentor-section/light.png`, logo_dark_path: null,
  logo_path: `${TENANT}/courses/${COURSE}/mentor-section/dark.png`,
  assigned_by: USER, assigned_to: MENTOR, assigned_by_display_name: 'Admin', assigned_to_display_name: 'Mentor',
  action: 'assign', assigned_at: '2026-03-01T00:00:00.000Z',
  parent_id: null, block_type: 'chapter', data: '<p>x</p>', metadata: { a: 1 }, sort_order: 1,
  welcome_enabled: true, welcome_title: 'Chào', section_id: SECTION, enabled: true, title: 'Tiêu đề',
  max_courses: 100, current_count: '1', quota: 100, used: '1', limit: 100, plan_limit: 100,
};

type Answer = (text: string, index: number) => { rows: unknown[] } | undefined;

interface Statement {
  via: string;
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
  const handler = (via: string) => async (config: string | { text: string; values?: unknown[] }, values: unknown[] = []) => {
    const text = typeof config === 'string' ? config : config.text;
    statements.push({ via, text, params: [...(typeof config === 'string' ? values : (config.values ?? []))] });
    return reply(text);
  };
  t.mock.method(pg.default.Pool.prototype, 'query', async function (this: unknown, config: string, values?: unknown[]) {
    return handler(this === pool ? 'pool' : 'other-pool')(config, values);
  });
  t.mock.method(pg.default.Pool.prototype, 'connect', async function (this: unknown) {
    return { query: handler(this === pool ? 'client' : 'other-client'), release() {} };
  });
  return statements;
}

interface FakeResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, unknown>;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  send(body: unknown): FakeResponse;
  setHeader(name: string, value: unknown): FakeResponse;
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

interface CallOptions {
  role?: string;
  tenantId?: string | null;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: unknown;
  file?: unknown;
  originalUrl?: string;
}

async function call(handler: Handler, options: CallOptions = {}) {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
  };
  let passed: unknown;
  const req = {
    user: {
      id: USER,
      tenantId: options.tenantId === undefined ? TENANT : options.tenantId,
      role: options.role ?? 'superuser',
      username: 'admin01',
      sessionMode: 'normal',
    },
    query: options.query ?? {},
    params: { id: COURSE, mode: 'light', jobId: 'job-1', ...options.params },
    body: 'body' in options ? options.body : {},
    file: options.file,
    originalUrl: options.originalUrl ?? `/api/courses/${encodeURIComponent(COURSE)}`,
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  } as unknown as Request;
  await handler(req, res as unknown as Response, (error?: unknown) => {
    passed = error;
  });
  if (passed !== undefined) {
    const error = passed as { name?: string; message?: string; statusCode?: unknown; code?: unknown };
    return {
      next: {
        name: error?.name ?? null,
        message: error?.message ?? String(passed),
        statusCode: error?.statusCode ?? null,
        code: error?.code ?? null,
      },
    };
  }
  return { status: res.statusCode, body: res.body, headers: res.headers };
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
const rowsWhen =
  (pattern: RegExp, rows: unknown[]): Answer =>
  text =>
    pattern.test(text) ? { rows } : undefined;

const H = ctrl;
const LOGO = { originalname: 'Logo mới.png', mimetype: 'image/png', size: 2048, buffer: Buffer.from('png') };

// ── List and export ──
add('list', () => call(H.listController));
add('list filtered staff only', () =>
  call(H.listController, { query: { search: 'Excel', visibility: 'staff_only', page: '2', page_size: '5' } }),
);
add('list public', () => call(H.listController, { query: { visibility: 'public' } }));
add('list odd query', () => call(H.listController, { query: { search: ['a', 'b'], page: 'x', page_size: '0', visibility: ['public'] } }));
add('list no tenant', () => call(H.listController, { tenantId: null, query: { page_size: '500' } }));
add('list empty', () => call(H.listController), text => (/COUNT\(\*\) AS count/.test(text) ? { rows: [{ count: '0' }] } : { rows: [] }));
add('export markdown', () => call(H.exportMarkdownController));
add('export markdown raw id', () =>
  call(H.exportMarkdownController, { originalUrl: `/api/courses/x/export-markdown?id=${encodeURIComponent('course-v1:Landa+C1+2026')}&b=1` }),
);
add('export markdown blank id', () => call(H.exportMarkdownController, { params: { id: '  ' } }));
add('export markdown no tenant', () => call(H.exportMarkdownController, { tenantId: null }));
add('export markdown missing', () => call(H.exportMarkdownController), noRowsAt(0));
add('export markdown no blocks', () => call(H.exportMarkdownController), noRowsAt(1));

// ── Create, update, bulk ──
const CREATE = { id: 'course-v1:Landa+NEW+2026', display_name: 'Khóa mới', description: 'Mô tả', org: 'Landa' };
add('create', () => call(H.createController, { body: CREATE }));
add('create full', () =>
  call(H.createController, {
    body: { ...CREATE, visible_to_staff_only: true, image_url: 'a.png', start_date: '2026-01-01', end_date: null },
  }),
);
add('create invalid', () => call(H.createController, { body: { id: '', display_name: 'x' } }));
add('create no body', () => call(H.createController, { body: undefined }));
add('create no tenant', () => call(H.createController, { tenantId: null, body: CREATE }));
add('create no tenant row', () => call(H.createController, { body: CREATE }), noRowsAt(0));
add('update', () => call(H.updateController, { body: { display_name: 'Tên mới', visible_to_staff_only: true, image_url: '' } }));
add('update description only', () => call(H.updateController, { body: { description: 'Mô tả mới' } }));
add('update other fields only', () => call(H.updateController, { body: { is_active: true } }));
add('update is_public', () => call(H.updateController, { body: { is_public: true } }));
add('update invalid', () => call(H.updateController, { body: { display_name: '' } }));
add('update empty', () => call(H.updateController, { body: {} }));
add('update no tenant', () => call(H.updateController, { tenantId: null, body: { description: 'x' } }));
add('update missing', () => call(H.updateController, { body: { description: 'x' } }), noRowsWhen(/FOR UPDATE/));
add('update vanished', () => call(H.updateController, { body: { description: 'x' } }), noRowsWhen(/^\s*UPDATE courses/));
add('bulk staff only', () => call(H.bulkActionController, { body: { ids: [COURSE, 'c2'], action: 'staff_only' } }));
add('bulk public', () => call(H.bulkActionController, { body: { ids: [COURSE], action: 'public' } }));
add('bulk none updated', () =>
  call(H.bulkActionController, { body: { ids: [COURSE], action: 'public' } }),
  noRowsWhen(/^\s*UPDATE courses/),
);
add('bulk invalid', () => call(H.bulkActionController, { body: { ids: [], action: 'public' } }));
add('bulk no tenant', () => call(H.bulkActionController, { tenantId: null, body: { ids: ['a'], action: 'public' } }));

// ── Mentor ──
add('mentor', () => call(H.getMentorController));
add('mentor none', () => call(H.getMentorController), (_text, index) =>
  index === 0 ? { rows: [{ ...ROW, mentor_id: null }] } : undefined,
);
add('mentor missing', () => call(H.getMentorController), noRowsAt(0));
add('mentor no tenant', () => call(H.getMentorController, { tenantId: null }));
for (const role of ['staff', 'superuser', 'superadmin']) {
  add(`${role} mentor candidates`, () => call(H.listMentorCandidatesController, { role }));
  add(`${role} mentor history`, () => call(H.listMentorHistoryController, { role }));
  add(`${role} mentor section`, () => call(H.getMentorSectionController, { role }));
  add(`${role} mentor update`, () => call(H.updateMentorController, { role, body: { mentor_id: USER } }));
}
add('mentor candidates search', () =>
  call(H.listMentorCandidatesController, { query: { search: 'Nguyễn', page: '2', page_size: '10' } }),
);
add('mentor candidates empty', () => call(H.listMentorCandidatesController), noRowsAt(1));
add('mentor candidates missing course', () => call(H.listMentorCandidatesController), noRowsAt(0));
add('mentor candidates no tenant', () => call(H.listMentorCandidatesController, { tenantId: null }));
add('mentor update same', () => call(H.updateMentorController, { body: { mentor_id: ` ${MENTOR} ` } }));
add('mentor update remove', () => call(H.updateMentorController, { body: { mentor_id: null } }));
add('mentor update blank', () => call(H.updateMentorController, { body: { mentor_id: '  ' } }));
add('mentor update remove none', () => call(H.updateMentorController, { body: { mentor_id: null } }), (_text, index) =>
  index === 1 ? { rows: [{ mentor_id: null, display_name: 'Khóa học A', mentor_name: null }] } : undefined,
);
add('mentor update missing id', () => call(H.updateMentorController, { body: {} }));
add('mentor update number id', () => call(H.updateMentorController, { body: { mentor_id: 5 } }));
add('mentor update no body', () => call(H.updateMentorController, { body: undefined }));
add('mentor update missing course', () => call(H.updateMentorController, { body: { mentor_id: USER } }), noRowsAt(1));
add('mentor update invalid mentor', () =>
  call(H.updateMentorController, { body: { mentor_id: USER } }),
  noRowsWhen(/role IN \('staff', 'superuser'\)\s+AND is_active = true/),
);
add('mentor update unnamed users', () =>
  call(H.updateMentorController, { body: { mentor_id: USER } }),
  rowsWhen(/AS display_name/, []),
);
add('mentor update no tenant', () => call(H.updateMentorController, { tenantId: null, body: { mentor_id: USER } }));
add('mentor history filtered', () =>
  call(H.listMentorHistoryController, {
    query: { page: '3', page_size: '10', search: '  Nguyễn  50%_x ', date_from: '2026-01-01', date_to: '2026-02-28' },
  }),
);
add('mentor history iso dates', () =>
  call(H.listMentorHistoryController, { query: { date_from: '2026-01-01T05:00:00Z', date_to: '2026-01-02T05:00:00Z' } }),
);
add('mentor history page past end', () =>
  call(H.listMentorHistoryController, { query: { page: '9', page_size: '7' } }),
  rowsWhen(/COUNT\(\*\) AS count/, [{ count: '12' }]),
);
add('mentor history none', () => call(H.listMentorHistoryController, { query: { page: '0' } }), rowsWhen(/COUNT\(\*\) AS count/, [{ count: '0' }]));
add('mentor history short search', () => call(H.listMentorHistoryController, { query: { search: 'a', page: 'x' } }));
add('mentor history bad date', () => call(H.listMentorHistoryController, { query: { date_from: '2026-02-30' } }));
add('mentor history bad date to', () => call(H.listMentorHistoryController, { query: { date_to: 'nope' } }));
add('mentor history reversed dates', () =>
  call(H.listMentorHistoryController, { query: { date_from: '2026-02-01', date_to: '2026-01-01' } }),
);
add('mentor history missing course', () => call(H.listMentorHistoryController), noRowsAt(0));
add('mentor history no tenant', () => call(H.listMentorHistoryController, { tenantId: null }));
add('mentor history unnamed', () => call(H.listMentorHistoryController), (_text, index) =>
  index === 2 ? { rows: [{ ...ROW, id: 7, assigned_by: null, assigned_by_display_name: null, assigned_to: undefined }] } : undefined,
);

// ── Mentor section ──
add('mentor section none', () => call(H.getMentorSectionController), noRowsAt(1));
add('mentor section missing course', () => call(H.getMentorSectionController), noRowsAt(0));
add('mentor section no tenant', () => call(H.getMentorSectionController, { tenantId: null }));
add('mentor section update', () => call(H.updateMentorSectionController, { body: { description: '  Giới thiệu  ' } }));
add('mentor section update blank', () => call(H.updateMentorSectionController, { body: { description: '   ' } }));
add('mentor section update null', () => call(H.updateMentorSectionController, { body: {} }));
add('mentor section update invalid', () => call(H.updateMentorSectionController, { body: { description: 'x'.repeat(2001) } }));
add('mentor section update staff', () => call(H.updateMentorSectionController, { role: 'staff', body: {} }));
add('mentor section update missing course', () => call(H.updateMentorSectionController, { body: {} }), noRowsAt(0));
add('mentor section update no tenant', () => call(H.updateMentorSectionController, { tenantId: null, body: {} }));

// ── Mentor section logo (Storage through the fetch double) ──
add('logo upload light', () => call(H.uploadMentorSectionLogoController, { body: { mode: 'light' }, file: LOGO }));
add('logo upload dark', () => call(H.uploadMentorSectionLogoController, { body: { mode: 'dark' }, file: LOGO }));
add('logo upload no old logo', () =>
  call(H.uploadMentorSectionLogoController, { body: { mode: 'light' }, file: LOGO }),
  noRowsWhen(/SELECT logo_light_path, logo_dark_path/),
);
add('logo upload old external logo', () =>
  call(H.uploadMentorSectionLogoController, { body: { mode: 'light' }, file: LOGO }),
  rowsWhen(/SELECT logo_light_path, logo_dark_path/, [{ logo_light_path: 'https://cdn.example.test/a.png', logo_dark_path: null }]),
);
add('logo upload bad mode', () => call(H.uploadMentorSectionLogoController, { body: { mode: 'blue' }, file: LOGO }));
add('logo upload no file', () => call(H.uploadMentorSectionLogoController, { body: { mode: 'light' } }));
add('logo upload too big', () =>
  call(H.uploadMentorSectionLogoController, { body: { mode: 'light' }, file: { ...LOGO, size: 6 * 1024 * 1024 } }),
);
add('logo upload bad type', () =>
  call(H.uploadMentorSectionLogoController, { body: { mode: 'light' }, file: { ...LOGO, mimetype: 'application/pdf' } }),
);
add('logo upload staff', () => call(H.uploadMentorSectionLogoController, { role: 'staff', body: { mode: 'light' }, file: LOGO }));
add('logo upload missing course', () =>
  call(H.uploadMentorSectionLogoController, { body: { mode: 'light' }, file: LOGO }),
  noRowsAt(0),
);
add('logo upload no tenant', () => call(H.uploadMentorSectionLogoController, { tenantId: null, body: { mode: 'light' }, file: LOGO }));
add('logo delete light', () => call(H.deleteMentorSectionLogoController));
add('logo delete dark', () => call(H.deleteMentorSectionLogoController, { params: { mode: 'dark' } }));
add('logo delete no section', () => call(H.deleteMentorSectionLogoController), noRowsWhen(/AS logo_path/));
add('logo delete empty', () => call(H.deleteMentorSectionLogoController), rowsWhen(/AS logo_path/, [{ logo_path: null }]));
add('logo delete external', () =>
  call(H.deleteMentorSectionLogoController),
  rowsWhen(/AS logo_path/, [{ logo_path: 'https://cdn.example.test/a.png' }]),
);
add('logo delete bad mode', () => call(H.deleteMentorSectionLogoController, { params: { mode: 'x' } }));
add('logo delete staff', () => call(H.deleteMentorSectionLogoController, { role: 'staff' }));
add('logo delete missing course', () => call(H.deleteMentorSectionLogoController), noRowsAt(0));
add('logo delete no tenant', () => call(H.deleteMentorSectionLogoController, { tenantId: null }));

// ── Modal configs ──
add('modal config', () => call(H.getModalConfigController));
// The popup reads check the course tenant first (statement 0), like their writes.
add('modal config default', () => call(H.getModalConfigController), noRowsAt(1));
add('modal config missing course', () => call(H.getModalConfigController), noRowsAt(0));
add('modal config no tenant', () => call(H.getModalConfigController, { tenantId: null }));
add('modal config update', () =>
  call(H.updateModalConfigController, { body: { welcome_enabled: true, welcome_title: 'Chào', bogus: 1, completion_social_link: null } }),
);
add('modal config update nothing', () => call(H.updateModalConfigController, { body: { bogus: 1 } }));
add('modal config update no body', () => call(H.updateModalConfigController, { body: undefined }));
add('modal config update missing course', () => call(H.updateModalConfigController, { body: { welcome_enabled: true } }), noRowsAt(0));
add('modal config update no tenant', () => call(H.updateModalConfigController, { tenantId: null, body: { welcome_enabled: true } }));
add('section modal', () => call(H.getSectionModalController, { query: { section_id: SECTION } }));
add('section modal default', () => call(H.getSectionModalController, { query: { section_id: SECTION } }), noRowsAt(1));
add('section modal missing course', () => call(H.getSectionModalController, { query: { section_id: SECTION } }), noRowsAt(0));
add('section modal no tenant', () => call(H.getSectionModalController, { tenantId: null, query: { section_id: SECTION } }));
add('section modal no section', () => call(H.getSectionModalController));
add('section modal update', () =>
  call(H.updateSectionModalController, { body: { section_id: SECTION, enabled: true, title: 'T', description: 'D' } }),
);
add('section modal update defaults', () => call(H.updateSectionModalController, { body: { section_id: SECTION } }));
add('section modal update missing course', () => call(H.updateSectionModalController, { body: { section_id: SECTION } }), noRowsAt(0));
add('section modal update no tenant', () => call(H.updateSectionModalController, { tenantId: null, body: { section_id: SECTION } }));

// ── Runner ──

// Storage quota reservations get a random id per call; any UUID that is not
// one of this file's fixed ids is recorded as "<random-uuid>".
const FIXED_IDS = new Set([TENANT, USER, MENTOR, SECTION]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' && UUID.test(item) && !FIXED_IDS.has(item) ? '<random-uuid>' : item,
    ),
  );
}

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
  test(`courses characterization: ${item.name}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    t.mock.method(console, 'warn', () => undefined);
    t.mock.method(console, 'error', () => undefined);
    storageRequests.length = 0;
    const statements = installDb(t, item.answer);
    let result: unknown;
    try {
      result = plain(await item.run());
    } catch (error) {
      result = { thrown: (error as Error).name, message: (error as Error).message };
    }
    const outcome = stable({
      statements: statements.map(s => ({ via: s.via, sql: s.text.replace(/\s+/g, ' ').trim(), params: plain(s.params) })),
      storage: [...storageRequests],
      result,
    });
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
