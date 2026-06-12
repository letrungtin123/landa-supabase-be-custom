import type { Request, Response, NextFunction } from 'express';
import * as badgesService from './badges.service.js';
import { sendSuccess, sendError } from '../../utils/response.js';

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
    const { badges } = req.body; // Expecting { badges: { badge_id: string, is_active: boolean }[] }

    if (!tenantId || !Array.isArray(badges)) {
      sendError(res, 'Dữ liệu không hợp lệ', 400);
      return;
    }

    await badgesService.updateAllTenantBadgeSettings(tenantId, badges);
    sendSuccess(res, null, 'Cập nhật danh hiệu thành công');
  } catch (err) {
    next(err);
  }
}
