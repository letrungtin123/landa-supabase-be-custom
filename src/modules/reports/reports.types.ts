import type { QueryResult, QueryResultRow } from 'pg';

/**
 * What a report repository needs from the database: `reportsQuery` (the
 * reports pool, or the open export snapshot) or `query` (the main pool,
 * joining the current transaction). The service picks one per repository.
 */
export interface ReportsDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}
