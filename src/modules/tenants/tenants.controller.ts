// ═══════════════════════════════════════════════════════════════
// Tenants Controller — CRUD + module toggle handlers
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as tenantsService from './tenants.service.js';
import { createTenantSchema, updateTenantSchema, updateTenantModulesSchema } from './tenants.validator.js';
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
export async function listSimpleController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenants = await tenantsService.listSimpleTenants(req.user!.id, req.user!.role);
    sendSuccess(res, tenants);
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

