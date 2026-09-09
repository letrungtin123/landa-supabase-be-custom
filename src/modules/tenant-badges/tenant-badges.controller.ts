import type { NextFunction, Request, Response } from 'express';
import { createTransactionalAuditEntry } from '../../middleware/audit-log.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import * as service from './tenant-badges.service.js';
import { updateTenantBadgeRuleSchema } from './tenant-badges.validator.js';

function tenantIdFromReq(req: Request, res: Response): string | null {
  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    sendError(res, 'Thiếu tenant context', 400);
    return null;
  }
  return tenantId;
}

export async function listBadges(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = tenantIdFromReq(req, res);
    if (!tenantId) return;
    sendSuccess(
      res,
      await service.listTenantBadges(tenantId, req.user?.role === 'superadmin'),
    );
  } catch (error) {
    next(error);
  }
}

export async function listCourses(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = tenantIdFromReq(req, res);
    if (!tenantId) return;
    sendSuccess(
      res,
      await service.listSelectableCourses(tenantId, req.query, req.user?.role === 'superadmin'),
    );
  } catch (error) {
    next(error);
  }
}

export async function updateBadge(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = tenantIdFromReq(req, res);
    if (!tenantId || !req.user) return;

    const parsed = updateTenantBadgeRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, parsed.error.errors[0]?.message || 'Dữ liệu không hợp lệ', 400);
      return;
    }

    const result = await service.updateTenantBadgeRule(
      tenantId,
      req.params.badgeId,
      req.user.id,
      parsed.data,
      req.user.role === 'superadmin',
      ({ badgeName, previousEnabled, nextEnabled, courseCount }) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'badge_setting',
        { code: 'badge.rule.updated', context: { affected_count: courseCount }, changes: previousEnabled !== nextEnabled ? [{ field: 'is_enabled', before: previousEnabled, after: nextEnabled }] : [] },
        req.params.badgeId,
        badgeName,
      ),
    );
    sendSuccess(res, result.badge, 'Cập nhật cấu hình huy hiệu thành công');
  } catch (error) {
    next(error);
  }
}
