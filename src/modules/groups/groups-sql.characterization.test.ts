import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';

// Characterization of the group routes (/api/groups): every SQL statement
// (text without whitespace differences, parameters, pool or transaction
// client) and the answer (status, body, headers, or the error passed to next)
// of every groups handler, over a matrix of queries, bodies and empty
// results. The golden file was written by the code before the groups
// repository existed; moving SQL into repositories must keep every entry
// equal.
//
// No database, Redis or network: a pg double answers every statement with one
// fixed row (or none, per case). Rewrite the golden file only for an intended
// change:
//   GROUPS_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/groups/groups-sql.characterization.test.ts
// GROUPS_SQL_FULL_OUT=<file> also writes every outcome in full.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

// No group route calls Storage; a request would be recorded, never sent.
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
const ctrl = await import('./groups.controller.js');

redis.installRedisClient(null);

test.after(async () => {
  await pool.end();
});

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'groups-sql.characterization.golden.json');
const WRITE_GOLDEN = process.env.GROUPS_SQL_GOLDEN_WRITE === '1';
const FULL_OUT = process.env.GROUPS_SQL_FULL_OUT?.trim() || '';
const NOW = Date.parse('2026-10-18T03:04:05.000Z');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-000000000001';
const MEMBER = 'a0000000-0000-4000-8000-000000000002';
const MEMBER_2 = 'a0000000-0000-4000-8000-000000000003';
const ORG = 'e0000000-0000-4000-8000-000000000001';
const SUB = 'e0000000-0000-4000-8000-000000000002';
const TEAM = 'e0000000-0000-4000-8000-000000000003';
const CATEGORY = 'f0000000-0000-4000-8000-000000000001';
const CATEGORY_2 = 'f0000000-0000-4000-8000-000000000002';
const COURSE = 'course-v1:Landa+G1+2026';

/** One row with every column a groups statement reads. */
const ROW = {
  id: TEAM, tenant_id: TENANT, name: 'Nhóm A', description: 'Mô tả', created_at: '2026-02-01T00:00:00.000Z',
  count: '3', subgroup_count: '2', team_count: '2', member_count: '4', course_count: '1', category_count: '1',
  course_category_count: '2', org_group_id: ORG, org_group_name: 'Nhóm A', sub_group_id: SUB, subgroup_name: 'Phân nhóm A',
  team_name: 'Team A', username: 'learner01', email: 'l@example.test', full_name: 'Học viên', avatar: null,
  added_at: '2026-03-01T00:00:00.000Z', course_id: COURSE, display_name: 'Khóa học A', assigned_at: '2026-03-02T00:00:00.000Z',
  category_id: CATEGORY, slug: 'dm-1', user_id: MEMBER, course_name: 'Khóa học A', category_name: 'Danh mục 1',
  action: 'UPDATE', entity_type: 'team', entity_id: TEAM, entity_name: 'Team A', actor_username: 'admin01',
  label: 'Nhóm', level: 'group',
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
    // No user is an active demo iframe account unless a case says so.
    const demo = /tenant_demo_iframe_settings/.test(text) ? [] : undefined;
    const rows = custom?.rows ?? demo ?? (/^\s*(BEGIN|COMMIT|ROLLBACK|SET|SAVEPOINT|RELEASE)/i.test(text) ? [] : [ROW]);
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
      role: options.role ?? 'staff',
      username: 'admin01',
      sessionMode: 'normal',
    },
    query: options.query ?? {},
    params: { id: TEAM, groupId: ORG, subgroupId: SUB, teamId: TEAM, userId: MEMBER, courseId: encodeURIComponent(COURSE), categoryId: CATEGORY, ...options.params },
    body: 'body' in options ? options.body : {},
    file: options.file,
    originalUrl: options.originalUrl ?? '/api/groups',
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

