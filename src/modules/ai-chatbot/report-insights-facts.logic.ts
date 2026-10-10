// Converts deterministic insights into narrative facts (ids + raw numbers) and
// attention items. No I/O. Entity names never appear in facts: courses/units
// are referenced by tokens (C1, U1) that are substituted only when rendering.
import { REPORT_SIGNAL_THRESHOLDS, type ReportAnalyticsSignal } from './report-chat.service.js';
import { reportBucketEnd } from './report-date.logic.js';
import {
  REPORT_INSIGHT_THRESHOLDS as T,
  isReportPercentChangeMeaningful,
  type ReportAttentionItem,
  type ReportAttentionKind,
  type ReportInsightFact,
  type ReportInsights,
  type ReportKpiId,
  type ReportKpiInsight,
  type ReportTrendInsight,
} from './report-insights.types.js';

type FactsInput = Omit<ReportInsights, 'attention' | 'facts' | 'entities' | 'limitations' | 'hiddenPercentChanges'> & {
  signals: ReportAnalyticsSignal[];
  contextValues: Record<string, number>;
};

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const KPI_PRIORITY: Record<ReportKpiId, number> = {
  completion_rate: 85,
  total_enrollments: 80,
  active_learners: 70,
  total_learners: 40,
  completed_enrollments: 30,
  incomplete_enrollments: 25,
};
const ATTENTION_SEVERITY: Record<ReportAttentionKind, ReportAttentionItem['severity']> = {
  completion_decline: 'warning',
  course_watchlist: 'warning',
  activity_drop: 'attention',
  activation_risk: 'attention',
  backlog_concentration: 'attention',
  enrollment_drop: 'attention',
  active_learner_drop: 'attention',
  unit_gap: 'attention',
  unit_decline: 'warning',
  unit_low_completion: 'attention',
  course_activation_risk: 'attention',
};

/** Splits YYYY-MM[-DD] into numeric fact values, e.g. peak_day/peak_month/peak_year. */
export function reportDateParts(prefix: string, ymd: string): Record<string, number> {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(ymd);
  if (!match) return {};
  return {
    [`${prefix}_year`]: Number(match[1]),
    [`${prefix}_month`]: Number(match[2]),
    ...(match[3] ? { [`${prefix}_day`]: Number(match[3]) } : {}),
  };
}

/**
 * Date values of a chart bucket as written in a sentence: the day for day
 * buckets, year and month only for months ("tháng 04/2026", never
 * "01/04/2026"), and for an ISO week its first and last day inside the period
 * (`<prefix>_*` and `<prefix>_end_*`).
 */
export function reportBucketDateParts(
  prefix: string,
  bucket: string,
  granularity: ReportTrendInsight['granularity'],
  period: { dateFrom: string; dateTo: string },
): Record<string, number> {
  if (granularity === 'month') return reportDateParts(prefix, bucket.slice(0, 7));
  if (granularity !== 'week' || !/^\d{4}-\d{2}-\d{2}$/.test(bucket)) return reportDateParts(prefix, bucket);
  const end = reportBucketEnd(bucket, 'week');
  const first = bucket > period.dateFrom ? bucket : period.dateFrom;
  const last = end < period.dateTo ? end : period.dateTo;
  return { ...reportDateParts(prefix, first), ...reportDateParts(`${prefix}_end`, last) };
}

/** A relative change kept as a fact value only when its base makes it meaningful; otherwise recorded as hidden. */
function percentValue(base: number, percent: number, hidden: number[]): number | null {
  if (isReportPercentChangeMeaningful(base, percent)) return Math.abs(percent);
  hidden.push(Math.abs(percent));
  return null;
}

function fact(input: Omit<ReportInsightFact, 'entities' | 'values'> & { values: Record<string, number | null | undefined>; entities?: string[] }): ReportInsightFact {
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(input.values)) {
    if (typeof value === 'number' && Number.isFinite(value)) values[key] = round(value, 2);
  }
  return { ...input, values, entities: input.entities ?? [] };
}

function kpiFacts(kpis: ReportKpiInsight[]): ReportInsightFact[] {
  return kpis.map((kpi) => fact({
    id: `kpi.${kpi.id}`,
    kind: 'kpi',
    tone: kpi.tone,
    priority: KPI_PRIORITY[kpi.id] + (kpi.deltaPercent !== null ? Math.min(10, Math.abs(kpi.deltaPercent) / 5) : 0),
    values: {
      current: kpi.current,
      previous: kpi.previous,
      delta: kpi.delta === null ? null : Math.abs(kpi.delta),
      delta_percent: kpi.deltaPercent === null ? null : Math.abs(kpi.deltaPercent),
    },
  }));
}

