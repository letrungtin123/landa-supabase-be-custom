// ═══════════════════════════════════════════════════════════════
// Tenant module state — which features the superadmin turned on per tenant
//
// One cached map per tenant: module code -> enabled. A module is enabled only
// when it is active globally and the tenant has an enabled tenant_modules row.
// Codes that are not modules (e.g. 'enrollments') are absent from the map.
// Invalidation: tenant module updates bump cacheVersions.tenantModules(tenant);
// module catalog changes bump cacheVersions.modules().
// ═══════════════════════════════════════════════════════════════

import { query } from '../config/database.js';
import { cacheJson, getCacheVersion } from '../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../config/cache-keys.js';

export type TenantModuleStates = Record<string, boolean>;

export async function loadTenantModuleStates(tenantId: string): Promise<TenantModuleStates> {
  const [tenantVersion, catalogVersion] = await Promise.all([
    getCacheVersion(...cacheVersions.tenantModules(tenantId)),
    getCacheVersion(...cacheVersions.modules()),
  ]);
  const key = cacheKeys.tenantResource(tenantId, 'module-states', `${tenantVersion}.${catalogVersion}`);
  return cacheJson(key, CACHE_TTL.publicConfig, async () => {
    const result = await query<{ code: string; enabled: boolean }>(
      `SELECT m.code, (m.is_active AND COALESCE(tm.is_enabled, false)) AS enabled
       FROM modules m
       LEFT JOIN tenant_modules tm ON tm.module_id = m.id AND tm.tenant_id = $1::uuid`,
      [tenantId],
    );
    const states: TenantModuleStates = {};
    for (const row of result.rows) states[row.code] = row.enabled === true;
    return states;
  });
}

/** True only for a module that is turned on for the tenant. */
export async function isTenantModuleEnabled(tenantId: string, moduleCode: string): Promise<boolean> {
  return (await loadTenantModuleStates(tenantId))[moduleCode] === true;
}

/** True when the code is a module and it is not turned on for the tenant. */
export async function isTenantModuleSwitchedOff(tenantId: string, moduleCode: string): Promise<boolean> {
  return (await loadTenantModuleStates(tenantId))[moduleCode] === false;
}
