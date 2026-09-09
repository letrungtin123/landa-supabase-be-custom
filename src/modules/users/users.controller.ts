// ═══════════════════════════════════════════════════════════════
// Users Controller — CRUD + assign permission groups
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as usersService from './users.service.js';
import { createUserSchema, updateUserSchema, assignGroupsSchema } from './users.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';
import { uploadFile, buildFileName, buildStoragePath, deleteFileByUrl } from '../../config/storage.js';
import { invalidatePermissionCache } from '../../middleware/authorize.js';
import { isDemoIframeSession } from '../demo-login/demo-iframe.service.js';
import {
  getUserDeletionJobStatus,
  requestUserDeletion,
  retryTerminalUserDeletionJob,
  type UserDeletionAuditTarget,
} from './user-deletion.service.js';

function userDeletionAuditLabel(target: UserDeletionAuditTarget): string {
  const displayName = target.full_name?.trim();
  const username = target.username?.trim();
  if (displayName && username) return `${displayName} (@${username})`;
  return displayName || (username ? `@${username}` : 'Tài khoản đã xóa');
}

/** GET /api/users */
export async function listController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    const result = await usersService.listUsers(tenantId, req.query as Record<string, unknown>);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/** GET /api/users/:id */
export async function getByIdController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await usersService.getUserById(req.params.id);
    sendSuccess(res, user);
  } catch (err) { next(err); }
}

/** POST /api/users */
export async function createController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const callerTenantId = req.user!.tenantId;
    const user = await runAuditedTransaction(
      () => usersService.createUser(parsed.data, callerTenantId),
      (created) => ({
        ...createTransactionalAuditEntry(
          req,
          'CREATE',
          'user',
          { code: 'user.created' },
          created.id,
          created.username,
        ),
        tenantId: created.tenant_id || null,
      }),
    );
    sendSuccess(res, user, 'Tạo user thành công', 201);
  } catch (err) { next(err); }
}

/** PUT /api/users/:id */
export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    let before: Awaited<ReturnType<typeof usersService.getUserById>> | undefined;
    const user = await runAuditedTransaction(
      async () => {
        before = await usersService.getUserById(req.params.id);
        return usersService.updateUser(req.params.id, parsed.data);
      },
      (updated) => {
        if (!before) throw new Error('Missing user snapshot for audit');
        return {
          ...createTransactionalAuditEntry(
            req,
            'UPDATE',
            'user',
            {
              code: 'user.updated',
              changes: [
                ...(before.username !== updated.username
                  ? [{ field: 'username', before: before.username, after: updated.username }]
                  : []),
                ...(before.role !== updated.role
                  ? [{ field: 'role', before: before.role, after: updated.role }]
                  : []),
                ...(before.is_active !== updated.is_active
                  ? [{ field: 'is_active', before: before.is_active, after: updated.is_active }]
                  : []),
              ],
            },
            updated.id,
            updated.username,
          ),
          tenantId: before.tenant_id || null,
        };
      },
    );
    sendSuccess(res, user, 'Cập nhật thành công');
  } catch (err) { next(err); }
}

/** DELETE /api/users/:id — Queue a durable permanent deletion. */
export async function deleteController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { jobId } = await requestUserDeletion(
      req.params.id,
      req.user!.id,
      req.user!.role,
      req.user!.tenantId || null,
      (jobId, targetTenantId, target) => ({
        ...createTransactionalAuditEntry(
          req,
          'DELETE',
          'user_deletion_job',
          { code: 'user.deleted' },
          jobId,
          userDeletionAuditLabel(target),
        ),
        tenantId: targetTenantId,
        subject: {
          displayName: target.full_name,
          username: target.username,
          email: target.email,
          role: target.role,
        },
      }),
    );

    // Invalidate caches
    invalidatePermissionCache(req.params.id);

    sendSuccess(res, { job_id: jobId, status: 'queued' }, 'Đã đưa user vào hàng đợi xóa vĩnh viễn', 202);
  } catch (err) { next(err); }
}

/** GET /api/users/deletion-jobs/:jobId — status for a queued permanent deletion. */
export async function getDeletionJobStatusController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const job = await getUserDeletionJobStatus(req.params.jobId, req.user!.tenantId || null);
    sendSuccess(res, job);
  } catch (err) { next(err); }
}

