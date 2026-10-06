import type { Request, Response, NextFunction } from 'express';
import { query } from '../config/database.js';
import { cacheJson, getCacheVersion } from '../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../config/cache-keys.js';
import { sendError } from '../utils/response.js';

interface TenantModuleGateOptions {
  /** Platform operators may prepare tenant content before enabling the learner feature. */
  superadminBypass?: boolean;
}

async function isTenantModuleEnabled(tenantId: string, moduleCode: string): Promise<boolean> {
  const version = await getCacheVersion(...cacheVersions.tenantModules(tenantId));
  const key = cacheKeys.tenantResource(tenantId, 'module-gate', version, { moduleCode });
  return cacheJson(key, CACHE_TTL.publicConfig, async () => {
    const result = await query<{ enabled: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM tenant_modules tm
         JOIN modules m ON m.id = tm.module_id
         WHERE tm.tenant_id = $1::uuid
           AND m.code = $2
           AND m.is_active = true
           AND tm.is_enabled = true
       ) AS enabled`,
      [tenantId, moduleCode],
    );
    return result.rows[0]?.enabled === true;
  });
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
