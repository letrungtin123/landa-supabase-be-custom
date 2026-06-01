import type { Request, Response, NextFunction } from 'express';
import * as svc from './audit-logs.service.js';
import { sendSuccess } from '../../utils/response.js';

export async function listController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;
    sendSuccess(res, await svc.listAuditLogs(tenantId, req.query as Record<string, unknown>));
  } catch (err) { next(err); }
}
