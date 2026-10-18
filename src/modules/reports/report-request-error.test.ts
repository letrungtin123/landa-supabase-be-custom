import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

// The report scope, date range and stored snapshot checks throw Errors
// (AppError: status, message, code), not plain objects, and every reader keeps
// its answer: report chat reads the code, the PDF export maps the status as
// before. pg double; no database, no Redis, no network.

const pg = await import('pg');
const { pool } = await import('../../config/database.js');
const { AppError } = await import('../../middleware/error-handler.js');
const access = await import('./report-access.service.js');
const reportChat = await import('../ai-chatbot/ai-report/report-chat.service.js');
const { getReportPdfExportError } = await import('../ai-chatbot/ai-report/report-pdf-export.service.js');
const { isKbStorePermissionFailure, readReportDomainErrorCode } =
  await import('../ai-chatbot/ai-report/report-chat-error.logic.js');
const { tinyReportFixture } = await import('../ai-chatbot/ai-report/report-pdf.fixture.js');

test.after(async () => {
  await pool.end();
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = 'b0000000-0000-4000-8000-000000000001';
const SUBGROUP = 'b0000000-0000-4000-8000-000000000002';
const TEAM = 'b0000000-0000-4000-8000-000000000003';
const OTHER = 'b0000000-0000-4000-8000-000000000009';

type Expected = { status: number; message: string | RegExp; code?: string };

async function thrown(work: () => unknown): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  assert.fail('expected the check to throw');
}

function assertRequestError(error: unknown, expected: Expected, label: string) {
  assert.ok(error instanceof Error, `${label}: an Error, not a plain object`);
  assert.ok(error instanceof AppError, `${label}: an AppError`);
  assert.equal(error.statusCode, expected.status, label);
  // Readers of the old plain objects read `status`: it is kept.
  assert.equal((error as unknown as { status?: unknown }).status, expected.status, `${label}: status`);
  if (typeof expected.message === 'string') assert.equal(error.message, expected.message, label);
  else assert.match(error.message, expected.message, label);
  assert.equal(error.code, expected.code, label);
}

function installDb(t: TestContext, answer: (text: string, params: unknown[]) => unknown[] | undefined) {
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    const rows = answer(text, params) ?? [];
    return { rows, rowCount: rows.length };
  });
}

test('a learner_plus scope that must be chosen or is not theirs is an AppError with its status and code', async () => {
  assertRequestError(
    await thrown(() =>
      access.resolveLearnerPlusReportScope([GROUP, OTHER], {}, {}, { requireExplicitLearnerPlusScope: true }),
    ),
    { status: 400, message: 'Vui lòng chọn đơn vị cần xem báo cáo', code: 'REPORT_SCOPE_REQUIRED' },
    'scope required',
  );
  assertRequestError(
    await thrown(() => access.resolveLearnerPlusReportScope([GROUP], { groupId: OTHER }, { groupId: OTHER })),
    { status: 403, message: 'Bạn không có quyền xem báo cáo của nhóm này', code: 'REPORT_SCOPE_FORBIDDEN' },
    'another group',
  );
});

test('an unknown or mismatched unit is an AppError 400 REPORT_SCOPE_INVALID', async t => {
  const invalid = (message: string): Expected => ({ status: 400, message, code: 'REPORT_SCOPE_INVALID' });
  let team: unknown[] = [];
  let subgroup: unknown[] = [];
  let group: unknown[] = [];
  installDb(t, text => {
    if (text.includes('FROM teams t')) return team;
    if (text.includes('FROM sub_groups sg')) return subgroup;
    if (text.includes('FROM org_groups WHERE id = $1')) return group;
    return undefined;
  });
  const cases: Array<[() => void, Parameters<typeof access.resolveReportHierarchy>[1], Expected]> = [
    [() => (team = []), { teamId: TEAM }, invalid('Team không hợp lệ hoặc không thuộc doanh nghiệp hiện tại')],
    [
      () => (team = [{ group_id: GROUP, subgroup_id: SUBGROUP, team_id: TEAM }]),
      { teamId: TEAM, subgroupId: OTHER },
      invalid('Team không thuộc nhóm con đã chọn'),
    ],
    [() => undefined, { teamId: TEAM, groupId: OTHER }, invalid('Team không thuộc nhóm đã chọn')],
    [
      () => (subgroup = []),
      { subgroupId: SUBGROUP },
      invalid('Nhóm con không hợp lệ hoặc không thuộc doanh nghiệp hiện tại'),
    ],
    [
      () => (subgroup = [{ group_id: GROUP, subgroup_id: SUBGROUP }]),
      { subgroupId: SUBGROUP, groupId: OTHER },
      invalid('Nhóm con không thuộc nhóm đã chọn'),
    ],
    [() => (group = []), { groupId: GROUP }, invalid('Nhóm không hợp lệ hoặc không thuộc doanh nghiệp hiện tại')],
  ];
  for (const [arrange, requested, expected] of cases) {
    arrange();
    assertRequestError(
      await thrown(() => access.resolveReportHierarchy(TENANT, requested)),
      expected,
      JSON.stringify(requested),
    );
  }
});

