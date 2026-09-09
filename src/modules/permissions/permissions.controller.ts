// ═══════════════════════════════════════════════════════════════
// Permissions Controller — CRUD groups + ma trận tick
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as permService from './permissions.service.js';
import { createPermGroupSchema, updatePermGroupSchema, updatePermissionsMatrixSchema } from './permissions.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import {
  createTransactionalAuditEntry,
  runAuditedTransaction,
} from '../../middleware/audit-log.js';
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
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const group = await permService.getPermGroupById(req.params.id, tenantId);
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

    const group = await runAuditedTransaction(
      () => permService.createPermGroup(tenantId, parsed.data),
      (created) => createTransactionalAuditEntry(req, 'CREATE', 'permission_group', { code: 'permission_group.created' }, created.id, created.name),
    );
    sendSuccess(res, group, 'Tạo nhóm quyền thành công', 201);
  } catch (err) { next(err); }
}

/** PUT /api/permission-groups/:id */
export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updatePermGroupSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const group = await runAuditedTransaction(
      () => permService.updatePermGroup(req.params.id, tenantId, parsed.data),
      (updated) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'permission_group',
        {
          code: 'permission_group.updated',
          changes: updated.previousName !== updated.name
            ? [{ field: 'name', before: updated.previousName, after: updated.name }]
            : [],
        },
        updated.id,
        updated.name,
      ),
    );
    sendSuccess(res, group, 'Cập nhật thành công');
  } catch (err) { next(err); }
}

/** DELETE /api/permission-groups/:id */
export async function deleteController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const group = await runAuditedTransaction(
      () => permService.deletePermGroup(req.params.id, tenantId),
      (removed) => createTransactionalAuditEntry(req, 'DELETE', 'permission_group', { code: 'permission_group.deleted' }, removed.id, removed.name),
    );
    sendSuccess(res, null, 'Xóa thành công');
  } catch (err) { next(err); }
}

/** PUT /api/permission-groups/:id/permissions */
export async function updateMatrixController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updatePermissionsMatrixSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    await permService.updatePermissionsMatrix(
      req.params.id,
      tenantId,
      parsed.data.permissions,
      ({ groupName, affectedCount }) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'permission_matrix',
        { code: 'permission_group.matrix.updated', context: { affected_count: affectedCount } },
        req.params.id,
        groupName,
      ),
    );
    invalidatePermissionCache(); // Clear all — permissions changed
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

    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await permService.addMembersToGroup(
      req.params.id,
      tenantId,
      userIds,
      ({ groupName, added }) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'permission_group_members',
        { code: 'permission_group.members.assigned', context: { parent_name: groupName, affected_count: added } },
        req.params.id,
        groupName,
      ),
    );
    for (const uid of userIds) invalidatePermissionCache(uid);
    sendSuccess(res, result, `Đã thêm ${result.added} thành viên`);
  } catch (err) { next(err); }
}

/** DELETE /api/permission-groups/:id/members/:userId — Xóa user khỏi group */
export async function removeMemberController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    if (!tenantId) { sendError(res, 'tenant_id là bắt buộc', 400); return; }
    const result = await runAuditedTransaction(
      () => permService.removeMemberFromGroup(req.params.id, req.params.userId, tenantId),
      (removed) => createTransactionalAuditEntry(
        req,
        'DELETE',
        'permission_group_members',
        {
          code: 'permission_group.members.removed',
          context: {
            parent_name: removed.groupName,
            related_entity_name: removed.username,
            related_entity_type: 'user',
          },
        },
        req.params.id,
        removed.groupName,
      ),
    );
    invalidatePermissionCache(req.params.userId);
    sendSuccess(res, null, 'Đã xóa thành viên');
  } catch (err) { next(err); }
}
