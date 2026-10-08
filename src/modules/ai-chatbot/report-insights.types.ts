// Types and versioned thresholds of the deterministic report insights engine.
import { REPORT_SIGNAL_THRESHOLDS, type ReportComparisonPeriod } from './report-chat.service.js';
import type { ReportBucketGranularity } from './report-pdf-i18n.js';
import type { ReportUnitRowKind } from './report-unit-breakdown.logic.js';

export const REPORT_INSIGHTS_VERSION = 'insights-v2';
/** Analysis heuristics. They only steer emphasis/narrative, never metric values. */
export const REPORT_INSIGHT_THRESHOLDS = {
  stableCountDeltaPercent: 2,
  stableRateDeltaPp: 0.5,
  minimumCourseSample: REPORT_SIGNAL_THRESHOLDS.high_enrollment_low_completion.minimum_enrollments,
  concentrationTopN: 3,
  concentrationShare: 60,
  activationNotStartedShare: 30,
  activationMinimumEnrollments: 10,
  backlogCourseShare: 25,
  backlogMinimumIncomplete: 10,
  backlogMinimumCourses: 3,
  anomalySigma: 2,
  anomalyMinimumBuckets: 7,
  anomalyMinimumValue: 3,
  momentumMinimumBuckets: 6,
  momentumChangePercent: 25,
  unitGapPp: 10,
  /** Units are ranked (and flagged) only with at least this many enrollments. */
  minimumUnitSample: REPORT_SIGNAL_THRESHOLDS.high_enrollment_low_completion.minimum_enrollments,
  /** A unit whose rate fell by this many points (both periods sampled) is a risk. */
  unitDeclinePp: Math.abs(REPORT_SIGNAL_THRESHOLDS.completion_decline.decline_percentage_points),
  /** A unit at or below this completion rate is a risk. */
  unitLowCompletionRate: REPORT_SIGNAL_THRESHOLDS.high_enrollment_low_completion.maximum_completion_rate,
  maxRankedCourses: 3,
  inProgressNudgeShare: 25,
} as const;

export type ReportInsightTone = 'positive' | 'negative' | 'neutral' | 'attention';
export type ReportKpiId = 'total_learners' | 'active_learners' | 'completion_rate' | 'total_enrollments' | 'completed_enrollments' | 'incomplete_enrollments';
export type ReportComparisonBasis = ReportComparisonPeriod['basis'] | 'none';
export type ReportAttentionKind = 'completion_decline' | 'course_watchlist' | 'activity_drop' | 'activation_risk'
  | 'backlog_concentration' | 'enrollment_drop' | 'active_learner_drop' | 'unit_gap' | 'unit_decline' | 'unit_low_completion';
export type ReportInsightFactKind = 'context' | 'kpi' | 'status_mix' | 'concentration' | 'top_performer' | 'low_performer'
  | 'spread' | 'trend_peak' | 'trend_momentum' | 'trend_vs_previous' | 'trend_spikes' | 'active_trend_momentum'
  | 'unit_ranking' | ReportAttentionKind;
export type ReportInsightLimitation = 'no_data_in_selected_period' | 'no_accessible_scope' | 'completion_decline_insufficient_sample'
  | 'unit_breakdown_missing' | 'previous_trend_missing' | 'portfolio_truncated' | 'legacy_snapshot' | 'unit_breakdown_invalid'
  | 'partial_last_bucket';

export interface ReportKpiInsight {
  id: ReportKpiId;
  unit: 'count' | 'percentage';
  current: number;
  previous: number | null;
  /** Absolute change for counts, percentage points for the completion rate. */
  delta: number | null;
  deltaPercent: number | null;
  direction: 'up' | 'down' | 'flat' | null;
  tone: ReportInsightTone;
}

export interface ReportTrendPoint { bucket: string; value: number }
export interface ReportTrendInsight {
  metric: 'enrollments' | 'active_learners';
  granularity: ReportBucketGranularity;
  points: ReportTrendPoint[];
  previousPoints: ReportTrendPoint[] | null;
  total: number;
  mean: number;
  peak: { index: number; bucket: string; value: number } | null;
  zeroBuckets: number;
  previousAverage: number | null;
  momentum: { first: number; last: number; changePercent: number } | null;
  spikes: Array<{ index: number; bucket: string; value: number }>;
  partialLastBucket: boolean;
}

