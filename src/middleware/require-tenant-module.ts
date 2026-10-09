import type { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/response.js';
import { isTenantModuleEnabled } from './tenant-module-state.js';

interface TenantModuleGateOptions {
  /** Platform operators may prepare tenant content before enabling the learner feature. */
  superadminBypass?: boolean;
}

/** Server-authoritative tenant feature gate. Navigation visibility is never a security boundary. */
export function requireTenantModule(moduleCode: string, options: TenantModuleGateOptions = {}) {
  return async function tenantModuleGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.user) {
      sendError(res, 'Chưa xác thực', 401);
      return;
    }
    if (options.superadminBypass && req.user.role === 'superadmin') {
      next();
      return;
    }
    if (!req.user.tenantId) {
      sendError(res, 'User không thuộc tenant nào', 403, 'TENANT_REQUIRED');
      return;
    }

    try {
      if (!await isTenantModuleEnabled(req.user.tenantId, moduleCode)) {
        sendError(res, 'Tính năng chưa được bật cho doanh nghiệp này', 403, 'MODULE_DISABLED');
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
