// Golden routing set: VI/EN report questions through the real router with a
// mocked Gemini tool call (no network). Each case fixes what the model
// returns (agreeing, wrong, declining, failing) and the decision we expect.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { UserRole } from '../../types/index.js';
import { parseReportRouterToolCall, type ReportClarificationReason, type ReportRouteDecision } from './report-chat-route.logic.js';
import { routeAdminReportQuestion, type ReportRouterDeps } from './report-chat-router.service.js';
import type { ReportChatFilterInput } from './report-chat.service.js';
import { REPORT_REFERENCE_DATE, REPORT_UNIT_CATALOG, UNIT_IDS } from './report-chat.fixture.js';
import { reportUnitFilter } from './report-org-unit.logic.js';

/** Report filter of a fixture unit (the unit and its ancestors). */
const u = (id: string) => reportUnitFilter(REPORT_UNIT_CATALOG.units.find((unit) => unit.id === id)!);

type ModelArgs = Record<string, unknown> | 'decline' | 'error';

interface GoldenCase {
  q: string;
  model: ModelArgs;
  locale?: 'vi' | 'en';
  role?: UserRole;
  allowed?: string[];
  expect:
    | { kind: 'direct' }
    | { kind: 'filters'; filter?: ReportChatFilterInput }
    | { kind: 'snapshot'; filter: ReportChatFilterInput; granularity?: string; compare?: boolean; course?: string; source?: string }
    | { kind: 'clarification'; reasons: ReportClarificationReason[]; options?: ReportChatFilterInput[]; optionCount?: number; mention?: string; hidden?: string[] };
}

const r = (date_from: string, date_to: string) => ({ date_from, date_to });
const m = (date_from?: string, date_to?: string, extra: Record<string, unknown> = {}) => ({
  ...(date_from ? { date_from } : {}), ...(date_to ? { date_to } : {}), ...extra,
});
const units = (...names: string[]) => ({ org_units: names.map((name) => ({ name })) });

