import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  callHandler,
  noRowsWhen,
  rowsWhen,
  runCharacterization,
  type Answer,
  type CharacterizationCase,
  type Handler,
} from '../../test-support/staff-sql-characterization.js';

// Characterization of the course category routes (/api/course-categories):
// every SQL statement and the answer of every handler (src/test-support/
// staff-sql-characterization.ts). The golden file was written by the code before
// the course categories repository existed; moving SQL into repositories
// must keep every entry equal. Rewrite it only for an intended change:
//   COURSE_CATEGORIES_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/course-categories/course-categories-sql.characterization.test.ts
// COURSE_CATEGORIES_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./course-categories.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const CATEGORY = 'c0000000-0000-4000-8000-000000000001';
const TEAM = 'd0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:Landa+C1+2026';

/** One row with every column a course categories statement reads. */
const ROW = {
  id: CATEGORY, tenant_id: TENANT, name: 'Danh mục A', slug: 'danh-muc-a', description: 'Mô tả', sort_order: 1,
  is_public: false, course_count: '2', is_assigned_to_team: true, count: '3', group_id: TEAM, group_name: 'Nhóm',
  subgroup_id: TEAM, subgroup_name: 'Nhóm con', team_id: TEAM, team_name: 'Team', assigned_at: '2026-10-01T00:00:00.000Z',
  course_id: COURSE, display_name: 'Khóa A', category_name: 'Danh mục B', course_name: 'Khóa A',
};

interface CallOptions {
  role?: string;
  tenantId?: string | null;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  body?: unknown;
}

function call(handler: Handler, options: CallOptions = {}) {
  return callHandler(handler, {
    user: {
      id: USER,
      tenantId: options.tenantId === undefined ? TENANT : options.tenantId,
      role: options.role ?? 'superuser',
      username: 'admin01',
      sessionMode: 'normal',
    },
    query: options.query ?? {},
    params: { id: CATEGORY, courseId: encodeURIComponent(COURSE), ...options.params },
    body: 'body' in options ? options.body : {},
    originalUrl: '/api/course-categories',
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  });
}

const cases: CharacterizationCase[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const H = ctrl;

// ── Lists ──
add('list all', () => call(H.listController));
add('list all superadmin', () => call(H.listController, { role: 'superadmin', tenantId: null }));
add('list page', () => call(H.listController, { query: { page: '2', page_size: '5', search: 'Kế toán' } }));
add('list page assigned team', () => call(H.listController, { query: { assigned_team_id: ` ${TEAM} ` } }));
add('list page assigned team superadmin', () =>
  call(H.listController, { role: 'superadmin', tenantId: null, query: { assigned_team_id: TEAM, search: 'x' } }),
);
add('list page blank team', () => call(H.listController, { query: { assigned_team_id: ' ', page_size: '1000' } }));
add('list page odd query', () => call(H.listController, { query: { search: ['a'], page: 'x', assigned_team_id: ['t'] } }));
add('public impact', () => call(H.publicImpactController));
add('public impact limit', () => call(H.publicImpactController, { query: { limit: '500' } }));
add('public impact odd limit', () => call(H.publicImpactController, { query: { limit: 'x' } }));
add('public impact missing', () => call(H.publicImpactController), noRowsWhen(/FROM course_categories\s+WHERE id = \$1::uuid/));
add('public impact no tenant', () => call(H.publicImpactController, { tenantId: null }));
add('courses', () => call(H.getCoursesController));
add('courses empty', () => call(H.getCoursesController), noRowsWhen(/FROM course_category_courses ccc/));
add('courses no tenant', () => call(H.getCoursesController, { tenantId: null }));

// ── Writes ──
add('create', () => call(H.createController, { body: { name: 'Kế Toán 101', description: 'Mô tả', sort_order: 3 } }));
add('create minimal', () => call(H.createController, { body: { name: '  Excel  ' } }));
add('create no name', () => call(H.createController, { body: {} }));
add('create no tenant', () => call(H.createController, { tenantId: null, body: { name: 'x' } }));
add('update', () => call(H.updateController, { body: { name: 'Tên Mới', description: 'D', sort_order: 2, is_public: false } }));
add('update make public', () => call(H.updateController, { body: { is_public: true } }));
add('update already public', () =>
  call(H.updateController, { body: { is_public: true } }),
  rowsWhen(/FOR UPDATE/, [{ ...ROW, is_public: true }]),
);
add('update nothing', () => call(H.updateController, { body: {} }));
add('update missing', () => call(H.updateController, { body: { name: 'x' } }), noRowsWhen(/FOR UPDATE/));
add('update vanished', () => call(H.updateController, { body: { name: 'x' } }), noRowsWhen(/^\s*UPDATE course_categories/));
add('update no tenant', () => call(H.updateController, { tenantId: null, body: { name: 'x' } }));
add('delete', () => call(H.deleteController));
add('delete missing', () => call(H.deleteController), noRowsWhen(/DELETE FROM course_categories/));
add('delete no tenant', () => call(H.deleteController, { tenantId: null }));
add('add courses', () => call(H.addCoursesController, { body: { course_ids: [` ${COURSE} `, COURSE, 5, '', 'course-v1:Landa+C2+2026'] } }));
add('add courses none inserted', () =>
  call(H.addCoursesController, { body: { course_ids: [COURSE] } }),
  text => (/INSERT INTO course_category_courses/.test(text) ? { rows: [], rowCount: 0 } : undefined),
);
add('add courses empty', () => call(H.addCoursesController, { body: { course_ids: [] } }));
add('add courses too many', () =>
  call(H.addCoursesController, { body: { course_ids: Array.from({ length: 501 }, (_, i) => `c${i}`) } }),
);
add('add courses missing category', () =>
  call(H.addCoursesController, { body: { course_ids: [COURSE] } }),
  noRowsWhen(/FROM course_categories\s+WHERE id = \$1::uuid/),
);
add('add courses not a list', () => call(H.addCoursesController, { body: { course_ids: COURSE } }));
add('add courses no tenant', () => call(H.addCoursesController, { tenantId: null, body: { course_ids: [] } }));
add('remove course', () => call(H.removeCourseController));
add('remove course unnamed', () =>
  call(H.removeCourseController),
  rowsWhen(/AS category_name,\s+c\.display_name AS course_name/, [{ tenant_id: TENANT, category_name: '', course_name: null }]),
);
add('remove course missing category', () =>
  call(H.removeCourseController),
  noRowsWhen(/AS category_name,\s+c\.display_name AS course_name/),
);
add('remove course not linked', () => call(H.removeCourseController), noRowsWhen(/DELETE FROM course_category_courses/));
add('remove course no tenant', () => call(H.removeCourseController, { tenantId: null }));

runCharacterization({
  label: 'course categories characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'course-categories-sql.characterization.golden.json'),
  writeGolden: process.env.COURSE_CATEGORIES_SQL_GOLDEN_WRITE === '1',
  fullOut: process.env.COURSE_CATEGORIES_SQL_FULL_OUT?.trim() || '',
  cases,
  pool,
  defaultRow: ROW,
  now: Date.parse('2026-10-19T03:04:05.000Z'),
  fixedIds: [TENANT, USER, CATEGORY, TEAM],
});
