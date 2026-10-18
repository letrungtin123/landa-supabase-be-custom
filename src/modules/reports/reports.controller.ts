// ═══════════════════════════════════════════════════════════════
// Reports Controller — HTTP handlers for analytics
// ═══════════════════════════════════════════════════════════════

import type { NextFunction, Request, Response } from 'express';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { AppError } from '../../middleware/error-handler.js';
import { isReportsSnapshotAbortedError } from '../../config/reports-database.js';
import { errorKind } from '../../utils/best-effort.js';
import * as svc from './reports.service.js';
import {
  REPORTS_BUSY_CODE,
  REPORTS_BUSY_ERROR,
  REPORTS_BUSY_RETRY_AFTER_SECONDS,
  REPORT_EXPORT_BUSY_CODE,
  REPORT_EXPORT_BUSY_ERROR,
  REPORT_EXPORT_BUSY_RETRY_AFTER_SECONDS,
  REPORT_EXPORT_IN_PROGRESS_CODE,
  REPORT_EXPORT_IN_PROGRESS_ERROR,
  isReportsBusyError,
} from './report-admission.logic.js';
import { tryAcquireReportExportSlot } from './report-admission.service.js';
import { refreshReportSummaryOnce, type ReportSummaryRefreshOutcome } from './report-summary-refresh.service.js';
import {
  findReportCourse,
  listReportGroups,
  listReportSubGroups,
  listReportTeams,
  type ReportFilterRefusal,
} from './report-filters.service.js';
import {
  buildCourseLearnerExcelFileName,
  buildReportExcelFileName,
  normalizeReportExcelLocale,
  resolveReportExcelLabels,
  streamCourseLearnerExcel,
  streamReportExcel,
  type ReportExcelLocale,
} from './reports-export.service.js';
import { getTenantGroupLabels } from '../tenants/tenant-group-labels.service.js';
import {
  canReportOnLearner,
  enforceReportScope as enforceSharedReportScope,
  readReportScopeId,
  type ReportScope,
} from './report-access.service.js';
import type { StudyTimeGranularity } from '../enrollments/enrollments.service.js';

/** Level names of an Excel export: the tenant's labels, else the names the client sent, else the defaults. */
async function getExportLabels(req: Request, tenantId: string, locale: ReportExcelLocale) {
  return resolveReportExcelLabels(
    await getTenantGroupLabels(tenantId),
    { group: req.query.group_label, subgroup: req.query.subgroup_label, team: req.query.team_label },
    locale,
  );
}

/** The dashboard sends its UI language on every request. */
function requestUiLocale(req: Request): ReportExcelLocale {
  return req.get('X-UI-Locale')?.trim().toLowerCase() === 'en' ? 'en' : 'vi';
}

/**
 * Router error handler: a report aggregate that found no free slot in time
 * (report-admission.logic.ts) answers 429 REPORTS_BUSY instead of a 500.
 */
export function handleReportsBusyError(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (!isReportsBusyError(err) || res.headersSent) {
    next(err);
    return;
  }
  const [status, vi, en] = REPORTS_BUSY_ERROR;
  res.setHeader('Retry-After', String(REPORTS_BUSY_RETRY_AFTER_SECONDS));
  res.status(status).json({ success: false, code: REPORTS_BUSY_CODE, message: requestUiLocale(req) === 'en' ? en : vi });
}

/** An export slot of the caller (release it when done), or null once a 429 has been sent. */
function acquireExportSlotOrRefuse(req: Request, res: Response, locale: ReportExcelLocale): (() => void) | null {
  const slot = tryAcquireReportExportSlot({ tenantId: req.user!.tenantId!, userId: req.user!.id });
  if ('release' in slot) return slot.release;
  const [status, vi, en] = slot.refused === 'user' ? REPORT_EXPORT_IN_PROGRESS_ERROR : REPORT_EXPORT_BUSY_ERROR;
  res.setHeader('Retry-After', String(REPORT_EXPORT_BUSY_RETRY_AFTER_SECONDS));
  res.status(status).json({
    success: false,
    code: slot.refused === 'user' ? REPORT_EXPORT_IN_PROGRESS_CODE : REPORT_EXPORT_BUSY_CODE,
    message: locale === 'en' ? en : vi,
  });
  return null;
}

