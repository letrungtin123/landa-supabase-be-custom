// ═══════════════════════════════════════════════════════════════
// Report insights: deterministic analysis facts computed from the immutable
// report snapshot. No I/O. Every number that may appear in the PDF narrative
// comes from a fact produced here (ids + raw numbers), so the narrative
// validator can prove that the narrative does not invent figures.
// ═══════════════════════════════════════════════════════════════
import { z } from 'zod';
import { REPORT_SIGNAL_THRESHOLDS, type StoredReportChatSnapshot } from './report-chat.service.js';
import type { ReportBucketGranularity } from './report-pdf-i18n.js';
import { buildReportInsightFacts, reportDateParts } from './report-insights-facts.logic.js';
import {
  REPORT_INSIGHTS_VERSION,
  REPORT_INSIGHT_THRESHOLDS,
  type ReportCourseInsight,
  type ReportCourseInsights,
  type ReportEntity,
  type ReportInsightLimitation,
  type ReportInsights,
  type ReportInsightTone,
  type ReportKpiId,
  type ReportKpiInsight,
  type ReportScopeInsight,
  type ReportStatusMix,
  type ReportTrendInsight,
  type ReportTrendPoint,
  type ReportUnitInsight,
  type ReportUnitInsights,
} from './report-insights.types.js';

export * from './report-insights.types.js';

const UnitRowSchema = z.object({
  unit_id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(300),
  learners: z.number().int().nonnegative(),
  active_learners: z.number().int().nonnegative(),
  enrollments: z.number().int().nonnegative(),
  completed_enrollments: z.number().int().nonnegative(),
  completion_rate: z.number().min(0).max(100),
  previous_completion_rate: z.number().min(0).max(100).nullable().optional(),
});
/**
 * Optional snapshot extension (not produced by the snapshot builder yet): one
 * row per child unit of the applied scope, computed with the same cohort rules.
 */
export const ReportUnitBreakdownSchema = z.object({
  level: z.enum(['group', 'subgroup', 'team']),
  rows: z.array(UnitRowSchema).min(1).max(100),
});
const TrendSeriesSchema = z.array(z.object({ bucket: z.string().min(7).max(32), value: z.number().nonnegative() })).max(62);

const KPI_POLARITY: Record<ReportKpiId, 'higher_is_better' | 'neutral'> = {
  total_learners: 'higher_is_better',
  active_learners: 'higher_is_better',
  completion_rate: 'higher_is_better',
  total_enrollments: 'higher_is_better',
  completed_enrollments: 'higher_is_better',
  incomplete_enrollments: 'neutral',
};

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const share = (part: number, total: number): number | null => (total > 0 ? round((part / total) * 100, 2) : null);

function parseYmd(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function countReportDays(dateFrom: string, dateTo: string): number {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  if (!from || !to || to < from) return 0;
  return Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
}

/** Number of chart buckets touched by a date range for a granularity. */
export function countReportBuckets(dateFrom: string, dateTo: string, granularity: ReportBucketGranularity): number | null {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  if (!from || !to || to < from) return null;
  if (granularity === 'day') return countReportDays(dateFrom, dateTo);
  if (granularity === 'month') {
    return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) + 1;
  }
  if (granularity === 'week') {
    const mondayOf = (date: Date) => date.getTime() - ((date.getUTCDay() + 6) % 7) * 86_400_000;
    return Math.round((mondayOf(to) - mondayOf(from)) / (7 * 86_400_000)) + 1;
  }
  return null;
}

