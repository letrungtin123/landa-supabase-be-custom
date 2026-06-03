// ═══════════════════════════════════════════════════════════════
// Permissions Controller — CRUD groups + ma trận tick
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as permService from './permissions.service.js';
import { createPermGroupSchema, updatePermGroupSchema, updatePermissionsMatrixSchema } from './permissions.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { auditFromReq } from '../../middleware/audit-log.js';
import { invalidatePermissionCache } from '../../middleware/authorize.js';

/** GET /api/permission-groups */
export async function listController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    const result = await permService.listPermGroups(tenantId, req.query as Record<string, unknown>);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/** GET /api/permission-groups/:id */
export async function getByIdController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const group = await permService.getPermGroupById(req.params.id);
    sendSuccess(res, group);
  } catch (err) { next(err); }
}

/** POST /api/permission-groups */
export async function createController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createPermGroupSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    // superadmin phải chỉ định tenant_id trong body
    const tenantId = req.user!.tenantId;

    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }

    const group = await permService.createPermGroup(tenantId, parsed.data);
    auditFromReq(req, 'CREATE', 'permission_group', group.id, group.name);
    sendSuccess(res, group, 'Tạo nhóm quyền thành công', 201);
  } catch (err) { next(err); }
}

/** PUT /api/permission-groups/:id */
export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updatePermGroupSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const group = await permService.updatePermGroup(req.params.id, parsed.data);
    auditFromReq(req, 'UPDATE', 'permission_group', group.id, group.name);
    sendSuccess(res, group, 'Cập nhật thành công');
  } catch (err) { next(err); }
}

/** DELETE /api/permission-groups/:id */
export async function deleteController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await permService.deletePermGroup(req.params.id);
    auditFromReq(req, 'DELETE', 'permission_group', req.params.id);
    sendSuccess(res, null, 'Xóa thành công');
  } catch (err) { next(err); }
}

/** PUT /api/permission-groups/:id/permissions */
export async function updateMatrixController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updatePermissionsMatrixSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    await permService.updatePermissionsMatrix(req.params.id, parsed.data.permissions);
    invalidatePermissionCache(); // Clear all — permissions changed
    auditFromReq(req, 'UPDATE', 'permission_matrix', req.params.id, undefined, 'Cập nhật ma trận quyền');
    sendSuccess(res, null, 'Cập nhật quyền thành công');
  } catch (err) { next(err); }
}

/** POST /api/permission-groups/:id/members — Thêm users vào group */
export async function addMembersController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userIds = req.body.user_ids;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      sendError(res, 'user_ids phải là mảng không rỗng', 400);
      return;
    }

    const result = await permService.addMembersToGroup(req.params.id, userIds);
    for (const uid of userIds) invalidatePermissionCache(uid);
    auditFromReq(req, 'UPDATE', 'permission_group_members', req.params.id, undefined, `Thêm ${result.added} thành viên`);
    sendSuccess(res, result, `Đã thêm ${result.added} thành viên`);
  } catch (err) { next(err); }
}

/** DELETE /api/permission-groups/:id/members/:userId — Xóa user khỏi group */
export async function removeMemberController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await permService.removeMemberFromGroup(req.params.id, req.params.userId);
    invalidatePermissionCache(req.params.userId);
    auditFromReq(req, 'DELETE', 'permission_group_members', req.params.id, undefined, `Xóa thành viên ${req.params.userId}`);
    sendSuccess(res, null, 'Đã xóa thành viên');
  } catch (err) { next(err); }
}
