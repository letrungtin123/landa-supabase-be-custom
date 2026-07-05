// ═══════════════════════════════════════════════════════════════
// Tenants Controller — CRUD + module toggle handlers
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as tenantsService from './tenants.service.js';
import * as roleLabelsService from './tenant-role-labels.service.js';
import * as smtpService from './tenant-smtp.service.js';
import { createTenantSchema, updateTenantSchema, updateTenantModulesSchema } from './tenants.validator.js';
import { updateTenantSmtpSchema } from './tenant-smtp.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { auditFromReq } from '../../middleware/audit-log.js';
import { invalidateTenantCache } from '../../middleware/tenant-context.js';

/** GET /api/tenants */
export async function listController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await tenantsService.listTenants(req.query as Record<string, unknown>);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

/** GET /api/tenants/:id */
export async function getByIdController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenant = await tenantsService.getTenantById(req.params.id);
    sendSuccess(res, tenant);
  } catch (err) { next(err); }
}

/** POST /api/tenants */
export async function createController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const tenant = await tenantsService.createTenant(parsed.data);
    auditFromReq(req, 'CREATE', 'tenant', tenant.id, tenant.name);
    sendSuccess(res, tenant, 'Tạo tenant thành công', 201);
  } catch (err) { next(err); }
}

/** PUT /api/tenants/:id */
export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateTenantSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const tenant = await tenantsService.updateTenant(req.params.id, parsed.data);
    invalidateTenantCache(req.params.id);
    auditFromReq(req, 'UPDATE', 'tenant', tenant.id, tenant.name);
    sendSuccess(res, tenant, 'Cập nhật thành công');
  } catch (err) { next(err); }
}

/** DELETE /api/tenants/:id */
export async function deleteController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await tenantsService.deleteTenant(req.params.id);
    invalidateTenantCache(req.params.id);
    auditFromReq(req, 'DELETE', 'tenant', req.params.id);
    sendSuccess(res, null, 'Xóa thành công');
  } catch (err) { next(err); }
}

/** GET /api/tenants/:id/modules */
export async function getModulesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const modules = await tenantsService.getTenantModules(req.params.id);
    sendSuccess(res, modules);
  } catch (err) { next(err); }
}

/** PUT /api/tenants/:id/modules */
export async function updateModulesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateTenantModulesSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    await tenantsService.updateTenantModules(req.params.id, parsed.data.modules);
    auditFromReq(req, 'UPDATE', 'tenant_modules', req.params.id, undefined, 'Cập nhật modules tenant');
    sendSuccess(res, null, 'Cập nhật modules thành công');
  } catch (err) { next(err); }
}

/** GET /api/tenants/simple — Danh sách nhẹ (id+name) cho dropdown filter */
export async function getRoleLabelsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const labels = await roleLabelsService.getTenantRoleLabels(req.params.id);
    sendSuccess(res, { labels });
  } catch (err) { next(err); }
}

export async function updateRoleLabelsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const labelsInput = req.body?.labels ?? req.body?.role_labels ?? {};
    const labels = await roleLabelsService.replaceTenantRoleLabels(
      req.params.id,
      labelsInput,
      req.user?.id ?? null,
    );
    auditFromReq(req, 'UPDATE', 'tenant_role_labels', req.params.id, undefined, 'Cap nhat ten hien thi role tenant');
    sendSuccess(res, { labels }, 'Cap nhat ten role thanh cong');
  } catch (err) { next(err); }
}

export async function listSimpleController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenants = await tenantsService.listSimpleTenants(req.user!.id, req.user!.role);
    sendSuccess(res, tenants);
  } catch (err) { next(err); }
}

/** GET /api/tenants/:id/quota — Quota usage hiện tại (superadmin only) */
export async function getQuotaController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const usage = await tenantsService.getTenantQuotaUsage(req.params.id);
    sendSuccess(res, usage);
  } catch (err) { next(err); }
}

/** GET /api/tenants/user-tenants/:userId — Tenants mà user được quản lý */
export async function getUserTenantsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenants = await tenantsService.getUserTenants(req.params.userId);
    sendSuccess(res, tenants);
  } catch (err) { next(err); }
}

/** PUT /api/tenants/user-tenants/:userId — Gán user quản lý nhiều tenants */
export async function setUserTenantsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { tenant_ids } = req.body;
    if (!Array.isArray(tenant_ids)) {
      sendError(res, 'tenant_ids phải là mảng', 400);
      return;
    }
    const result = await tenantsService.setUserTenants(req.params.userId, tenant_ids);
    auditFromReq(req, 'UPDATE', 'user_tenants', req.params.userId, undefined, `Gán ${result.updated} tenants`);
    sendSuccess(res, result, 'Gán tenants thành công');
  } catch (err) { next(err); }
}

/** GET /api/tenants/:id/smtp */
export async function getSmtpController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const config = await smtpService.getTenantSmtpConfig(req.params.id);
    sendSuccess(res, config);
  } catch (err) { next(err); }
}

/** PUT /api/tenants/:id/smtp */
export async function updateSmtpController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateTenantSmtpSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const config = await smtpService.updateTenantSmtpConfig(req.params.id, parsed.data);
    auditFromReq(req, 'UPDATE', 'tenant_smtp_config', req.params.id, undefined, 'Cap nhat SMTP tenant');
    sendSuccess(res, config, 'Cap nhat SMTP thanh cong');
  } catch (err) { next(err); }
}