export interface ReportCourseInsight {
  token: string;
  courseId: string;
  name: string;
  enrollments: number;
  completed: number;
  incomplete: number;
  notStarted: number | null;
  inProgress: number | null;
  completionRate: number;
  enrollmentShare: number | null;
  incompleteShare: number | null;
  rankable: boolean;
  watch: boolean;
}

export interface ReportCourseInsights {
  rows: ReportCourseInsight[];
  coverageShare: number | null;
  truncated: boolean;
  topN: number;
  topShare: number | null;
  top1Share: number | null;
  topPerformers: ReportCourseInsight[];
  lowPerformers: ReportCourseInsight[];
  watchlist: ReportCourseInsight[];
  spread: { best: ReportCourseInsight; worst: ReportCourseInsight; pp: number } | null;
  largestBacklog: ReportCourseInsight | null;
}

export interface ReportStatusMix {
  completed: number; inProgress: number; notStarted: number; total: number;
  completedShare: number; inProgressShare: number; notStartedShare: number;
}

export interface ReportUnitInsight {
  token: string; unitId: string; name: string;
  /** 'others' aggregates the units past the listed ones; 'unassigned' the scope learners in no unit. */
  kind: ReportUnitRowKind;
  unitCount: number | null;
  learners: number; activeLearners: number; enrollments: number; completed: number;
  completionRate: number; previousCompletionRate: number | null; previousEnrollments: number | null; deltaPp: number | null;
  rankable: boolean;
}
export interface ReportUnitInsights {
  level: 'group' | 'subgroup' | 'team';
  /** Units first (by completion rate), then the aggregate rows. */
  rows: ReportUnitInsight[];
  best: ReportUnitInsight | null;
  worst: ReportUnitInsight | null;
  gapPp: number | null;
  /** Largest completion-rate drop vs the comparison period, beyond the threshold. */
  decline: ReportUnitInsight | null;
  /** Ranked units at or below the low-completion threshold, lowest first. */
  lowCompletion: ReportUnitInsight[];
  /** Child units of the scope with learners (listed + aggregated into "others"). */
  unitCount: number;
  /** Distinct learners of the scope, when the snapshot carries it. */
  scopeLearners: number | null;
  /** A learner counts in each of their units: the rows add up to more than the scope. */
  overlapping: boolean;
  /** Units past the listed ones were aggregated into an "others" row. */
  truncated: boolean;
}
/** Why the units section has (or has no) rows. */
export type ReportUnitBreakdownState = 'available' | 'leaf_scope' | 'no_child_units' | 'not_computed' | 'missing' | 'invalid';

export interface ReportScopeInsight {
  tenantWide: boolean;
  groupName: string | null;
  subgroupName: string | null;
  teamName: string | null;
}

export interface ReportAttentionItem { kind: ReportAttentionKind; severity: 'warning' | 'attention'; factId: string }

export interface ReportInsightFact {
  id: string;
  kind: ReportInsightFactKind;
  tone: ReportInsightTone;
  priority: number;
  values: Record<string, number>;
  entities: string[];
}

export interface ReportEntity { token: string; type: 'course' | 'unit'; name: string }

export interface ReportInsights {
  version: typeof REPORT_INSIGHTS_VERSION;
  available: boolean;
  comparisonBasis: ReportComparisonBasis;
  period: { dateFrom: string; dateTo: string; days: number };
  comparison: { dateFrom: string; dateTo: string } | null;
  kpis: ReportKpiInsight[];
  trends: { enrollments: ReportTrendInsight | null; activeLearners: ReportTrendInsight | null };
  statusMix: ReportStatusMix | null;
  courses: ReportCourseInsights;
  units: ReportUnitInsights | null;
  unitBreakdownState: ReportUnitBreakdownState;
  scope: ReportScopeInsight;
  attention: ReportAttentionItem[];
  facts: ReportInsightFact[];
  entities: ReportEntity[];
  limitations: ReportInsightLimitation[];
}
