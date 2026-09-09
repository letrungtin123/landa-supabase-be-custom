import type { NextFunction, Request, Response } from 'express';
import {
  createTransactionalAuditEntry,
  runAuditedTransaction,
} from '../../middleware/audit-log.js';
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

    const result = await runAuditedTransaction(
      async () => {
        const before = await ssoService.getConfigAuditState(tenantId, providerParsed.data.provider);
        const after = await ssoService.updateConfig(tenantId, providerParsed.data.provider, bodyParsed.data);
        return { before, after };
      },
      ({ before, after }) => {
        const changes = [] as Array<{ field: string; before: boolean; after: boolean }>;
        if (before.is_enabled !== after.is_enabled) changes.push({ field: 'is_enabled', before: before.is_enabled, after: after.is_enabled });
        if (before.has_secret !== after.has_secret) changes.push({ field: 'secret_status', before: before.has_secret, after: after.has_secret });
        return createTransactionalAuditEntry(
          req,
          'UPDATE',
          'sso_config',
          {
            code: 'sso_config.updated',
            context: { related_entity_name: after.label, related_entity_type: 'sso_provider' },
            changes,
          },
          `${tenantId}:${after.provider}`,
          after.label,
        );
      },
    );
    sendSuccess(res, result.after, 'Cập nhật SSO thành công');
  } catch (err) { next(err); }
}

export async function deleteConfigController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user?.tenantId;
    if (!tenantId) { sendError(res, 'Không xác định được tenant', 400); return; }

    const providerParsed = providerParamSchema.safeParse(req.params);
    if (!providerParsed.success) { sendError(res, providerParsed.error.errors[0].message, 400); return; }

    await runAuditedTransaction(
      () => ssoService.deleteConfig(tenantId, providerParsed.data.provider),
      () => createTransactionalAuditEntry(
        req,
        'DELETE',
        'sso_config',
        {
          code: 'sso_config.deleted',
          context: { related_entity_name: providerParsed.data.provider, related_entity_type: 'sso_provider' },
        },
        `${tenantId}:${providerParsed.data.provider}`,
        providerParsed.data.provider,
      ),
    );
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
