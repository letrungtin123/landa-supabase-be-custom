import type { Request, Response, NextFunction } from 'express';
import {
  createTransactionalAuditEntry,
  runAuditedTransaction,
} from '../../middleware/audit-log.js';
import { sendError, sendSuccess } from '../../utils/response.js';
import * as svc from './email-templates.service.js';
import { EMAIL_TEMPLATE_INPUT_INVALID_CODE, emailTemplateBodySchema } from './email-templates.validator.js';

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId!;
    const result = await svc.listTenantEmailTemplates(tenantId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId!;
    const userId = req.user!.id;
    const parsed = emailTemplateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, parsed.error.errors[0].message, 400, EMAIL_TEMPLATE_INPUT_INVALID_CODE);
      return;
    }
    const body = parsed.data;
    const result = await runAuditedTransaction(
      () => svc.updateTenantEmailTemplate(tenantId, req.params.key, body, userId),
      (updated) => createTransactionalAuditEntry(
        req,
        'UPDATE',
        'email_template',
        {
          code: 'email_template.updated',
          context: { related_entity_name: updated.name, related_entity_type: 'email_template' },
        },
        updated.template_key,
        updated.name,
      ),
    );
    sendSuccess(res, result, 'Cập nhật mẫu email thành công');
  } catch (err) {
    next(err);
  }
}

export async function reset(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId!;
    const result = await runAuditedTransaction(
      () => svc.resetTenantEmailTemplate(tenantId, req.params.key),
      (reset) => createTransactionalAuditEntry(
        req,
        'DELETE',
        'email_template',
        {
          code: 'email_template.reset',
          context: { related_entity_name: reset.name, related_entity_type: 'email_template' },
        },
        reset.template_key,
        reset.name,
      ),
    );
    sendSuccess(res, result, 'Đã khôi phục mẫu email mặc định');
  } catch (err) {
    next(err);
  }
}

export async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId!;
    const result = await svc.previewTenantEmailTemplate(tenantId, req.params.key, req.body);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}
