// Report snapshot analytics: the metric facts of a snapshot and the signals detected from them,
// with their versioned thresholds. Split out of report-chat.service.ts (move only), which
// re-exports its public names.

import * as reportsService from '../../reports/reports.service.js';

export const REPORT_SIGNAL_THRESHOLD_VERSION = 'v1' as const;
export const REPORT_SIGNAL_THRESHOLDS = {
  completion_decline: {
    minimum_current_enrollments: 10,
    minimum_previous_enrollments: 10,
    decline_percentage_points: -3,
  },
  high_enrollment_low_completion: {
    minimum_enrollments: 5,
    maximum_completion_rate: 50,
  },
  end_period_activity_drop: {
    minimum_buckets: 8,
    minimum_preceding_activity: 3,
    maximum_recent_to_preceding_ratio: 0.5,
  },
} as const;

export type ReportMetricId = 'total_learners' | 'active_learners' | 'completion_rate' | 'total_enrollments' | 'incomplete_enrollments';
export type ReportMetricUnit = 'count' | 'percentage';
export type ReportSignalSeverity = 'attention' | 'warning' | 'neutral';

export interface ReportMetricFact {
  id: ReportMetricId;
  unit: ReportMetricUnit;
  current: number;
  previous: number | null;
  delta_absolute: number | null;
  delta_percent: number | null;
  delta_percentage_points: number | null;
}

export interface ReportSignalEvidence {
  metric_id?: ReportMetricId;
  course_id?: string;
  course_name?: string;
  current?: number;
  previous?: number;
  delta_absolute?: number;
  delta_percentage_points?: number;
  affected_course_count?: number;
  enrollment_count?: number;
  completion_rate?: number;
  current_sample_size?: number;
  previous_sample_size?: number;
}

export interface ReportAnalyticsSignal {
  id: string;
  category: 'enrollment' | 'completion' | 'activity' | 'course';
  severity: ReportSignalSeverity;
  threshold_version: typeof REPORT_SIGNAL_THRESHOLD_VERSION;
  evidence: ReportSignalEvidence;
}

function roundReportValue(value: number): number {
  return Math.round(value * 100) / 100;
}

function metricFact(id: ReportMetricId, unit: ReportMetricUnit, current: number, previous: number): ReportMetricFact {
  const delta = roundReportValue(current - previous);
  return {
    id,
    unit,
    current,
    previous,
    delta_absolute: delta,
    delta_percent: unit === 'count' && previous > 0 ? roundReportValue((delta / previous) * 100) : null,
    delta_percentage_points: unit === 'percentage' ? delta : null,
  };
}

export function buildReportMetricFacts(summary: reportsService.ReportSummary, previousSummary: reportsService.ReportSummary): ReportMetricFact[] {
  const current = summary.overview;
  const previous = previousSummary.overview;
  return [
    metricFact('total_learners', 'count', current.total_learners, previous.total_learners),
    metricFact('active_learners', 'count', current.active_learners, previous.active_learners),
    metricFact('completion_rate', 'percentage', current.completion_rate, previous.completion_rate),
    metricFact('total_enrollments', 'count', current.total_enrollments, previous.total_enrollments),
    metricFact('incomplete_enrollments', 'count', current.incomplete_enrollments, previous.incomplete_enrollments),
  ];
}

