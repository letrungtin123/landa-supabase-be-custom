// ═══════════════════════════════════════════════════════════════
// Tenants Controller — CRUD + module toggle handlers
// ═══════════════════════════════════════════════════════════════

import type { Request, Response, NextFunction } from 'express';
import * as tenantsService from './tenants.service.js';
import * as roleLabelsService from './tenant-role-labels.service.js';
import * as groupLabelsService from './tenant-group-labels.service.js';
import * as smtpService from './tenant-smtp.service.js';
import * as tenantCourseComponentsService from './tenant-course-components.service.js';
import { createTenantSchema, updateTenantSchema, updateTenantModulesSchema, updateTenantCourseComponentPermissionsSchema } from './tenants.validator.js';
import { updateTenantSmtpSchema } from './tenant-smtp.validator.js';
import { sendSuccess, sendError } from '../../utils/response.js';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';
import { invalidateTenantCache } from '../../middleware/tenant-context.js';

function quotaLimitGbForAudit(bytes: string | null): number | null {
  if (bytes === null) return null;
  try { return Number(BigInt(bytes)) / 1_000_000_000; }
  catch { return null; }
}

function tenantUpdateChanges(
  before: tenantsService.TenantAuditSnapshot,
  after: tenantsService.TenantAuditSnapshot,
) {
  const fields: Array<keyof tenantsService.TenantAuditSnapshot> = [
    'name', 'slug', 'domain_admin', 'domain_learner', 'is_active', 'max_users', 'max_courses',
  ];
  const changes: Array<{ field: string; before: string | number | boolean | null; after: string | number | boolean | null }> = fields
    .filter((field) => before[field] !== after[field])
    .map((field) => ({ field, before: before[field], after: after[field] }));

  if (before.data_limit_bytes !== after.data_limit_bytes) {
    changes.push({
      field: 'data_limit_gb',
      before: quotaLimitGbForAudit(before.data_limit_bytes),
      after: quotaLimitGbForAudit(after.data_limit_bytes),
    });
  }
  return changes;
}

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

    const tenant = await tenantsService.createTenant(
      parsed.data,
      (created) => ({
        ...createTransactionalAuditEntry(
          req,
          'CREATE',
          'tenant',
          { code: 'tenant.created' },
          created.id,
          created.name,
        ),
        tenantId: created.id,
      }),
    );
    sendSuccess(res, tenant, 'Tạo tenant thành công', 201);
  } catch (err) { next(err); }
}

/** PUT /api/tenants/:id */
export async function updateController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateTenantSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const update = await runAuditedTransaction(
      () => tenantsService.updateTenant(req.params.id, parsed.data),
      ({ tenant, previousTenant }) => ({
        ...createTransactionalAuditEntry(
          req,
          'UPDATE',
          'tenant',
          { code: 'tenant.updated', changes: tenantUpdateChanges(previousTenant, tenant) },
          tenant.id,
          tenant.name,
        ),
        tenantId: tenant.id,
      }),
    );
    const { tenant } = update;
    invalidateTenantCache(req.params.id);
    sendSuccess(res, tenant, 'Cập nhật thành công');
  } catch (err) { next(err); }
}

/** DELETE /api/tenants/:id */
export async function deleteController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenant = await runAuditedTransaction(
      () => tenantsService.deleteTenant(req.params.id),
      (deleted) => createTransactionalAuditEntry(
        req,
        'DELETE',
        'tenant',
        { code: 'tenant.deleted' },
        deleted.id,
        deleted.name,
      ),
    );
    invalidateTenantCache(req.params.id);
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

    const tenant = await tenantsService.getTenantById(req.params.id);
    await tenantsService.updateTenantModules(
      req.params.id,
      parsed.data.modules,
      {
        ...createTransactionalAuditEntry(
          req,
          'UPDATE',
          'tenant_modules',
          { code: 'tenant.modules.updated', context: { affected_count: parsed.data.modules.length } },
          req.params.id,
          tenant.name,
        ),
        tenantId: req.params.id,
      },
    );
    sendSuccess(res, null, 'Cập nhật modules thành công');
  } catch (err) { next(err); }
}