function localYmd(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function buildKpi(id: ReportKpiId, current: number, previous: number | null): ReportKpiInsight {
  const unit = id === 'completion_rate' ? 'percentage' : 'count';
  if (previous === null) return { id, unit, current, previous, delta: null, deltaPercent: null, direction: null, tone: 'neutral' };
  const delta = round(current - previous, 2);
  const deltaPercent = unit === 'count' && previous > 0 ? round((delta / previous) * 100, 2) : null;
  const stable = unit === 'percentage'
    ? Math.abs(delta) < REPORT_INSIGHT_THRESHOLDS.stableRateDeltaPp
    : delta === 0 || (deltaPercent !== null && Math.abs(deltaPercent) < REPORT_INSIGHT_THRESHOLDS.stableCountDeltaPercent);
  const direction = stable ? 'flat' : delta > 0 ? 'up' : 'down';
  const tone: ReportInsightTone = direction === 'flat' || KPI_POLARITY[id] === 'neutral'
    ? 'neutral'
    : direction === 'up' ? 'positive' : 'negative';
  return { id, unit, current, previous, delta, deltaPercent, direction, tone };
}

function buildKpis(snapshot: StoredReportChatSnapshot): ReportKpiInsight[] {
  const current = snapshot.summary.overview;
  const previous = snapshot.version === 2 ? snapshot.previous_summary.overview : null;
  const ids: ReportKpiId[] = ['total_enrollments', 'completion_rate', 'active_learners', 'total_learners', 'completed_enrollments', 'incomplete_enrollments'];
  return ids.map((id) => buildKpi(id, Number(current[id]) || 0, previous ? Number(previous[id]) || 0 : null));
}

function readTrendExtension(snapshot: StoredReportChatSnapshot, key: 'previous_enrollment_trend' | 'previous_active_learner_trend'): ReportTrendPoint[] | null {
  const raw = (snapshot as unknown as Record<string, unknown>)[key];
  if (raw === undefined) return null;
  const parsed = TrendSeriesSchema.safeParse(raw);
  return parsed.success && parsed.data.length > 0 ? parsed.data : null;
}

function buildTrend(input: {
  metric: ReportTrendInsight['metric'];
  points: Array<{ bucket: string; value: number }>;
  previousPoints: ReportTrendPoint[] | null;
  granularity: ReportBucketGranularity;
  previousTotal: number | null;
  comparison: { dateFrom: string; dateTo: string } | null;
  partialLastBucket: boolean;
}): ReportTrendInsight | null {
  const points = input.points
    .filter((point) => typeof point.bucket === 'string' && Number.isFinite(point.value) && point.value >= 0)
    .map((point) => ({ bucket: point.bucket, value: point.value }));
  if (!points.length) return null;
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const mean = total / points.length;
  const max = Math.max(...points.map((point) => point.value));
  const peakIndex = points.findIndex((point) => point.value === max);
  const thresholds = REPORT_INSIGHT_THRESHOLDS;
  let previousAverage: number | null = null;
  if (input.previousPoints) {
    previousAverage = input.previousPoints.reduce((sum, point) => sum + point.value, 0) / input.previousPoints.length;
  } else if (input.previousTotal !== null && input.comparison && input.granularity !== 'unknown') {
    const buckets = countReportBuckets(input.comparison.dateFrom, input.comparison.dateTo, input.granularity);
    previousAverage = buckets ? input.previousTotal / buckets : null;
  }
  const analysed = input.partialLastBucket && points.length > 1 ? points.slice(0, -1) : points;
  let momentum: ReportTrendInsight['momentum'] = null;
  if (analysed.length >= thresholds.momentumMinimumBuckets) {
    const third = Math.max(1, Math.floor(analysed.length / 3));
    const first = analysed.slice(0, third).reduce((sum, point) => sum + point.value, 0) / third;
    const last = analysed.slice(-third).reduce((sum, point) => sum + point.value, 0) / third;
    if (first > 0) momentum = { first: round(first, 1), last: round(last, 1), changePercent: round(((last - first) / first) * 100, 1) };
  }
  const spikes: ReportTrendInsight['spikes'] = [];
  if (points.length >= thresholds.anomalyMinimumBuckets) {
    const deviation = Math.sqrt(points.reduce((sum, point) => sum + (point.value - mean) ** 2, 0) / points.length);
    if (deviation > 0) {
      points.forEach((point, index) => {
        if (point.value >= mean + thresholds.anomalySigma * deviation && point.value >= thresholds.anomalyMinimumValue) {
          spikes.push({ index, bucket: point.bucket, value: point.value });
        }
      });
    }
  }
  return {
    metric: input.metric,
    granularity: input.granularity,
    points,
    previousPoints: input.previousPoints,
    total,
    mean: round(mean, 2),
    peak: max > 0 ? { index: peakIndex, bucket: points[peakIndex].bucket, value: max } : null,
    zeroBuckets: points.filter((point) => point.value === 0).length,
    previousAverage: previousAverage === null ? null : round(previousAverage, 2),
    momentum,
    spikes,
    partialLastBucket: input.partialLastBucket,
  };
}

function buildCourses(snapshot: StoredReportChatSnapshot, totalEnrollments: number, totalIncomplete: number): ReportCourseInsights {
  const thresholds = REPORT_INSIGHT_THRESHOLDS;
  const watchRule = REPORT_SIGNAL_THRESHOLDS.high_enrollment_low_completion;
  const source = snapshot.version === 2
    ? snapshot.course_portfolio.map((course) => ({ ...course, not_started: course.not_started_enrollments, in_progress: course.in_progress_enrollments }))
    : snapshot.completion_ranking.map((course) => ({ ...course, not_started: null, in_progress: null }));
  const rows: ReportCourseInsight[] = [...source]
    .sort((left, right) => right.total_enrollments - left.total_enrollments || left.completion_rate - right.completion_rate || left.name.localeCompare(right.name))
    .map((course, index) => ({
      token: `C${index + 1}`,
      courseId: course.course_id,
      name: course.name,
      enrollments: course.total_enrollments,
      completed: course.completed_enrollments,
      incomplete: course.incomplete_enrollments,
      notStarted: course.not_started,
      inProgress: course.in_progress,
      completionRate: course.completion_rate,
      enrollmentShare: share(course.total_enrollments, totalEnrollments),
      incompleteShare: share(course.incomplete_enrollments, totalIncomplete),
      rankable: course.total_enrollments >= thresholds.minimumCourseSample,
      watch: course.total_enrollments >= watchRule.minimum_enrollments && course.completion_rate <= watchRule.maximum_completion_rate,
    }));
  const covered = rows.reduce((sum, row) => sum + row.enrollments, 0);
  const coverageShare = share(covered, totalEnrollments);
  const topN = Math.min(thresholds.concentrationTopN, rows.length);
  const rankable = rows.filter((row) => row.rankable);
  const byRateDesc = [...rankable].sort((left, right) => right.completionRate - left.completionRate || right.enrollments - left.enrollments);
  const topPerformers = byRateDesc.slice(0, thresholds.maxRankedCourses);
  const topIds = new Set(topPerformers.map((row) => row.courseId));
  const lowPerformers = [...byRateDesc].reverse().filter((row) => !topIds.has(row.courseId)).slice(0, thresholds.maxRankedCourses);
  const best = byRateDesc[0];
  const worst = byRateDesc.at(-1);
  const backlogCandidates = rows.filter((row) => row.incomplete > 0);
  const largestBacklog = backlogCandidates.length
    ? backlogCandidates.reduce((max, row) => (row.incomplete > max.incomplete ? row : max))
    : null;
  return {
    rows,
    coverageShare,
    truncated: coverageShare !== null && coverageShare < 99.5,
    topN,
    topShare: topN > 0 ? share(rows.slice(0, topN).reduce((sum, row) => sum + row.enrollments, 0), totalEnrollments) : null,
    top1Share: rows.length ? share(rows[0].enrollments, totalEnrollments) : null,
    topPerformers,
    lowPerformers,
    watchlist: rows.filter((row) => row.watch),
    spread: best && worst && best.courseId !== worst.courseId ? { best, worst, pp: round(best.completionRate - worst.completionRate, 2) } : null,
    largestBacklog,
  };
}

function buildStatusMix(snapshot: StoredReportChatSnapshot): ReportStatusMix | null {
  if (snapshot.version !== 2) return null;
  const { completed, in_progress: inProgress, not_started: notStarted } = snapshot.completion_status_distribution;
  const total = completed + inProgress + notStarted;
  if (total <= 0) return null;
  return {
    completed, inProgress, notStarted, total,
    completedShare: round((completed / total) * 100, 2),
    inProgressShare: round((inProgress / total) * 100, 2),
    notStartedShare: round((notStarted / total) * 100, 2),
  };
}

function buildUnits(snapshot: StoredReportChatSnapshot, limitations: ReportInsightLimitation[]): ReportUnitInsights | null {
  const raw = (snapshot as unknown as Record<string, unknown>).unit_breakdown;
  if (raw === undefined) {
    limitations.push('unit_breakdown_missing');
    return null;
  }
  const parsed = ReportUnitBreakdownSchema.safeParse(raw);
  if (!parsed.success) {
    limitations.push('unit_breakdown_invalid');
    return null;
  }
  const rows: ReportUnitInsight[] = [...parsed.data.rows]
    .sort((left, right) => right.completion_rate - left.completion_rate || right.enrollments - left.enrollments || left.name.localeCompare(right.name))
    .map((row, index) => ({
      token: `U${index + 1}`,
      unitId: row.unit_id,
      name: row.name,
      learners: row.learners,
      activeLearners: row.active_learners,
      enrollments: row.enrollments,
      completed: row.completed_enrollments,
      completionRate: row.completion_rate,
      previousCompletionRate: row.previous_completion_rate ?? null,
      deltaPp: row.previous_completion_rate === undefined || row.previous_completion_rate === null
        ? null : round(row.completion_rate - row.previous_completion_rate, 2),
      rankable: row.enrollments >= REPORT_INSIGHT_THRESHOLDS.minimumCourseSample,
    }));
  const rankable = rows.filter((row) => row.rankable);
  const best = rankable[0] ?? null;
  const worst = rankable.length > 1 ? rankable.at(-1)! : null;
  return { level: parsed.data.level, rows, best, worst, gapPp: best && worst ? round(best.completionRate - worst.completionRate, 2) : null };
}

/** Builds every deterministic insight of a stored report snapshot. */
export function buildReportInsights(snapshot: StoredReportChatSnapshot): ReportInsights {
  const limitations: ReportInsightLimitation[] = [];
  const overview = snapshot.summary.overview;
  const isV2 = snapshot.version === 2;
  if (!isV2) limitations.push('legacy_snapshot');
  if (isV2) {
    for (const code of snapshot.availability.limitations) {
      const normalized = code.split(':')[0] as ReportInsightLimitation;
      if (['no_data_in_selected_period', 'no_accessible_scope', 'completion_decline_insufficient_sample'].includes(normalized)
        && !limitations.includes(normalized)) limitations.push(normalized);
    }
  }
  const comparison = isV2 ? { dateFrom: snapshot.comparison.date_from, dateTo: snapshot.comparison.date_to } : null;
  const granularity: ReportBucketGranularity = isV2 && snapshot.enrollment_trend_context?.granularity
    ? snapshot.enrollment_trend_context.granularity : 'unknown';
  const partialLastBucket = localYmd(snapshot.generated_at) === snapshot.filter.date_to && granularity === 'day';
  if (partialLastBucket) limitations.push('partial_last_bucket');
  const previousEnrollments = readTrendExtension(snapshot, 'previous_enrollment_trend');
  const previousActive = readTrendExtension(snapshot, 'previous_active_learner_trend');
  if (isV2 && !previousEnrollments) limitations.push('previous_trend_missing');
  const enrollments = buildTrend({
    metric: 'enrollments', points: snapshot.enrollment_trend, previousPoints: previousEnrollments, granularity,
    previousTotal: isV2 ? snapshot.previous_summary.overview.total_enrollments : null, comparison, partialLastBucket,
  });
  const activeLearners = isV2 ? buildTrend({
    metric: 'active_learners', points: snapshot.active_learner_trend, previousPoints: previousActive, granularity,
    previousTotal: null, comparison, partialLastBucket,
  }) : null;
  const courses = buildCourses(snapshot, overview.total_enrollments, overview.incomplete_enrollments);
  if (courses.truncated) limitations.push('portfolio_truncated');
  const units = isV2 ? buildUnits(snapshot, limitations) : null;
  const scopeDisplay = isV2 ? snapshot.scope_display : {};
  const scope: ReportScopeInsight = {
    tenantWide: !snapshot.scope.groupId && !snapshot.scope.subgroupId && !snapshot.scope.teamId,
    groupName: scopeDisplay.group_name ?? null,
    subgroupName: scopeDisplay.subgroup_name ?? null,
    teamName: scopeDisplay.team_name ?? null,
  };
  const available = Object.values(overview).some((value) => Number(value) > 0)
    && !(isV2 && snapshot.availability.state !== 'available');
  const base: Omit<ReportInsights, 'attention' | 'facts' | 'entities' | 'limitations'> = {
    version: REPORT_INSIGHTS_VERSION,
    available,
    comparisonBasis: isV2 ? snapshot.comparison.basis : 'none',
    period: { dateFrom: snapshot.filter.date_from, dateTo: snapshot.filter.date_to, days: countReportDays(snapshot.filter.date_from, snapshot.filter.date_to) },
    comparison,
    kpis: buildKpis(snapshot),
    trends: { enrollments, activeLearners },
    statusMix: buildStatusMix(snapshot),
    courses,
    units,
    scope,
  };
  const entities: ReportEntity[] = [
    ...courses.rows.map((row) => ({ token: row.token, type: 'course' as const, name: row.name })),
    ...(units?.rows ?? []).map((row) => ({ token: row.token, type: 'unit' as const, name: row.name })),
  ];
  const contextValues = {
    ...reportDateParts('from', base.period.dateFrom),
    ...reportDateParts('to', base.period.dateTo),
    ...(comparison ? { ...reportDateParts('previous_from', comparison.dateFrom), ...reportDateParts('previous_to', comparison.dateTo) } : {}),
    days: base.period.days,
  };
  const { facts, attention } = buildReportInsightFacts({
    ...base,
    signals: isV2 ? snapshot.signals : [],
    contextValues,
  });
  return { ...base, attention, facts, entities, limitations };
}
