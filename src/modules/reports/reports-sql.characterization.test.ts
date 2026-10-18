import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import type { ReportCourseCompletionStatus } from './reports.service.js';

// Characterization of the reports module: every SQL statement a report read
// sends (pool, text without whitespace differences, parameters) and the
// answer it returns, for a matrix of filters, scopes, pages, statuses and
// periods, through the services, the scope check, the HTTP handlers and the
// Excel exports. The golden file was written by the code before the reports
// repositories existed; moving SQL into repositories or parsing the query
// with zod must keep every entry equal.
//
// No database, Redis or network: a pg double answers every statement with
// one fixed row. The golden file keeps one digest per case. Rewrite it only
// for an intended change:
//   REPORTS_SQL_GOLDEN_WRITE=1 npx tsx --test src/modules/reports/reports-sql.characterization.test.ts
// REPORTS_SQL_FULL_OUT=<file> also writes every outcome in full (SQL text,
// parameters, answer), to diff two versions of the code when a digest differs.

process.env.TZ = 'Asia/Ho_Chi_Minh';
process.env.REDIS_URL = 'redis://127.0.0.1:1';

const ExcelJS = (await import('exceljs')).default;
const pg = await import('pg');
const redis = await import('../../config/redis.js');
const { pool: mainPool } = await import('../../config/database.js');
const { endReportsPool } = await import('../../config/reports-database.js');
const svc = await import('./reports.service.js');
const access = await import('./report-access.service.js');
const ctrl = await import('./reports.controller.js');
const exportService = await import('./reports-export.service.js');

redis.installRedisClient(null);

test.after(async () => {
  await endReportsPool();
  await mainPool.end();
});

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reports-sql.characterization.golden.json');
const WRITE_GOLDEN = process.env.REPORTS_SQL_GOLDEN_WRITE === '1';
const FULL_OUT = process.env.REPORTS_SQL_FULL_OUT?.trim() || '';
const NOW = Date.parse('2026-10-18T03:04:05.000Z');

const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = 'a0000000-0000-4000-8000-000000000001';
const SUBGROUP = 'b0000000-0000-4000-8000-000000000001';
const TEAM = 'c0000000-0000-4000-8000-000000000001';
const COURSE = 'd0000000-0000-4000-8000-000000000001';

/** One row with every column a report statement reads. */
const ROW = {
  id: 'row-id', user_id: 'user-1', group_id: GROUP, subgroup_id: SUBGROUP, team_id: TEAM, visible: true, pid: 4242,
  entity_id: GROUP, m: 3, cnt: '7', value: '9', bucket: '2025-03-01', bucket_label: 'Tháng 3/2025', series_name: 'Phòng A',
  total_learners: '10', active_learners: '4', total_enrollments: '20', completed_enrollments: '5', incomplete_enrollments: '15',
  completion_rate: '42.50', not_started_enrollments: '3', in_progress_enrollments: '12', course_count: '2',
  not_started: '1', in_progress: '2', completed: '3', full_count: '41',
  course_id: COURSE, name: 'Khóa Excel', display_name: 'Khóa Excel', course_name: 'Khóa Excel', enrollments: '8',
  username: 'learner01', email: 'learner01@example.test', full_name: 'Nguyễn Văn A', avatar: null, avatar_url: null,
  enrolled_at: '2025-03-02T01:00:00.000Z', completed_at: null, progress: '50.00', status: 'learning',
  last_completion_at: null, completed_courses: '1', enrolled_courses: '2', incomplete_courses: '1', is_completed: false,
  group_name: 'Công ty A', subgroup_name: 'Chi nhánh B', team_name: 'Phòng C',
  groupName: 'Công ty A', subgroupName: 'Chi nhánh B', teamName: 'Phòng C',
  member_count: '6', period_month: 3, period_year: 2025, period_index: 0,
  group_names: 'Công ty A', subgroup_names: 'Chi nhánh B', team_names: 'Phòng C',
  enrollment_id: 'enr-1', sort_name: 'nguyen van a', badge_id: 'badge-1', earned_at: '2025-03-05T00:00:00.000Z',
  name_override: null, subgroup_count: 2, team_count: 3, date: '2025-03-02', minutes: '30',
};

type Answer = (text: string, index: number) => { rows: unknown[] } | undefined;

interface Statement {
  pool: 'main' | 'reports' | 'snapshot';
  text: string;
  params: unknown[];
}