const CASES: GoldenCase[] = [
  // Vietnamese dates
  { q: 'Báo cáo học viên từ 2025-07-01 đến 2025-07-31', model: m('2025-07-01', '2025-07-31'), expect: { kind: 'snapshot', filter: r('2025-07-01', '2025-07-31'), source: 'agreed' } },
  { q: 'Báo cáo từ 01/07/2025 đến 31/07/2025', model: m('2025-07-01', '2025-07-31'), expect: { kind: 'snapshot', filter: r('2025-07-01', '2025-07-31') } },
  { q: 'Báo cáo học viên 1-7-2025 đến 31-7-2025', model: m('2025-07-01', '2025-07-31'), expect: { kind: 'snapshot', filter: r('2025-07-01', '2025-07-31') } },
  { q: 'Số học viên có hoạt động học từ 1/7 đến 31/7', model: m('2026-07-01', '2026-07-31'), expect: { kind: 'snapshot', filter: r('2026-07-01', '2026-07-31') } },
  { q: 'Số học viên từ 1/7 đến 31/7 là bao nhiêu', model: m('2024-07-01', '2024-07-31'), expect: { kind: 'snapshot', filter: r('2026-07-01', '2026-07-31'), source: 'agreed' } },
  { q: 'Báo cáo học viên ngày 5 tháng 7 năm 2025', model: m('2025-07-05', '2025-07-05'), expect: { kind: 'snapshot', filter: r('2025-07-05', '2025-07-05') } },
  { q: 'Báo cáo học viên ngày 5 tháng 7 năm 2025', model: m('2025-07-01', '2025-07-31'), expect: { kind: 'clarification', reasons: ['date_conflict'], options: [r('2025-07-05', '2025-07-05'), r('2025-07-01', '2025-07-31')] } },
  { q: 'Báo cáo khóa học tháng 7', model: m('2026-07-01', '2026-07-31'), expect: { kind: 'snapshot', filter: r('2026-07-01', '2026-07-31') } },
  { q: 'Báo cáo khóa học tháng 7 năm 2024', model: m('2026-07-01', '2026-07-31'), expect: { kind: 'clarification', reasons: ['date_conflict'], options: [r('2024-07-01', '2024-07-31'), r('2026-07-01', '2026-07-31')] } },
  { q: 'Thống kê ghi danh tháng 7/2025', model: m('2025-07-01', '2025-07-31'), expect: { kind: 'snapshot', filter: r('2025-07-01', '2025-07-31') } },
  { q: 'Báo cáo học viên T7/2025', model: m('2025-07-01', '2025-07-31'), expect: { kind: 'snapshot', filter: r('2025-07-01', '2025-07-31') } },
  { q: 'Báo cáo học viên quý 3', model: m('2026-07-01', '2026-09-30'), expect: { kind: 'snapshot', filter: r('2026-07-01', '2026-09-30') } },
  { q: 'Báo cáo học viên quý 3 năm 2025', model: m('2025-07-01', '2025-09-30'), expect: { kind: 'snapshot', filter: r('2025-07-01', '2025-09-30') } },
  { q: 'Báo cáo học viên Q3/2025', model: m('2025-07-01', '2025-09-30'), expect: { kind: 'snapshot', filter: r('2025-07-01', '2025-09-30') } },
  { q: 'Báo cáo học viên tuần này', model: m('2026-10-05', '2026-10-11'), expect: { kind: 'snapshot', filter: r('2026-10-05', '2026-10-08') } },
  { q: 'Báo cáo học viên tuần trước', model: m('2026-09-28', '2026-10-04'), expect: { kind: 'snapshot', filter: r('2026-09-28', '2026-10-04') } },
  { q: 'Báo cáo học viên tuần trước', model: m('2026-09-27', '2026-10-03'), expect: { kind: 'clarification', reasons: ['date_conflict'], options: [r('2026-09-28', '2026-10-04'), r('2026-09-27', '2026-10-03')] } },
  { q: 'Báo cáo học viên tháng này', model: m('2026-10-01', '2026-10-31'), expect: { kind: 'snapshot', filter: r('2026-10-01', '2026-10-08') } },
  { q: 'Báo cáo học viên tháng trước', model: m('2026-09-01', '2026-09-30'), expect: { kind: 'snapshot', filter: r('2026-09-01', '2026-09-30') } },
  { q: 'Báo cáo học viên năm nay', model: m('2026-01-01', '2026-12-31'), expect: { kind: 'snapshot', filter: r('2026-01-01', '2026-10-08') } },
  { q: 'Báo cáo học viên năm ngoái', model: m('2025-01-01', '2025-12-31'), expect: { kind: 'snapshot', filter: r('2025-01-01', '2025-12-31') } },
  { q: 'Báo cáo học viên 30 ngày qua', model: m('2026-09-09', '2026-10-08'), expect: { kind: 'snapshot', filter: r('2026-09-09', '2026-10-08') } },
  { q: 'Báo cáo học viên 3 tháng gần đây', model: m('2026-07-09', '2026-10-08'), expect: { kind: 'snapshot', filter: r('2026-07-09', '2026-10-08') } },
  { q: 'Báo cáo học viên từ 1/7 đến nay', model: m('2026-07-01', '2026-10-08'), expect: { kind: 'snapshot', filter: r('2026-07-01', '2026-10-08') } },
  { q: 'Tỷ lệ hoàn thành tháng 7 đến nay', model: m('2026-07-01', '2026-10-08'), expect: { kind: 'snapshot', filter: r('2026-07-01', '2026-10-08') } },
  { q: 'Báo cáo học viên từ đầu năm đến nay', model: m('2026-01-01', '2026-10-08'), expect: { kind: 'snapshot', filter: r('2026-01-01', '2026-10-08') } },
  { q: 'Báo cáo học viên hôm nay', model: m('2026-10-08', '2026-10-08'), expect: { kind: 'snapshot', filter: r('2026-10-08', '2026-10-08') } },
  { q: 'Báo cáo học viên hôm qua', model: m('2026-10-07', '2026-10-07'), expect: { kind: 'snapshot', filter: r('2026-10-07', '2026-10-07') } },
  { q: 'Báo cáo học viên từ tháng 11 đến tháng 2 năm 2026', model: m('2025-11-01', '2026-02-28'), expect: { kind: 'snapshot', filter: r('2025-11-01', '2026-02-28') } },
  { q: 'Báo cáo học viên từ 15/12 đến 10/1', model: m('2025-12-15', '2026-01-10'), expect: { kind: 'snapshot', filter: r('2025-12-15', '2026-01-10') } },
  { q: 'Báo cáo học viên từ 31/7 đến 1/7', model: m('2026-07-01', '2026-07-31'), expect: { kind: 'clarification', reasons: ['date_reversed'], options: [r('2026-07-01', '2026-07-31')] } },
  { q: 'Báo cáo học viên từ 1/1/2024 đến 31/12/2025', model: m('2024-01-01', '2025-12-31'), expect: { kind: 'clarification', reasons: ['date_too_long'], options: [r('2024-12-31', '2025-12-31'), r('2024-01-01', '2024-12-31')] } },
  { q: 'Báo cáo học viên tháng 11', model: m('2026-11-01', '2026-11-30'), expect: { kind: 'clarification', reasons: ['date_future'], options: [r('2025-11-01', '2025-11-30'), r('2026-11-01', '2026-11-30')] } },
  { q: 'Báo cáo học viên tháng 11', model: m('2025-11-01', '2025-11-30'), expect: { kind: 'snapshot', filter: r('2025-11-01', '2025-11-30'), source: 'agreed' } },
  { q: 'Đến nay có bao nhiêu học viên trong team Marketing?', model: m(undefined, undefined, units('Marketing')), expect: { kind: 'clarification', reasons: ['date_open'], options: [{ ...r('2026-01-01', '2026-10-08'), ...u(UNIT_IDS.marketing) }, { ...r('2025-10-08', '2026-10-08'), ...u(UNIT_IDS.marketing) }, { ...r('2026-10-01', '2026-10-08'), ...u(UNIT_IDS.marketing) }] } },
  { q: 'Báo cáo học viên tháng 5 và tháng 7', model: m('2026-05-01', '2026-07-31'), expect: { kind: 'clarification', reasons: ['date_multiple'], options: [r('2026-05-01', '2026-05-31'), r('2026-07-01', '2026-07-31'), r('2026-05-01', '2026-07-31')] } },
  { q: 'So sánh lượt ghi danh tháng 6 với tháng 5', model: m('2026-06-01', '2026-06-30', { compare: true }), expect: { kind: 'snapshot', filter: r('2026-06-01', '2026-06-30'), compare: true } },
  { q: 'Báo cáo học viên ngày 31/2', model: m(), expect: { kind: 'clarification', reasons: ['date_invalid'], options: [r('2026-02-28', '2026-02-28')] } },
  // English dates
  { q: 'Report learners for July 2025', locale: 'en', model: m('2025-07-01', '2025-07-31'), expect: { kind: 'snapshot', filter: r('2025-07-01', '2025-07-31') } },
  { q: 'How many learners enrolled between July 1 and July 31, 2025?', locale: 'en', model: m('2025-07-01', '2025-07-31'), expect: { kind: 'snapshot', filter: r('2025-07-01', '2025-07-31') } },
  { q: 'Show the completion rate for the last 30 days', locale: 'en', model: m('2026-09-09', '2026-10-08'), expect: { kind: 'snapshot', filter: r('2026-09-09', '2026-10-08') } },
  { q: 'Enrollments this year', locale: 'en', model: m('2026-01-01', '2026-12-31'), expect: { kind: 'snapshot', filter: r('2026-01-01', '2026-10-08') } },
  { q: 'Course ranking for Q3 2025', locale: 'en', model: m('2025-07-01', '2025-09-30'), expect: { kind: 'snapshot', filter: r('2025-07-01', '2025-09-30') } },
  { q: 'Learner report for last quarter', locale: 'en', model: m('2026-07-01', '2026-09-30'), expect: { kind: 'snapshot', filter: r('2026-07-01', '2026-09-30') } },
  { q: 'Completion rate year to date', locale: 'en', model: m('2026-01-01', '2026-10-08'), expect: { kind: 'snapshot', filter: r('2026-01-01', '2026-10-08') } },
  { q: 'Learner activity report since March', locale: 'en', model: m('2026-03-01'), expect: { kind: 'snapshot', filter: r('2026-03-01', '2026-10-08') } },
  { q: 'Weekly enrollments in September', locale: 'en', model: m('2026-09-01', '2026-09-30', { granularity: 'week' }), expect: { kind: 'snapshot', filter: r('2026-09-01', '2026-09-30'), granularity: 'week' } },
  // Org units
  { q: 'Báo cáo nhóm Kinh doanh Hà Nội tháng 7', model: m('2026-07-01', '2026-07-31', units('Kinh doanh Hà Nội')), expect: { kind: 'snapshot', filter: { ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.salesHanoi) } } },
  { q: 'bao cao team kinh doanh ha noi thang 7', model: m('2026-07-01', '2026-07-31', units('kinh doanh ha noi')), expect: { kind: 'snapshot', filter: { ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.salesHanoi) } } },
  { q: 'Báo cáo phòng ban Markting tháng này', model: m('2026-10-01', '2026-10-31', units('Markting')), expect: { kind: 'snapshot', filter: { ...r('2026-10-01', '2026-10-08'), ...u(UNIT_IDS.marketing) } } },
  { q: 'Báo cáo nhóm Kinh doanh tháng 7', model: m('2026-07-01', '2026-07-31', units('Kinh doanh')), expect: { kind: 'clarification', reasons: ['unit_ambiguous'], optionCount: 5 } },
  { q: 'Báo cáo nhóm Sales tháng 7', model: m('2026-07-01', '2026-07-31', units('Sales')), expect: { kind: 'clarification', reasons: ['unit_not_found'], options: [r('2026-07-01', '2026-07-31')] } },
  { q: 'Báo cáo học viên của Kinh doanh TP.HCM tháng 7', model: m('2026-07-01', '2026-07-31', units('Kinh doanh TP.HCM')), expect: { kind: 'snapshot', filter: { ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.salesHcm) } } },
  { q: 'Learners in the Marketing team last month', locale: 'en', model: m('2026-09-01', '2026-09-30', units('Marketing')), expect: { kind: 'snapshot', filter: { ...r('2026-09-01', '2026-09-30'), ...u(UNIT_IDS.marketing) } } },
  { q: 'So sánh tỷ lệ hoàn thành team Marketing và team QC tháng 7', model: m('2026-07-01', '2026-07-31', { ...units('Marketing', 'QC'), compare: true }), expect: { kind: 'clarification', reasons: ['unit_multiple'], options: [{ ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.marketing) }, { ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.qc) }] } },
  { q: 'Báo cáo team Marketing của chi nhánh Miền Nam tháng 7', model: m('2026-07-01', '2026-07-31', units('Marketing', 'Miền Nam')), expect: { kind: 'snapshot', filter: { ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.marketing) } } },
  { q: 'Báo cáo chi nhánh Miền Nam tháng 7', model: m('2026-07-01', '2026-07-31', units('Miền Nam')), expect: { kind: 'clarification', reasons: ['unit_ambiguous'], options: [{ ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.southSales) }, { ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.southProduction) }] } },
  { q: 'Báo cáo nhóm Nesso tháng 7', model: m('2026-07-01', '2026-07-31', units('Nesso')), expect: { kind: 'snapshot', filter: { ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.nesso) } } },
  // RBAC (learner_plus)
  // A unit outside a learner_plus' groups is answered exactly like an unknown name (typed text only).
  { q: 'Báo cáo team Marketing tháng 7', role: 'learner_plus', allowed: [UNIT_IDS.nesso], model: m('2026-07-01', '2026-07-31', units('Marketing')), expect: { kind: 'clarification', reasons: ['unit_not_found'], mention: 'Marketing', options: [{ ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.nesso) }] } },
  { q: 'Báo cáo phòng ban Markting tháng 7', role: 'learner_plus', allowed: [UNIT_IDS.nesso], model: m('2026-07-01', '2026-07-31', units('Markting')), expect: { kind: 'clarification', reasons: ['unit_not_found'], mention: 'Markting', hidden: ['Marketing', 'Miền Nam - Kinh doanh', 'L&A Holdings'], options: [{ ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.nesso) }] } },
  { q: 'Báo cáo học viên tháng 7', role: 'learner_plus', allowed: [UNIT_IDS.nesso], model: m('2026-07-01', '2026-07-31'), expect: { kind: 'snapshot', filter: { ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.nesso) } } },
  { q: 'Báo cáo học viên tháng 7', role: 'learner_plus', allowed: [UNIT_IDS.holdings, UNIT_IDS.nesso], model: m('2026-07-01', '2026-07-31'), expect: { kind: 'clarification', reasons: ['scope_required'], options: [{ ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.holdings) }, { ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.nesso) }] } },
  { q: 'Báo cáo nhóm Kinh doanh tháng 7', role: 'learner_plus', allowed: [UNIT_IDS.nesso], model: m('2026-07-01', '2026-07-31', units('Kinh doanh')), expect: { kind: 'snapshot', filter: { ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.salesNesso) } } },
  { q: 'Báo cáo chi nhánh Miền Nam tháng 7', role: 'learner_plus', allowed: [UNIT_IDS.nesso], model: m('2026-07-01', '2026-07-31', units('Miền Nam')), expect: { kind: 'clarification', reasons: ['unit_not_found'], mention: 'Miền Nam', hidden: ['Miền Nam - Kinh doanh', 'Miền Nam - Sản xuất'], options: [{ ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.nesso) }] } },
  { q: 'So sánh team Marketing và team QC tháng 7', role: 'learner_plus', allowed: [UNIT_IDS.nesso], model: m('2026-07-01', '2026-07-31', units('Marketing', 'QC')), expect: { kind: 'clarification', reasons: ['unit_not_found'], mention: 'Marketing', hidden: ['Miền Nam - Kinh doanh', 'Miền Nam - Sản xuất', 'L&A Holdings'], options: [{ ...r('2026-07-01', '2026-07-31'), ...u(UNIT_IDS.nesso) }] } },
  // Unit and period both unclear: one turn asks for both (bounded options)
  { q: 'Báo cáo nhóm Kinh doanh tháng 11', model: m('2026-11-01', '2026-11-30', units('Kinh doanh')), expect: { kind: 'clarification', reasons: ['unit_ambiguous', 'date_future'], optionCount: 6 } },
  // Model behaviour
  { q: 'Bảng xếp hạng khóa học tháng 5/2026', model: 'decline', expect: { kind: 'snapshot', filter: r('2026-05-01', '2026-05-31'), source: 'parser' } },
  { q: 'Báo cáo tỷ lệ hoàn thành của học viên', model: 'decline', expect: { kind: 'filters', filter: {} } },
  { q: 'Báo cáo học viên tháng 7/2025', model: 'error', expect: { kind: 'snapshot', filter: r('2025-07-01', '2025-07-31'), source: 'parser' } },
  { q: 'Viết email chúc mừng sinh nhật đồng nghiệp', model: 'decline', expect: { kind: 'direct' } },
  { q: 'Tỷ lệ hoàn thành là gì?', model: 'decline', expect: { kind: 'direct' } },
  { q: 'Báo cáo học viên', model: m(), expect: { kind: 'snapshot', filter: {}, source: 'default' } },
  { q: 'Báo cáo học viên mùa hè', model: m('2024-06-01', '2024-08-31'), expect: { kind: 'clarification', reasons: ['date_conflict'], options: [r('2026-06-01', '2026-08-31'), r('2024-06-01', '2024-08-31')] } },
  { q: 'Báo cáo học viên dịp Tết', model: m('2026-02-14', '2026-02-22'), expect: { kind: 'snapshot', filter: r('2026-02-14', '2026-02-22'), source: 'model' } },
  { q: 'How many learners in the Marketing team this month?', locale: 'en', model: 'decline', expect: { kind: 'snapshot', filter: { ...r('2026-10-01', '2026-10-08'), ...u(UNIT_IDS.marketing) } } },
  { q: 'Khóa học "An toàn lao động" có bao nhiêu người học tháng 7', model: m('2026-07-01', '2026-07-31', { course: 'An toàn lao động' }), expect: { kind: 'snapshot', filter: r('2026-07-01', '2026-07-31'), course: 'An toàn lao động' } },
];

