// ═══════════════════════════════════════════════════════════════
// Report aggregate cache: how long a cached report answer lives, and the
// cached load through the tenant's report admission. Moved unchanged from
// reports.service.ts.
// ═══════════════════════════════════════════════════════════════

import { cacheJson } from '../../config/cache.js';
import { runReportAggregate } from './report-admission.service.js';
import type { ReportDateRange } from './report-results.types.js';

export function getSummaryCacheTtl(range: Pick<ReportDateRange, 'dateTo'>): number {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  return range.dateTo >= today ? 30 : 300;
}

/** Seconds a cached aggregate of a range lives: 30 while the range includes today, else 300. */
export function getReportAggregateCacheTtl(range: Pick<ReportDateRange, 'dateTo'>): number {
  return getSummaryCacheTtl(range);
}

/**
 * Report list pages (learners, a course's learners, top courses, the yearly
 * chart): 30 s while the period includes today, 60 s for a past period. Lists
 * page and search, so they keep a shorter life than the summary figures.
 */
export function getReportListCacheTtl(dateTo: string | null): number {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  return dateTo === null || dateTo >= today ? 30 : 60;
}

/**
 * A report aggregate: from Redis when cached, else loaded in a slot of the
 * tenant's report admission (runReportAggregate), so a cache hit never waits.
 */
export function cachedReportAggregate<T>(tenantId: string, key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  return cacheJson(key, ttlSeconds, () => runReportAggregate(tenantId, load));
}
