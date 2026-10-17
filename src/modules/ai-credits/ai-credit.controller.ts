import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import * as service from './ai-credit.service.js';
import { createPlanSchema, fxSchema, monthParam, reconcileSchema, setTenantPlanSchema, topupSchema, updatePlanSchema } from './ai-credit.validator.js';

function parse<T>(schema: ZodSchema<T>, value: unknown, res: Response): T | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    sendError(res, parsed.error.errors[0]?.message || 'Dữ liệu không hợp lệ', 400);
    return null;
  }
  return parsed.data;
}

function queryMonth(req: Request): string | undefined {
  return typeof req.query.month === 'string' && req.query.month ? req.query.month : undefined;
}

/** Billing change on one tenant, audited in that tenant's log (superadmin action). */
function tenantSettingAudit(req: Request, tenantId: string, tenantName: string, name: string, count: number) {
  return {
    ...createTransactionalAuditEntry(req, 'UPDATE', 'tenant',
      { code: 'tenant.settings.updated', context: { related_entity_name: name, related_entity_type: 'tenant_setting', affected_count: count } },
      tenantId, tenantName),
    tenantId,
  };
}

// --- Tenant -----------------------------------------------------------------------------------------

export async function getUsage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { sendError(res, 'Thiếu tenant context', 400); return; }
    // Tenant admins only: learner_plus shares staff routes but not billing data.
    if (req.user?.role === 'learner_plus') { sendError(res, 'Bạn không có quyền xem mức dùng AI', 403); return; }
    sendSuccess(res, await service.getTenantAiUsage(tenantId, queryMonth(req)));
  } catch (error) { next(error); }
}

// --- Superadmin ---------------------------------------------------------------------------------------

export async function listPlans(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await service.listAiCreditPlans()); } catch (error) { next(error); }
}

export async function createPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = parse(createPlanSchema, req.body, res);
    if (!input || !req.user) return;
    sendSuccess(res, await service.createAiCreditPlan({ ...input, description: input.description ?? null, sort_order: input.sort_order ?? 0 }, req.user.id), 'Đã tạo gói', 201);
  } catch (error) { next(error); }
}

export async function updatePlan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = parse(updatePlanSchema, req.body, res);
    if (!input) return;
    sendSuccess(res, await service.updateAiCreditPlan(req.params.planId, { ...input, description: input.description ?? null, sort_order: input.sort_order ?? 0 }), 'Đã cập nhật gói');
  } catch (error) { next(error); }
}

export async function setTenantPlan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = parse(setTenantPlanSchema, req.body, res);
    if (!input || !req.user) return;
    const actorId = req.user.id;
    const result = await runAuditedTransaction(
      () => service.setTenantAiCreditPlan(req.params.tenantId, input.plan_id, actorId),
      (done) => tenantSettingAudit(req, req.params.tenantId, done.tenantName, 'ai_credit_plan', 1),
    );
    sendSuccess(res, result, 'Đã gán gói AI');
  } catch (error) { next(error); }
}

export async function addTopup(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = parse(topupSchema, req.body, res);
    if (!input || !req.user) return;
    const actorId = req.user.id;
    const result = await runAuditedTransaction(
      () => service.addTenantAiCreditTopup(req.params.tenantId, input, actorId),
      (done) => tenantSettingAudit(req, req.params.tenantId, done.tenantName, 'ai_credit_topup', input.points),
    );
    sendSuccess(res, result, 'Đã cộng điểm AI', 201);
  } catch (error) { next(error); }
}

export async function listFx(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await service.listAiFxRates()); } catch (error) { next(error); }
}

export async function setFx(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const month = parse(monthParam, req.params.month, res);
    const input = parse(fxSchema, req.body, res);
    if (!month || !input || !req.user) return;
    sendSuccess(res, await service.setAiFxRate(month, input.vnd_per_usd, input.source_note ?? null, req.user.id), 'Đã lưu tỷ giá');
  } catch (error) { next(error); }
}

export async function overview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await service.getAiCreditOverview(queryMonth(req))); } catch (error) { next(error); }
}

export async function tenantUsage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await service.getTenantAiUsage(req.params.tenantId, queryMonth(req))); } catch (error) { next(error); }
}

export async function reconcile(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const month = parse(monthParam, req.params.month, res);
    const input = parse(reconcileSchema, req.body, res);
    if (!month || !input || !req.user) return;
    const actorId = req.user.id;
    const result = await runAuditedTransaction(
      () => service.reconcileTenantAiMonth(req.params.tenantId, month, input.cost_vnd, input.note ?? null, actorId),
      (done) => tenantSettingAudit(req, req.params.tenantId, done.tenantName, 'ai_credit_reconciliation', 1),
    );
    sendSuccess(res, result, 'Đã lưu đối soát');
  } catch (error) { next(error); }
}