test('a report chat date range the checks refuse is an AppError 400 REPORT_RANGE_INVALID', async () => {
  const range = (message: string | RegExp): Expected => ({ status: 400, message, code: 'REPORT_RANGE_INVALID' });
  const cases: Array<[Parameters<typeof reportChat.normalizeReportChatFilter>[0], Expected]> = [
    [{ date_from: '2026-09-01' }, range('date_from và date_to phải được gửi cùng nhau')],
    [{ date_from: '2026-9-1', date_to: '2026-09-30' }, range('date_from/date_to phải có định dạng YYYY-MM-DD')],
    [{ date_from: '2026-09-30', date_to: '2026-09-01' }, range('Khoảng ngày không hợp lệ')],
    [{ date_from: '2024-01-01', date_to: '2026-01-01' }, range(/^Khoảng ngày báo cáo tối đa \d+ ngày$/)],
  ];
  for (const [filter, expected] of cases) {
    const error = await thrown(() => reportChat.normalizeReportChatFilter(filter));
    assertRequestError(error, expected, JSON.stringify(filter));
    // Report chat turns these into a clarification by their code.
    assert.equal(readReportDomainErrorCode(error), 'REPORT_RANGE_INVALID');
    assert.equal(isKbStorePermissionFailure(error), false);
  }
});

test('a missing or altered stored snapshot is an AppError 404 / 409, and the PDF export maps it as before', async t => {
  const fixture = tinyReportFixture();
  let metadata: unknown = null;
  installDb(t, text => (text.includes('FROM chat_messages message') ? (metadata ? [{ metadata }] : []) : undefined));
  const reference = {
    conversationId: 'c0000000-0000-4000-8000-000000000001',
    assistantMessageId: 'c0000000-0000-4000-8000-000000000002',
    userId: 'c0000000-0000-4000-8000-000000000003',
    tenantId: TENANT,
  };

  const missing = await thrown(() => reportChat.loadStoredReportSnapshot(reference));
  assertRequestError(missing, { status: 404, message: 'Không tìm thấy bản chụp báo cáo hợp lệ' }, 'missing');

  metadata = { kind: 'report_analysis', report_snapshot: fixture.snapshot, report_snapshot_hash: 'altered' };
  const altered = await thrown(() => reportChat.loadStoredReportSnapshot(reference));
  assertRequestError(altered, { status: 409, message: 'Bản chụp báo cáo không còn toàn vẹn' }, 'altered');

  metadata = { kind: 'report_analysis', report_snapshot: fixture.snapshot, report_snapshot_hash: fixture.snapshotHash };
  assert.equal((await reportChat.loadStoredReportSnapshot(reference)).snapshot, fixture.snapshot);

  // The PDF export answers these exactly as it answered the plain objects.
  const forbidden = await thrown(() =>
    access.resolveLearnerPlusReportScope([GROUP], { groupId: OTHER }, { groupId: OTHER }),
  );
  const scopeInvalid = await thrown(() => access.resolveReportHierarchy(TENANT, { groupId: GROUP }));
  for (const [error, statusCode, code] of [
    [missing, 404, 'REPORT_PDF_NOT_FOUND'],
    [altered, 409, 'REPORT_PDF_SNAPSHOT_UNAVAILABLE'],
    [forbidden, 403, 'REPORT_PDF_SCOPE_DENIED'],
    [scopeInvalid, 400, 'REPORT_PDF_INVALID_REQUEST'],
  ] as const) {
    const mapped = getReportPdfExportError(error);
    assert.equal(mapped.code, code, String(statusCode));
    assert.equal(mapped.statusCode, statusCode, code);
  }
});
