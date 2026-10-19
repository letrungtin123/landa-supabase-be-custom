import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  answers,
  callHandler,
  failWhen,
  noRowsWhen,
  rowsWhen,
  runCharacterization,
  type Answer,
  type CharacterizationCase,
  type Handler,
} from '../../test-support/sql-characterization.js';

// Characterization of the tenant badge rule routes (/api/tenant-badges):
// every SQL statement and the answer of every handler (src/test-support/
// sql-characterization.ts). The golden file was written by the code before
// the tenant badges repository existed; moving SQL into repositories must
// keep every entry equal. Rewrite it only for an intended change:
//   TENANT_BADGES_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/tenant-badges/tenant-badges-sql.characterization.test.ts
// TENANT_BADGES_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const redis = await import('../../config/redis.js');
const { pool } = await import('../../config/database.js');
const ctrl = await import('./tenant-badges.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const BADGE = 'course_finisher';
const COURSE = 'course-v1:Landa+C1+2026';
const COURSE_2 = 'course-v1:Landa+C2+2026';

const SELECTED = { version: 1, type: 'completed_selected_courses', threshold: 1, requires_courses: true };

/** One row with every column a tenant badges statement reads. */
const ROW = {
  id: BADGE, name: 'Hoàn thành khóa', description: 'Mô tả', image_key: 'finisher', card_image_url: null,
  icon_image_url: null, mobile_card_image_url: null, sort_order: '1', criteria: SELECTED, is_enabled: true,
  updated_at: '2026-10-01T00:00:00.000Z', courses: [{ course_id: COURSE, display_name: 'Khóa A', is_deleted: false }],
  enabled: true, count: '2', display_name: 'Khóa A', visible_to_staff_only: false, course_id: COURSE,
};

const anyCourses = { version: 1, type: 'completed_any_courses', threshold: 1 };
const noCourseRule: Answer = text =>
  /SELECT COALESCE\(NULLIF\(BTRIM\(tbs\.name_override\), ''\), b\.name\) AS name, b\.criteria/.test(text)
    ? { rows: [{ name: 'Học chăm', criteria: anyCourses }] }
    : undefined;
const noCurrentCourses = noRowsWhen(/SELECT course_id\s+FROM tenant_badge_rule_courses/);

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
    params: { badgeId: BADGE, ...options.params },
    body: 'body' in options ? options.body : {},
    originalUrl: '/api/tenant-badges',
    get: () => undefined,
    headers: {},
    ip: '127.0.0.1',
  });
}

const cases: CharacterizationCase[] = [];
const add = (name: string, run: () => Promise<unknown>, answer?: Answer) => cases.push({ name, run, answer });
const H = ctrl;
const moduleOff = noRowsWhen(/AS enabled/);
const moduleOffRow = rowsWhen(/AS enabled/, [{ enabled: false }]);

// ── Lists ──
add('list', () => call(H.listBadges));
add('list module off', () => call(H.listBadges), moduleOffRow);
add('list module off superadmin', () => call(H.listBadges, { role: 'superadmin' }), moduleOffRow);
add('list odd rows', () =>
  call(H.listBadges),
  rowsWhen(/FROM badge_definitions b/, [
    { ...ROW, criteria: { version: 9 }, courses: null, sort_order: null, is_enabled: null },
    { ...ROW, id: 'x', criteria: anyCourses, courses: [] },
    {
      ...ROW,
      id: 'y',
      courses: [
        { course_id: COURSE, display_name: 'A', is_deleted: false },
        { course_id: COURSE, display_name: 'A', is_deleted: false },
        { course_id: null, display_name: 'Khóa học đã bị xóa', is_deleted: true },
      ],
    },
  ]),
);
add('list empty', () => call(H.listBadges), noRowsWhen(/FROM badge_definitions b/));
add('list no tenant', () => call(H.listBadges, { tenantId: null }));
add('courses', () => call(H.listCourses));
add('courses search', () => call(H.listCourses, { query: { search: 'Excel', page: '2', page_size: '5' } }));
add('courses odd query', () => call(H.listCourses, { query: { search: ['a'], page: 'x', page_size: '1000' } }));
add('courses module off', () => call(H.listCourses), moduleOffRow);
add('courses module off superadmin', () => call(H.listCourses, { role: 'superadmin' }), moduleOff);
add('courses empty', () => call(H.listCourses), text => (/COUNT\(\*\)/.test(text) ? { rows: [] } : /AS enabled/.test(text) ? undefined : { rows: [] }));
add('courses no tenant', () => call(H.listCourses, { tenantId: null }));

