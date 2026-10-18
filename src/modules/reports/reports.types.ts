import type { QueryResult, QueryResultRow } from 'pg';

/**
 * What a report repository needs from the database: `reportsQuery` (the
 * reports pool, or the open export snapshot) or `query` (the main pool,
 * joining the current transaction). The service picks one per repository.
 */
export interface ReportsDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** The bucket of a date-range chart. */
export type ReportBucketGranularity = 'day' | 'week' | 'month';

/** Start and end of a report period (local day bounds). */
export interface ReportPeriodBounds {
  startDate: Date;
  endDate: Date;
}

/** The org unit a report reads: the most specific one set wins. */
export interface ReportScopeIds {
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
}