function normalizeSql(text: string): string {
  return text.replace(/reports_cursor_\d+/g, 'reports_cursor_N').replace(/\s+/g, ' ').trim();
}

function digest(outcome: CaseOutcome): string {
  return createHash('sha256').update(JSON.stringify(outcome)).digest('hex');
}

/** JSON as an HTTP answer would carry it: Dates as ISO text, undefined dropped. */
function plain(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function installDb(t: TestContext, answer?: Answer): Statement[] {
  const statements: Statement[] = [];
  const reply = (text: string): { rows: unknown[]; rowCount: number } => {
    const custom = answer?.(text, statements.length - 1);
    const rows = custom?.rows ?? (/^\s*(BEGIN|COMMIT|ROLLBACK|CLOSE|DECLARE)/.test(text) ? [] : [ROW]);
    return { rows, rowCount: rows.length };
  };
  t.mock.method(pg.default.Pool.prototype, 'query', async function (this: unknown, text: string, params: unknown[] = []) {
    statements.push({ pool: this === mainPool ? 'main' : 'reports', text, params });
    return reply(text);
  });
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => {
    const fetched = new Set<string>();
    return {
      async query(text: string, params: unknown[] = []) {
        statements.push({ pool: 'snapshot', text, params });
        const fetch = /^FETCH FORWARD \d+ FROM (\w+)/.exec(text);
        if (fetch) {
          if (fetched.has(fetch[1])) return { rows: [], rowCount: 0 };
          fetched.add(fetch[1]);
          return { rows: [ROW], rowCount: 1 };
        }
        return reply(text);
      },
      release() {},
    };
  });
  return statements;
}

function describeError(error: unknown): unknown {
  if (error instanceof Error) {
    const { statusCode, code } = error as Error & { statusCode?: unknown; code?: unknown };
    return { error: error.name, message: error.message, statusCode: statusCode ?? null, code: code ?? null };
  }
  return { thrown: plain(error) };
}

interface CaseOutcome {
  statements: Array<{ pool: string; sql: string; params: unknown }>;
  result: unknown;
}

async function runCase(t: TestContext, run: () => Promise<unknown>, answer?: Answer): Promise<CaseOutcome> {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const statements = installDb(t, answer);
  let result: unknown;
  try {
    result = { value: plain(await run()) };
  } catch (error) {
    result = describeError(error);
  }
  return {
    statements: statements.map(statement => ({
      pool: statement.pool,
      sql: normalizeSql(statement.text),
      params: plain(statement.params),
    })),
    result,
  };
}

// ── HTTP handlers ──

interface FakeResponse {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  headers: Record<string, string>;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  setHeader(name: string, value: string): void;
}