// ── Org groups ──
add('org groups', () => call(H.listOrgGroupsController));
add('org groups filtered', () => call(H.listOrgGroupsController, { query: { search: 'Kinh doanh', page: '2', page_size: '5' } }));
add('org groups odd query', () => call(H.listOrgGroupsController, { query: { search: ['a'], page: 'x', page_size: '1000' } }));
add('org groups no tenant', () => call(H.listOrgGroupsController, { tenantId: null }));
add('org group create', () => call(H.createOrgGroupController, { body: { name: 'Nhóm mới', description: 'Mô tả', extra: 1 } }));
add('org group create no description', () => call(H.createOrgGroupController, { body: { name: 'Nhóm mới' } }));
add('org group create invalid', () => call(H.createOrgGroupController, { body: { name: '' } }));
add('org group create no tenant', () => call(H.createOrgGroupController, { tenantId: null, body: { name: 'x' } }));
add('org group update', () =>
  call(H.updateOrgGroupController, { params: { id: ORG }, body: { name: 'Tên mới', description: 'Mô tả mới' } }),
);
add('org group update same name', () => call(H.updateOrgGroupController, { params: { id: ORG }, body: { name: 'Nhóm A' } }));
add('org group update description only', () =>
  call(H.updateOrgGroupController, { params: { id: ORG }, body: { description: '' } }),
);
add('org group update nothing', () => call(H.updateOrgGroupController, { params: { id: ORG }, body: {} }));
add('org group update missing', () =>
  call(H.updateOrgGroupController, { params: { id: ORG }, body: { name: 'x' } }),
  noRowsWhen(/FOR UPDATE/),
);
add('org group update vanished', () =>
  call(H.updateOrgGroupController, { params: { id: ORG }, body: { name: 'x' } }),
  noRowsWhen(/^UPDATE org_groups/),
);
add('org group update no tenant', () => call(H.updateOrgGroupController, { tenantId: null, body: { name: 'x' } }));
add('org group delete', () => call(H.deleteOrgGroupController, { params: { id: ORG } }));
add('org group delete missing', () =>
  call(H.deleteOrgGroupController, { params: { id: ORG } }),
  noRowsWhen(/^DELETE FROM org_groups/),
);
add('org group delete no tenant', () => call(H.deleteOrgGroupController, { tenantId: null }));

// ── Sub groups ──
add('subgroups', () => call(H.listSubGroupsController));
add('subgroups search', () => call(H.listSubGroupsController, { query: { search: 'Bắc' } }));
add('subgroups empty', () => call(H.listSubGroupsController), noRowsAt(0));
add('subgroups no tenant', () => call(H.listSubGroupsController, { tenantId: null }));
add('subgroup create', () => call(H.createSubGroupController, { body: { name: 'Phân nhóm mới' } }));
add('subgroup create other tenant', () =>
  call(H.createSubGroupController, { body: { name: 'x' } }),
  noRowsWhen(/INSERT INTO sub_groups/),
);
add('subgroup create invalid', () => call(H.createSubGroupController, { body: {} }));
add('subgroup create no tenant', () => call(H.createSubGroupController, { tenantId: null, body: { name: 'x' } }));
add('subgroup detail', () => call(H.getSubGroupDetailController, { params: { id: SUB } }));
add('subgroup detail empty lists', () =>
  call(H.getSubGroupDetailController, { params: { id: SUB } }),
  (_text, index) => (index > 0 ? { rows: [] } : undefined),
);
add('subgroup detail missing', () => call(H.getSubGroupDetailController, { params: { id: SUB } }), noRowsAt(0));
add('subgroup detail no tenant', () => call(H.getSubGroupDetailController, { tenantId: null }));
add('subgroup update', () => call(H.updateSubGroupController, { params: { id: SUB }, body: { name: 'Tên mới' } }));
add('subgroup update missing', () =>
  call(H.updateSubGroupController, { params: { id: SUB }, body: { name: 'x' } }),
  noRowsWhen(/FOR UPDATE OF sg/),
);
add('subgroup update vanished', () =>
  call(H.updateSubGroupController, { params: { id: SUB }, body: { name: 'x' } }),
  noRowsWhen(/^UPDATE sub_groups/),
);
add('subgroup update no tenant', () => call(H.updateSubGroupController, { tenantId: null, body: { name: 'x' } }));
add('subgroup delete', () => call(H.deleteSubGroupController, { params: { id: SUB } }));
add('subgroup delete missing', () =>
  call(H.deleteSubGroupController, { params: { id: SUB } }),
  noRowsWhen(/^DELETE FROM sub_groups/),
);
add('subgroup delete no tenant', () => call(H.deleteSubGroupController, { tenantId: null }));

