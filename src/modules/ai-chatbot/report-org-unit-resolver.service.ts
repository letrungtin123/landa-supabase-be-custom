// Tenant-scoped org-unit catalog for chat reports (names + hierarchy only).
//
// Cached in Redis per tenant with a short TTL and a version key: groups,
// subgroups and teams are edited rarely, a 60 s staleness window is the
// accepted bound, and `invalidateReportOrgUnitCatalog` is the named
// invalidation point for the groups module to call on writes.

import { bumpCacheVersion, cacheJson, getCacheVersion } from '../../config/cache.js';
import { cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { getTenantGroupLabels } from '../tenants/tenant-group-labels.service.js';
import { loadReportOrgUnitRows } from './report-chat.repository.js';
import type { ReportGroupLabels, ReportOrgUnitCatalog } from './report-org-unit.logic.js';

export const REPORT_ORG_UNIT_CATALOG_TTL_SECONDS = 60;
/** Upper bound of units scanned per question; far above today's largest tenant (2 groups / 7 subgroups / 15 teams). */
export const REPORT_ORG_UNIT_CATALOG_MAX_UNITS = 5000;
const CATALOG_RESOURCE = 'report-org-unit-catalog';

export async function loadReportOrgUnitCatalog(tenantId: string): Promise<ReportOrgUnitCatalog> {
  const version = await getCacheVersion(...cacheVersions.tenantResource(tenantId, CATALOG_RESOURCE));
  return cacheJson(
    cacheKeys.tenantResource(tenantId, CATALOG_RESOURCE, version),
    REPORT_ORG_UNIT_CATALOG_TTL_SECONDS,
    async () => {
      const rows = await loadReportOrgUnitRows(tenantId, REPORT_ORG_UNIT_CATALOG_MAX_UNITS);
      const truncated = rows.length > REPORT_ORG_UNIT_CATALOG_MAX_UNITS;
      if (truncated) {
        console.warn(JSON.stringify({ event: 'report_org_unit_catalog_truncated', tenant_id: tenantId, max_units: REPORT_ORG_UNIT_CATALOG_MAX_UNITS }));
      }
      return { units: rows.slice(0, REPORT_ORG_UNIT_CATALOG_MAX_UNITS), truncated };
    },
  );
}

export async function invalidateReportOrgUnitCatalog(tenantId: string): Promise<void> {
  await bumpCacheVersion(...cacheVersions.tenantResource(tenantId, CATALOG_RESOURCE));
}

export async function loadReportGroupLabels(tenantId: string): Promise<ReportGroupLabels> {
  return getTenantGroupLabels(tenantId);
}