function trendFacts(trend: ReportTrendInsight | null, period: FactsInput['period'], hidden: number[]): ReportInsightFact[] {
  if (!trend) return [];
  const facts: ReportInsightFact[] = [];
  const momentumPct = () => (trend.momentum ? percentValue(trend.momentum.firstTotal, trend.momentum.changePercent, hidden) : null);
  if (trend.metric === 'enrollments') {
    if (trend.peak && trend.points.length >= 3 && trend.mean > 0) {
      facts.push(fact({
        id: 'trend.enrollments.peak', kind: 'trend_peak', tone: 'neutral', priority: 45 + (trend.spikes.length ? 8 : 0),
        values: { value: trend.peak.value, ratio: round(trend.peak.value / trend.mean, 1), ...reportBucketDateParts('peak', trend.peak.bucket, trend.granularity, period) },
      }));
    }
    if (trend.previousAverage !== null && trend.previousAverage > 0 && trend.mean >= 0) {
      const change = round(((trend.mean - trend.previousAverage) / trend.previousAverage) * 100, 1);
      if (Math.abs(change) >= T.stableCountDeltaPercent) {
        // 47 enrollments last period and 421 now: "+765%" says nothing; the averages are kept.
        facts.push(fact({
          id: 'trend.enrollments.vs_previous', kind: 'trend_vs_previous', tone: change > 0 ? 'positive' : 'negative', priority: 58,
          values: { avg: round(trend.mean, 1), previous: round(trend.previousAverage, 1), pct: percentValue(trend.previousTotal ?? 0, change, hidden), direction: change > 0 ? 1 : -1 },
        }));
      }
    }
    if (trend.momentum && Math.abs(trend.momentum.changePercent) >= T.momentumChangePercent) {
      facts.push(fact({
        id: 'trend.enrollments.momentum', kind: 'trend_momentum', tone: trend.momentum.changePercent > 0 ? 'positive' : 'attention', priority: 52,
        values: { first: trend.momentum.first, last: trend.momentum.last, pct: momentumPct(), direction: trend.momentum.changePercent > 0 ? 1 : -1 },
      }));
    }
    // A single spike is the peak already reported above.
    if (trend.spikes.length >= 2) {
      const largest = trend.spikes.reduce((max, spike) => (spike.value > max.value ? spike : max));
      facts.push(fact({
        id: 'trend.enrollments.spikes', kind: 'trend_spikes', tone: 'neutral', priority: 44,
        values: { count: trend.spikes.length, value: largest.value, ...reportBucketDateParts('spike', largest.bucket, trend.granularity, period) },
      }));
    }
  } else if (trend.momentum && Math.abs(trend.momentum.changePercent) >= T.momentumChangePercent) {
    facts.push(fact({
      id: 'trend.active.momentum', kind: 'active_trend_momentum', tone: trend.momentum.changePercent > 0 ? 'positive' : 'attention', priority: 45,
      values: { first: trend.momentum.first, last: trend.momentum.last, pct: momentumPct(), direction: trend.momentum.changePercent > 0 ? 1 : -1 },
    }));
  }
  return facts;
}

/** Data-quality facts (never risks): a suspicious flat tail or outlier bucket in a series. */
function anomalyFacts(input: FactsInput): ReportInsightFact[] {
  return ([['enrollments', input.trends.enrollments], ['active_learners', input.trends.activeLearners]] as const).flatMap(([metric, trend]) => {
    if (!trend?.anomaly) return [];
    const first = trend.points[trend.anomaly.indexes[0]];
    return [fact({
      id: `data.anomaly.${metric}`, kind: 'data_anomaly', tone: 'attention', priority: 20,
      values: {
        count: trend.anomaly.indexes.length, value: trend.anomaly.value,
        ...reportBucketDateParts('start', first.bucket, trend.granularity, input.period),
      },
    })];
  });
}

