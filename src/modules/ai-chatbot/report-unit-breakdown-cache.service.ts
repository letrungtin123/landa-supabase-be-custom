// Unit breakdown rows of a report chat snapshot, cached like the other report
// aggregates (30 s while the period includes today, else 300 s) per tenant,
// breakdown plan (level + parent unit, from the already-enforced scope), both
// periods and limit. Loaded on the reports pool inside a report admission slot.

import { cacheJson, cacheKey, stableHash } from '../../config/cache.js';
import { runReportAggregate } from '../reports/report-admission.service.js';
import { getReportAggregateCacheTtl } from '../reports/reports.service.js';
import { loadReportUnitBreakdownRows } from './report-chat.repository.js';
import { localYmd } from './report-date.logic.js';
import type { ReportUnitBreakdownQueryInput, ReportUnitBreakdownQueryRow } from './report-unit-breakdown.logic.js';

export function loadCachedReportUnitBreakdownRows(input: ReportUnitBreakdownQueryInput): Promise<ReportUnitBreakdownQueryRow[]> {
  const key = cacheKey('reports', 'unit-breakdown', 'v1', input.tenantId, stableHash({
    plan: input.plan,
    from: input.range.startDate.toISOString(),
    to: input.range.endDate.toISOString(),
    previousFrom: input.previousRange.startDate.toISOString(),
    previousTo: input.previousRange.endDate.toISOString(),
    limit: input.limit,
  }));
  return cacheJson(
    key,
    getReportAggregateCacheTtl({ dateTo: localYmd(input.range.endDate) }),
    () => runReportAggregate(input.tenantId, () => loadReportUnitBreakdownRows(input)),
  );
}
