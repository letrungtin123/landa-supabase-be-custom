import type { NextFunction, Request, Response } from 'express';
import { createTransactionalAuditEntry, runAuditedTransaction } from '../../middleware/audit-log.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import * as authService from '../auth/auth.service.js';
import * as demoIframeService from './demo-iframe.service.js';
import * as demoLoginService from './demo-login.service.js';
import {
  deleteDemoLoginAccountParamSchema,
  demoIframeBootstrapSchema,
  demoIframeEmbedParamSchema,
  publicClaimSchema,
  publicDomainParamSchema,
  replaceDemoLoginAccountsSchema,
  tenantParamSchema,
  updateDemoIframeConfigSchema,
  updateDemoLoginConfigSchema,
} from './demo-login.validator.js';

function firstError(parsed: { success: false; error: { errors: Array<{ message: string }> } }): string {
  return parsed.error.errors[0]?.message || 'Dữ liệu không hợp lệ';
}

export async function getAdminConfigController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = tenantParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    const result = await demoLoginService.getDemoLoginConfig(params.data.tenantId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function updateAdminConfigController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = tenantParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    const body = updateDemoLoginConfigSchema.safeParse(req.body);
    if (!body.success) { sendError(res, firstError(body), 400); return; }

    const result = await runAuditedTransaction(
      () => demoLoginService.updateDemoLoginConfig(params.data.tenantId, body.data, req.user?.id || null),
      (updated) => ({
        ...createTransactionalAuditEntry(
          req, 'UPDATE', 'tenant',
          { code: 'demo_login.settings.updated', context: { related_entity_name: 'demo_qr_login', related_entity_type: 'tenant_setting' } },
          params.data.tenantId, updated.tenant.name,
        ), tenantId: params.data.tenantId,
      }),
    );
    sendSuccess(res, result, 'Đã lưu cấu hình demo QR login');
  } catch (err) {
    next(err);
  }
}

export async function searchEligibleLearnersController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = tenantParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    const result = await demoLoginService.searchEligibleLearners(
      params.data.tenantId,
      req.query as Record<string, unknown>,
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function replaceAccountsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = tenantParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    const body = replaceDemoLoginAccountsSchema.safeParse(req.body);
    if (!body.success) { sendError(res, firstError(body), 400); return; }

    const config = await demoLoginService.getDemoLoginConfig(params.data.tenantId);
    const result = await demoLoginService.replaceDemoLoginAccounts(
      params.data.tenantId, body.data, req.user?.id || null,
      {
        ...createTransactionalAuditEntry(
          req, 'UPDATE', 'tenant',
          { code: 'demo_login.accounts.updated', context: { related_entity_name: 'demo_qr_login', related_entity_type: 'tenant_setting', affected_count: body.data.accounts.length } },
          params.data.tenantId, config.tenant.name,
        ), tenantId: params.data.tenantId,
      },
    );
    sendSuccess(res, result, 'Đã cập nhật danh sách learner demo');
  } catch (err) {
    next(err);
  }
}

export async function deleteAccountController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = deleteDemoLoginAccountParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    const result = await runAuditedTransaction(
      () => demoLoginService.deleteDemoLoginAccount(params.data.tenantId, params.data.publicId),
      (deleted) => ({
        ...createTransactionalAuditEntry(
          req, 'DELETE', 'demo_login_account',
          { code: 'demo_login.account.removed', context: { related_entity_name: deleted.username, related_entity_type: 'learner' } },
          params.data.publicId, deleted.username,
        ), tenantId: params.data.tenantId,
      }),
    );
    sendSuccess(res, null, 'Đã xóa tài khoản demo');
  } catch (err) {
    next(err);
  }
}

export async function listPublicAccountsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = publicDomainParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    const result = await demoLoginService.listPublicDemoLoginAccounts(params.data.domain);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function claimPublicAccountController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = publicDomainParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    const body = publicClaimSchema.safeParse(req.body);
    if (!body.success) { sendError(res, firstError(body), 400); return; }

    const result = await demoLoginService.claimPublicDemoLoginAccount(params.data.domain, body.data.account_id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getAdminIframeConfigController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = tenantParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    const result = await demoIframeService.getDemoIframeConfig(params.data.tenantId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function updateAdminIframeConfigController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = tenantParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    const body = updateDemoIframeConfigSchema.safeParse(req.body);
    if (!body.success) { sendError(res, firstError(body), 400); return; }

    const result = await runAuditedTransaction(
      () => demoIframeService.updateDemoIframeConfig(params.data.tenantId, body.data, req.user?.id || null),
      (updated) => ({
        ...createTransactionalAuditEntry(
          req, 'UPDATE', 'tenant',
          { code: 'demo_iframe.settings.updated', context: { related_entity_name: 'demo_iframe_login', related_entity_type: 'tenant_setting' } },
          params.data.tenantId, updated.tenant.name,
        ), tenantId: params.data.tenantId,
      }),
    );
    sendSuccess(res, result, 'Đã lưu cấu hình demo iframe login');
  } catch (err) {
    next(err);
  }
}

export async function regenerateAdminIframeEmbedController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = tenantParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    const result = await runAuditedTransaction(
      () => demoIframeService.regenerateDemoIframeEmbedId(params.data.tenantId, req.user?.id || null),
      (updated) => ({
        ...createTransactionalAuditEntry(
          req, 'UPDATE', 'tenant',
          { code: 'demo_iframe.embed.regenerated', context: { related_entity_name: 'demo_iframe_login', related_entity_type: 'tenant_setting' } },
          params.data.tenantId, updated.tenant.name,
        ), tenantId: params.data.tenantId,
      }),
    );
    sendSuccess(res, result, 'Đã tạo lại mã nhúng demo iframe');
  } catch (err) {
    next(err);
  }
}

export async function searchEligibleIframeLearnersController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = tenantParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    const result = await demoIframeService.searchEligibleIframeLearners(
      params.data.tenantId,
      req.query as Record<string, unknown>,
    );
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function bootstrapPublicIframeController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = demoIframeEmbedParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    const body = demoIframeBootstrapSchema.safeParse(req.body);
    if (!body.success) { sendError(res, firstError(body), 400); return; }

    const bootstrap = await demoIframeService.resolveDemoIframeBootstrap(
      params.data.embedId,
      body.data.parent_origin,
      req.get('origin'),
    );
    const session = await authService.issueSessionForUserId(bootstrap.user_id, {
      sessionMode: 'demo_iframe',
      updateLastLogin: false,
    });
    sendSuccess(res, {
      ...session,
      demo_iframe: {
        tenant: bootstrap.tenant,
        parent_origin: bootstrap.parent_origin,
        learner_label: bootstrap.learner_label,
      },
    }, 'Đăng nhập demo iframe thành công');
  } catch (err) {
    next(err);
  }
}