/** Aborts when the response closes before the whole file was sent (tab closed, download cancelled). */
function abortWhenClientLeaves(res: Response): AbortSignal {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

const VALID_STUDY_GRANULARITIES = new Set(['day', 'month', 'year']);
const VALID_COURSE_COMPLETION_STATUSES = new Set(['all', 'not_started', 'learning', 'completed']);
const VALID_CHART_WINDOW_DIRECTIONS = new Set(['initial', 'before', 'after']);
const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function getQueryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseReportDateRange(req: Request): svc.ReportDateRange | undefined {
  const dateFrom = getQueryString(req.query.date_from);
  const dateTo = getQueryString(req.query.date_to);
  if (!dateFrom && !dateTo) return undefined;
  if (!dateFrom || !dateTo) {
    throw new AppError('Vui lòng chọn cả ngày bắt đầu và ngày kết thúc.', 400);
  }

  const ymdPattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymdPattern.test(dateFrom) || !ymdPattern.test(dateTo)) {
    throw new AppError('Ngày bắt đầu hoặc ngày kết thúc không hợp lệ.', 400);
  }

  const startDate = new Date(`${dateFrom}T00:00:00.000+07:00`);
  const endDate = new Date(`${dateTo}T23:59:59.999+07:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new AppError('Khoảng ngày không hợp lệ.', 400);
  }
  if (startDate.getTime() > endDate.getTime()) {
    throw new AppError('Ngày bắt đầu không được sau ngày kết thúc.', 400);
  }

  return { startDate, endDate, dateFrom, dateTo };
}

function parseChartGranularity(value: unknown): svc.ReportChartGranularity {
  return value === 'day' || value === 'week' || value === 'month' ? value : 'auto';
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseChartWindowOptions(req: Request): svc.ReportChartWindowOptions {
  const mode = req.query.mode === 'window' ? 'window' : 'range';
  const rawDirection = typeof req.query.direction === 'string' ? req.query.direction : 'initial';
  if (rawDirection && !VALID_CHART_WINDOW_DIRECTIONS.has(rawDirection)) {
    throw new AppError('Hướng xem tiếp của biểu đồ không hợp lệ.', 400);
  }

  const anchorBucket = getQueryString(req.query.anchor_bucket);
  if (anchorBucket && !YMD_PATTERN.test(anchorBucket)) {
    throw new AppError('Mốc thời gian của biểu đồ không hợp lệ.', 400);
  }

  return {
    mode,
    direction: rawDirection as svc.ReportChartWindowDirection,
    anchorBucket,
    limitBuckets: parsePositiveInteger(req.query.limit_buckets),
    seriesLimit: parsePositiveInteger(req.query.series_limit),
  };
}

/**
 * Cho learner_plus: lấy danh sách org_group_ids mà user thuộc về.
 * Nếu user không thuộc group nào → trả mảng rỗng → FE hiển thị "Không có dữ liệu".
 * Nếu user request group_id không thuộc về họ → reject 403.
 */
function reportActor(req: Request) {
  return { userId: req.user!.id, tenantId: req.user!.tenantId!, role: req.user!.role };
}

/**
 * The shared scope check (report-access.service.ts) throws ReportRequestErrors
 * (AppErrors), which pass through unchanged. A plain 4xx `{ status, message,
 * code }` object, the form those errors used to have, still becomes an
 * AppError, so the answer keeps its 4xx and message instead of the global
 * handler's 500.
 */
export function asReportRequestError(error: unknown): unknown {
  if (error instanceof Error || !error || typeof error !== 'object') return error;
  const { status, message, code } = error as { status?: unknown; message?: unknown; code?: unknown };
  if (typeof status !== 'number' || status < 400 || status >= 500 || typeof message !== 'string') return error;
  return new AppError(message, status, typeof code === 'string' ? code : undefined);
}

async function enforceReportScope(req: Request): Promise<ReportScope> {
  try {
    return await enforceSharedReportScope(
      {
        userId: req.user!.id,
        tenantId: req.user!.tenantId!,
        role: req.user!.role,
      },
      {
        groupId: readReportScopeId(req.query.group_id),
        subgroupId: readReportScopeId(req.query.subgroup_id),
        teamId: readReportScopeId(req.query.team_id),
      },
    );
  } catch (error) {
    throw asReportRequestError(error);
  }
}

/** GET /api/reports/summary */
export async function getSummary(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const dateRange = parseReportDateRange(req);

  const scope = await enforceReportScope(req);
  if (scope.allowedGroupIds?.length === 0) {
    return sendSuccess(res, { meta: { month: month || new Date().getMonth() + 1, year: year || new Date().getFullYear() }, overview: { total_learners: 0, active_learners: 0, completion_rate: 0, total_enrollments: 0, completed_enrollments: 0, incomplete_enrollments: 0 } });
  }
  const result = await svc.getReportSummary(tenantId, month, year, scope.groupId, scope.subgroupId, scope.teamId, dateRange);
  sendSuccess(res, result);
}

/** GET /api/reports/chart */
export async function getChart(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const metric = (req.query.metric as string) || 'total_enrollments';
  const groupByOrg = req.query.group_by_org === 'true';
  const grouped = req.query.grouped !== 'false'; // default true
  const dateRange = parseReportDateRange(req);
  const granularity = parseChartGranularity(req.query.granularity);
  const windowOptions = parseChartWindowOptions(req);

  const scope = await enforceReportScope(req);
  if (scope.allowedGroupIds?.length === 0) {
    return sendSuccess(res, { data: [] });
  }
  const result = await svc.getReportChart(tenantId, year, metric, scope.groupId, scope.subgroupId, scope.teamId, groupByOrg, grouped, dateRange, granularity, windowOptions);
  sendSuccess(res, result);
}

/** GET /api/reports/top-courses */
export async function getTopCourses(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = Math.min(parseInt(req.query.page_size as string) || 10, 100);
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const dateRange = parseReportDateRange(req);

  const scope = await enforceReportScope(req);
  if (scope.allowedGroupIds?.length === 0) {
    return sendSuccess(res, { results: [], total: 0, total_pages: 0 });
  }
  const result = await svc.getReportTopCourses(tenantId, page, pageSize, month, year, scope.groupId, scope.subgroupId, scope.teamId, dateRange);
  sendSuccess(res, result);
}

/** GET /api/reports/course-completion-ranking */
export async function getCourseCompletionRanking(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.page_size as string) || 10, 1), 100);
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const dateRange = parseReportDateRange(req);

  const scope = await enforceReportScope(req);
  if (scope.allowedGroupIds?.length === 0) {
    return sendSuccess(res, { results: [], count: 0, total_pages: 0, current_page: page });
  }
  const result = await svc.getReportCourseCompletionRanking(
    tenantId, page, pageSize, month, year, scope.groupId, scope.subgroupId, scope.teamId, dateRange,
  );
  sendSuccess(res, result);
}

/** GET /api/reports/course-completion-ranking/:courseId/learners */
export async function getCourseCompletionLearners(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const courseId = req.params.courseId;
  if (!courseId) return sendError(res, 'courseId is required', 400);

  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.page_size as string) || 20, 1), 100);
  const search = req.query.search as string | undefined;
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const dateRange = parseReportDateRange(req);
  const rawStatus = req.query.status as string | undefined;
  const status = VALID_COURSE_COMPLETION_STATUSES.has(rawStatus || '')
    ? rawStatus as svc.ReportCourseCompletionStatus
    : 'all';

  const scope = await enforceReportScope(req);
  if (scope.allowedGroupIds?.length === 0) {
    return sendSuccess(res, { results: [], count: 0, total_pages: 0, current_page: page });
  }
  const result = await svc.getReportCourseCompletionLearners(
    tenantId, courseId, page, pageSize, search, month, year, scope.groupId, scope.subgroupId, scope.teamId, status, dateRange,
  );
  sendSuccess(res, result);
}

/** GET /api/reports/course-completion-ranking/:courseId/export.xlsx */
export async function exportCourseCompletionLearners(req: Request, res: Response) {
  if (req.user!.role === 'learner_plus') {
    return sendError(res, 'Không có quyền xuất file báo cáo', 403);
  }

  const tenantId = req.user!.tenantId!;
  const courseId = req.params.courseId;
  if (!courseId) return sendError(res, 'courseId is required', 400);

  const course = await findReportCourse(tenantId, courseId);
  if (!course) return sendError(res, 'Không tìm thấy khóa học', 404);

  const now = new Date();
  const dateRange = parseReportDateRange(req);
  const year = Math.max(parseInt(req.query.year as string) || dateRange?.startDate.getFullYear() || now.getFullYear(), 2000);
  const rawMonth = req.query.month ? parseInt(req.query.month as string) : undefined;
  const month = dateRange ? undefined : rawMonth && rawMonth >= 1 && rawMonth <= 12 ? rawMonth : undefined;
  const locale = normalizeReportExcelLocale(req.query.locale);
  const scope = await enforceReportScope(req);
  if (scope.allowedGroupIds?.length === 0) {
    return sendError(res, 'Không có dữ liệu trong phạm vi báo cáo hiện tại', 403);
  }

  const releaseExportSlot = acquireExportSlotOrRefuse(req, res, locale);
  if (!releaseExportSlot) return;
  const clientGone = abortWhenClientLeaves(res);

  const courseName = course.display_name;
  const fileName = buildCourseLearnerExcelFileName(locale, courseName, dateRange, month, year);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader('Cache-Control', 'no-store');

  try {
    await streamCourseLearnerExcel({
      stream: res,
      tenantId,
      courseId,
      courseName,
      year,
      month,
      dateRange,
      scope: {
        groupId: scope.groupId,
        subgroupId: scope.subgroupId,
        teamId: scope.teamId,
      },
      labels: await getExportLabels(req, tenantId, locale),
      exporterName: req.user!.username || 'Admin',
      locale,
      signal: clientGone,
    });
  } catch (err) {
    if (isReportsSnapshotAbortedError(err)) {
      console.info(JSON.stringify({ event: 'report_export_aborted', export: 'course_learners', tenant_id: tenantId }));
      return;
    }
    console.error('[CourseLearnersExport] Error:', err);
    if (!res.headersSent) {
      sendError(res, 'Có lỗi xảy ra khi xuất danh sách học viên khóa học', 500);
      return;
    }
    res.destroy(err instanceof Error ? err : undefined);
  } finally {
    releaseExportSlot();
  }
}

/** GET /api/reports/learners */
export async function getLearners(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = Math.min(parseInt(req.query.page_size as string) || 20, 100);
  const search = req.query.search as string | undefined;
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const dateRange = parseReportDateRange(req);
  // The dashboard always sends one ('all' for no filter); a missing or empty
  // status used to filter on the text 'undefined' and list nobody.
  if (getQueryString(req.query.status) === undefined) {
    return sendError(res, 'Vui lòng chọn trạng thái học tập để xem danh sách học viên.', 400);
  }
  const status = req.query.status as 'all' | 'not_started' | 'learning' | 'completed';

  const scope = await enforceReportScope(req);
  if (scope.allowedGroupIds?.length === 0) {
    return sendSuccess(res, { results: [], count: 0, total_pages: 0 });
  }
  const result = await svc.getReportLearners(
    tenantId, page, pageSize, search, month, year, scope.groupId, scope.subgroupId, scope.teamId, status, dateRange,
  );
  sendSuccess(res, result);
}

/** GET /api/reports/export.xlsx */
export async function exportExcel(req: Request, res: Response) {
  if (req.user!.role === 'learner_plus') {
    return sendError(res, 'Không có quyền xuất file báo cáo', 403);
  }

  const tenantId = req.user!.tenantId!;
  const now = new Date();
  const dateRange = parseReportDateRange(req);
  const year = Math.max(parseInt(req.query.year as string) || dateRange?.startDate.getFullYear() || now.getFullYear(), 2000);
  const rawMonth = req.query.month ? parseInt(req.query.month as string) : undefined;
  const month = dateRange ? undefined : rawMonth && rawMonth >= 1 && rawMonth <= 12 ? rawMonth : undefined;
  const locale = normalizeReportExcelLocale(req.query.locale);
  const scope = await enforceReportScope(req);

  if (scope.allowedGroupIds?.length === 0) {
    return sendError(res, 'Không có dữ liệu trong phạm vi báo cáo hiện tại', 403);
  }

  const releaseExportSlot = acquireExportSlotOrRefuse(req, res, locale);
  if (!releaseExportSlot) return;
  const clientGone = abortWhenClientLeaves(res);

  const fileName = buildReportExcelFileName(locale, dateRange, month, year);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader('Cache-Control', 'no-store');

  try {
    await streamReportExcel({
      stream: res,
      tenantId,
      year,
      month,
      dateRange,
      scope: {
        groupId: scope.groupId,
        subgroupId: scope.subgroupId,
        teamId: scope.teamId,
      },
      labels: await getExportLabels(req, tenantId, locale),
      exporterName: req.user!.username || 'Admin',
      locale,
      signal: clientGone,
    });
  } catch (err) {
    if (isReportsSnapshotAbortedError(err)) {
      console.info(JSON.stringify({ event: 'report_export_aborted', export: 'report', tenant_id: tenantId }));
      return;
    }
    console.error('[ReportsExport] Error:', err);
    if (!res.headersSent) {
      sendError(res, 'Có lỗi xảy ra khi xuất file báo cáo', 500);
      return;
    }
    res.destroy(err instanceof Error ? err : undefined);
  } finally {
    releaseExportSlot();
  }
}

/** GET /api/reports/learner-detail */
export async function getLearnerDetail(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const username = req.query.username as string;
  if (!username) return sendError(res, 'username is required', 400);

  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const search = (req.query.search as string) || '';
  const pageSize = Math.min(Math.max(parseInt(req.query.page_size as string) || 10, 1), 100);
  const rawStatus = req.query.status as string | undefined;
  const status = VALID_COURSE_COMPLETION_STATUSES.has(rawStatus || '')
    ? rawStatus as svc.ReportCourseCompletionStatus
    : 'all';

  const rawDataScope = req.query.data_scope as string | undefined;
  const dataScope: svc.LearnerDetailDataScope | undefined = rawDataScope === 'report_filter' || rawDataScope === 'learner_history'
    ? rawDataScope
    : undefined;
  const dateRange = dataScope === 'report_filter' ? parseReportDateRange(req) : undefined;
  if (dataScope === 'report_filter' && !dateRange) {
    return sendError(res, 'date_from và date_to là bắt buộc khi lọc theo bộ lọc báo cáo', 400);
  }
  const scope = await enforceReportScope(req);
  // learner_plus: only learners of their own groups (an out-of-scope learner looks unknown).
  if (scope.allowedGroupIds?.length === 0 || !await canReportOnLearner(reportActor(req), username)) {
    return sendSuccess(res, { username, groups: [], results: [], total_count: 0, total_pages: 0, current_page: page });
  }

  const result = await svc.getLearnerDetail(
    tenantId,
    username,
    page,
    pageSize,
    search,
    scope.groupId,
    scope.subgroupId,
    scope.teamId,
    status,
    dataScope,
    dateRange,
  );
  sendSuccess(res, result);
}

/** GET /api/reports/user-badges */
export async function getUserBadges(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const username = req.query.username as string;
  if (!username) return sendError(res, 'username is required', 400);

  if (!await canReportOnLearner(reportActor(req), username)) {
    return sendSuccess(res, { username, badges: [] });
  }
  const result = await svc.getUserBadges(username, tenantId);
  sendSuccess(res, result);
}

/** GET /api/reports/user-study-time */
export async function getUserStudyTime(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const username = req.query.username as string;
  if (!username) return sendError(res, 'username is required', 400);

  const granularity = req.query.granularity as string | undefined;
  if (granularity && !VALID_STUDY_GRANULARITIES.has(granularity)) {
    return sendError(res, 'granularity must be day, month, or year', 400);
  }

  const options = {
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
    granularity: granularity as StudyTimeGranularity | undefined,
  };
  // An out-of-scope learner answers like an unknown one (no entries).
  if (!await canReportOnLearner(reportActor(req), username)) {
    return sendSuccess(res, svc.emptyUserStudyTime(username, options));
  }
  const result = await svc.getUserStudyTime(username, tenantId, options);
  sendSuccess(res, result);
}

export const REPORT_SUMMARY_REFRESH_FAILED_CODE = 'REPORT_SUMMARY_REFRESH_FAILED';
/** [HTTP status, Vietnamese, English]: the summary could not be refreshed (a database failure). */
export const REPORT_SUMMARY_REFRESH_FAILED_ERROR = [
  503,
  'Không làm mới được báo cáo, vui lòng thử lại sau.',
  'The report could not be refreshed. Please try again later.',
] as const;

/**
 * POST /api/reports/refresh — Manually refresh materialized view. One rebuild
 * at a time per process; a call within a minute of a successful rebuild
 * answers success with `skipped_recent: true` and rebuilds nothing.
 */
export async function refreshSummary(req: Request, res: Response) {
  let outcome: ReportSummaryRefreshOutcome;
  try {
    outcome = await refreshReportSummaryOnce();
  } catch (error) {
    // Success only when the summary was refreshed. The log has the error kind, never its text.
    console.error(`[Reports] ${JSON.stringify({
      event: 'report_summary_refresh_failed', tenant_id: req.user!.tenantId ?? null, error_kind: errorKind(error),
    })}`);
    const [status, vi, en] = REPORT_SUMMARY_REFRESH_FAILED_ERROR;
    throw new AppError(requestUiLocale(req) === 'en' ? en : vi, status, REPORT_SUMMARY_REFRESH_FAILED_CODE);
  }
  if (outcome.skippedRecent) {
    // Nothing was rebuilt, so nothing is audited.
    sendSuccess(res, { message: 'Report summary refreshed', skipped_recent: true });
    return;
  }
  await runAuditedTransaction(
    () => Promise.resolve(),
    () => createTransactionalAuditEntry(req, 'UPDATE', 'report_summary', { code: 'report.summary.refreshed' }, req.user!.tenantId || undefined, 'report_summary'),
  );
  sendSuccess(res, { message: 'Report summary refreshed' });
}

/** [HTTP status, message] of each refused filter list (the messages the dashboard shows). */
const REPORT_FILTER_REFUSALS: Record<ReportFilterRefusal, readonly [number, string]> = {
  group_not_in_tenant: [400, 'Nhóm không hợp lệ hoặc không thuộc doanh nghiệp hiện tại'],
  group_not_allowed: [403, 'Không có quyền xem nhóm này'],
  subgroup_not_in_group: [400, 'Nhóm con không hợp lệ hoặc không thuộc nhóm đã chọn'],
};

function sendFilterRefusal(res: Response, refusal: ReportFilterRefusal): void {
  const [status, message] = REPORT_FILTER_REFUSALS[refusal];
  sendError(res, message, status);
}

/**
 * GET /api/reports/groups — Danh sách org groups cho filter report.
 * Dùng quyền report_summary thay vì groups module.
 * learner_plus: chỉ trả groups mà user thuộc về.
 */
export async function getReportGroups(req: Request, res: Response) {
  const groups = await listReportGroups(reportActor(req));
  sendSuccess(res, { groups, total: groups.length });
}

/**
 * GET /api/reports/groups/:groupId/subgroups — Danh sách subgroups cho filter report.
 */
export async function getReportSubGroups(req: Request, res: Response) {
  const result = await listReportSubGroups(reportActor(req), req.params.groupId);
  if (result.refusal) return sendFilterRefusal(res, result.refusal);
  sendSuccess(res, { subgroups: result.subgroups, total: result.subgroups.length });
}

/**
 * GET /api/reports/groups/:groupId/subgroups/:subgroupId/teams — Danh sách teams cho filter report.
 */
export async function getReportTeams(req: Request, res: Response) {
  const result = await listReportTeams(reportActor(req), req.params.groupId, req.params.subgroupId);
  if (result.refusal) return sendFilterRefusal(res, result.refusal);
  sendSuccess(res, { teams: result.teams, total: result.teams.length });
}
