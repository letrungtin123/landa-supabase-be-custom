// ═══════════════════════════════════════════════════════════════
// Reports query schemas: the query string of each report route, read the
// way the controller always read it. They coerce and never reject: every
// request accepted before is accepted with the same values (a text that is
// not a number reads as the default, a repeated parameter keeps its old
// reading). The checks that answer 400 stay in the controller, in their old
// order, because their messages and answer shapes differ.
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';
import { readReportScopeId } from './report-access.service.js';

/** Trimmed text, or undefined when absent, blank or not a single text. */
export function getQueryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// parseInt() of the raw value, as before: a repeated parameter reads its first item.
const rawInt = (value: unknown): number => parseInt(value as string);

/** `?month=3` -> 3; absent or empty -> undefined; not a number -> NaN (as before). */
const optionalInt = z.unknown().transform(value => (value ? rawInt(value) : undefined));
/** The raw value as text, unchecked (as before: a repeated parameter stays a list at run time). */
const rawText = z.unknown().transform(value => value as string | undefined);
const scopeId = z.unknown().transform(readReportScopeId);
const queryText = z.unknown().transform(getQueryString);

const scopeFields = { group_id: scopeId, subgroup_id: scopeId, team_id: scopeId };
const periodFields = { month: optionalInt, year: optionalInt, date_from: queryText, date_to: queryText };

/** `?page=` -> parseInt or `fallback`; with `min`, never below it. */
function page(fallback: number, min?: number) {
  return z.unknown().transform(value => {
    const parsed = rawInt(value) || fallback;
    return min === undefined ? parsed : Math.max(parsed, min);
  });
}

/** `?page_size=` -> parseInt or `fallback`, at most `max`; with `min`, never below it. */
function pageSize(fallback: number, max: number, min?: number) {
  return z.unknown().transform(value => {
    const parsed = rawInt(value) || fallback;
    return Math.min(min === undefined ? parsed : Math.max(parsed, min), max);
  });
}

/**
 * `?page=` / `?page_size=` -> parseInt when it is a positive number, else
 * `fallback` (what a missing value reads as); at most `max`. A negative value
 * reads as a missing one instead of reaching LIMIT / OFFSET.
 */
function positiveOr(fallback: number, max = Number.POSITIVE_INFINITY) {
  return z.unknown().transform(value => {
    const parsed = rawInt(value);
    return Math.min(parsed > 0 ? parsed : fallback, max);
  });
}

/** A text filter sent once (or not at all); a repeated parameter is a list and is refused by the controller. */
export function isSingleQueryText(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

const COURSE_COMPLETION_STATUSES = new Set(['all', 'not_started', 'learning', 'completed']);
/** A course status filter: one of the four values, anything else lists every status. */
const courseCompletionStatus = z
  .unknown()
  .transform(value =>
    COURSE_COMPLETION_STATUSES.has((value as string | undefined) || '')
      ? (value as 'all' | 'not_started' | 'learning' | 'completed')
      : 'all',
  );

/** GET /summary */
export const reportSummaryQuerySchema = z.object({ ...periodFields, ...scopeFields });

/** GET /chart (the window checks run in the controller, after the date range). */
export const reportChartQuerySchema = z.object({
  ...periodFields,
  ...scopeFields,
  year: z.unknown().transform(value => rawInt(value) || new Date().getFullYear()),
  metric: z.unknown().transform(value => (value as string) || 'total_enrollments'),
  group_by_org: z.unknown().transform(value => value === 'true'),
  grouped: z.unknown().transform(value => value !== 'false'),
  granularity: z
    .unknown()
    .transform(value => (value === 'day' || value === 'week' || value === 'month' ? value : 'auto')),
  mode: z.unknown().transform(value => (value === 'window' ? ('window' as const) : ('range' as const))),
  direction: z.unknown().transform(value => (typeof value === 'string' ? value : 'initial')),
  anchor_bucket: queryText,
  limit_buckets: z.unknown().transform(parsePositiveInteger),
  series_limit: z.unknown().transform(parsePositiveInteger),
});

/** GET /top-courses (its service does not clamp: a negative page or size reads as the default). */
export const reportTopCoursesQuerySchema = z.object({
  ...periodFields,
  ...scopeFields,
  page: positiveOr(1),
  page_size: positiveOr(10, 100),
});

/** GET /course-completion-ranking */
export const reportCourseRankingQuerySchema = z.object({
  ...periodFields,
  ...scopeFields,
  page: page(1, 1),
  page_size: pageSize(10, 100, 1),
});

/** GET /course-completion-ranking/:courseId/learners */
export const reportCourseLearnersQuerySchema = z.object({
  ...periodFields,
  ...scopeFields,
  page: page(1, 1),
  page_size: pageSize(20, 100, 1),
  search: rawText,
  status: courseCompletionStatus,
});

/** GET /learners (a missing status is refused in the controller). */
export const reportLearnersQuerySchema = z.object({
  ...periodFields,
  ...scopeFields,
  page: page(1),
  page_size: pageSize(20, 100),
  search: rawText,
  status: z.unknown().transform(value => ({
    present: getQueryString(value) !== undefined,
    value: value as 'all' | 'not_started' | 'learning' | 'completed',
  })),
});

/** GET /export.xlsx and GET /course-completion-ranking/:courseId/export.xlsx */
export const reportExportQuerySchema = z.object({
  ...periodFields,
  ...scopeFields,
  /** parseInt of `?year=` (NaN when not a number); the controller picks the year. */
  year: z.unknown().transform(rawInt),
  locale: z.unknown(),
  group_label: z.unknown(),
  subgroup_label: z.unknown(),
  team_label: z.unknown(),
});

/** GET /learner-detail (a missing username is refused in the controller). */
export const reportLearnerDetailQuerySchema = z.object({
  ...periodFields,
  ...scopeFields,
  username: z.unknown().transform(value => value as string),
  page: page(1, 1),
  search: z.unknown().transform(value => (value as string) || ''),
  page_size: pageSize(10, 100, 1),
  status: courseCompletionStatus,
  data_scope: z
    .unknown()
    .transform(value =>
      value === 'report_filter' || value === 'learner_history' ? (value as 'report_filter' | 'learner_history') : undefined,
    ),
});

/** GET /user-badges */
export const reportUserBadgesQuerySchema = z.object({
  username: z.unknown().transform(value => value as string),
});

/** GET /user-study-time (an unknown granularity is refused in the controller). */
export const reportUserStudyTimeQuerySchema = z.object({
  username: z.unknown().transform(value => value as string),
  granularity: rawText,
  from: rawText,
  to: rawText,
});

export type ReportPeriodQuery = z.infer<typeof reportSummaryQuerySchema>;
export type ReportChartQuery = z.infer<typeof reportChartQuerySchema>;
export type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;
