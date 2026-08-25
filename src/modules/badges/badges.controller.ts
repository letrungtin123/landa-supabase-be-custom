import type { Request, Response, NextFunction } from 'express';
import { auditFromReqForTenant } from '../../middleware/audit-log.js';
import * as badgesService from './badges.service.js';
import { sendSuccess, sendError } from '../../utils/response.js';

type BadgeUploadFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

const MAX_BADGE_IMAGE_SIZE = 10 * 1024 * 1024;
const ACCEPTED_BADGE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function hasValidBadgeImageSignature(file: BadgeUploadFile): boolean {
  const b = file.buffer;

  if (file.mimetype === 'image/png') {
    return b.length >= 8
      && b[0] === 0x89
      && b[1] === 0x50
      && b[2] === 0x4e
      && b[3] === 0x47
      && b[4] === 0x0d
      && b[5] === 0x0a
      && b[6] === 0x1a
      && b[7] === 0x0a;
  }

  if (file.mimetype === 'image/jpeg') {
    return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  }

  if (file.mimetype === 'image/webp') {
    return b.length >= 12
      && b.subarray(0, 4).toString('ascii') === 'RIFF'
      && b.subarray(8, 12).toString('ascii') === 'WEBP';
  }

  return false;
}

function validateBadgeImageFile(file: BadgeUploadFile | undefined, res: Response): file is BadgeUploadFile {
  if (!file) {
    sendError(res, 'Chưa upload file ảnh', 400);
    return false;
  }

  if (file.size > MAX_BADGE_IMAGE_SIZE) {
    sendError(res, 'File quá lớn. Tối đa 10MB', 400);
    return false;
  }

  if (!ACCEPTED_BADGE_IMAGE_TYPES.has(file.mimetype)) {
    sendError(res, 'Định dạng file không hỗ trợ. Chỉ nhận PNG, JPEG hoặc WebP', 400);
    return false;
  }

  if (!hasValidBadgeImageSignature(file)) {
    sendError(res, 'Nội dung file ảnh không hợp lệ', 400);
    return false;
  }

  return true;
}

export async function getTenantBadges(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user?.role !== 'superadmin') {
      sendError(res, 'Không có quyền truy cập', 403);
      return;
    }

    const tenantId = req.params.tenantId;
    if (!tenantId) {
      sendError(res, 'Thiếu tenantId', 400);
      return;
    }

    const badges = await badgesService.getTenantBadgeSettings(tenantId);
    sendSuccess(res, badges);
  } catch (err) {
    next(err);
  }
}

export async function updateTenantBadges(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user?.role !== 'superadmin') {
      sendError(res, 'Không có quyền truy cập', 403);
      return;
    }

    const tenantId = req.params.tenantId;
    const { badges } = req.body;

    if (!tenantId || !Array.isArray(badges)) {
      sendError(res, 'Dữ liệu không hợp lệ', 400);
      return;
    }

    await badgesService.updateAllTenantBadgeSettings(tenantId, badges);
    auditFromReqForTenant(req, tenantId, 'UPDATE', 'badge_setting', tenantId, undefined, `Cập nhật ${badges.length} danh hiệu`);
    sendSuccess(res, null, 'Cập nhật danh hiệu thành công');
  } catch (err) {
    next(err);
  }
}

export async function uploadCardImage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user?.role !== 'superadmin') {
      sendError(res, 'Không có quyền truy cập', 403);
      return;
    }

    const { tenantId, badgeId } = req.params;
    const file = req.file;

    if (!tenantId) { sendError(res, 'Thiếu tenantId', 400); return; }
    if (!badgeId) { sendError(res, 'Thiếu badgeId', 400); return; }
    if (!validateBadgeImageFile(file, res)) return;

    const result = await badgesService.uploadBadgeCardImage(tenantId, badgeId, file);
    auditFromReqForTenant(req, tenantId, 'UPDATE', 'badge_setting', tenantId, undefined, `Upload ảnh card ${badgeId}`);
    sendSuccess(res, result, 'Upload ảnh card thành công');
  } catch (err) {
    next(err);
  }
}

export async function uploadIconImage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user?.role !== 'superadmin') {
      sendError(res, 'Không có quyền truy cập', 403);
      return;
    }

    const { tenantId, badgeId } = req.params;
    const file = req.file;

    if (!tenantId) { sendError(res, 'Thiếu tenantId', 400); return; }
    if (!badgeId) { sendError(res, 'Thiếu badgeId', 400); return; }
    if (!validateBadgeImageFile(file, res)) return;

    const result = await badgesService.uploadBadgeIconImage(tenantId, badgeId, file);
    auditFromReqForTenant(req, tenantId, 'UPDATE', 'badge_setting', tenantId, undefined, `Upload ảnh icon ${badgeId}`);
    sendSuccess(res, result, 'Upload ảnh icon thành công');
  } catch (err) {
    next(err);
  }
}

export async function uploadMobileCardImage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user?.role !== 'superadmin') {
      sendError(res, 'Không có quyền truy cập', 403);
      return;
    }

    const { tenantId, badgeId } = req.params;
    const file = req.file;

    if (!tenantId) { sendError(res, 'Thiếu tenantId', 400); return; }
    if (!badgeId) { sendError(res, 'Thiếu badgeId', 400); return; }
    if (!validateBadgeImageFile(file, res)) return;

    const result = await badgesService.uploadBadgeMobileCardImage(tenantId, badgeId, file);
    auditFromReqForTenant(req, tenantId, 'UPDATE', 'badge_setting', tenantId, undefined, `Upload ảnh card mobile ${badgeId}`);
    sendSuccess(res, result, 'Upload ảnh card mobile thành công');
  } catch (err) {
    next(err);
  }
}

