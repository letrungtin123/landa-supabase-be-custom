import assert from 'node:assert/strict';
import test from 'node:test';
import { pool } from '../../config/database.js';
import type { UserRole } from '../../types/index.js';
import { AppError } from '../../middleware/error-handler.js';
import { isGeminiPermissionDeniedError } from './gemini.service.js';
import {
  ReportChatError,
  isKbStorePermissionFailure,
  isReportChatError,
} from './report-chat-error.logic.js';
import { parseReportRouterToolCall } from './report-chat-route.logic.js';
import { routeAdminReportQuestion, type ReportRouterDeps } from './report-chat-router.service.js';
import {
  handleAdminReportTurn,
  type AdminReportTurnDeps,
  type AdminReportTurnInput,
  type ReportChatSideEvent,
} from './report-chat-turn.service.js';
import { createReportSnapshot, type ReportChatFilterInput, type ReportChatSnapshot } from './report-chat.service.js';
import type { ReportSummary } from '../reports/reports.service.js';
import { REPORT_REFERENCE_DATE, REPORT_TODAY, REPORT_UNIT_CATALOG, UNIT_IDS } from './report-chat.fixture.js';

test.after(async () => {
  await pool.end();
});

function summary(dateFrom: string, dateTo: string, enrollments = 4): ReportSummary {
  return {
    meta: { month: 7, year: 2026, month_label: '', is_current_month: false, date_from: dateFrom, date_to: dateTo },
    overview: { total_learners: 2, active_learners: 1, completion_rate: 50, total_enrollments: enrollments, completed_enrollments: 2, incomplete_enrollments: 2 },
  };
}

function fakeSnapshot(filter: ReportChatFilterInput): ReportChatSnapshot {
  const dateFrom = filter.date_from ?? '2026-10-01';
  const dateTo = filter.date_to ?? REPORT_TODAY;
  return createReportSnapshot(
    {
      version: 2,
      generated_at: '2026-10-08T05:00:00.000Z',
      timezone: 'Asia/Ho_Chi_Minh',
      filter: { date_from: dateFrom, date_to: dateTo, ...(filter.team_id ? { team_id: filter.team_id } : {}) },
      scope: { groupId: undefined, subgroupId: undefined, teamId: filter.team_id },
      comparison: { date_from: '2026-06-01', date_to: '2026-06-30', basis: 'calendar_month' },
    },
    summary(dateFrom, dateTo),
    summary('2026-06-01', '2026-06-30', 3),
    [], [], [], { not_started: 0, in_progress: 2, completed: 2 }, {}, 'available',
  );
}

interface Harness {
  deps: AdminReportTurnDeps;
  saved: Array<{ content: string; metadata: Record<string, unknown> }>;
  events: ReportChatSideEvent[];
  chunks: string[];
  finalized: Array<Record<string, unknown>>;
  snapshotFilters: ReportChatFilterInput[];
}

function harness(options: {
  modelArgs?: Record<string, unknown> | 'decline' | 'error';
  allowedGroupIds?: string[];
  buildSnapshot?: (filter: ReportChatFilterInput) => Promise<ReportChatSnapshot>;
} = {}): Harness {
  const saved: Harness['saved'] = [];
  const snapshotFilters: ReportChatFilterInput[] = [];
  const router: ReportRouterDeps = {
    callModel: async (input) => {
      if (options.modelArgs === 'error') throw Object.assign(new Error('Gemini PERMISSION_DENIED'), { status: 403 });
      return parseReportRouterToolCall(
        options.modelArgs === 'decline' ? { name: 'respond_directly', args: {} } : { name: 'get_report_snapshot', args: options.modelArgs ?? {} },
        input.today,
      );
    },
    loadCatalog: async () => REPORT_UNIT_CATALOG,
    loadLabels: async () => ({}),
    loadAllowedGroupIds: async () => options.allowedGroupIds ?? [],
    log: () => undefined,
  };
  return {
    saved,
    events: [],
    chunks: [],
    finalized: [],
    snapshotFilters,
    deps: {
      router,
      route: (input, deps) => routeAdminReportQuestion({ ...input, referenceDate: REPORT_REFERENCE_DATE }, deps),
      buildSnapshot: async (input) => {
        snapshotFilters.push(input.filter ?? {});
        return options.buildSnapshot ? options.buildSnapshot(input.filter ?? {}) : fakeSnapshot(input.filter ?? {});
      },
      generateNarrative: async () => ({ selected_signal_ids: [], interpretation: ['Hoạt động học ổn định.'], recommended_actions: [], limitations: [] }),
      loadLatestAnalysis: async () => null,
      saveAssistantMessage: async (_conversationId, content, metadata) => {
        saved.push({ content, metadata });
        return `message-${saved.length}`;
      },
      touchConversation: async () => undefined,
    },
  };
}

