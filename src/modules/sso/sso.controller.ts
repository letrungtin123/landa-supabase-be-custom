import type { NextFunction, Request, Response } from 'express';
import { auditFromReq } from '../../middleware/audit-log.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import * as ssoService from './sso.service.js';
import { exchangeSsoCodeSchema, providerParamSchema, updateSsoConfigSchema } from './sso.validator.js';

export async function listConfigsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { sendError(res, 'Không xác định được tenant', 400); return; }
    const result = await ssoService.listConfigs(tenantId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function updateConfigController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { sendError(res, 'Không xác định được tenant', 400); return; }

    const providerParsed = providerParamSchema.safeParse(req.params);
    if (!providerParsed.success) { sendError(res, providerParsed.error.errors[0].message, 400); return; }

    const bodyParsed = updateSsoConfigSchema.safeParse(req.body);
    if (!bodyParsed.success) { sendError(res, bodyParsed.error.errors[0].message, 400); return; }

    const result = await ssoService.updateConfig(tenantId, providerParsed.data.provider, bodyParsed.data);
    auditFromReq(req, 'UPDATE', 'sso_config', tenantId, providerParsed.data.provider, 'Cập nhật cấu hình SSO');
    sendSuccess(res, result, 'Cập nhật SSO thành công');
  } catch (err) { next(err); }
}

export async function deleteConfigController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { sendError(res, 'Không xác định được tenant', 400); return; }

    const providerParsed = providerParamSchema.safeParse(req.params);
    if (!providerParsed.success) { sendError(res, providerParsed.error.errors[0].message, 400); return; }

    await ssoService.deleteConfig(tenantId, providerParsed.data.provider);
    auditFromReq(req, 'DELETE', 'sso_config', tenantId, providerParsed.data.provider, 'Xóa cấu hình SSO');
    sendSuccess(res, null, 'Xóa SSO thành công');
  } catch (err) { next(err); }
}

export async function getPublicByDomainController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { domain } = req.params;
    if (!domain) { sendError(res, 'Domain không được để trống', 400); return; }
    const result = await ssoService.getPublicConfigByDomain(domain);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function exchangeController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const providerParsed = providerParamSchema.safeParse(req.params);
    if (!providerParsed.success) { sendError(res, providerParsed.error.errors[0].message, 400); return; }

    const bodyParsed = exchangeSsoCodeSchema.safeParse(req.body);
    if (!bodyParsed.success) { sendError(res, bodyParsed.error.errors[0].message, 400); return; }

    const result = await ssoService.exchangeSsoCode(providerParsed.data.provider, bodyParsed.data);
    sendSuccess(res, result, 'Đăng nhập SSO thành công');
  } catch (err) { next(err); }
}