function courseFacts(input: FactsInput): ReportInsightFact[] {
  const { courses, statusMix } = input;
  const facts: ReportInsightFact[] = [];
  if (statusMix) {
    facts.push(fact({
      id: 'status.mix', kind: 'status_mix', tone: 'neutral', priority: 65,
      values: {
        total: statusMix.total, completed: statusMix.completed, in_progress: statusMix.inProgress, not_started: statusMix.notStarted,
        completed_share: statusMix.completedShare, in_progress_share: statusMix.inProgressShare, not_started_share: statusMix.notStartedShare,
      },
    }));
  }
  if (courses.rows.length >= 2 && courses.topShare !== null && courses.top1Share !== null) {
    const concentrated = courses.topShare >= T.concentrationShare && courses.rows.length > courses.topN;
    facts.push(fact({
      id: 'courses.concentration', kind: 'concentration', tone: concentrated ? 'attention' : 'neutral', priority: concentrated ? 62 : 50,
      values: { n: courses.topN, share: courses.topShare, top_share: courses.top1Share, threshold: T.concentrationShare },
      entities: [courses.rows[0].token],
    }));
  }
  const rankableCount = courses.rows.filter((row) => row.rankable).length;
  const top = courses.topPerformers[0];
  if (top && rankableCount >= 2) {
    facts.push(fact({
      id: 'courses.top', kind: 'top_performer', tone: 'positive', priority: 50,
      values: { rate: top.completionRate, enrollments: top.enrollments, completed: top.completed }, entities: [top.token],
    }));
  }
  const low = courses.lowPerformers[0];
  if (low && rankableCount >= 2) {
    facts.push(fact({
      id: 'courses.low', kind: 'low_performer', tone: low.completionRate <= 50 ? 'negative' : 'neutral', priority: 48,
      values: { rate: low.completionRate, enrollments: low.enrollments, completed: low.completed }, entities: [low.token],
    }));
  }
  if (courses.spread && courses.spread.pp >= T.unitGapPp) {
    facts.push(fact({
      id: 'courses.spread', kind: 'spread', tone: 'neutral', priority: 35,
      values: { spread: courses.spread.pp, best: courses.spread.best.completionRate, worst: courses.spread.worst.completionRate },
      entities: [courses.spread.best.token, courses.spread.worst.token],
    }));
  }
  return facts;
}

function attentionFacts(input: FactsInput): ReportInsightFact[] {
  const facts: ReportInsightFact[] = [];
  const kpi = (id: ReportKpiId) => input.kpis.find((item) => item.id === id)!;
  const signal = (id: string) => input.signals.find((item) => item.id === id);
  const completion = kpi('completion_rate');
  if (signal('completion_decline') && completion.previous !== null && completion.delta !== null) {
    facts.push(fact({
      id: 'signal.completion_decline', kind: 'completion_decline', tone: 'negative', priority: 95,
      values: { current: completion.current, previous: completion.previous, delta: Math.abs(completion.delta), threshold: Math.abs(REPORT_SIGNAL_THRESHOLDS.completion_decline.decline_percentage_points) },
    }));
  }
  const watch = input.courses.watchlist[0];
  if (watch) {
    const rule = REPORT_SIGNAL_THRESHOLDS.high_enrollment_low_completion;
    facts.push(fact({
      id: 'risk.watchlist', kind: 'course_watchlist', tone: 'negative', priority: 90,
      values: { count: input.courses.watchlist.length, min: rule.minimum_enrollments, max: rule.maximum_completion_rate, rate: watch.completionRate, enrollments: watch.enrollments },
      entities: input.courses.watchlist.map((row) => row.token),
    }));
  }
  const status = input.statusMix;
  if (status && status.total >= T.activationMinimumEnrollments && status.notStartedShare >= T.activationNotStartedShare) {
    facts.push(fact({
      id: 'risk.activation', kind: 'activation_risk', tone: 'attention', priority: 75,
      values: { share: status.notStartedShare, count: status.notStarted, threshold: T.activationNotStartedShare },
    }));
  }
  // Same rule per course (from minimumCourseSample enrollments): a course where many learners never started.
  const activation = input.courses.activationRisk[0];
  if (activation && activation.notStarted !== null && activation.notStartedShare !== null) {
    facts.push(fact({
      id: 'risk.course_activation', kind: 'course_activation_risk', tone: 'attention', priority: 78,
      values: {
        count: input.courses.activationRisk.length, not_started: activation.notStarted, enrollments: activation.enrollments,
        share: activation.notStartedShare, threshold: T.activationNotStartedShare, min: T.minimumCourseSample,
      },
      entities: input.courses.activationRisk.map((row) => row.token),
    }));
  }
  const activityDrop = signal('end_period_activity_drop');
  if (activityDrop && activityDrop.evidence.current !== undefined && activityDrop.evidence.previous !== undefined) {
    facts.push(fact({
      id: 'signal.activity_drop', kind: 'activity_drop', tone: 'attention', priority: 70,
      values: { recent: activityDrop.evidence.current, preceding: activityDrop.evidence.previous },
    }));
  }
  for (const [id, kind, priority] of [['total_enrollments', 'enrollment_drop', 65], ['active_learners', 'active_learner_drop', 60]] as const) {
    const item = kpi(id);
    if (item.direction === 'down' && item.delta !== null) {
      facts.push(fact({
        id: kind === 'enrollment_drop' ? 'risk.enrollment_drop' : 'risk.active_drop', kind, tone: 'negative', priority,
        values: { delta: Math.abs(item.delta), pct: item.deltaPercent === null ? null : Math.abs(item.deltaPercent), current: item.current, previous: item.previous },
      }));
    }
  }
  const backlog = input.courses.largestBacklog;
  const totalIncomplete = input.kpis.find((item) => item.id === 'incomplete_enrollments')?.current ?? 0;
  if (backlog && backlog.incompleteShare !== null && input.courses.rows.length >= T.backlogMinimumCourses
    && totalIncomplete >= T.backlogMinimumIncomplete && backlog.incompleteShare >= T.backlogCourseShare) {
    facts.push(fact({
      id: 'risk.backlog', kind: 'backlog_concentration', tone: 'attention', priority: 55,
      values: { share: backlog.incompleteShare, count: backlog.incomplete }, entities: [backlog.token],
    }));
  }
  const units = input.units;
  if (units?.best && units.worst && units.gapPp !== null && units.gapPp >= T.unitGapPp) {
    facts.push(fact({
      id: 'risk.unit_gap', kind: 'unit_gap', tone: 'attention', priority: 50,
      values: { gap: units.gapPp, best_rate: units.best.completionRate, worst_rate: units.worst.completionRate },
      entities: [units.worst.token, units.best.token],
    }));
  }
  const decline = units?.decline;
  if (decline && decline.previousCompletionRate !== null && decline.deltaPp !== null) {
    facts.push(fact({
      id: 'risk.unit_decline', kind: 'unit_decline', tone: 'negative', priority: 72,
      values: {
        current: decline.completionRate, previous: decline.previousCompletionRate, delta: Math.abs(decline.deltaPp),
        threshold: T.unitDeclinePp, enrollments: decline.enrollments,
      },
      entities: [decline.token],
    }));
  }
  const low = units?.lowCompletion ?? [];
  if (low.length) {
    facts.push(fact({
      id: 'risk.unit_low_completion', kind: 'unit_low_completion', tone: 'negative', priority: 66,
      values: { count: low.length, min: T.minimumUnitSample, max: T.unitLowCompletionRate, rate: low[0].completionRate, enrollments: low[0].enrollments },
      entities: low.map((row) => row.token),
    }));
  }
  return facts;
}