function turnInput(question: string, overrides: Partial<AdminReportTurnInput> = {}): AdminReportTurnInput {
  return {
    conversationId: '10000000-0000-4000-8000-000000000001',
    tenantId: '20000000-0000-4000-8000-000000000001',
    userId: '30000000-0000-4000-8000-000000000001',
    role: 'staff' as UserRole,
    locale: 'vi',
    question,
    chatModel: 'test-model',
    isFirstMessage: false,
    ...overrides,
  };
}

async function run(h: Harness, input: AdminReportTurnInput) {
  return handleAdminReportTurn(input, {
    chunk: (text) => h.chunks.push(text),
    sideEvent: (event) => h.events.push(event),
    finalize: async (_parts, _output, metadata) => { h.finalized.push(metadata); },
  }, h.deps);
}

test('root cause: a report 403 looks like a Gemini PERMISSION_DENIED unless it is typed', () => {
  const legacyReport403 = { status: 403, message: 'Bạn không có quyền xem báo cáo của nhóm này' };
  assert.equal(isGeminiPermissionDeniedError(legacyReport403), true);
  assert.equal(isKbStorePermissionFailure({ ...legacyReport403, code: 'REPORT_SCOPE_FORBIDDEN' }), false);
  assert.equal(isKbStorePermissionFailure(new ReportChatError('REPORT_DATA_UNAVAILABLE', 'en')), false);
  assert.equal(isKbStorePermissionFailure(Object.assign(new Error('PERMISSION_DENIED: File Search store'), { status: 403 })), true);
});

test('ReportChatError is an AppError with a localized message, so chat error sanitising keeps it', () => {
  const error = new ReportChatError('REPORT_DATA_UNAVAILABLE', 'en');
  assert.ok(error instanceof AppError);
  assert.equal(error.statusCode, 503);
  assert.equal(error.code, 'REPORT_DATA_UNAVAILABLE');
  assert.equal(error.message, 'Report data is not available right now. Please try again later.');
  assert.equal(new ReportChatError('REPORT_DATA_UNAVAILABLE', 'vi').message, 'Chưa thể tải số liệu báo cáo lúc này. Vui lòng thử lại sau.');
});

test('a resolved question builds one snapshot with the resolved unit and period', async () => {
  const h = harness({ modelArgs: { date_from: '2026-07-01', date_to: '2026-07-31', org_units: [{ name: 'Marketing', level: 'team' }] } });
  assert.equal(await run(h, turnInput('Báo cáo team Marketing tháng 7')), 'handled');
  assert.deepEqual(h.snapshotFilters, [{ date_from: '2026-07-01', date_to: '2026-07-31', group_id: UNIT_IDS.holdings, subgroup_id: UNIT_IDS.southSales, team_id: UNIT_IDS.marketing }]);
  assert.equal(h.saved[0].metadata.kind, 'report_analysis');
  assert.deepEqual(h.saved[0].metadata.report_request, { period_source: 'agreed', unit_source: 'question' });
  assert.deepEqual(h.events.map((event) => event.type), ['report_status', 'report_status', 'report_result']);
  assert.equal(h.finalized[0].report_stage, 'analysis');
});

test('a learner_plus 403 while reading data becomes a localized clarification, not an error', async () => {
  const h = harness({
    allowedGroupIds: [UNIT_IDS.nesso],
    buildSnapshot: async () => { throw { status: 403, message: 'Bạn không có quyền xem báo cáo của nhóm này', code: 'REPORT_SCOPE_FORBIDDEN' }; },
  });
  // The catalog no longer lists the requested team (renamed/moved): the read is what fails.
  const outcome = await run(h, turnInput('Báo cáo', {
    role: 'learner_plus', locale: 'en', reportFilters: { date_from: '2026-07-01', date_to: '2026-07-31', team_id: '00000000-0000-4000-8000-00000000ffff' },
  }));
  assert.equal(outcome, 'handled');
  assert.equal(h.saved[0].metadata.kind, 'report_clarification');
  const clarification = h.saved[0].metadata.report_clarification as { reasons: string[]; options: Array<{ filter: ReportChatFilterInput }> };
  assert.deepEqual(clarification.reasons, ['unit_forbidden']);
  assert.deepEqual(clarification.options.map((option) => option.filter), [{ date_from: '2026-07-01', date_to: '2026-07-31', group_id: UNIT_IDS.nesso }]);
  assert.equal(h.chunks[0], 'You do not have access to reports for this unit. Choose an option below or open the filters.');
});

test('a learner_plus filter for a unit outside their groups is refused by name before any data read', async () => {
  const h = harness({ allowedGroupIds: [UNIT_IDS.nesso] });
  await run(h, turnInput('Báo cáo', { role: 'learner_plus', reportFilters: { date_from: '2026-07-01', date_to: '2026-07-31', team_id: UNIT_IDS.marketing } }));
  assert.deepEqual(h.snapshotFilters, []);
  const clarification = h.saved[0].metadata.report_clarification as { reasons: string[]; params: { unit_name?: string } };
  assert.deepEqual(clarification.reasons, ['unit_forbidden']);
  assert.equal(clarification.params.unit_name, 'Marketing');
  assert.equal(h.chunks[0], 'Bạn không có quyền xem báo cáo của “Marketing”. Chọn một lựa chọn bên dưới hoặc mở bộ lọc.');
});