// ── Update ──
const COURSE_ROWS = rowsWhen(/SELECT id, display_name\s+FROM courses/, [{ id: COURSE, display_name: 'Khóa A' }]);
add('update enable with course', () => call(H.updateBadge, { body: { is_enabled: true, course_ids: [COURSE] } }), COURSE_ROWS);
add('update keep courses', () => call(H.updateBadge, { body: { is_enabled: false } }), COURSE_ROWS);
add('update clear courses', () => call(H.updateBadge, { body: { is_enabled: false, course_ids: [] } }));
add('update enable without courses', () =>
  call(H.updateBadge, { body: { is_enabled: true } }),
  answers(noCurrentCourses, COURSE_ROWS),
);
add('update too many courses', () => call(H.updateBadge, { body: { is_enabled: false, course_ids: [COURSE, COURSE_2] } }));
add('update unknown course', () =>
  call(H.updateBadge, { body: { is_enabled: true, course_ids: [COURSE_2] } }),
  noRowsWhen(/SELECT id, display_name\s+FROM courses/),
);
add('update rule without courses', () => call(H.updateBadge, { body: { is_enabled: true } }), answers(noCourseRule, noCurrentCourses));
add('update rule without courses given courses', () =>
  call(H.updateBadge, { body: { is_enabled: true, course_ids: [COURSE] } }),
  answers(noCourseRule, noCurrentCourses),
);
add('update unsupported rule', () =>
  call(H.updateBadge, { body: { is_enabled: true } }),
  rowsWhen(/AS name, b\.criteria/, [{ name: 'X', criteria: { version: 9 } }]),
);
add('update missing badge', () => call(H.updateBadge, { body: { is_enabled: true } }), noRowsWhen(/AS name, b\.criteria/));
add('update module off', () => call(H.updateBadge, { body: { is_enabled: true } }), moduleOffRow);
add('update not reloaded', () =>
  call(H.updateBadge, { body: { is_enabled: false, course_ids: [COURSE] } }),
  answers(COURSE_ROWS, noRowsWhen(/FROM badge_definitions b\s+LEFT JOIN tenant_badge_settings tbs\s+ON tbs\.badge_id = b\.id AND tbs\.tenant_id = \$1\s+LEFT JOIN tenant_badge_rules/)),
);
add('update write fails', () =>
  call(H.updateBadge, { body: { is_enabled: false, course_ids: [COURSE] } }),
  answers(COURSE_ROWS, failWhen(/INSERT INTO tenant_badge_rule_courses/, '23503')),
);
add('update duplicate courses', () => call(H.updateBadge, { body: { is_enabled: true, course_ids: [COURSE, COURSE] } }));
add('update invalid', () => call(H.updateBadge, { body: { is_enabled: 'yes' } }));
add('update no tenant', () => call(H.updateBadge, { tenantId: null, body: { is_enabled: true } }));

runCharacterization({
  label: 'tenant badges characterization',
  goldenPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'tenant-badges-sql.characterization.golden.json'),
  writeGolden: process.env.TENANT_BADGES_SQL_GOLDEN_WRITE === '1',
  fullOut: process.env.TENANT_BADGES_SQL_FULL_OUT?.trim() || '',
  cases,
  pool,
  defaultRow: ROW,
  now: Date.parse('2026-10-19T03:04:05.000Z'),
  fixedIds: [TENANT, USER],
});