function unitFacts(input: FactsInput): ReportInsightFact[] {
  const units = input.units;
  if (!units?.best || !units.worst || units.gapPp === null) return [];
  return [fact({
    id: 'units.ranking', kind: 'unit_ranking', tone: 'neutral', priority: 60,
    values: { best_rate: units.best.completionRate, worst_rate: units.worst.completionRate, gap: units.gapPp, count: units.unitCount },
    entities: [units.best.token, units.worst.token],
  })];
}

export function buildReportInsightFacts(input: FactsInput): { facts: ReportInsightFact[]; attention: ReportAttentionItem[]; hiddenPercentChanges: number[] } {
  const context = fact({ id: 'context.period', kind: 'context', tone: 'neutral', priority: 0, values: input.contextValues });
  const hidden = input.kpis.flatMap((kpi) => (kpi.hiddenDeltaPercent === null ? [] : [Math.abs(kpi.hiddenDeltaPercent)]));
  if (!input.available) {
    const empty = kpiFacts(input.kpis).filter((item) => item.id === 'kpi.total_enrollments' || item.id === 'kpi.active_learners');
    return { facts: [context, ...empty], attention: [], hiddenPercentChanges: hidden };
  }
  const risks = attentionFacts(input).sort((left, right) => right.priority - left.priority);
  const facts = [
    context,
    ...kpiFacts(input.kpis),
    ...courseFacts(input),
    ...trendFacts(input.trends.enrollments, input.period, hidden),
    ...trendFacts(input.trends.activeLearners, input.period, hidden),
    ...unitFacts(input),
    ...anomalyFacts(input),
    ...risks,
  ];
  const attention = risks.map((item) => ({
    kind: item.kind as ReportAttentionKind,
    severity: ATTENTION_SEVERITY[item.kind as ReportAttentionKind],
    factId: item.id,
  }));
  return { facts, attention, hiddenPercentChanges: [...new Set(hidden.map((value) => round(value, 2)))] };
}
