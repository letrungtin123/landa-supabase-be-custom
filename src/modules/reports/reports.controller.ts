// ═══════════════════════════════════════════════════════════════
// Reports Controller — HTTP handlers for analytics
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import { query } from '../../config/database.js';
import * as svc from './reports.service.js';
import type { StudyTimeGranularity } from '../enrollments/enrollments.service.js';

const VALID_STUDY_GRANULARITIES = new Set(['day', 'month', 'year']);

/**
 * Cho learner_plus: lấy danh sách org_group_ids mà user thuộc về.
 * Nếu user không thuộc group nào → trả mảng rỗng → FE hiển thị "Không có dữ liệu".
 * Nếu user request group_id không thuộc về họ → reject 403.
 */
async function enforceGroupScope(req: Request): Promise<{
  groupId: string | undefined;
  subgroupId: string | undefined;
  allowedGroupIds: string[] | null;  // null = no restriction (staff/superadmin), [] = no groups
}> {
  const role = req.user!.role;
  const requestedGroupId = req.query.group_id as string | undefined;
  const requestedSubgroupId = req.query.subgroup_id as string | undefined;

  // Staff/superuser/superadmin: không giới hạn
  if (role !== 'learner_plus') {
    return { groupId: requestedGroupId, subgroupId: requestedSubgroupId, allowedGroupIds: null };
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
    return { groupId: undefined, subgroupId: undefined, allowedGroupIds: [] };
  }

  // Nếu user request cụ thể 1 group_id → validate
  if (requestedGroupId && !allowedGroupIds.includes(requestedGroupId)) {
    throw { status: 403, message: 'Bạn không có quyền xem báo cáo của nhóm này' };
  }

  // Nếu user không chỉ định group_id → mặc định group đầu tiên
  const effectiveGroupId = requestedGroupId || allowedGroupIds[0];

  return { groupId: effectiveGroupId, subgroupId: requestedSubgroupId, allowedGroupIds };
}

/** GET /api/reports/summary */
export async function getSummary(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;

  const scope = await enforceGroupScope(req);
  if (scope.allowedGroupIds?.length === 0) {
    return sendSuccess(res, { meta: { month: month || new Date().getMonth() + 1, year: year || new Date().getFullYear() }, overview: { total_learners: 0, active_learners: 0, completion_rate: 0, total_enrollments: 0 } });
  }
  const result = await svc.getReportSummary(tenantId, month, year, scope.groupId, scope.subgroupId);
  sendSuccess(res, result);
}

/** GET /api/reports/chart */
export async function getChart(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const metric = (req.query.metric as string) || 'total_enrollments';
  const groupByOrg = req.query.group_by_org === 'true';
  const grouped = req.query.grouped !== 'false'; // default true

  const scope = await enforceGroupScope(req);
  if (scope.allowedGroupIds?.length === 0) {
    return sendSuccess(res, { data: [] });
  }
  const result = await svc.getReportChart(tenantId, year, metric, scope.groupId, scope.subgroupId, groupByOrg, grouped);
  sendSuccess(res, result);
}

/** GET /api/reports/top-courses */
export async function getTopCourses(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = Math.min(parseInt(req.query.page_size as string) || 10, 100);
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;

  const scope = await enforceGroupScope(req);
  if (scope.allowedGroupIds?.length === 0) {
    return sendSuccess(res, { results: [], total: 0, total_pages: 0 });
  }
  const result = await svc.getReportTopCourses(tenantId, page, pageSize, month, year, scope.groupId, scope.subgroupId);
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
  const status = req.query.status as 'all' | 'not_started' | 'learning' | 'completed' | undefined;

  const scope = await enforceGroupScope(req);
  if (scope.allowedGroupIds?.length === 0) {
    return sendSuccess(res, { results: [], count: 0, total_pages: 0 });
  }
  const result = await svc.getReportLearners(
    tenantId, page, pageSize, search, month, year, scope.groupId, scope.subgroupId, status,
  );
  sendSuccess(res, result);
}

/** GET /api/reports/learner-detail */
export async function getLearnerDetail(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const username = req.query.username as string;
  if (!username) return sendError(res, 'username is required', 400);

  const page = parseInt(req.query.page as string) || 1;
  const search = (req.query.search as string) || '';
  const pageSize = parseInt(req.query.page_size as string) || 10;

  const result = await svc.getLearnerDetail(tenantId, username, page, pageSize, search);
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
  const groupId = req.params.groupId;
  const role = req.user!.role;

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
