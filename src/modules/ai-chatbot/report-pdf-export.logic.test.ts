import assert from 'node:assert/strict';
import test from 'node:test';
import { getReportPdfExportPhaseIndex, isReportPdfExportTerminal } from './report-pdf-export.logic.js';
import {
  buildReportPdfArtifact,
  downloadReportPdfExportJob,
  startReportPdfExportJob,
} from './report-pdf-export.service.js';
import { generateReportPdfNarrative } from './report-pdf.service.js';

test('orders report PDF export phases without treating in-flight phases as complete', () => {
  assert.ok(getReportPdfExportPhaseIndex('validating') < getReportPdfExportPhaseIndex('narrative'));
  assert.ok(getReportPdfExportPhaseIndex('narrative') < getReportPdfExportPhaseIndex('rendering'));
  assert.ok(getReportPdfExportPhaseIndex('rendering') < getReportPdfExportPhaseIndex('ready'));
  assert.equal(isReportPdfExportTerminal('rendering'), false);
  assert.equal(isReportPdfExportTerminal('ready'), true);
  assert.equal(isReportPdfExportTerminal('failed'), true);
});

const deniedPermission = async () => false;
const actor = { userId: 'user-id', tenantId: 'tenant-id', role: 'staff' as const };
const reportReference = {
  ...actor,
  conversationId: '00000000-0000-4000-8000-000000000001',
  assistantMessageId: '00000000-0000-4000-8000-000000000002',
  permissionChecker: deniedPermission,
};

test('denies PDF job start and background artifact build when report permission was revoked', async () => {
  await assert.rejects(
    () => startReportPdfExportJob(reportReference),
    (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'REPORT_PDF_PERMISSION_DENIED'),
  );
  await assert.rejects(
    () => buildReportPdfArtifact({
      actor,
      conversationId: reportReference.conversationId,
      assistantMessageId: reportReference.assistantMessageId,
      permissionChecker: deniedPermission,
    }),
    (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'REPORT_PDF_PERMISSION_DENIED'),
  );
});

test('denies a ready-PDF download when report permission was revoked', async () => {
  await assert.rejects(
    () => downloadReportPdfExportJob({ ...reportReference, jobId: '00000000-0000-4000-8000-000000000003' }),
    (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'REPORT_PDF_PERMISSION_DENIED'),
  );
});

test('builds PDF factual narrative from the persisted report snapshot', async () => {
  const snapshot = {
    version: 1 as const,
    generated_at: '2026-09-19T00:00:00.000Z',
    timezone: 'Asia/Ho_Chi_Minh' as const,
    filter: { date_from: '2026-09-01', date_to: '2026-09-19' },
    scope: { groupId: 'group-1', subgroupId: undefined, teamId: undefined, allowedGroupIds: null },
    summary: {
      meta: { month: 9, year: 2026, month_label: '09/2026', is_current_month: true, date_from: '2026-09-01', date_to: '2026-09-19' },
      overview: { total_learners: 13, active_learners: 8, completion_rate: 78.5, total_enrollments: 37, completed_enrollments: 29, incomplete_enrollments: 8 },
    },
    enrollment_trend: [],
    top_courses: [],
    completion_ranking: [],
  };
  const narrative = await generateReportPdfNarrative({
    tenantId: 'tenant-id',
    model: 'deterministic',
    locale: 'vi',
    question: 'Báo cáo học tập',
    snapshot,
  });

  assert.deepEqual(narrative.highlights, [
    'Giai đoạn đã chọn chưa cho thấy thay đổi đáng kể ở các chỉ số có dữ liệu so sánh.',
  ]);
  assert.deepEqual(narrative.risks, []);
  assert.deepEqual(narrative.recommendations, []);
});