function deps(testCase: GoldenCase): ReportRouterDeps {
  return {
    callModel: async (input) => {
      if (testCase.model === 'error') throw Object.assign(new Error('UNAVAILABLE'), { status: 503 });
      return parseReportRouterToolCall(
        testCase.model === 'decline' ? { name: 'respond_directly', args: {} } : { name: 'get_report_snapshot', args: testCase.model },
        input.today,
      );
    },
    loadCatalog: async () => REPORT_UNIT_CATALOG,
    loadLabels: async () => ({}),
    loadAllowedGroupIds: async () => testCase.allowed ?? [],
    log: () => undefined,
  };
}

function check(testCase: GoldenCase, decision: ReportRouteDecision): void {
  const label = `${testCase.q} [${JSON.stringify(testCase.model)}]`;
  assert.equal(decision.kind, testCase.expect.kind, `${label}: ${JSON.stringify(decision)}`);
  const expected = testCase.expect;
  if (expected.kind === 'snapshot' && decision.kind === 'snapshot') {
    assert.deepEqual(decision.filter, expected.filter, label);
    if (expected.granularity) assert.equal(decision.request.granularity, expected.granularity, label);
    if (expected.compare) assert.equal(decision.request.compare, true, label);
    if (expected.course) assert.equal(decision.request.course_hint, expected.course, label);
    if (expected.source) assert.equal(decision.request.period_source, expected.source, label);
  }
  if (expected.kind === 'filters' && decision.kind === 'filters' && expected.filter) {
    assert.deepEqual(decision.suggested_filter, expected.filter, label);
  }
  if (expected.kind === 'clarification' && decision.kind === 'clarification') {
    assert.deepEqual(decision.clarification.reasons, expected.reasons, `${label}: ${JSON.stringify(decision.clarification)}`);
    if (expected.options) assert.deepEqual(decision.clarification.options.map((option) => option.filter), expected.options, label);
    if (expected.optionCount !== undefined) assert.equal(decision.clarification.options.length, expected.optionCount, label);
    if (expected.mention) assert.equal(decision.clarification.params.mention, expected.mention, label);
    for (const name of expected.hidden ?? []) assert.ok(!JSON.stringify(decision).includes(name), `${label}: reveals ${name}`);
  }
}

test(`golden set covers at least 60 VI/EN phrasings (${CASES.length})`, () => {
  assert.ok(CASES.length >= 60);
});

for (const [index, testCase] of CASES.entries()) {
  test(`golden #${index + 1}: ${testCase.q}`, async () => {
    const decision = await routeAdminReportQuestion({
      tenantId: '20000000-0000-4000-8000-000000000001',
      userId: '30000000-0000-4000-8000-000000000001',
      role: testCase.role ?? 'staff',
      model: 'test-model',
      question: testCase.q,
      locale: testCase.locale ?? 'vi',
      referenceDate: REPORT_REFERENCE_DATE,
    }, deps(testCase));
    check(testCase, decision);
  });
}