function fakeResponse(): FakeResponse {
  return {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

type Query = Record<string, string | string[]>;

function fakeRequest(query: Query, options: { role?: string; params?: Record<string, string>; locale?: string } = {}): Request {
  return {
    user: { id: 'user-actor', tenantId: TENANT, role: options.role ?? 'admin', username: 'admin01' },
    query,
    params: options.params ?? {},
    get: (name: string) => (name.toLowerCase() === 'x-ui-locale' ? options.locale : undefined),
  } as unknown as Request;
}

async function callHandler(
  handler: (req: Request, res: Response) => Promise<unknown>,
  query: Query,
  options: { role?: string; params?: Record<string, string>; locale?: string } = {},
): Promise<unknown> {
  const res = fakeResponse();
  await handler(fakeRequest(query, options), res as unknown as Response);
  return { status: res.statusCode, body: res.body, headers: res.headers };
}

// ── Excel ──

async function workbookValues(run: (stream: PassThrough) => Promise<void>): Promise<unknown> {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  await run(stream);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
  return workbook.worksheets.map(sheet => {
    const rows: unknown[] = [];
    sheet.eachRow({ includeEmpty: false }, row => rows.push(row.values));
    return { name: sheet.name, rows };
  });
}

const EXPORT_LABELS = { group: 'Công ty', subgroup: 'Chi nhánh', team: 'Phòng ban' };

// ── The matrix ──

function range(dateFrom: string, dateTo: string) {
  return {
    startDate: new Date(`${dateFrom}T00:00:00.000+07:00`),
    endDate: new Date(`${dateTo}T23:59:59.999+07:00`),
    dateFrom,
    dateTo,
  };
}

const MARCH = range('2025-03-01', '2025-03-31');
const QUARTER = range('2025-01-01', '2025-03-15');
const YEAR = range('2025-01-01', '2025-12-31');

type Scope = [string | undefined, string | undefined, string | undefined];
const SCOPES: Record<string, Scope> = {
  tenant: [undefined, undefined, undefined],
  group: [GROUP, undefined, undefined],
  subgroup: [GROUP, SUBGROUP, undefined],
  team: [GROUP, SUBGROUP, TEAM],
};
const METRICS = ['total_learners', 'active_learners', 'total_enrollments', 'completion_rate'];
const STATUSES = ['all', 'not_started', 'learning', 'completed', 'bogus'] as const;

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

for (const [scopeName, scope] of Object.entries(SCOPES)) {
  add(`summary month ${scopeName}`, () => svc.getReportSummary(TENANT, 3, 2025, ...scope));
  add(`summary range ${scopeName}`, () => svc.getReportSummary(TENANT, undefined, undefined, ...scope, MARCH));
  add(`summary current month ${scopeName}`, () => svc.getReportSummary(TENANT, undefined, undefined, ...scope));

  for (const metric of METRICS) {
    add(`chart range ${metric} ${scopeName}`, () =>
      svc.getReportChart(TENANT, 2025, metric, ...scope, false, false, MARCH, 'auto', {}),
    );
    add(`chart year ${metric} ${scopeName}`, () => svc.getReportChart(TENANT, 2025, metric, ...scope, false, false));
    add(`chart year grouped ${metric} ${scopeName}`, () =>
      svc.getReportChart(TENANT, 2025, metric, ...scope, false, true),
    );
    add(`chart year by org ${metric} ${scopeName}`, () => svc.getReportChart(TENANT, 2025, metric, ...scope, true));
  }
  add(`chart range grouped enrollments ${scopeName}`, () =>
    svc.getReportChart(TENANT, 2025, 'total_enrollments', ...scope, false, true, QUARTER, 'auto', { seriesLimit: 3 }),
  );
  add(`chart range by org enrollments ${scopeName}`, () =>
    svc.getReportChart(TENANT, 2025, 'total_enrollments', ...scope, true, true, YEAR, 'auto', {}),
  );

  add(`top courses all time ${scopeName}`, () => svc.getReportTopCourses(TENANT, 1, 10, undefined, undefined, ...scope));
  add(`top courses year ${scopeName}`, () => svc.getReportTopCourses(TENANT, 2, 5, undefined, 2025, ...scope));
  add(`top courses month ${scopeName}`, () => svc.getReportTopCourses(TENANT, 1, 10, 3, 2025, ...scope));
  add(`top courses range ${scopeName}`, () =>
    svc.getReportTopCourses(TENANT, 1, 10, undefined, undefined, ...scope, MARCH),
  );

  add(`course ranking month ${scopeName}`, () =>
    svc.getReportCourseCompletionRanking(TENANT, 1, 10, 3, 2025, ...scope),
  );
  add(`course ranking range page 3 ${scopeName}`, () =>
    svc.getReportCourseCompletionRanking(TENANT, 3, 7, undefined, undefined, ...scope, MARCH),
  );
  add(`course performance ${scopeName}`, () => svc.getReportCoursePerformance(TENANT, 20, 3, 2025, ...scope));
  add(`course count ${scopeName}`, () => svc.getReportCourseCount(TENANT, ...scope, MARCH));
  add(`course by name ${scopeName}`, () => svc.findReportCoursePerformanceByName(TENANT, ' Excel ', ...scope, MARCH));
  add(`course by id ${scopeName}`, () => svc.getReportCoursePerformanceById(TENANT, ` ${COURSE} `, ...scope, MARCH));
  add(`completion status ${scopeName}`, () =>
    svc.getReportCompletionStatusDistribution(TENANT, 3, 2025, ...scope),
  );

  for (const status of STATUSES) {
    const typed = status as ReportCourseCompletionStatus;
    add(`course learners ${status} ${scopeName}`, () =>
      svc.getReportCourseCompletionLearners(TENANT, COURSE, 2, 20, undefined, 3, 2025, ...scope, typed),
    );
    add(`learners ${status} ${scopeName}`, () =>
      svc.getReportLearners(TENANT, 1, 20, undefined, undefined, undefined, ...scope, typed, MARCH),
    );
    add(`learner detail ${status} ${scopeName}`, () =>
      svc.getLearnerDetail(TENANT, 'learner01', 1, 10, '', ...scope, typed),
    );
    add(`learner detail report_filter ${status} ${scopeName}`, () =>
      svc.getLearnerDetail(TENANT, 'learner01', 2, 10, '', ...scope, typed, 'report_filter', MARCH),
    );
    add(`learner detail history ${status} ${scopeName}`, () =>
      svc.getLearnerDetail(TENANT, 'learner01', 1, 10, '', ...scope, typed, 'learner_history'),
    );
  }
  add(`course learners search ${scopeName}`, () =>
    svc.getReportCourseCompletionLearners(TENANT, COURSE, 1, 500, ' an ', undefined, undefined, ...scope, 'all', MARCH),
  );
  add(`learners search ${scopeName}`, () =>
    svc.getReportLearners(TENANT, 0, 0, ' an ', 3, 2025, ...scope, 'completed'),
  );
  add(`learners no status ${scopeName}`, () => svc.getReportLearners(TENANT, 1, 20, '', 3, 2025, ...scope));
  add(`learner detail search ${scopeName}`, () =>
    svc.getLearnerDetail(TENANT, 'learner01', 1, 10, ' Excel ', ...scope, 'learning'),
  );
  add(`learner detail report_filter search ${scopeName}`, () =>
    svc.getLearnerDetail(TENANT, 'learner01', 1, 10, ' Excel ', ...scope, 'all', 'report_filter', MARCH),
  );
}

for (const granularity of ['auto', 'day', 'week', 'month'] as const) {
  for (const [rangeName, period] of Object.entries({ MARCH, QUARTER, YEAR })) {
    add(`chart granularity ${granularity} ${rangeName}`, () =>
      svc.getReportChart(TENANT, 2025, 'total_enrollments', undefined, undefined, undefined, false, false, period, granularity, {}),
    );
  }
}
for (const direction of ['initial', 'before', 'after'] as const) {
  add(`chart window ${direction}`, () =>
    svc.getReportChart(TENANT, 2025, 'completion_rate', GROUP, undefined, undefined, false, false, YEAR, 'day', {
      mode: 'window',
      direction,
      anchorBucket: '2025-06-15',
      limitBuckets: 20,
    }),
  );
  add(`chart window grouped ${direction}`, () =>
    svc.getReportChart(TENANT, 2025, 'total_enrollments', GROUP, undefined, undefined, false, true, YEAR, 'week', {
      mode: 'window',
      direction,
      limitBuckets: 500,
      seriesLimit: 50,
    }),
  );
}
add('chart future year', () => svc.getReportChart(TENANT, 2099, 'total_enrollments'));
add('chart current year', () => svc.getReportChart(TENANT, 2026, 'active_learners', GROUP, undefined, undefined, false, false));
add('chart unknown metric year', () => svc.getReportChart(TENANT, 2025, 'nope'));
add('chart unknown metric range', () =>
  svc.getReportChart(TENANT, 2025, 'nope', undefined, undefined, undefined, false, false, MARCH),
);
add('chart grouped series overflow', () =>
  svc.getReportChart(TENANT, 2025, 'total_enrollments', GROUP, undefined, undefined, false, true, MARCH),
  text => (text.includes('other_series') ? { rows: [ROW, { ...ROW, series_name: 'Khác', value: '2' }] } : undefined),
);
add('course by name empty', () => svc.findReportCoursePerformanceByName(TENANT, '   '));
add('course by id empty', () => svc.getReportCoursePerformanceById(TENANT, '  '));
add('course by id none', () => svc.getReportCoursePerformanceById(TENANT, COURSE), noRowsAt(0));
add('learner detail unknown', () => svc.getLearnerDetail(TENANT, 'ghost', 3, 10), noRowsAt(0));
add('learner detail report_filter no range', () =>
  svc.getLearnerDetail(TENANT, 'learner01', 1, 10, '', undefined, undefined, undefined, 'all', 'report_filter'),
);
add('summary empty row', () => svc.getReportSummary(TENANT, 3, 2025), noRowsAt(0));
add('user badges', () => svc.getUserBadges('learner01', TENANT));
add('user study time', () =>
  svc.getUserStudyTime('learner01', TENANT, { from: '2025-03-01', to: '2025-03-31', granularity: 'day' }),
);
add('user study time unknown', () => svc.getUserStudyTime('ghost', TENANT, {}), noRowsAt(0));
add('empty study time', async () => svc.emptyUserStudyTime('ghost', { from: '2025-01-01' }));
add('refresh summary', () => svc.refreshReportSummary());

// ── Scope check ──

const ADMIN = { userId: 'user-actor', tenantId: TENANT, role: 'staff' as const };
const LEARNER_PLUS = { userId: 'user-actor', tenantId: TENANT, role: 'learner_plus' as const };
const REQUESTS = {
  none: {},
  group: { groupId: GROUP },
  subgroup: { subgroupId: SUBGROUP },
  team: { teamId: TEAM },
  'team of another subgroup': { teamId: TEAM, subgroupId: 'b0000000-0000-4000-8000-000000000009' },
  'team of another group': { teamId: TEAM, groupId: 'a0000000-0000-4000-8000-000000000009' },
  'subgroup of another group': { subgroupId: SUBGROUP, groupId: 'a0000000-0000-4000-8000-000000000009' },
};
for (const [requestName, requested] of Object.entries(REQUESTS)) {
  add(`scope admin ${requestName}`, () => access.enforceReportScope(ADMIN, requested));
  add(`scope admin unknown ${requestName}`, () => access.enforceReportScope(ADMIN, requested), noRowsAt(0));
  add(`scope learner_plus ${requestName}`, () => access.enforceReportScope(LEARNER_PLUS, requested));
  add(`scope learner_plus explicit ${requestName}`, () =>
    access.enforceReportScope(LEARNER_PLUS, requested, { requireExplicitLearnerPlusScope: true }),
  );
  add(`scope learner_plus no group ${requestName}`, () => access.enforceReportScope(LEARNER_PLUS, requested), noRowsAt(0));
}
add('scope learner_plus other group', () => access.enforceReportScope(LEARNER_PLUS, { groupId: GROUP }), text =>
  text.includes('tm.user_id = $1') ? { rows: [{ group_id: 'a0000000-0000-4000-8000-000000000009' }] } : undefined,
);
add('allowed groups', () => access.loadReportAllowedGroupIds(LEARNER_PLUS));
add('can report admin', () => access.canReportOnLearner(ADMIN, 'learner01'));
add('can report learner_plus', () => access.canReportOnLearner(LEARNER_PLUS, 'learner01'));
add('can report learner_plus no group', () => access.canReportOnLearner(LEARNER_PLUS, 'learner01'), noRowsAt(0));
add('can report learner_plus hidden', () => access.canReportOnLearner(LEARNER_PLUS, 'learner01'), text =>
  text.includes('AS visible') ? { rows: [{ visible: false }] } : undefined,
);

// ── HTTP handlers (query parsing included) ──

const H = {
  summary: ctrl.getSummary,
  chart: ctrl.getChart,
  topCourses: ctrl.getTopCourses,
  ranking: ctrl.getCourseCompletionRanking,
  courseLearners: ctrl.getCourseCompletionLearners,
  learners: ctrl.getLearners,
  learnerDetail: ctrl.getLearnerDetail,
  badges: ctrl.getUserBadges,
  studyTime: ctrl.getUserStudyTime,
  groups: ctrl.getReportGroups,
  subgroups: ctrl.getReportSubGroups,
  teams: ctrl.getReportTeams,
};

const QUERIES: Record<string, Query> = {
  empty: {},
  'month and year': { month: '3', year: '2025' },
  'month text': { month: 'abc', year: '2025x' },
  'month 13': { month: '13', year: '1999' },
  'month zero': { month: '0', year: '0' },
  'month float': { month: '3.7', year: '2025.9' },
  'month negative': { month: '-2', year: '-2025' },
  'month repeated': { month: ['3', '4'], year: ['2025', '2024'] },
  range: { date_from: '2025-03-01', date_to: '2025-03-31' },
  'range padded': { date_from: ' 2025-03-01 ', date_to: '2025-03-31 ' },
  'range half': { date_from: '2025-03-01' },
  'range bad': { date_from: '2025-3-1', date_to: '2025-03-31' },
  'range invalid day': { date_from: '2025-02-30', date_to: '2025-13-45' },
  'range reversed': { date_from: '2025-04-01', date_to: '2025-03-31' },
  'range repeated': { date_from: ['2025-03-01', '2025-03-02'], date_to: '2025-03-31' },
  'range and month': { date_from: '2025-03-01', date_to: '2025-03-31', month: '5', year: '2024' },
  'page and size': { page: '3', page_size: '15' },
  'page text': { page: 'x', page_size: 'y' },
  'page negative': { page: '-4', page_size: '-9' },
  'page zero': { page: '0', page_size: '0' },
  'page large': { page: '100000', page_size: '1000' },
  'page float': { page: '2.9', page_size: '7.5' },
  'page repeated': { page: ['2', '3'], page_size: ['5', '6'] },
  group: { group_id: GROUP },
  'group all': { group_id: 'all', subgroup_id: ' all ', team_id: '' },
  subgroup: { group_id: GROUP, subgroup_id: SUBGROUP },
  team: { team_id: TEAM },
  'group padded': { group_id: ` ${GROUP} ` },
  'group repeated': { group_id: [GROUP, GROUP] },
  search: { search: ' an ' },
  'search repeated': { search: ['an', 'bo'] },
  'search empty': { search: '' },
  'status all': { status: 'all' },
  'status completed': { status: 'completed' },
  'status bogus': { status: 'bogus' },
  'status padded': { status: ' learning ' },
  'status empty': { status: '  ' },
  'status repeated': { status: ['completed', 'learning'] },
  'chart metric': { metric: 'completion_rate', group_by_org: 'true', grouped: 'false' },
  'chart metric grouped': { metric: 'total_enrollments', grouped: 'true', group_id: GROUP },
  'chart metric repeated': { metric: ['active_learners', 'x'], group_by_org: ['true'], grouped: ['false'] },
  'chart range week': { date_from: '2025-01-01', date_to: '2025-03-15', granularity: 'week' },
  'chart range bad granularity': { date_from: '2025-01-01', date_to: '2025-03-15', granularity: 'hour' },
  'chart window': {
    date_from: '2025-01-01',
    date_to: '2025-12-31',
    mode: 'window',
    direction: 'before',
    anchor_bucket: '2025-06-01',
    limit_buckets: '30',
    series_limit: '5',
  },
  'chart window after': { date_from: '2025-01-01', date_to: '2025-12-31', mode: 'window', direction: 'after' },
  'chart window bad direction': { date_from: '2025-01-01', date_to: '2025-12-31', mode: 'window', direction: 'up' },
  'chart window empty direction': { mode: 'window', direction: '' },
  'chart window bad anchor': { mode: 'window', anchor_bucket: '2025-6-1' },
  'chart window limits text': { mode: 'window', limit_buckets: 'x', series_limit: '-3' },
  'chart window repeated': { mode: ['window'], direction: ['before'], anchor_bucket: ['2025-06-01'] },
  username: { username: 'learner01' },
  'username repeated': { username: ['learner01', 'learner02'] },
  'username empty': { username: '' },
  'detail report_filter': { username: 'learner01', data_scope: 'report_filter', date_from: '2025-03-01', date_to: '2025-03-31' },
  'detail report_filter no range': { username: 'learner01', data_scope: 'report_filter' },
  'detail history': { username: 'learner01', data_scope: 'learner_history', status: 'completed', search: 'Excel' },
  'detail bad scope': { username: 'learner01', data_scope: 'x', page: '2', page_size: '500' },
  'study time': { username: 'learner01', from: '2025-03-01', to: '2025-03-31', granularity: 'month' },
  'study time bad granularity': { username: 'learner01', granularity: 'week' },
  'study time repeated': { username: 'learner01', from: ['2025-03-01', 'x'], granularity: ['day'] },
};

const PARSED_HANDLERS = ['summary', 'chart', 'topCourses', 'ranking', 'courseLearners', 'learners', 'learnerDetail', 'badges', 'studyTime'] as const;
for (const handlerName of PARSED_HANDLERS) {
  for (const [queryName, query] of Object.entries(QUERIES)) {
    const learnerQuery =
      handlerName === 'learners' && !('status' in query) ? { ...query, status: 'all' } : query;
    const params = handlerName === 'courseLearners' ? { courseId: COURSE } : undefined;
    add(`http ${handlerName} ${queryName}`, () => callHandler(H[handlerName], learnerQuery, { params }));
  }
  add(`http ${handlerName} learner_plus`, () =>
    callHandler(H[handlerName], { username: 'learner01', status: 'all' }, { role: 'learner_plus', params: { courseId: COURSE } }),
  );
  add(`http ${handlerName} learner_plus no group`, () =>
    callHandler(H[handlerName], { username: 'learner01', status: 'all' }, { role: 'learner_plus', params: { courseId: COURSE } }),
    noRowsAt(0),
  );
}
add('http courseLearners no course', () => callHandler(H.courseLearners, {}, { params: { courseId: '' } }));
add('http learners missing status', () => callHandler(H.learners, {}));
add('http summary locale en', () => callHandler(H.summary, { date_from: '2025-03-01' }, { locale: 'en' }));

for (const role of ['admin', 'learner_plus']) {
  add(`http groups ${role}`, () => callHandler(H.groups, {}, { role }));
  add(`http groups ${role} none`, () => callHandler(H.groups, {}, { role }), noRowsAt(0));
  add(`http subgroups ${role}`, () => callHandler(H.subgroups, {}, { role, params: { groupId: GROUP } }));
  add(`http subgroups ${role} unknown group`, () =>
    callHandler(H.subgroups, {}, { role, params: { groupId: GROUP } }),
    noRowsAt(0),
  );
  add(`http subgroups ${role} not a member`, () =>
    callHandler(H.subgroups, {}, { role, params: { groupId: GROUP } }),
    noRowsAt(1),
  );
  add(`http teams ${role}`, () =>
    callHandler(H.teams, {}, { role, params: { groupId: GROUP, subgroupId: SUBGROUP } }),
  );
  add(`http teams ${role} unknown subgroup`, () =>
    callHandler(H.teams, {}, { role, params: { groupId: GROUP, subgroupId: SUBGROUP } }),
    noRowsAt(0),
  );
  add(`http teams ${role} not a member`, () =>
    callHandler(H.teams, {}, { role, params: { groupId: GROUP, subgroupId: SUBGROUP } }),
    noRowsAt(1),
  );
}

// Export handlers up to the file: refusals, the course lookup and the headers.
add('http export learner_plus', () => callHandler(ctrl.exportExcel, {}, { role: 'learner_plus' }));
add('http course export learner_plus', () =>
  callHandler(ctrl.exportCourseCompletionLearners, {}, { role: 'learner_plus', params: { courseId: COURSE } }),
);
add('http course export no course id', () =>
  callHandler(ctrl.exportCourseCompletionLearners, {}, { params: { courseId: '' } }),
);
add('http course export unknown course', () =>
  callHandler(ctrl.exportCourseCompletionLearners, {}, { params: { courseId: COURSE } }),
  noRowsAt(0),
);
add('http course export no group', () =>
  callHandler(ctrl.exportCourseCompletionLearners, {}, { role: 'learner_plus', params: { courseId: COURSE } }),
  noRowsAt(0),
);

// ── Excel exports: statements and every cell value ──

const EXPORTS = {
  'year tenant': { year: 2025, scope: {} },
  'month group': { year: 2025, month: 3, scope: { groupId: GROUP } },
  'range subgroup': { year: 2025, dateRange: MARCH, scope: { groupId: GROUP, subgroupId: SUBGROUP } },
  'range team en': { year: 2025, dateRange: QUARTER, scope: { groupId: GROUP, subgroupId: SUBGROUP, teamId: TEAM }, locale: 'en' as const },
};
for (const [exportName, options] of Object.entries(EXPORTS)) {
  const base = { tenantId: TENANT, labels: EXPORT_LABELS, exporterName: 'Golden', locale: 'vi' as const, ...options };
  add(`excel report ${exportName}`, () => workbookValues(stream => exportService.streamReportExcel({ ...base, stream })));
  add(`excel course ${exportName}`, () =>
    workbookValues(stream =>
      exportService.streamCourseLearnerExcel({ ...base, stream, courseId: COURSE, courseName: 'Khóa Excel' }),
    ),
  );
}

// ── Runner ──

const golden: Record<string, string> = existsSync(GOLDEN_PATH)
  ? (JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, string>)
  : {};
const written: Record<string, string> = {};
const full: Record<string, CaseOutcome> = {};

test('the case names are unique', () => {
  assert.equal(new Set(cases.map(item => item.name)).size, cases.length);
});

for (const item of cases) {
  test(`reports characterization: ${item.name}`, async t => {
    const outcome = await runCase(t, item.run, item.answer);
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