/** POST /api/users/deletion-jobs/:jobId/retry — retry an exhausted job. */
export async function retryDeletionJobController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await runAuditedTransaction(
      () => retryTerminalUserDeletionJob(req.params.jobId, req.user!.tenantId || null),
      () => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'user_deletion_job',
        { code: 'user.deletion_job.retry_queued' },
        req.params.jobId,
        'Yêu cầu xóa tài khoản',
      ),
    );
    sendSuccess(res, { job_id: req.params.jobId, status: 'queued' }, 'Đã đưa deletion job vào hàng đợi retry', 202);
  } catch (err) { next(err); }
}

/** PUT /api/users/:id/permission-groups */
export async function assignGroupsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = assignGroupsSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const user = await usersService.getUserById(req.params.id);
    await usersService.assignPermissionGroups(
      req.params.id,
      parsed.data.permission_group_ids,
      {
        ...createTransactionalAuditEntry(
          req,
          'UPDATE',
          'user_permission_groups',
          {
            code: 'user.updated',
            changes: [{
              field: 'permission_groups',
              before: user.permission_groups.length,
              after: parsed.data.permission_group_ids.length,
            }],
          },
          req.params.id,
          user.username,
        ),
        tenantId: user.tenant_id || null,
      },
    );
    invalidatePermissionCache(req.params.id);
    sendSuccess(res, null, 'Gán nhóm quyền thành công');
  } catch (err) { next(err); }
}

// ══════════════════════════════════════════════════════════════
// Profile endpoints (self-service, any authenticated user)
// ══════════════════════════════════════════════════════════════

/** GET /api/users/profile/:username */
export async function getProfileController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const profile = await usersService.getProfile(req.params.username);
    sendSuccess(res, profile);
  } catch (err) { next(err); }
}

/** PATCH /api/users/profile */
export async function updateProfileController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.id;
    if (isDemoIframeSession(req.user)) {
      sendError(res, 'Phiên demo iframe không thể cập nhật hồ sơ', 403);
      return;
    }
    const result = await usersService.updateProfile(userId, req.body);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/** POST /api/users/profile/avatar */
export async function uploadAvatarController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.id;
    const tenantId = req.user!.tenantId || 'default';
    if (isDemoIframeSession(req.user)) {
      sendError(res, 'Phiên demo iframe không thể cập nhật avatar', 403);
      return;
    }

    if (!req.file) { sendError(res, 'Chưa upload file', 400); return; }

    // Delete old avatar from storage (if exists, may have different extension)
    const oldUser = await usersService.getUserById(userId);
    if (oldUser?.avatar_url) {
      await deleteFileByUrl(oldUser.avatar_url).catch(() => {});
    }

    const file = req.file;
    // Use userId in filename for easy overwrite with upsert=true
    const ext = file.originalname.split('.').pop() || 'jpg';
    const fileName = `${userId}.${ext}`;
    const storagePath = buildStoragePath(tenantId, 'avatars', fileName);

    // Upload to Supabase Storage (upsert: overwrite old avatar)
    // uploadFile() trả về path, KHÔNG phải full URL
    const avatarPath = await uploadFile(storagePath, file.buffer, file.mimetype, true);

    // DB lưu PATH, không lưu full URL
    try {
      await usersService.updateAvatar(userId, avatarPath);
    } catch (error) {
      // A concurrent permanent deletion can fence the profile write after the
      // object upload completed. Do not leave that object behind.
      await deleteFileByUrl(avatarPath).catch(() => undefined);
      throw error;
    }

    // sendSuccess tự động resolve path → full URL
    sendSuccess(res, { avatar_url: avatarPath });
  } catch (err) { next(err); }
}

/** POST /api/users/profile/change-password */
export async function changePasswordController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.id;
    const { current_password, new_password } = req.body;
    if (isDemoIframeSession(req.user)) {
      sendError(res, 'Phiên demo iframe không thể đổi mật khẩu', 403);
      return;
    }

    if (!current_password || !new_password) {
      sendError(res, 'Thiếu current_password hoặc new_password', 400);
      return;
    }
    if (new_password.length < 8) {
      sendError(res, 'Mật khẩu mới phải có ít nhất 8 ký tự', 400);
      return;
    }

    await usersService.changePassword(userId, current_password, new_password);
    sendSuccess(res, null, 'Đổi mật khẩu thành công');
  } catch (err) { next(err); }
}
