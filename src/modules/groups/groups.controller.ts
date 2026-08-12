// ═══════════════════════════════════════════════════════════════
// Groups Controller — All endpoints for 3-level hierarchy
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as svc from './groups.service.js';
import { createOrgGroupSchema, createSubGroupSchema, createTeamSchema } from './groups.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { auditFromReq } from '../../middleware/audit-log.js';

// ═══ Org Groups ═══

export async function listOrgGroupsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    sendSuccess(res, await svc.listOrgGroups(tenantId, req.query as Record<string, unknown>));
  } catch (err) { next(err); }
}

export async function createOrgGroupController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const parsed = createOrgGroupSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const group = await svc.createOrgGroup(tenantId, req.body);
    auditFromReq(req, 'CREATE', 'org_group', group.id, group.name);
    sendSuccess(res, group, 'Tạo nhóm thành công', 201);
  } catch (err) { next(err); }
}

export async function updateOrgGroupController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group = await svc.updateOrgGroup(req.params.id, req.body);
    auditFromReq(req, 'UPDATE', 'org_group', group.id, group.name);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

export async function deleteOrgGroupController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const deleted = await svc.deleteOrgGroup(req.params.id);
    auditFromReq(req, 'DELETE', 'org_group', req.params.id, deleted.name);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

// ═══ Sub Groups ═══

export async function listSubGroupsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await svc.listSubGroups(req.params.groupId, req.query as Record<string, unknown>)); }
  catch (err) { next(err); }
}

export async function createSubGroupController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createSubGroupSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const sg = await svc.createSubGroup(req.params.groupId, req.body);
    auditFromReq(req, 'CREATE', 'sub_group', sg.id, sg.name);
    sendSuccess(res, sg, 'Tạo phân nhóm thành công', 201);
  } catch (err) { next(err); }
}

export async function getSubGroupDetailController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await svc.getSubGroupDetail(req.params.id)); }
  catch (err) { next(err); }
}

export async function updateSubGroupController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sg = await svc.updateSubGroup(req.params.id, req.body);
    auditFromReq(req, 'UPDATE', 'sub_group', req.params.id, sg.name);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

export async function deleteSubGroupController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const deleted = await svc.deleteSubGroup(req.params.id);
    auditFromReq(req, 'DELETE', 'sub_group', req.params.id, deleted.name);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

// ═══ Teams ═══

export async function listTeamsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await svc.listTeams(req.params.subgroupId, req.query as Record<string, unknown>)); }
  catch (err) { next(err); }
}

export async function createTeamController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createTeamSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const team = await svc.createTeam(req.params.subgroupId, req.body);
    auditFromReq(req, 'CREATE', 'team', team.id, team.name);
    sendSuccess(res, team, 'Tạo team thành công', 201);
  } catch (err) { next(err); }
}

export async function getTeamDetailController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await svc.getTeamDetail(req.params.id)); }
  catch (err) { next(err); }
}

export async function listTeamMembersController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    sendSuccess(res, await svc.listTeamMembers(req.params.teamId, tenantId, req.query as Record<string, unknown>));
  } catch (err) { next(err); }
}

export async function listTeamDocCategoriesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    sendSuccess(res, await svc.listTeamDocCategories(req.params.teamId, tenantId, req.query as Record<string, unknown>));
  } catch (err) { next(err); }
}

export async function listTeamCourseCategoriesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    sendSuccess(res, await svc.listTeamCourseCategories(req.params.teamId, tenantId, req.query as Record<string, unknown>));
  } catch (err) { next(err); }
}

export async function updateTeamController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const team = await svc.updateTeam(req.params.id, req.body);
    auditFromReq(req, 'UPDATE', 'team', req.params.id, team.name);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

export async function deleteTeamController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const deleted = await svc.deleteTeam(req.params.id);
    auditFromReq(req, 'DELETE', 'team', req.params.id, deleted.name);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

// ═══ Team Members ═══

export async function addTeamMembersController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user_ids } = req.body;
    if (!Array.isArray(user_ids)) { sendError(res, 'user_ids phải là mảng', 400); return; }
    const tenantId = req.user!.tenantId;
    const actorUserId = req.user!.id;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await svc.addTeamMembers(req.params.teamId, user_ids, {
      tenantId,
      actorUserId,
    });
    auditFromReq(req, 'UPDATE', 'team_member', req.params.teamId, result.teamName, `Thêm ${result.added} thành viên`);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function groupSmtpStatusController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    sendSuccess(res, await svc.getGroupNotificationSmtpStatus(tenantId));
  } catch (err) { next(err); }
}

export async function removeTeamMemberController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await svc.removeTeamMember(req.params.teamId, req.params.userId);
    auditFromReq(req, 'DELETE', 'team_member', req.params.teamId, result.teamName, `Xóa thành viên ${result.username}`);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

// ═══ Team Courses ═══

export async function assignTeamCoursesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { course_ids } = req.body;
    if (!Array.isArray(course_ids)) { sendError(res, 'course_ids phải là mảng', 400); return; }
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    sendError(res, 'Không còn hỗ trợ phân khóa học riêng cho team. Vui lòng phân danh mục khóa học.', 400);
  } catch (err) { next(err); }
}

export async function revokeTeamCourseController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await svc.revokeTeamCourse(req.params.teamId, decodeURIComponent(req.params.courseId), tenantId);
    auditFromReq(req, 'DELETE', 'team_course', req.params.teamId, result.teamName, `Gỡ khóa học ${result.courseName}`);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

// ═══ Team Doc Categories ═══

export async function assignTeamDocCategoriesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { category_ids } = req.body;
    if (!Array.isArray(category_ids)) { sendError(res, 'category_ids phải là mảng', 400); return; }
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await svc.assignTeamDocCategories(req.params.teamId, category_ids, tenantId);
    auditFromReq(req, 'UPDATE', 'team_category', req.params.teamId, result.teamName, `Gán ${result.assigned} danh mục tài liệu`);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function revokeTeamDocCategoryController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await svc.revokeTeamDocCategory(req.params.teamId, req.params.categoryId, tenantId);
    auditFromReq(req, 'DELETE', 'team_category', req.params.teamId, result.teamName, `Gỡ danh mục tài liệu ${result.categoryName}`);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

// ═══ Team Course Categories ═══

export async function assignTeamCourseCategoriesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { category_ids } = req.body;
    if (!Array.isArray(category_ids)) { sendError(res, 'category_ids phải là mảng', 400); return; }
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await svc.assignTeamCourseCategories(req.params.teamId, category_ids, tenantId);
    auditFromReq(req, 'UPDATE', 'team_course_category', req.params.teamId, result.teamName, `Gán ${result.assigned} danh mục khóa học`);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function revokeTeamCourseCategoryController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await svc.revokeTeamCourseCategory(req.params.teamId, req.params.categoryId, tenantId);
    auditFromReq(req, 'DELETE', 'team_course_category', req.params.teamId, result.teamName, `Gỡ danh mục khóa học ${result.categoryName}`);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

// ═══ Group Audit Logs ═══

export async function groupAuditLogsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    sendSuccess(res, await svc.getGroupAuditLogs(tenantId, req.query as Record<string, unknown>));
  } catch (err) { next(err); }
}
