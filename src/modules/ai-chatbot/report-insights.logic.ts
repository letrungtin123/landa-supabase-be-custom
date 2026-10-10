// ═══════════════════════════════════════════════════════════════
// Report insights: deterministic analysis facts computed from the immutable
// report snapshot. No I/O. Every number that may appear in the PDF narrative
// comes from a fact produced here (ids + raw numbers), so the narrative
// validator can prove that the narrative does not invent figures.
// ═══════════════════════════════════════════════════════════════
import { z } from 'zod';
import { REPORT_SIGNAL_THRESHOLDS, type StoredReportChatSnapshot } from './report-chat.service.js';
import { reportBucketCoverage } from './report-date.logic.js';
import type { ReportBucketGranularity } from './report-pdf-i18n.js';
import { buildReportInsightFacts, reportDateParts } from './report-insights-facts.logic.js';
import type { ReportGranularity } from './report-time-expression.logic.js';
import {
  REPORT_INSIGHTS_VERSION,
  REPORT_INSIGHT_THRESHOLDS,
  isReportPercentChangeMeaningful,
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
  type ReportTrendAnomaly,
  type ReportTrendInsight,
  type ReportTrendPoint,
  type ReportUnitBreakdownState,
  type ReportUnitInsight,
  type ReportUnitInsights,
} from './report-insights.types.js';

export * from './report-insights.types.js';

const UnitRowSchema = z.object({
  kind: z.enum(['unit', 'others', 'unassigned']).default('unit'),
  unit_id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(300),
  unit_count: z.number().int().positive().optional(),
  learners: z.number().int().nonnegative(),
  active_learners: z.number().int().nonnegative(),
  enrollments: z.number().int().nonnegative(),
  completed_enrollments: z.number().int().nonnegative(),
  completion_rate: z.number().min(0).max(100),
  previous_enrollments: z.number().int().nonnegative().optional(),
  previous_completion_rate: z.number().min(0).max(100).nullable().optional(),
});
/**
 * Optional snapshot extension (report-unit-breakdown.logic.ts): one row per
 * child unit of the applied scope, computed with the main report's rules,
 * then the aggregate "others" / "not in any unit" rows.
 */
export const ReportUnitBreakdownSchema = z.object({
  level: z.enum(['group', 'subgroup', 'team']),
  scope_learners: z.number().int().nonnegative().optional(),
  rows: z.array(UnitRowSchema).min(1).max(100),
});
const UNIT_BREAKDOWN_STATUSES = new Set<ReportUnitBreakdownState>(['available', 'leaf_scope', 'no_child_units', 'not_computed']);
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

/**
 * Whole-bucket equivalents of a date range: days for day buckets, days / 7
 * for ISO weeks, and for months the sum of each month's covered share.
 */
export function countReportBucketEquivalents(dateFrom: string, dateTo: string, granularity: ReportBucketGranularity): number | null {
  const days = countReportDays(dateFrom, dateTo);
  if (!days || granularity === 'unknown') return null;
  if (granularity === 'day') return days;
  if (granularity === 'week') return days / 7;
  let total = 0;
  for (let month = `${dateFrom.slice(0, 7)}-01`; month <= dateTo; month = nextMonthStart(month)) {
    total += reportBucketCoverage(month, 'month', { date_from: dateFrom, date_to: dateTo }).ratio;
  }
  return total;
}

