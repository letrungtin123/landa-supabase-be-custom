import type { Request, Response, NextFunction } from 'express';
import * as svc from './audit-logs.service.js';
import { sendSuccess } from '../../utils/response.js';

export async function listController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    res.setHeader('Cache-Control', 'private, no-store');
    sendSuccess(res, await svc.listAuditLogs(tenantId, req.user!.role, req.query as Record<string, unknown>));
  } catch (err) { next(err); }
}

export async function detailController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    sendSuccess(res, await svc.getAuditLogDetail(
      req.params.id,
      req.user!.tenantId,
      req.user!.role,
      req.query as Record<string, unknown>,
    ));
  } catch (err) { next(err); }
}