// ── Teams ──
add('teams', () => call(H.listTeamsController));
add('teams search', () => call(H.listTeamsController, { query: { search: 'A' } }));
add('teams empty', () => call(H.listTeamsController), noRowsAt(0));
add('teams no tenant', () => call(H.listTeamsController, { tenantId: null }));
add('team create', () => call(H.createTeamController, { body: { name: 'Team mới' } }));
add('team create other tenant', () => call(H.createTeamController, { body: { name: 'x' } }), noRowsWhen(/INSERT INTO teams/));
add('team create invalid', () => call(H.createTeamController, { body: { name: 5 } }));
add('team create no tenant', () => call(H.createTeamController, { tenantId: null, body: { name: 'x' } }));
add('team detail', () => call(H.getTeamDetailController));
add('team detail zero counts', () =>
  call(H.getTeamDetailController),
  () => ({ rows: [{ ...ROW, member_count: null, course_count: 0, category_count: undefined, course_category_count: '0' }] }),
);
add('team detail missing', () => call(H.getTeamDetailController), noRowsAt(0));
add('team detail no tenant', () => call(H.getTeamDetailController, { tenantId: null }));
for (const [label, handler] of [
  ['members', H.listTeamMembersController],
  ['doc categories', H.listTeamDocCategoriesController],
  ['course categories', H.listTeamCourseCategoriesController],
] as const) {
  add(`team ${label}`, () => call(handler));
  add(`team ${label} search`, () => call(handler, { query: { search: 'Nguyễn', page: '3', page_size: '10' } }));
  add(`team ${label} odd query`, () => call(handler, { query: { search: ['x'], page: '-1', page_size: 'abc' } }));
  add(`team ${label} empty`, () => call(handler), () => ({ rows: [] }));
  add(`team ${label} no tenant`, () => call(handler, { tenantId: null }));
}
add('team update', () => call(H.updateTeamController, { body: { name: 'Tên mới' } }));
add('team update missing', () => call(H.updateTeamController, { body: { name: 'x' } }), noRowsWhen(/FOR UPDATE OF t/));
add('team update vanished', () => call(H.updateTeamController, { body: { name: 'x' } }), noRowsWhen(/^UPDATE teams/));
add('team update no tenant', () => call(H.updateTeamController, { tenantId: null, body: { name: 'x' } }));
add('team delete', () => call(H.deleteTeamController));
add('team delete missing', () => call(H.deleteTeamController), noRowsWhen(/^DELETE FROM teams/));
add('team delete no tenant', () => call(H.deleteTeamController, { tenantId: null }));

// ── Members ──
add('smtp status', () => call(H.groupSmtpStatusController));
add('smtp status none', () => call(H.groupSmtpStatusController), noRowsAt(0));
add('smtp status no tenant', () => call(H.groupSmtpStatusController, { tenantId: null }));
add('members add', () =>
  call(H.addTeamMembersController, { body: { user_ids: [MEMBER, ` ${MEMBER_2} `, MEMBER, 5, ''] } }),
  rowsWhen(/RETURNING user_id/, [{ user_id: MEMBER }, { user_id: MEMBER_2 }]),
);
add('members add none eligible', () =>
  call(H.addTeamMembersController, { body: { user_ids: [MEMBER] } }),
  noRowsWhen(/RETURNING user_id/),
);
add('members add no categories', () =>
  call(H.addTeamMembersController, { body: { user_ids: [MEMBER] } }),
  noRowsWhen(/GROUP BY cc\.id, cc\.name/),
);
add('members add empty list', () => call(H.addTeamMembersController, { body: { user_ids: [' ', 3] } }));
add('members add demo user', () =>
  call(H.addTeamMembersController, { body: { user_ids: [MEMBER] } }),
  rowsWhen(/tenant_demo_iframe_settings/, [{ demo_user_id: MEMBER }]),
);
add('members add team missing', () =>
  call(H.addTeamMembersController, { body: { user_ids: [MEMBER] } }),
  noRowsWhen(/FOR SHARE/),
);
add('members add not a list', () => call(H.addTeamMembersController, { body: { user_ids: MEMBER } }));
add('members add no tenant', () => call(H.addTeamMembersController, { tenantId: null, body: { user_ids: [MEMBER] } }));
add('member remove', () => call(H.removeTeamMemberController));
add('member remove unnamed', () => call(H.removeTeamMemberController), noRowsWhen(/JOIN users u ON u\.id = \$2/));
add('member remove not member', () => call(H.removeTeamMemberController), noRowsWhen(/^DELETE FROM team_members/));
add('member remove demo user', () =>
  call(H.removeTeamMemberController),
  rowsWhen(/tenant_demo_iframe_settings/, [{ demo_user_id: MEMBER, exists: true }]),
);
add('member remove no tenant', () => call(H.removeTeamMemberController, { tenantId: null }));

