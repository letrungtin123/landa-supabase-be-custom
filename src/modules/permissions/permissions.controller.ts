// ═══════════════════════════════════════════════════════════════
// Permissions Controller — CRUD groups + ma trận tick
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as permService from './permissions.service.js';
import {
  addPermissionGroupMembersSchema,
  createPermGroupSchema,
  permissionGroupIdentifierSchema,
  savePermGroupConfigurationSchema,
  updatePermGroupSchema,
  updatePermissionsMatrixSchema,
} from './permissions.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { invalidatePermissionCache } from '../../middleware/authorize.js';
import {
  getPermissionGroupHistoryDetail,
  listPermissionGroupHistory,
} from './permission-group-history.service.js';

function historyActor(req: Request) {
  const user = req.user!;
  return { id: user.id, username: user.username, role: user.role };
}

function invalidateUsers(userIds: string[]): void {
  for (const userId of new Set(userIds)) invalidatePermissionCache(userId);
}

function parseIdentifier(res: Response, value: string): string | null {
  const parsed = permissionGroupIdentifierSchema.safeParse(value);
  if (!parsed.success) {
    sendError(res, parsed.error.errors[0].message, 400);
    return null;
  }
  return parsed.data;
}

function requireSelectedTenant(req: Request, res: Response): string | null {
  const tenantId = req.user!.tenantId;
  if (!tenantId) {
    sendError(res, 'Vui lòng chọn doanh nghiệp trước khi quản lý nhóm quyền', 400);
    return null;
  }
  return tenantId;
}

/** GET /api/permission-groups */
export async function listController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireSelectedTenant(req, res);
    if (!tenantId) return;
    const result = await permService.listPermGroups(tenantId, req.query as Record<string, unknown>);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/** GET /api/permission-groups/:id */
export async function getByIdController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireSelectedTenant(req, res);
    if (!tenantId) return;
    const groupId = parseIdentifier(res, req.params.id);
    if (!groupId) return;
    const group = await permService.getPermGroupById(groupId, tenantId);
    sendSuccess(res, group);
  } catch (err) { next(err); }
}

/** POST /api/permission-groups */
export async function createController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createPermGroupSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const tenantId = requireSelectedTenant(req, res);
    if (!tenantId) return;
    const group = await permService.createPermGroup(tenantId, parsed.data, historyActor(req));
    sendSuccess(res, group, 'Tạo nhóm quyền thành công', 201);
  } catch (err) { next(err); }
}

/** PUT /api/permission-groups/:id */
export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updatePermGroupSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const tenantId = requireSelectedTenant(req, res);
    if (!tenantId) return;
    const groupId = parseIdentifier(res, req.params.id);
    if (!groupId) return;
    const group = await permService.updatePermGroup(groupId, tenantId, parsed.data, historyActor(req));
    sendSuccess(res, group, 'Cập nhật thành công');
  } catch (err) { next(err); }
}

/** DELETE /api/permission-groups/:id */
export async function deleteController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireSelectedTenant(req, res);
    if (!tenantId) return;
    const groupId = parseIdentifier(res, req.params.id);
    if (!groupId) return;
    await permService.deletePermGroup(groupId, tenantId, historyActor(req));
    // A deleted group can affect an arbitrarily large membership set.  Do not
    // load every user into memory just to invalidate this small local cache.
    invalidatePermissionCache();
    sendSuccess(res, null, 'Xóa thành công');
  } catch (err) { next(err); }
}

/** PUT /api/permission-groups/:id/permissions */
export async function updateMatrixController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updatePermissionsMatrixSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const tenantId = requireSelectedTenant(req, res);
    if (!tenantId) return;
    const groupId = parseIdentifier(res, req.params.id);
    if (!groupId) return;
    const result = await permService.updatePermissionsMatrix(
      groupId,
      tenantId,
      parsed.data.permissions,
      historyActor(req),
    );
    if (result.changed) invalidatePermissionCache();
    sendSuccess(res, null, 'Cập nhật quyền thành công');
  } catch (err) { next(err); }
}

/** POST /api/permission-groups/:id/members — Thêm users vào group */
export async function addMembersController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = addPermissionGroupMembersSchema.safeParse(req.body.user_ids);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const tenantId = requireSelectedTenant(req, res);
    if (!tenantId) return;
    const groupId = parseIdentifier(res, req.params.id);
    if (!groupId) return;
    const result = await permService.addMembersToGroup(groupId, tenantId, parsed.data, historyActor(req));
    invalidateUsers(result.affectedUserIds);
    sendSuccess(res, result, `Đã thêm ${result.added} thành viên`);
  } catch (err) { next(err); }
}

/** DELETE /api/permission-groups/:id/members/:userId — Xóa user khỏi group */
export async function removeMemberController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireSelectedTenant(req, res);
    if (!tenantId) return;
    const groupId = parseIdentifier(res, req.params.id);
    const userId = parseIdentifier(res, req.params.userId);
    if (!groupId || !userId) return;
    if (userId === req.user!.id) {
      sendError(res, 'Không thể xóa chính bạn khỏi nhóm quyền', 403);
      return;
    }
    const result = await permService.removeMemberFromGroup(groupId, userId, tenantId, historyActor(req));
    invalidateUsers(result.affectedUserIds);
    sendSuccess(res, null, 'Đã xóa thành viên');
  } catch (err) { next(err); }
}

/** PUT /api/permission-groups/:id/configuration — matrix + members atomically. */
export async function saveConfigurationController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = savePermGroupConfigurationSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }
    const tenantId = requireSelectedTenant(req, res);
    if (!tenantId) return;
    const groupId = parseIdentifier(res, req.params.id);
    if (!groupId) return;
    const result = await permService.savePermGroupConfiguration(groupId, tenantId, parsed.data, historyActor(req));
    if (result.matrixChanged) invalidatePermissionCache();
    else invalidateUsers(result.affectedUserIds);
    sendSuccess(res, result, result.changed ? 'Đã lưu thay đổi' : 'Không có thay đổi cần lưu');
  } catch (err) { next(err); }
}

/** GET /api/permission-groups/history — history module riêng, không phải Audit Log. */
export async function listHistoryController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireSelectedTenant(req, res);
    if (!tenantId) return;
    sendSuccess(res, await listPermissionGroupHistory(tenantId, req.query as Record<string, unknown>));
  } catch (err) { next(err); }
}

/** GET /api/permission-groups/history/:historyId — full matrix + sensitive snapshots. */
export async function getHistoryDetailController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = requireSelectedTenant(req, res);
    if (!tenantId) return;
    const historyId = parseIdentifier(res, req.params.historyId);
    if (!historyId) return;
    sendSuccess(res, await getPermissionGroupHistoryDetail(historyId, tenantId));
  } catch (err) { next(err); }
}
