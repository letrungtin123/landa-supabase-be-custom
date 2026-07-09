import type { Request, Response, NextFunction } from 'express';
import { auditFromReq } from '../../middleware/audit-log.js';
import { sendSuccess } from '../../utils/response.js';
import * as svc from './email-templates.service.js';

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
    const result = await svc.updateTenantEmailTemplate(tenantId, req.params.key, req.body, userId);
    auditFromReq(req, 'UPDATE', 'email_template', req.params.key, result.name, 'Cập nhật mẫu email');
    sendSuccess(res, result, 'Cập nhật mẫu email thành công');
  } catch (err) {
    next(err);
  }
}

export async function reset(req: Request, res: Response, next: NextFunction) {
  try {
    const tenantId = req.user!.tenantId!;
    const result = await svc.resetTenantEmailTemplate(tenantId, req.params.key);
    auditFromReq(req, 'DELETE', 'email_template', req.params.key, result.name, 'Khôi phục mẫu email mặc định');
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
