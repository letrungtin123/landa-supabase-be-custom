// ═══════════════════════════════════════════════════════════════
// Reports Controller — HTTP handlers for analytics
// ═══════════════════════════════════════════════════════════════

import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/response.js';
import * as svc from './reports.service.js';

/** GET /api/reports/summary */
export async function getSummary(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const groupId = req.query.group_id as string | undefined;
  const subgroupId = req.query.subgroup_id as string | undefined;

  const result = await svc.getReportSummary(tenantId, month, year, groupId, subgroupId);
  sendSuccess(res, result);
}

/** GET /api/reports/chart */
export async function getChart(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const metric = (req.query.metric as string) || 'total_enrollments';
  const groupId = req.query.group_id as string | undefined;
  const subgroupId = req.query.subgroup_id as string | undefined;
  const groupByOrg = req.query.group_by_org === 'true';
  const grouped = req.query.grouped !== 'false'; // default true

  const result = await svc.getReportChart(tenantId, year, metric, groupId, subgroupId, groupByOrg, grouped);
  sendSuccess(res, result);
}

/** GET /api/reports/top-courses */
export async function getTopCourses(req: Request, res: Response) {
  const tenantId = req.user!.tenantId!;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = Math.min(parseInt(req.query.page_size as string) || 10, 100);
  const month = req.query.month ? parseInt(req.query.month as string) : undefined;
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const groupId = req.query.group_id as string | undefined;
  const subgroupId = req.query.subgroup_id as string | undefined;

  const result = await svc.getReportTopCourses(tenantId, page, pageSize, month, year, groupId, subgroupId);
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
  const groupId = req.query.group_id as string | undefined;
  const subgroupId = req.query.subgroup_id as string | undefined;
  const status = req.query.status as 'all' | 'not_started' | 'learning' | 'completed' | undefined;

  const result = await svc.getReportLearners(
    tenantId, page, pageSize, search, month, year, groupId, subgroupId, status,
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

  const result = await svc.getUserStudyTime(username, tenantId);
  sendSuccess(res, result);
}

/** POST /api/reports/refresh — Manually refresh materialized view */
export async function refreshSummary(req: Request, res: Response) {
  await svc.refreshReportSummary();
  sendSuccess(res, { message: 'Report summary refreshed' });
}