test('learner_plus with several groups and no unit is asked to choose instead of getting the first group', async () => {
  const h = harness({ allowedGroupIds: [UNIT_IDS.holdings, UNIT_IDS.nesso] });
  await run(h, turnInput('Báo cáo', { role: 'learner_plus', reportFilters: { date_from: '2026-07-01', date_to: '2026-07-31' } }));
  const clarification = h.saved[0].metadata.report_clarification as { reasons: string[]; options: Array<{ filter: ReportChatFilterInput }> };
  assert.deepEqual(clarification.reasons, ['scope_required']);
  assert.deepEqual(clarification.options.map((option) => option.filter.group_id).sort(), [UNIT_IDS.holdings, UNIT_IDS.nesso].sort());
  assert.deepEqual(h.snapshotFilters, []);
});

test('learner_plus with one group gets that group explicitly', async () => {
  const h = harness({ allowedGroupIds: [UNIT_IDS.nesso] });
  await run(h, turnInput('Báo cáo', { role: 'learner_plus', reportFilters: { date_from: '2026-07-01', date_to: '2026-07-31' } }));
  assert.deepEqual(h.snapshotFilters, [{ date_from: '2026-07-01', date_to: '2026-07-31', group_id: UNIT_IDS.nesso }]);
});

test('a scope that must be chosen while reading data (REPORT_SCOPE_REQUIRED) becomes scope_required', async () => {
  const h = harness({
    allowedGroupIds: [UNIT_IDS.holdings, UNIT_IDS.nesso],
    buildSnapshot: async () => { throw { status: 400, message: 'Vui lòng chọn đơn vị cần xem báo cáo', code: 'REPORT_SCOPE_REQUIRED' }; },
  });
  await run(h, turnInput('Báo cáo', { reportFilters: { date_from: '2026-07-01', date_to: '2026-07-31' } }));
  assert.deepEqual((h.saved[0].metadata.report_clarification as { reasons: string[] }).reasons, ['scope_required']);
});

test('an invalid range raised while reading data becomes a clarification instead of "Yêu cầu không hợp lệ"', async () => {
  const h = harness({ buildSnapshot: async () => { throw { status: 400, message: 'Khoảng ngày không hợp lệ', code: 'REPORT_RANGE_INVALID' }; } });
  await run(h, turnInput('Báo cáo', { reportFilters: { date_from: '2026-07-01', date_to: '2026-07-31' } }));
  assert.deepEqual((h.saved[0].metadata.report_clarification as { reasons: string[] }).reasons, ['date_invalid']);
});

test('a reversed period in the question is a clarification with the swapped range as a chip', async () => {
  const h = harness({ modelArgs: { date_from: '2026-07-31', date_to: '2026-07-01' } });
  await run(h, turnInput('báo cáo học viên từ 31/7 đến 1/7'));
  const clarification = h.saved[0].metadata.report_clarification as { reasons: string[]; options: Array<{ filter: ReportChatFilterInput }> };
  assert.deepEqual(clarification.reasons, ['date_reversed']);
  assert.deepEqual(clarification.options.map((option) => option.filter), [{ date_from: '2026-07-01', date_to: '2026-07-31' }]);
  assert.equal(h.finalized[0].report_stage, 'clarification');
});

test('an unexpected failure is a typed, localized report error that never marks the KB store', async () => {
  const h = harness({ buildSnapshot: async () => { throw new Error('connection terminated unexpectedly'); } });
  await assert.rejects(
    run(h, turnInput('Báo cáo', { locale: 'en', reportFilters: { date_from: '2026-07-01', date_to: '2026-07-31' } })),
    (error: unknown) => isReportChatError(error)
      && error.statusCode === 503
      && error.message === 'Report data is not available right now. Please try again later.'
      && !isKbStorePermissionFailure(error),
  );
});

test('a model outage falls back to the deterministic parser instead of failing the turn', async () => {
  const h = harness({ modelArgs: 'error' });
  assert.equal(await run(h, turnInput('Báo cáo học viên tháng 7/2025')), 'handled');
  assert.deepEqual(h.snapshotFilters, [{ date_from: '2025-07-01', date_to: '2025-07-31' }]);
});

test('a question that is not a report is left to the normal chat', async () => {
  const h = harness({ modelArgs: 'decline' });
  assert.equal(await run(h, turnInput('Viết giúp tôi một email chúc mừng sinh nhật')), 'not_report');
  assert.equal(h.saved.length, 0);
  assert.equal(h.chunks.length, 0);
});
