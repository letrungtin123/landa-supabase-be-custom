// ═══════════════════════════════════════════════════════════════
// Dashboard Content Controller — Express request handlers
// CRUD nội dung Hero Card + Tips cho /dashboard FE 5173
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import {
  createTransactionalAuditEntry,
  runAuditedTransaction,
} from '../../middleware/audit-log.js';
import * as service from './dashboard-content.service.js';
import { upsertDashboardContentSchema } from './dashboard-content.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';

/**
 * GET /api/dashboard-content/by-domain/:domain — PUBLIC (no auth)
 * FE 5173 gọi để lấy dashboard content.
 */
export async function getByDomainController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { domain } = req.params;
    if (!domain) { sendError(res, 'Domain không được để trống', 400); return; }

    const result = await service.getDashboardContentByDomain(domain);
    if (!result) {
      // Domain không match → trả empty (FE sẽ dùng fallback)
      sendSuccess(res, { tenant_id: null, hero_badge: null, hero_title: null, tips: null, explore_hero_badge: null, explore_hero_title: null });
      return;
    }

    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/**
 * GET /api/dashboard-content — PROTECTED (admin)
 * Lấy dashboard content cho tenant đang active.
 */
export async function getByTenantController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { sendError(res, 'Không xác định được tenant', 400); return; }

    const result = await service.getDashboardContentByTenantId(tenantId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/**
 * PUT /api/dashboard-content — PROTECTED (admin)
 * Cập nhật dashboard content cho tenant.
 */
export async function upsertController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { sendError(res, 'Không xác định được tenant', 400); return; }

    const parsed = upsertDashboardContentSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, parsed.error.errors[0].message, 400);
      return;
    }

    const result = await runAuditedTransaction(
      () => service.upsertDashboardContent(tenantId, parsed.data),
      (updated) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'dashboard_content',
        {
          code: 'dashboard_content.updated',
          context: { affected_count: updated.tips?.length || 0 },
        },
        tenantId,
        'Nội dung trang chủ',
      ),
    );
    sendSuccess(res, result, 'Cập nhật thành công');
  } catch (err) { next(err); }
}