/** GET /api/tenants/:id/course-component-permissions */
export async function getCourseComponentPermissionsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const permissions = await tenantCourseComponentsService.getTenantCourseComponentPermissions(req.params.id);
    sendSuccess(res, permissions);
  } catch (err) { next(err); }
}

/** PUT /api/tenants/:id/course-component-permissions */
export async function updateCourseComponentPermissionsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateTenantCourseComponentPermissionsSchema.safeParse(req.body);
    if (!parsed.success) { sendError(res, parsed.error.errors[0].message, 400); return; }

    const tenant = await tenantsService.getTenantById(req.params.id);
    const permissions = await runAuditedTransaction(
      () => tenantCourseComponentsService.updateTenantCourseComponentPermissions(
        req.params.id,
        parsed.data.allowed_component_types,
      ),
      () => ({
        ...createTransactionalAuditEntry(
          req, 'UPDATE', 'tenant_course_component_permissions',
          { code: 'tenant.settings.updated', context: { related_entity_name: 'course_component_permissions', related_entity_type: 'tenant_setting', affected_count: parsed.data.allowed_component_types.length } },
          req.params.id, tenant.name,
        ),
        tenantId: req.params.id,
      }),
    );
    sendSuccess(res, permissions, 'Cập nhật quyền component khóa học thành công');
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
    const tenant = await tenantsService.getTenantById(req.params.id);
    const labels = await roleLabelsService.replaceTenantRoleLabels(
      req.params.id, labelsInput, req.user?.id ?? null,
      {
        ...createTransactionalAuditEntry(
          req, 'UPDATE', 'tenant_role_labels',
          { code: 'tenant.settings.updated', context: { related_entity_name: 'role_labels', related_entity_type: 'tenant_setting', affected_count: Object.keys(labelsInput).length } },
          req.params.id, tenant.name,
        ), tenantId: req.params.id,
      },
    );
    sendSuccess(res, { labels }, 'Cap nhat ten role thanh cong');
  } catch (err) { next(err); }
}

export async function getGroupLabelsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const labels = await groupLabelsService.getTenantGroupLabels(req.params.id);
    sendSuccess(res, { labels });
  } catch (err) { next(err); }
}

export async function updateGroupLabelsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const labelsInput = req.body?.labels ?? req.body?.group_labels ?? {};
    const tenant = await tenantsService.getTenantById(req.params.id);
    const labels = await groupLabelsService.replaceTenantGroupLabels(
      req.params.id, labelsInput, req.user?.id ?? null,
      {
        ...createTransactionalAuditEntry(
          req, 'UPDATE', 'tenant_group_labels',
          { code: 'tenant.settings.updated', context: { related_entity_name: 'group_labels', related_entity_type: 'tenant_setting', affected_count: Object.keys(labelsInput).length } },
          req.params.id, tenant.name,
        ), tenantId: req.params.id,
      },
    );
    sendSuccess(res, { labels }, 'Cap nhat ten group hierarchy thanh cong');
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

/** GET /api/tenants/current/data-quota — quota của tenant trong phiên hiện tại. */
export async function getCurrentDataQuotaController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      sendError(res, 'Không xác định được doanh nghiệp đang sử dụng', 403);
      return;
    }
    const quota = await tenantsService.getCurrentTenantDataQuota(tenantId);
    sendSuccess(res, quota);
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
    const result = await tenantsService.setUserTenants(
      req.params.userId,
      tenant_ids,
      (user) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'user_tenants',
        { code: 'tenant.user_tenants.updated', context: { affected_count: tenant_ids.length } },
        req.params.userId,
        user.username,
      ),
    );
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

    const tenant = await tenantsService.getTenantById(req.params.id);
    const config = await runAuditedTransaction(
      () => smtpService.updateTenantSmtpConfig(req.params.id, parsed.data),
      () => ({
        ...createTransactionalAuditEntry(
          req, 'UPDATE', 'tenant_smtp_config',
          { code: 'tenant.settings.updated', context: { related_entity_name: 'smtp', related_entity_type: 'tenant_setting' } },
          req.params.id, tenant.name,
        ), tenantId: req.params.id,
      }),
    );
    sendSuccess(res, config, 'Cap nhat SMTP thanh cong');
  } catch (err) { next(err); }
}
