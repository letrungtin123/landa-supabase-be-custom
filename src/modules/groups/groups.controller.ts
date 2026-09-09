// ═══════════════════════════════════════════════════════════════
// Groups Controller — All endpoints for 3-level hierarchy
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as svc from './groups.service.js';
import { createOrgGroupSchema, createSubGroupSchema, createTeamSchema } from './groups.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import {
  createTransactionalAuditEntry,
  runAuditedTransaction,
} from '../../middleware/audit-log.js';

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
    const group = await runAuditedTransaction(
      () => svc.createOrgGroup(tenantId, req.body),
      (created) => createTransactionalAuditEntry(req, 'CREATE', 'org_group', { code: 'group.org.created' }, created.id, created.name),
    );
    sendSuccess(res, group, 'Tạo nhóm thành công', 201);
  } catch (err) { next(err); }
}

export async function updateOrgGroupController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const group = await runAuditedTransaction(
      () => svc.updateOrgGroup(req.params.id, tenantId, req.body),
      (updated) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'org_group',
        {
          code: 'group.org.updated',
          changes: updated.previousName !== updated.name
            ? [{ field: 'name', before: updated.previousName, after: updated.name }]
            : [],
        },
        updated.id,
        updated.name,
      ),
    );
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

export async function deleteOrgGroupController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const deleted = await runAuditedTransaction(
      () => svc.deleteOrgGroup(req.params.id, tenantId),
      (removed) => createTransactionalAuditEntry(req, 'DELETE', 'org_group', { code: 'group.org.deleted' }, removed.id, removed.name),
    );
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
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const sg = await runAuditedTransaction(
      () => svc.createSubGroup(req.params.groupId, tenantId, req.body),
      (created) => createTransactionalAuditEntry(req, 'CREATE', 'sub_group', { code: 'group.sub.created' }, created.id, created.name),
    );
    sendSuccess(res, sg, 'Tạo phân nhóm thành công', 201);
  } catch (err) { next(err); }
}

export async function getSubGroupDetailController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await svc.getSubGroupDetail(req.params.id)); }
  catch (err) { next(err); }
}

export async function updateSubGroupController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const sg = await runAuditedTransaction(
      () => svc.updateSubGroup(req.params.id, tenantId, req.body),
      (updated) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'sub_group',
        {
          code: 'group.sub.updated',
          changes: updated.previousName !== updated.name
            ? [{ field: 'name', before: updated.previousName, after: updated.name }]
            : [],
        },
        updated.id,
        updated.name,
      ),
    );
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

export async function deleteSubGroupController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const deleted = await runAuditedTransaction(
      () => svc.deleteSubGroup(req.params.id, tenantId),
      (removed) => createTransactionalAuditEntry(req, 'DELETE', 'sub_group', { code: 'group.sub.deleted' }, removed.id, removed.name),
    );
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
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const team = await runAuditedTransaction(
      () => svc.createTeam(req.params.subgroupId, tenantId, req.body),
      (created) => createTransactionalAuditEntry(req, 'CREATE', 'team', { code: 'group.team.created' }, created.id, created.name),
    );
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
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const team = await runAuditedTransaction(
      () => svc.updateTeam(req.params.id, tenantId, req.body),
      (updated) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'team',
        {
          code: 'group.team.updated',
          changes: updated.previousName !== updated.name
            ? [{ field: 'name', before: updated.previousName, after: updated.name }]
            : [],
        },
        updated.id,
        updated.name,
      ),
    );
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

export async function deleteTeamController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const deleted = await runAuditedTransaction(
      () => svc.deleteTeam(req.params.id, tenantId),
      (removed) => createTransactionalAuditEntry(req, 'DELETE', 'team', { code: 'group.team.deleted' }, removed.id, removed.name),
    );
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
      auditEntry: ({ teamName, added }) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'team_member',
        { code: 'group.team_member.added', context: { parent_name: teamName, affected_count: added } },
        req.params.teamId,
        teamName,
      ),
    });
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
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await runAuditedTransaction(
      () => svc.removeTeamMember(req.params.teamId, req.params.userId, tenantId),
      (removed) => createTransactionalAuditEntry(
        req,
        'DELETE',
        'team_member',
        {
          code: 'group.team_member.removed',
          context: {
            parent_name: removed.teamName,
            related_entity_name: removed.username,
            related_entity_type: 'user',
          },
        },
        req.params.teamId,
        removed.teamName,
      ),
    );
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
    const result = await runAuditedTransaction(
      () => svc.revokeTeamCourse(req.params.teamId, decodeURIComponent(req.params.courseId), tenantId),
      (removed) => createTransactionalAuditEntry(
        req,
        'DELETE',
        'team_course',
        {
          code: 'group.team_course.removed',
          context: {
            parent_name: removed.teamName,
            related_entity_name: removed.courseName,
            related_entity_type: 'course',
          },
        },
        req.params.teamId,
        removed.teamName,
      ),
    );
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
    const result = await svc.assignTeamDocCategories(req.params.teamId, category_ids, tenantId, ({ teamName, assigned }) =>
      createTransactionalAuditEntry(
        req,
        'UPDATE',
        'team_category',
        { code: 'group.team_document_category.assigned', context: { parent_name: teamName, affected_count: assigned } },
        req.params.teamId,
        teamName,
      ));
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function revokeTeamDocCategoryController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await runAuditedTransaction(
      () => svc.revokeTeamDocCategory(req.params.teamId, req.params.categoryId, tenantId),
      (removed) => createTransactionalAuditEntry(
        req,
        'DELETE',
        'team_category',
        {
          code: 'group.team_document_category.removed',
          context: {
            parent_name: removed.teamName,
            related_entity_name: removed.categoryName,
            related_entity_type: 'document_category',
          },
        },
        req.params.teamId,
        removed.teamName,
      ),
    );
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
    const result = await runAuditedTransaction(
      () => svc.assignTeamCourseCategories(req.params.teamId, category_ids, tenantId),
      (assigned) => assigned.assigned > 0
        ? createTransactionalAuditEntry(
          req,
          'UPDATE',
          'team_course_category',
          { code: 'group.team_course_category.assigned', context: { parent_name: assigned.teamName, affected_count: assigned.assigned } },
          req.params.teamId,
          assigned.teamName,
        )
        : null,
    );
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function revokeTeamCourseCategoryController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await runAuditedTransaction(
      () => svc.revokeTeamCourseCategory(req.params.teamId, req.params.categoryId, tenantId),
      (removed) => createTransactionalAuditEntry(
        req,
        'DELETE',
        'team_course_category',
        {
          code: 'group.team_course_category.removed',
          context: {
            parent_name: removed.teamName,
            related_entity_name: removed.categoryName,
            related_entity_type: 'course_category',
          },
        },
        req.params.teamId,
        removed.teamName,
      ),
    );
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
}

// ═══ Group Audit Logs ═══

export async function groupAuditLogsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    res.setHeader('Cache-Control', 'private, no-store');
    sendSuccess(res, await svc.getGroupAuditLogs(tenantId, req.user!.role, req.query as Record<string, unknown>));
  } catch (err) { next(err); }
}