function nextMonthStart(monthStart: string): string {
  const year = Number(monthStart.slice(0, 4));
  const month = Number(monthStart.slice(5, 7));
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

/** Share of each bucket inside the range (1 for days and whole weeks/months). */
function bucketCoverage(points: ReportTrendPoint[], granularity: ReportBucketGranularity, range: { dateFrom: string; dateTo: string } | null): number[] {
  if ((granularity !== 'week' && granularity !== 'month') || !range) return points.map(() => 1);
  return points.map((point) => (/^\d{4}-\d{2}-\d{2}$/.test(point.bucket)
    ? reportBucketCoverage(point.bucket, granularity, { date_from: range.dateFrom, date_to: range.dateTo }).ratio
    : 1));
}

function localYmd(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/**
 * Period-over-period change. A count shows its percentage change only from a
 * comparison value of percentChangeMinimumBase and up to percentChangeMaximum
 * (47 -> 421 shows "+374" and a note, not "+795.7%"); the completion rate shows
 * its change only when both periods have rateChangeMinimumEnrollments enrollments.
 */
function buildKpi(id: ReportKpiId, current: number, previous: number | null, sample: { current: number; previous: number } | null): ReportKpiInsight {
  const thresholds = REPORT_INSIGHT_THRESHOLDS;
  const unit = id === 'completion_rate' ? 'percentage' : 'count';
  const base = { id, unit, current, previous, smallBase: false, hiddenDeltaPercent: null } as const;
  if (previous === null) return { ...base, delta: null, deltaPercent: null, direction: null, tone: 'neutral' };
  if (unit === 'percentage' && sample
    && (sample.current < thresholds.rateChangeMinimumEnrollments || sample.previous < thresholds.rateChangeMinimumEnrollments)) {
    return { ...base, delta: null, deltaPercent: null, direction: null, tone: 'neutral', smallBase: true };
  }
  const delta = round(current - previous, 2);
  const rawPercent = unit === 'count' && previous > 0 ? round((delta / previous) * 100, 2) : null;
  const meaningful = rawPercent !== null && isReportPercentChangeMeaningful(previous, rawPercent);
  const deltaPercent = meaningful ? rawPercent : null;
  const smallBase = unit === 'count' && delta !== 0 && !meaningful;
  const stable = unit === 'percentage'
    ? Math.abs(delta) < thresholds.stableRateDeltaPp
    : delta === 0 || (deltaPercent !== null && Math.abs(deltaPercent) < thresholds.stableCountDeltaPercent);
  const direction = stable ? 'flat' : delta > 0 ? 'up' : 'down';
  const tone: ReportInsightTone = direction === 'flat' || KPI_POLARITY[id] === 'neutral'
    ? 'neutral'
    : direction === 'up' ? 'positive' : 'negative';
  return { ...base, delta, deltaPercent, direction, tone, smallBase, hiddenDeltaPercent: smallBase && rawPercent !== null ? rawPercent : null };
}

function buildKpis(snapshot: StoredReportChatSnapshot): ReportKpiInsight[] {
  const current = snapshot.summary.overview;
  const previous = snapshot.version === 2 ? snapshot.previous_summary.overview : null;
  const sample = previous ? { current: Number(current.total_enrollments) || 0, previous: Number(previous.total_enrollments) || 0 } : null;
  const ids: ReportKpiId[] = ['total_enrollments', 'completion_rate', 'active_learners', 'total_learners', 'completed_enrollments', 'incomplete_enrollments'];
  return ids.map((id) => buildKpi(id, Number(current[id]) || 0, previous ? Number(previous[id]) || 0 : null, sample));
}

/**
 * Conservative data-quality check: a series that ends with
 * flatTailMinimumBuckets or more identical non-zero buckets (e.g. 35, 35, 35,
 * 35), or one bucket outlierRatio times above every other one while the rest
 * of the series is active. Both look like test or re-imported data.
 */
export function detectReportTrendAnomaly(points: ReportTrendPoint[]): ReportTrendAnomaly | null {
  const thresholds = REPORT_INSIGHT_THRESHOLDS;
  if (points.length < thresholds.anomalyMinimumBuckets) return null;
  const values = points.map((point) => point.value);
  const last = values[values.length - 1];
  let run = 1;
  while (run < values.length && values[values.length - 1 - run] === last) run += 1;
  if (last >= thresholds.flatTailMinimumValue && run >= thresholds.flatTailMinimumBuckets && run < values.length) {
    return { kind: 'flat_tail', indexes: Array.from({ length: run }, (_, index) => values.length - run + index), value: last };
  }
  const max = Math.max(...values);
  const maxIndex = values.indexOf(max);
  const others = values.filter((_, index) => index !== maxIndex);
  const otherActive = others.filter((value) => value > 0).length;
  if (max >= thresholds.outlierMinimumValue && otherActive >= thresholds.outlierMinimumOtherBuckets
    && max >= thresholds.outlierRatio * Math.max(...others)) {
    return { kind: 'outlier', indexes: [maxIndex], value: max };
  }
  return null;
}

function readTrendExtension(snapshot: StoredReportChatSnapshot, key: 'previous_enrollment_trend' | 'previous_active_learner_trend'): ReportTrendPoint[] | null {
  const raw = (snapshot as unknown as Record<string, unknown>)[key];
  if (raw === undefined) return null;
  const parsed = TrendSeriesSchema.safeParse(raw);
  return parsed.success && parsed.data.length > 0 ? parsed.data : null;
}

/**
 * Trend of one series. Weeks/months cut by the period are partial: the
 * average is per whole bucket (total / covered share), and partial buckets
 * never drive momentum or spikes. A suspicious flat tail (see
 * detectReportTrendAnomaly) is left out of the average, peak, spikes and
 * momentum so it is never presented as a real trend.
 */
function buildTrend(input: {
  metric: ReportTrendInsight['metric'];
  points: Array<{ bucket: string; value: number }>;
  previousPoints: ReportTrendPoint[] | null;
  granularity: ReportBucketGranularity;
  previousTotal: number | null;
  period: { dateFrom: string; dateTo: string };
  comparison: { dateFrom: string; dateTo: string } | null;
  partialLastBucket: boolean;
}): ReportTrendInsight | null {
  const points = input.points
    .filter((point) => typeof point.bucket === 'string' && Number.isFinite(point.value) && point.value >= 0)
    .map((point) => ({ bucket: point.bucket, value: point.value }));
  if (!points.length) return null;
  const thresholds = REPORT_INSIGHT_THRESHOLDS;
  const sum = (indexes: number[], values: number[]) => indexes.reduce((total, index) => total + values[index], 0);
  const values = points.map((point) => point.value);
  const coverage = bucketCoverage(points, input.granularity, input.period);
  const partialIndexes = coverage.flatMap((ratio, index) => (ratio < 1 ? [index] : []));
  const total = values.reduce((acc, value) => acc + value, 0);
  const anomaly = detectReportTrendAnomaly(points);
  const excludedIndexes = anomaly?.kind === 'flat_tail' ? anomaly.indexes : [];
  const excluded = new Set(excludedIndexes);
  const kept = points.map((_, index) => index).filter((index) => !excluded.has(index));
  const keptCoverage = sum(kept, coverage);
  const mean = keptCoverage > 0 ? sum(kept, values) / keptCoverage : 0;
  const peakIndex = kept.reduce((best, index) => (values[index] > values[best] ? index : best), kept[0]);
  const max = values[peakIndex];

  let previousAverage: number | null = null;
  let previousTotal: number | null = null;
  const previousCoverage = input.previousPoints ? bucketCoverage(input.previousPoints, input.granularity, input.comparison) : [];
  if (input.previousPoints) {
    previousTotal = input.previousPoints.reduce((acc, point) => acc + point.value, 0);
    const covered = previousCoverage.reduce((acc, ratio) => acc + ratio, 0);
    previousAverage = covered > 0 ? previousTotal / covered : null;
  } else if (input.previousTotal !== null && input.comparison && input.granularity !== 'unknown') {
    previousTotal = input.previousTotal;
    const buckets = countReportBucketEquivalents(input.comparison.dateFrom, input.comparison.dateTo, input.granularity);
    previousAverage = buckets ? input.previousTotal / buckets : null;
  }

  // Whole, trustworthy buckets only (and not today's unfinished day).
  const partial = new Set(partialIndexes);
  const analysed = kept.filter((index) => !partial.has(index) && !(input.partialLastBucket && points.length > 1 && index === points.length - 1));
  let momentum: ReportTrendInsight['momentum'] = null;
  if (analysed.length >= thresholds.momentumMinimumBuckets) {
    const third = Math.max(1, Math.floor(analysed.length / 3));
    const firstTotal = sum(analysed.slice(0, third), values);
    const first = firstTotal / third;
    const last = sum(analysed.slice(-third), values) / third;
    if (first > 0) momentum = { first: round(first, 1), last: round(last, 1), changePercent: round(((last - first) / first) * 100, 1), firstTotal };
  }
  const spikes: ReportTrendInsight['spikes'] = [];
  if (analysed.length >= thresholds.anomalyMinimumBuckets) {
    const analysedMean = sum(analysed, values) / analysed.length;
    const deviation = Math.sqrt(analysed.reduce((acc, index) => acc + (values[index] - analysedMean) ** 2, 0) / analysed.length);
    if (deviation > 0) {
      for (const index of analysed) {
        if (values[index] >= analysedMean + thresholds.anomalySigma * deviation && values[index] >= thresholds.anomalyMinimumValue) {
          spikes.push({ index, bucket: points[index].bucket, value: values[index] });
        }
      }
    }
  }
  return {
    metric: input.metric,
    granularity: input.granularity,
    points,
    previousPoints: input.previousPoints,
    coverage: coverage.map((ratio) => round(ratio, 4)),
    partialIndexes,
    previousPartialIndexes: previousCoverage.flatMap((ratio, index) => (ratio < 1 ? [index] : [])),
    total,
    mean: round(mean, 2),
    peak: max > 0 ? { index: peakIndex, bucket: points[peakIndex].bucket, value: max } : null,
    zeroBuckets: values.filter((value) => value === 0).length,
    previousAverage: previousAverage === null ? null : round(previousAverage, 2),
    previousTotal,
    momentum,
    spikes,
    partialLastBucket: input.partialLastBucket,
    anomaly,
    excludedIndexes,
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
      notStartedShare: course.not_started === null ? null : share(course.not_started, course.total_enrollments),
      completionRate: course.completion_rate,
      enrollmentShare: share(course.total_enrollments, totalEnrollments),
      incompleteShare: share(course.incomplete_enrollments, totalIncomplete),
      rankable: course.total_enrollments >= thresholds.minimumCourseSample,
      watch: course.total_enrollments >= watchRule.minimum_enrollments && course.completion_rate <= watchRule.maximum_completion_rate,
    }));
  const covered = rows.reduce((sum, row) => sum + row.enrollments, 0);
  const coverageShare = share(covered, totalEnrollments);
  const storedTotal = (snapshot as unknown as Record<string, unknown>).course_portfolio_total;
  const totalCourses = snapshot.version === 2 && typeof storedTotal === 'number' && Number.isInteger(storedTotal) && storedTotal >= rows.length
    ? storedTotal : null;
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
  const activationRisk = rows
    .filter((row) => row.enrollments >= thresholds.minimumCourseSample && row.notStartedShare !== null
      && row.notStartedShare >= thresholds.activationNotStartedShare)
    .sort((left, right) => (right.notStarted ?? 0) - (left.notStarted ?? 0) || (right.notStartedShare ?? 0) - (left.notStartedShare ?? 0) || left.name.localeCompare(right.name));
  return {
    rows,
    coverageShare,
    truncated: totalCourses !== null ? totalCourses > rows.length : coverageShare !== null && coverageShare < 99.5,
    topN,
    topShare: topN > 0 ? share(rows.slice(0, topN).reduce((sum, row) => sum + row.enrollments, 0), totalEnrollments) : null,
    top1Share: rows.length ? share(rows[0].enrollments, totalEnrollments) : null,
    topPerformers,
    lowPerformers,
    watchlist: rows.filter((row) => row.watch),
    activationRisk,
    spread: best && worst && best.courseId !== worst.courseId ? { best, worst, pp: round(best.completionRate - worst.completionRate, 2) } : null,
    largestBacklog,
    totalCourses,
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

function unitInsight(row: z.infer<typeof UnitRowSchema>, token: string): ReportUnitInsight {
  const previousEnrollments = row.previous_enrollments ?? null;
  const previousRate = row.previous_completion_rate ?? null;
  return {
    token,
    unitId: row.unit_id,
    name: row.name,
    kind: row.kind,
    unitCount: row.kind === 'others' ? row.unit_count ?? null : null,
    learners: row.learners,
    activeLearners: row.active_learners,
    enrollments: row.enrollments,
    completed: row.completed_enrollments,
    completionRate: row.completion_rate,
    previousCompletionRate: previousRate,
    previousEnrollments,
    deltaPp: previousRate === null ? null : round(row.completion_rate - previousRate, 2),
    rankable: row.kind === 'unit' && row.enrollments >= REPORT_INSIGHT_THRESHOLDS.minimumUnitSample,
  };
}

/**
 * Units of the snapshot's breakdown. Without a breakdown the state says why:
 * a team scope has nothing below it; a snapshot older than the breakdown is a
 * limitation (only when it has data to break down).
 */
function buildUnits(snapshot: StoredReportChatSnapshot, limitations: ReportInsightLimitation[], available: boolean): { units: ReportUnitInsights | null; state: ReportUnitBreakdownState } {
  const record = snapshot as unknown as Record<string, unknown>;
  const raw = record.unit_breakdown;
  const status = typeof record.unit_breakdown_status === 'string' && UNIT_BREAKDOWN_STATUSES.has(record.unit_breakdown_status as ReportUnitBreakdownState)
    ? record.unit_breakdown_status as ReportUnitBreakdownState : null;
  if (raw === undefined) {
    if (status && status !== 'available') return { units: null, state: status };
    if (snapshot.scope.teamId) return { units: null, state: 'leaf_scope' };
    if (!available) return { units: null, state: 'not_computed' };
    limitations.push(status === 'available' ? 'unit_breakdown_invalid' : 'unit_breakdown_missing');
    return { units: null, state: status === 'available' ? 'invalid' : 'missing' };
  }
  const parsed = ReportUnitBreakdownSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.rows.some((row) => row.kind === 'unit')) {
    limitations.push('unit_breakdown_invalid');
    return { units: null, state: 'invalid' };
  }
  const thresholds = REPORT_INSIGHT_THRESHOLDS;
  const unitRows = parsed.data.rows
    .filter((row) => row.kind === 'unit')
    .sort((left, right) => right.completion_rate - left.completion_rate || right.enrollments - left.enrollments || left.name.localeCompare(right.name));
  const aggregates = (['others', 'unassigned'] as const).flatMap((kind) => parsed.data.rows.filter((row) => row.kind === kind).slice(0, 1));
  const rows = [...unitRows, ...aggregates].map((row, index) => unitInsight(row, `U${index + 1}`));
  const units = rows.filter((row) => row.kind === 'unit');
  const rankable = units.filter((row) => row.rankable);
  // With a single ranked unit the unit view adds nothing to the scope figures.
  const comparable = rankable.length >= 2;
  const best = rankable[0] ?? null;
  const worst = rankable.length > 1 ? rankable.at(-1)! : null;
  const declines = comparable
    ? rankable.filter((row) => row.deltaPp !== null
      && (row.previousEnrollments ?? 0) >= thresholds.minimumUnitSample
      && row.deltaPp <= -thresholds.unitDeclinePp)
    : [];
  const decline = declines.reduce<ReportUnitInsight | null>((largest, row) => (
    !largest || row.deltaPp! < largest.deltaPp! || (row.deltaPp === largest.deltaPp && row.enrollments > largest.enrollments) ? row : largest
  ), null);
  const lowCompletion = comparable
    ? rankable.filter((row) => row.completionRate <= thresholds.unitLowCompletionRate)
      .sort((left, right) => left.completionRate - right.completionRate || right.enrollments - left.enrollments)
    : [];
  const others = rows.find((row) => row.kind === 'others');
  const scopeLearners = parsed.data.scope_learners ?? null;
  return {
    state: 'available',
    units: {
      level: parsed.data.level,
      rows,
      best,
      worst,
      gapPp: best && worst ? round(best.completionRate - worst.completionRate, 2) : null,
      decline,
      lowCompletion,
      unitCount: units.length + (others?.unitCount ?? 0),
      scopeLearners,
      overlapping: scopeLearners !== null && rows.reduce((sum, row) => sum + row.learners, 0) > scopeLearners,
      truncated: Boolean(others),
    },
  };
}

const REQUESTED_GRANULARITIES = new Set<ReportGranularity>(['day', 'week', 'month', 'quarter']);

/** The breakdown the user asked for, when the snapshot charts had to use another one. */
function readRequestedGranularity(snapshot: StoredReportChatSnapshot, granularity: ReportBucketGranularity): ReportGranularity | null {
  if (snapshot.version !== 2) return null;
  const requested = (snapshot.enrollment_trend_context as Record<string, unknown> | undefined)?.requested_granularity;
  return typeof requested === 'string' && REQUESTED_GRANULARITIES.has(requested as ReportGranularity) && requested !== granularity
    ? requested as ReportGranularity : null;
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
  const available = Object.values(overview).some((value) => Number(value) > 0)
    && !(isV2 && snapshot.availability.state !== 'available');
  const previousEnrollments = readTrendExtension(snapshot, 'previous_enrollment_trend');
  const previousActive = readTrendExtension(snapshot, 'previous_active_learner_trend');
  if (isV2 && available && snapshot.enrollment_trend.length > 0 && !previousEnrollments) limitations.push('previous_trend_missing');
  const period = { dateFrom: snapshot.filter.date_from, dateTo: snapshot.filter.date_to };
  const enrollments = buildTrend({
    metric: 'enrollments', points: snapshot.enrollment_trend, previousPoints: previousEnrollments, granularity,
    previousTotal: isV2 ? snapshot.previous_summary.overview.total_enrollments : null, period, comparison, partialLastBucket,
  });
  const activeLearners = isV2 ? buildTrend({
    metric: 'active_learners', points: snapshot.active_learner_trend, previousPoints: previousActive, granularity,
    previousTotal: null, period, comparison, partialLastBucket,
  }) : null;
  if (enrollments?.anomaly || activeLearners?.anomaly) limitations.push('data_anomaly');
  const courses = buildCourses(snapshot, overview.total_enrollments, overview.incomplete_enrollments);
  if (courses.truncated) limitations.push('portfolio_truncated');
  const unitBreakdown = buildUnits(snapshot, limitations, available);
  const units = unitBreakdown.units;
  if (available && unitBreakdown.state === 'no_child_units') limitations.push('no_child_units');
  const scopeDisplay = isV2 ? snapshot.scope_display : {};
  const scope: ReportScopeInsight = {
    tenantWide: !snapshot.scope.groupId && !snapshot.scope.subgroupId && !snapshot.scope.teamId,
    groupName: scopeDisplay.group_name ?? null,
    subgroupName: scopeDisplay.subgroup_name ?? null,
    teamName: scopeDisplay.team_name ?? null,
  };
  const base: Omit<ReportInsights, 'attention' | 'facts' | 'entities' | 'limitations'> = {
    version: REPORT_INSIGHTS_VERSION,
    available,
    comparisonBasis: isV2 ? snapshot.comparison.basis : 'none',
    period: { dateFrom: snapshot.filter.date_from, dateTo: snapshot.filter.date_to, days: countReportDays(snapshot.filter.date_from, snapshot.filter.date_to) },
    comparison,
    kpis: buildKpis(snapshot),
    trends: { enrollments, activeLearners },
    requestedGranularity: readRequestedGranularity(snapshot, granularity),
    hiddenPercentChanges: [],
    statusMix: buildStatusMix(snapshot),
    courses,
    units,
    unitBreakdownState: unitBreakdown.state,
    scope,
  };
  const entities: ReportEntity[] = [
    ...courses.rows.map((row) => ({ token: row.token, type: 'course' as const, name: row.name })),
    // Aggregate rows are never cited by a fact, so their tokens are not entities.
    ...(units?.rows ?? []).filter((row) => row.kind === 'unit').map((row) => ({ token: row.token, type: 'unit' as const, name: row.name })),
  ];
  const contextValues = {
    ...reportDateParts('from', base.period.dateFrom),
    ...reportDateParts('to', base.period.dateTo),
    ...(comparison ? { ...reportDateParts('previous_from', comparison.dateFrom), ...reportDateParts('previous_to', comparison.dateTo) } : {}),
    days: base.period.days,
  };
  const { facts, attention, hiddenPercentChanges } = buildReportInsightFacts({
    ...base,
    signals: isV2 ? snapshot.signals : [],
    contextValues,
  });
  return { ...base, hiddenPercentChanges, attention, facts, entities, limitations };
}
