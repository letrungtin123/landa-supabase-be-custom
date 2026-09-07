// ═══════════════════════════════════════════════════════════════
// Users Controller — CRUD + assign permission groups
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as usersService from './users.service.js';
import { createUserSchema, updateUserSchema, assignGroupsSchema } from './users.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { auditFromReq } from '../../middleware/audit-log.js';
import { uploadFile, buildFileName, buildStoragePath, deleteFileByUrl } from '../../config/storage.js';
import { invalidatePermissionCache } from '../../middleware/authorize.js';
import { isDemoIframeSession } from '../demo-login/demo-iframe.service.js';
import {
  getUserDeletionJobStatus,
  requestUserDeletion,
  retryTerminalUserDeletionJob,
} from './user-deletion.service.js';

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
    const user = await usersService.createUser(parsed.data, callerTenantId);
    auditFromReq(req, 'CREATE', 'user', user.id, user.username);
    sendSuccess(res, user, 'Tạo user thành công', 201);
  } catch (err) { next(err); }
}

/** PUT /api/users/:id */
export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const user = await usersService.updateUser(req.params.id, parsed.data);
    auditFromReq(req, 'UPDATE', 'user', user.id, user.username);
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
    );

    // Invalidate caches
    invalidatePermissionCache(req.params.id);

    // Do not fire-and-forget an audit row for a subject that the background
    // job can hard-delete before this request returns. Operational state lives
    // in user_deletion_jobs and is purged without retaining personal fields.
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
    await retryTerminalUserDeletionJob(req.params.jobId, req.user!.tenantId || null);
    sendSuccess(res, { job_id: req.params.jobId, status: 'queued' }, 'Đã đưa deletion job vào hàng đợi retry', 202);
  } catch (err) { next(err); }
}

/** PUT /api/users/:id/permission-groups */
export async function assignGroupsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = assignGroupsSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const user = await usersService.getUserById(req.params.id);
    await usersService.assignPermissionGroups(req.params.id, parsed.data.permission_group_ids);
    invalidatePermissionCache(req.params.id);
    auditFromReq(req, 'UPDATE', 'user_permission_groups', req.params.id, user.username, 'Gán permission groups');
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
