// One time-bucket rule for every report chart that has no explicit choice:
// the Reports screen charts (reports.service resolveChartGranularity 'auto')
// and the AI report snapshots behind the chat card and the PDF
// (report-time-expression.logic resolveSnapshotChartGranularity). Both read
// this module so the two cannot drift apart again.

export type ReportAutoBucketSize = 'day' | 'week' | 'month';

/**
 * Up to dayMaxDays days the chart shows one point per day, up to weekMaxDays
 * days one point per ISO week (Monday to Sunday), longer ranges one point per
 * calendar month. The first and last week or month may be cut by the range.
 */
export const REPORT_AUTO_BUCKET_RULE = {
  dayMaxDays: 31,
  weekMaxDays: 120,
} as const;

/** Bucket size for a range of `dayCount` calendar days (both ends included). */
export function resolveAutoReportBucket(dayCount: number): ReportAutoBucketSize {
  if (dayCount <= REPORT_AUTO_BUCKET_RULE.dayMaxDays) return 'day';
  if (dayCount <= REPORT_AUTO_BUCKET_RULE.weekMaxDays) return 'week';
  return 'month';
}