export function buildReportSignals(input: {
  metrics: ReportMetricFact[];
  activeTrend: Array<{ value: number }>;
  coursePortfolio: reportsService.ReportCoursePerformance[];
}): ReportAnalyticsSignal[] {
  const metric = (id: ReportMetricId) => input.metrics.find((item) => item.id === id)!;
  const signals: ReportAnalyticsSignal[] = [];
  const enrollments = metric('total_enrollments');
  const completion = metric('completion_rate');
  if (enrollments.delta_absolute !== null && enrollments.delta_absolute !== 0) {
    signals.push({
      id: 'enrollment_period_change',
      category: 'enrollment',
      severity: 'neutral',
      threshold_version: REPORT_SIGNAL_THRESHOLD_VERSION,
      evidence: {
        metric_id: 'total_enrollments',
        current: enrollments.current,
        previous: enrollments.previous ?? undefined,
        delta_absolute: enrollments.delta_absolute,
      },
    });
  }
  const enrollmentCount = metric('total_enrollments');
  const completionSampleIsSufficient = enrollmentCount.current >= REPORT_SIGNAL_THRESHOLDS.completion_decline.minimum_current_enrollments
    && (enrollmentCount.previous ?? 0) >= REPORT_SIGNAL_THRESHOLDS.completion_decline.minimum_previous_enrollments;
  if (completionSampleIsSufficient
    && (completion.delta_percentage_points ?? 0) <= REPORT_SIGNAL_THRESHOLDS.completion_decline.decline_percentage_points) {
    signals.push({
      id: 'completion_decline',
      category: 'completion',
      severity: 'warning',
      threshold_version: REPORT_SIGNAL_THRESHOLD_VERSION,
      evidence: {
        metric_id: 'completion_rate',
        current: completion.current,
        previous: completion.previous ?? undefined,
        delta_percentage_points: completion.delta_percentage_points ?? undefined,
        current_sample_size: enrollmentCount.current,
        previous_sample_size: enrollmentCount.previous ?? undefined,
      },
    });
  }
  const watchlist = input.coursePortfolio.filter((course) => (
    course.total_enrollments >= REPORT_SIGNAL_THRESHOLDS.high_enrollment_low_completion.minimum_enrollments
    && course.completion_rate <= REPORT_SIGNAL_THRESHOLDS.high_enrollment_low_completion.maximum_completion_rate
  ));
  if (watchlist.length > 0) {
    const representative = watchlist[0];
    signals.push({
      id: 'high_enrollment_low_completion',
      category: 'course',
      severity: 'warning',
      threshold_version: REPORT_SIGNAL_THRESHOLD_VERSION,
      evidence: {
        course_id: representative.course_id,
        course_name: representative.name,
        affected_course_count: watchlist.length,
        enrollment_count: representative.total_enrollments,
        completion_rate: representative.completion_rate,
      },
    });
  }
  if (input.activeTrend.length >= REPORT_SIGNAL_THRESHOLDS.end_period_activity_drop.minimum_buckets) {
    const recent = input.activeTrend.slice(-Math.min(7, Math.floor(input.activeTrend.length / 2))).reduce((sum, point) => sum + point.value, 0);
    const preceding = input.activeTrend.slice(-Math.min(14, input.activeTrend.length), -Math.min(7, Math.floor(input.activeTrend.length / 2))).reduce((sum, point) => sum + point.value, 0);
    if (preceding >= REPORT_SIGNAL_THRESHOLDS.end_period_activity_drop.minimum_preceding_activity
      && recent <= preceding * REPORT_SIGNAL_THRESHOLDS.end_period_activity_drop.maximum_recent_to_preceding_ratio) {
      signals.push({
        id: 'end_period_activity_drop',
        category: 'activity',
        severity: 'attention',
        threshold_version: REPORT_SIGNAL_THRESHOLD_VERSION,
        evidence: { current: recent, previous: preceding, delta_absolute: recent - preceding },
      });
    }
  }
  return signals.slice(0, 5);
}

export function getReportSignalLimitations(metrics: ReportMetricFact[]): string[] {
  const enrollments = metrics.find((metric) => metric.id === 'total_enrollments');
  if (!enrollments) return [];
  const currentIsSufficient = enrollments.current >= REPORT_SIGNAL_THRESHOLDS.completion_decline.minimum_current_enrollments;
  const previousIsSufficient = (enrollments.previous ?? 0) >= REPORT_SIGNAL_THRESHOLDS.completion_decline.minimum_previous_enrollments;
  return currentIsSufficient && previousIsSufficient
    ? []
    : [`completion_decline_insufficient_sample:${REPORT_SIGNAL_THRESHOLD_VERSION}`];
}