// ── Team courses and categories ──
add('courses assign', () => call(H.assignTeamCoursesController, { body: { course_ids: [COURSE] } }));
add('courses assign not a list', () => call(H.assignTeamCoursesController, { body: {} }));
add('courses assign no tenant', () => call(H.assignTeamCoursesController, { tenantId: null, body: { course_ids: [] } }));
add('course revoke', () => call(H.revokeTeamCourseController));
add('course revoke unnamed', () => call(H.revokeTeamCourseController), noRowsWhen(/LEFT JOIN courses c/));
add('course revoke not assigned', () => call(H.revokeTeamCourseController), noRowsWhen(/^DELETE FROM team_courses/));
add('course revoke other tenant team', () => call(H.revokeTeamCourseController), noRowsAt(1));
add('course revoke no tenant', () => call(H.revokeTeamCourseController, { tenantId: null }));
add('doc categories assign', () =>
  call(H.assignTeamDocCategoriesController, { body: { category_ids: [CATEGORY, ` ${CATEGORY_2}`, CATEGORY, 7] } }),
  (text, index) => (/INSERT INTO team_doc_categories/.test(text) && index % 2 === 0 ? { rows: [] } : undefined),
);
add('doc categories assign none', () =>
  call(H.assignTeamDocCategoriesController, { body: { category_ids: [CATEGORY] } }),
  noRowsWhen(/INSERT INTO team_doc_categories/),
);
add('doc categories assign unnamed team', () =>
  call(H.assignTeamDocCategoriesController, { body: { category_ids: [] } }),
  noRowsWhen(/SELECT name FROM teams/),
);
add('doc categories assign other tenant', () =>
  call(H.assignTeamDocCategoriesController, { body: { category_ids: [CATEGORY] } }),
  noRowsAt(0),
);
add('doc categories assign not a list', () => call(H.assignTeamDocCategoriesController, { body: { category_ids: 'x' } }));
add('doc categories assign no tenant', () =>
  call(H.assignTeamDocCategoriesController, { tenantId: null, body: { category_ids: [] } }),
);
add('doc category revoke', () => call(H.revokeTeamDocCategoryController));
add('doc category revoke unnamed', () => call(H.revokeTeamDocCategoryController), noRowsWhen(/LEFT JOIN document_categories/));
add('doc category revoke not assigned', () =>
  call(H.revokeTeamDocCategoryController),
  noRowsWhen(/^DELETE FROM team_doc_categories/),
);
add('doc category revoke no tenant', () => call(H.revokeTeamDocCategoryController, { tenantId: null }));
add('course categories assign', () =>
  call(H.assignTeamCourseCategoriesController, { body: { category_ids: [CATEGORY, CATEGORY_2] } }),
  (text, index) => (/INSERT INTO team_course_categories/.test(text) && index % 2 === 0 ? { rows: [] } : undefined),
);
add('course categories assign none', () =>
  call(H.assignTeamCourseCategoriesController, { body: { category_ids: [CATEGORY] } }),
  noRowsWhen(/INSERT INTO team_course_categories/),
);
add('course categories assign unnamed team', () =>
  call(H.assignTeamCourseCategoriesController, { body: { category_ids: [] } }),
  noRowsAt(2),
);
add('course categories assign other tenant', () =>
  call(H.assignTeamCourseCategoriesController, { body: { category_ids: [CATEGORY] } }),
  noRowsAt(1),
);
add('course categories assign not a list', () => call(H.assignTeamCourseCategoriesController, { body: {} }));
add('course categories assign no tenant', () =>
  call(H.assignTeamCourseCategoriesController, { tenantId: null, body: { category_ids: [] } }),
);
add('course category revoke', () => call(H.revokeTeamCourseCategoryController));
add('course category revoke unnamed', () =>
  call(H.revokeTeamCourseCategoryController),
  noRowsWhen(/LEFT JOIN course_categories/),
);
add('course category revoke not assigned', () =>
  call(H.revokeTeamCourseCategoryController),
  noRowsWhen(/^DELETE FROM team_course_categories/),
);
add('course category revoke no tenant', () => call(H.revokeTeamCourseCategoryController, { tenantId: null }));

// ── Audit logs ──
for (const role of ['staff', 'superuser', 'superadmin']) {
  add(`${role} audit logs`, () => call(H.groupAuditLogsController, { role }));
}
add('audit logs filtered', () =>
  call(H.groupAuditLogsController, {
    query: { search: 'Team', action: 'DELETE', date_from: '2026-01-01', date_to: '2026-02-01', page: '2', page_size: '15' },
  }),
);
add('audit logs action all short search', () => call(H.groupAuditLogsController, { query: { search: 'T', action: 'all' } }));
add('audit logs no tenant', () => call(H.groupAuditLogsController, { tenantId: null }));

// ── Runner ──

// Storage quota reservations get a random id per call; any UUID that is not
// one of this file's fixed ids is recorded as "<random-uuid>".
const FIXED_IDS = new Set([TENANT, USER, MEMBER, MEMBER_2, ORG, SUB, TEAM, CATEGORY, CATEGORY_2]);
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
  test(`groups characterization: ${item.name}`, async t => {
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
