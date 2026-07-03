import type { NextFunction, Request, Response } from 'express';
import { auditFromReq } from '../../middleware/audit-log.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import * as demoLoginService from './demo-login.service.js';
import {
  deleteDemoLoginAccountParamSchema,
  publicClaimSchema,
  publicDomainParamSchema,
  replaceDemoLoginAccountsSchema,
  tenantParamSchema,
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

    const result = await demoLoginService.updateDemoLoginConfig(
      params.data.tenantId,
      body.data,
      req.user?.id || null,
    );
    auditFromReq(req, 'UPDATE', 'tenant', params.data.tenantId, result.tenant.name, 'Cập nhật cấu hình demo QR login');
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

    const result = await demoLoginService.replaceDemoLoginAccounts(
      params.data.tenantId,
      body.data,
      req.user?.id || null,
    );
    auditFromReq(req, 'UPDATE', 'tenant', params.data.tenantId, result.tenant.name, 'Cập nhật danh sách learner demo');
    sendSuccess(res, result, 'Đã cập nhật danh sách learner demo');
  } catch (err) {
    next(err);
  }
}

export async function deleteAccountController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = deleteDemoLoginAccountParamSchema.safeParse(req.params);
    if (!params.success) { sendError(res, firstError(params), 400); return; }

    await demoLoginService.deleteDemoLoginAccount(params.data.tenantId, params.data.publicId);
    auditFromReq(req, 'DELETE', 'tenant', params.data.tenantId, params.data.publicId, 'Xóa learner khỏi demo QR login');
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
