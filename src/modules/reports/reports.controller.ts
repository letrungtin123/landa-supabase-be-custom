// ═══════════════════════════════════════════════════════════════
// Reports Controller — HTTP handlers for analytics
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { auditFromReq } from '../../middleware/audit-log.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { query } from '../../config/database.js';
import * as svc from './reports.service.js';
import { streamReportExcel } from './reports-export.service.js';
import type { StudyTimeGranularity } from '../enrollments/enrollments.service.js';

const VALID_STUDY_GRANULARITIES = new Set(['day', 'month', 'year']);
const VALID_COURSE_COMPLETION_STATUSES = new Set(['all', 'not_started', 'learning', 'completed']);
const VALID_CHART_WINDOW_DIRECTIONS = new Set(['initial', 'before', 'after']);
const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type ReportScope = {
  groupId: string | undefined;
  subgroupId: string | undefined;
  teamId: string | undefined;
  allowedGroupIds: string[] | null;  // null = no restriction (staff/superadmin), [] = no groups
};

function getQueryId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'all') return undefined;
  return trimmed;
}

function getQueryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseReportDateRange(req: Request): svc.ReportDateRange | undefined {
  const dateFrom = getQueryString(req.query.date_from);
  const dateTo = getQueryString(req.query.date_to);
  if (!dateFrom && !dateTo) return undefined;
  if (!dateFrom || !dateTo) {
    throw { status: 400, message: 'date_from và date_to phải được gửi cùng nhau' };
  }

  const ymdPattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymdPattern.test(dateFrom) || !ymdPattern.test(dateTo)) {
    throw { status: 400, message: 'date_from/date_to phải có định dạng YYYY-MM-DD' };
  }

  const startDate = new Date(`${dateFrom}T00:00:00.000+07:00`);
  const endDate = new Date(`${dateTo}T23:59:59.999+07:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw { status: 400, message: 'Khoảng ngày không hợp lệ' };
  }
  if (startDate.getTime() > endDate.getTime()) {
    throw { status: 400, message: 'date_from không được lớn hơn date_to' };
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
    throw { status: 400, message: 'direction phải là initial, before hoặc after' };
  }

  const anchorBucket = getQueryString(req.query.anchor_bucket);
  if (anchorBucket && !YMD_PATTERN.test(anchorBucket)) {
    throw { status: 400, message: 'anchor_bucket phải có định dạng YYYY-MM-DD' };
  }

  return {
    mode,
    direction: rawDirection as svc.ReportChartWindowDirection,
    anchorBucket,
    limitBuckets: parsePositiveInteger(req.query.limit_buckets),
    seriesLimit: parsePositiveInteger(req.query.series_limit),
  };
}

async function resolveReportHierarchy(
  tenantId: string,
  requested: { groupId?: string; subgroupId?: string; teamId?: string },
): Promise<{ groupId?: string; subgroupId?: string; teamId?: string }> {
  if (requested.teamId) {
    const result = await query<{ group_id: string; subgroup_id: string; team_id: string }>(
      `SELECT og.id AS group_id, sg.id AS subgroup_id, t.id AS team_id
       FROM teams t
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE t.id = $1 AND og.tenant_id = $2
       LIMIT 1`,
      [requested.teamId, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw { status: 400, message: 'Team không hợp lệ hoặc không thuộc doanh nghiệp hiện tại' };
    if (requested.subgroupId && requested.subgroupId !== row.subgroup_id) {
      throw { status: 400, message: 'Team không thuộc nhóm con đã chọn' };
    }
    if (requested.groupId && requested.groupId !== row.group_id) {
      throw { status: 400, message: 'Team không thuộc nhóm đã chọn' };
    }
    return { groupId: row.group_id, subgroupId: row.subgroup_id, teamId: row.team_id };
  }

  if (requested.subgroupId) {
    const result = await query<{ group_id: string; subgroup_id: string }>(
      `SELECT og.id AS group_id, sg.id AS subgroup_id
       FROM sub_groups sg
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE sg.id = $1 AND og.tenant_id = $2
       LIMIT 1`,
      [requested.subgroupId, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw { status: 400, message: 'Nhóm con không hợp lệ hoặc không thuộc doanh nghiệp hiện tại' };
    if (requested.groupId && requested.groupId !== row.group_id) {
      throw { status: 400, message: 'Nhóm con không thuộc nhóm đã chọn' };
    }
    return { groupId: row.group_id, subgroupId: row.subgroup_id };
  }

  if (requested.groupId) {
    const result = await query<{ group_id: string }>(
      `SELECT id AS group_id
       FROM org_groups
       WHERE id = $1 AND tenant_id = $2
       LIMIT 1`,
      [requested.groupId, tenantId],
    );
    const row = result.rows[0];
    if (!row) throw { status: 400, message: 'Nhóm không hợp lệ hoặc không thuộc doanh nghiệp hiện tại' };
    return { groupId: row.group_id };
  }

  return {};
}

/**
 * Cho learner_plus: lấy danh sách org_group_ids mà user thuộc về.
 * Nếu user không thuộc group nào → trả mảng rỗng → FE hiển thị "Không có dữ liệu".
 * Nếu user request group_id không thuộc về họ → reject 403.
 */
async function enforceReportScope(req: Request): Promise<ReportScope> {
  const tenantId = req.user!.tenantId!;
  const role = req.user!.role;
  const requestedGroupId = getQueryId(req.query.group_id);
  const requestedSubgroupId = getQueryId(req.query.subgroup_id);
  const requestedTeamId = getQueryId(req.query.team_id);

  // Staff/superuser/superadmin: không giới hạn
  if (role !== 'learner_plus') {
    const hierarchy = await resolveReportHierarchy(tenantId, {
      groupId: requestedGroupId,
      subgroupId: requestedSubgroupId,
      teamId: requestedTeamId,
    });
    return {
      groupId: hierarchy.groupId,
      subgroupId: hierarchy.subgroupId,
      teamId: hierarchy.teamId,
      allowedGroupIds: null,
    };
  }

  // learner_plus: query allowed groups
  const result = await query<{ group_id: string }>(
    `SELECT DISTINCT og.id AS group_id
     FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE tm.user_id = $1`,
    [req.user!.id],
  );

  const allowedGroupIds = result.rows.map(r => r.group_id);

  // Không thuộc group nào → trả mảng rỗng, handler sẽ trả empty data
  if (allowedGroupIds.length === 0) {
    return { groupId: undefined, subgroupId: undefined, teamId: undefined, allowedGroupIds: [] };
  }

  const hierarchy = await resolveReportHierarchy(tenantId, {
    groupId: requestedGroupId,
    subgroupId: requestedSubgroupId,
    teamId: requestedTeamId,
  });
  const effectiveGroupId = hierarchy.groupId || requestedGroupId || allowedGroupIds[0];

  // Nếu user request cụ thể 1 group/team/subgroup ngoài scope → validate
  if (!allowedGroupIds.includes(effectiveGroupId)) {
    throw { status: 403, message: 'Bạn không có quyền xem báo cáo của nhóm này' };
  }

  return {
    groupId: effectiveGroupId,
    subgroupId: hierarchy.subgroupId,
    teamId: hierarchy.teamId,
    allowedGroupIds,
  };
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

/** GET /api/reports/learners */
export async function getLearners(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = Math.min(parseInt(req.query.page_size as string) || 20, 100);
  const search = req.query.search as string | undefined;
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const dateRange = parseReportDateRange(req);
  const status = req.query.status as 'all' | 'not_started' | 'learning' | 'completed' | undefined;

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
  const scope = await enforceReportScope(req);

  if (scope.allowedGroupIds?.length === 0) {
    return sendError(res, 'Không có dữ liệu trong phạm vi báo cáo hiện tại', 403);
  }

  const fileName = dateRange
    ? `bao-cao-tong-hop-${dateRange.dateFrom}-den-${dateRange.dateTo}.xlsx`
    : `bao-cao-tong-hop-${month ? `${month}-` : ''}${year}.xlsx`;
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
      labels: {
        group: (req.query.group_label as string) || 'Khối/Khu vực',
        subgroup: (req.query.subgroup_label as string) || 'Nhóm con',
        team: (req.query.team_label as string) || 'Đội nhóm',
      },
      exporterName: req.user!.username || 'Admin',
    });
  } catch (err) {
    console.error('[ReportsExport] Error:', err);
    if (!res.headersSent) {
      sendError(res, 'Có lỗi xảy ra khi xuất file báo cáo', 500);
      return;
    }
    res.destroy(err instanceof Error ? err : undefined);
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

  const scope = await enforceReportScope(req);
  if (scope.allowedGroupIds?.length === 0) {
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
  );
  sendSuccess(res, result);
}

/** GET /api/reports/user-badges */
export async function getUserBadges(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const username = req.query.username as string;
  if (!username) return sendError(res, 'username is required', 400);

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

  const result = await svc.getUserStudyTime(username, tenantId, {
    from: req.query.from as string | undefined,
    to: req.query.to as string | undefined,
    granularity: granularity as StudyTimeGranularity | undefined,
  });
  sendSuccess(res, result);
}

/** POST /api/reports/refresh — Manually refresh materialized view */
export async function refreshSummary(req: Request, res: Response) {
  await svc.refreshReportSummary();
  auditFromReq(req, 'UPDATE', 'tenant', req.user!.tenantId || undefined, undefined, 'Refresh report summary');
  sendSuccess(res, { message: 'Report summary refreshed' });
}

/**
 * GET /api/reports/groups — Danh sách org groups cho filter report.
 * Dùng quyền report_summary thay vì groups module.
 * learner_plus: chỉ trả groups mà user thuộc về.
 */
export async function getReportGroups(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const role = req.user!.role;

  if (role === 'learner_plus') {
    // Chỉ trả groups user thuộc về
    const result = await query<{ id: string; name: string; subgroup_count: number }>(
      `SELECT DISTINCT og.id, og.name,
              (SELECT COUNT(*)::int FROM sub_groups sg2 WHERE sg2.org_group_id = og.id) AS subgroup_count
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE tm.user_id = $1
       ORDER BY og.name`,
      [req.user!.id],
    );
    return sendSuccess(res, { groups: result.rows, total: result.rows.length });
  }

  // Staff/superuser/superadmin: tất cả groups trong tenant
  const result = await query<{ id: string; name: string; subgroup_count: number }>(
    `SELECT og.id, og.name,
            (SELECT COUNT(*)::int FROM sub_groups sg WHERE sg.org_group_id = og.id) AS subgroup_count
     FROM org_groups og
     WHERE og.tenant_id = $1
     ORDER BY og.name`,
    [tenantId],
  );
  sendSuccess(res, { groups: result.rows, total: result.rows.length });
}

/**
 * GET /api/reports/groups/:groupId/subgroups — Danh sách subgroups cho filter report.
 */
export async function getReportSubGroups(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const groupId = req.params.groupId;
  const role = req.user!.role;

  const groupCheck = await query<{ id: string }>(
    `SELECT id
     FROM org_groups
     WHERE id = $1 AND tenant_id = $2
     LIMIT 1`,
    [groupId, tenantId],
  );
  if (groupCheck.rows.length === 0) {
    return sendError(res, 'Nhóm không hợp lệ hoặc không thuộc doanh nghiệp hiện tại', 400);
  }

  // learner_plus: validate group thuộc về user
  if (role === 'learner_plus') {
    const check = await query<{ group_id: string }>(
      `SELECT DISTINCT og.id AS group_id
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE tm.user_id = $1 AND og.id = $2`,
      [req.user!.id, groupId],
    );
    if (check.rows.length === 0) {
      return sendError(res, 'Không có quyền xem nhóm này', 403);
    }
  }

  const result = await query<{ id: string; name: string; team_count: number }>(
    `SELECT sg.id, sg.name,
            (SELECT COUNT(*)::int FROM teams t WHERE t.sub_group_id = sg.id) AS team_count
     FROM sub_groups sg
     WHERE sg.org_group_id = $1
     ORDER BY sg.name`,
    [groupId],
  );
  sendSuccess(res, { subgroups: result.rows, total: result.rows.length });
}

/**
 * GET /api/reports/groups/:groupId/subgroups/:subgroupId/teams — Danh sách teams cho filter report.
 */
export async function getReportTeams(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const role = req.user!.role;
  const groupId = req.params.groupId;
  const subgroupId = req.params.subgroupId;

  const subgroupCheck = await query<{ subgroup_id: string }>(
    `SELECT sg.id AS subgroup_id
     FROM sub_groups sg
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE sg.id = $1 AND og.id = $2 AND og.tenant_id = $3
     LIMIT 1`,
    [subgroupId, groupId, tenantId],
  );
  if (subgroupCheck.rows.length === 0) {
    return sendError(res, 'Nhóm con không hợp lệ hoặc không thuộc nhóm đã chọn', 400);
  }

  // learner_plus: validate group thuộc về user, giữ cùng rule hiện tại của subgroup filter
  if (role === 'learner_plus') {
    const check = await query<{ group_id: string }>(
      `SELECT DISTINCT og.id AS group_id
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE tm.user_id = $1 AND og.id = $2`,
      [req.user!.id, groupId],
    );
    if (check.rows.length === 0) {
      return sendError(res, 'Không có quyền xem nhóm này', 403);
    }
  }

  const result = await query<{ id: string; name: string; member_count: number }>(
    `SELECT t.id, t.name,
            (SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = t.id) AS member_count
     FROM teams t
     WHERE t.sub_group_id = $1
     ORDER BY t.name`,
    [subgroupId],
  );
  sendSuccess(res, { teams: result.rows, total: result.rows.length });
}

