// ═══════════════════════════════════════════════════════════════
// Report PDF view model: turns snapshot + insights + narrative into formatted,
// locale-specific display data and a deterministic page plan. No I/O, no HTML.
// ═══════════════════════════════════════════════════════════════
import type { StoredReportChatSnapshot } from './report-chat.service.js';
import {
  formatReportBucketLabel,
  formatReportBucketTick,
  formatReportDateTime,
  formatReportNumber,
  formatReportPercent,
  formatReportPercentagePoints,
  formatReportPeriod,
  formatReportSignedNumber,
  getReportPdfDictionary,
  getReportPdfDictionaryFor,
  type ReportBucketGranularity,
  type ReportPdfDictionary,
  type ReportPdfLocale,
} from './report-pdf-i18n.js';
import {
  REPORT_INSIGHT_THRESHOLDS,
  type ReportInsights,
  type ReportInsightTone,
  type ReportKpiId,
  type ReportTrendInsight,
} from './report-insights.logic.js';
import { planReportPdfPages, reportPdfSectionNumbers } from './report-pdf-layout.logic.js';
import { describeReportFact, type ReportPdfNarrative, type ReportPdfNarrativeItem } from './report-pdf-narrative.logic.js';
import { REPORT_SIGNAL_THRESHOLDS } from './report-chat.service.js';
import { REPORT_SNAPSHOT_BUCKET_RULE } from './report-time-expression.logic.js';

/** Bump when the layout or wording changes: stored PDFs are keyed by this version (and by the tenant's labels). */
export const REPORT_PDF_TEMPLATE_VERSION = '3.3.0';

/** The course table lists at most this many courses; the rest are in the Excel export. */
export const REPORT_PDF_MAX_COURSE_ROWS = 20;

export interface ReportPdfTenantBranding { name: string; logoDataUri: string | null }

const BRAND_LINE_MAX_CHARS = 80;

/**
 * Brand line of the cover footer: the tenant's display name (the one shown at
 * the top of the cover), shortened with an ellipsis past 80 characters; the
 * localized report title when the tenant has no name. Escaped when rendered.
 */
export function buildReportPdfBrandLine(tenantName: string | null | undefined, dict: ReportPdfDictionary): string {
  const name = (tenantName ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return dict.meta.title;
  const characters = Array.from(name);
  return characters.length > BRAND_LINE_MAX_CHARS ? `${characters.slice(0, BRAND_LINE_MAX_CHARS - 1).join('').trimEnd()}…` : name;
}

export interface ReportPdfKpiCard {
  id: ReportKpiId;
  label: string;
  value: string;
  deltaLabel: string | null;
  direction: 'up' | 'down' | 'flat' | null;
  tone: ReportInsightTone;
  previousLabel: string;
  spark: number[] | null;
  /** How the Completion rate is computed (completion card only). */
  hint: string | null;
  /** Why no percentage / no change is shown (small comparison period). */
  deltaNote: string | null;
}

export interface ReportPdfTrendChart {
  title: string;
  kind: 'area' | 'bars';
  granularity: ReportBucketGranularity;
  values: number[];
  labels: string[];
  /** Comparison series by bucket index; null where its week/month is cut by the comparison period. */
  previousValues: Array<number | null> | null;
  previousAverage: number | null;
  average: number;
  peakIndex: number | null;
  peakLabel: string | null;
  /** Weeks/months cut by the period (drawn lighter). */
  partialIndexes: number[];
  /** Buckets flagged by the data check (drawn in orange). */
  flaggedIndexes: number[];
  legend: Array<{ key: 'current' | 'previous' | 'previousAverage' | 'average' | 'partial' | 'flagged'; label: string }>;
  stats: Array<{ label: string; value: string; detail: string | null }>;
  notes: string[];
}

export interface ReportPdfCourseRow {
  rank: number;
  name: string;
  enrollments: string;
  completed: string;
  inProgress: string;
  notStarted: string;
  rate: number;
  rateLabel: string;
  share: string;
  watch: boolean;
}

export interface ReportPdfStatusSegment { key: 'completed' | 'in_progress' | 'not_started'; label: string; count: number; countLabel: string; shareLabel: string; ratio: number }
export interface ReportPdfRankedCourse { name: string; rate: number; rateLabel: string; detail: string }
export interface ReportPdfConcentrationBar { name: string; ratio: number; shareLabel: string; valueLabel: string }
export interface ReportPdfUnitRow {
  name: string; learners: string; active: string; enrollments: string; rate: number; rateLabel: string;
  deltaLabel: string; deltaTone: ReportInsightTone; heat: number;
  /** "Other units" / "not in any unit" rows: shown after the units, never ranked. */
  aggregate: boolean;
}
export interface ReportPdfAttentionCard { severity: 'warning' | 'attention'; severityLabel: string; title: string; text: string }
export interface ReportPdfRecommendation { text: string; priority: 'high' | 'medium' | 'low'; priorityLabel: string; fromChat: boolean }

export type ReportPdfSectionId = 'summary' | 'kpis' | 'trends' | 'trendObservations' | 'courses' | 'portfolio' | 'organization' | 'attention'
  | 'recommendations' | 'appendixDefinitions' | 'appendixData' | 'appendixMethods';
/** A section on a page; row-splittable sections (portfolio, organization) carry a row range. */
export interface ReportPdfSectionSlice { id: ReportPdfSectionId; from?: number; to?: number }
export interface ReportPdfWatchRow { name: string; enrollments: string; notStarted: string; rate: number; rateLabel: string }

export interface ReportPdfViewModel {
  locale: ReportPdfLocale;
  /** False when the snapshot has no data: trend/course sections are omitted. */
  available: boolean;
  dict: ReportPdfDictionary;
  templateVersion: string;
  title: string;
  tenant: ReportPdfTenantBranding;
  /** Cover footer brand: tenant display name, or the report title without one. */
  brandLine: string;
  periodLabel: string;
  comparisonLabel: string | null;
  comparisonTitle: string;
  scopeLabel: string;
  scopePath: Array<{ level: string; name: string }>;
  generatedAtLabel: string;
  reference: string;
  entities: Record<string, string>;
  narrative: ReportPdfNarrative;
  kpis: ReportPdfKpiCard[];
  coverKpis: ReportPdfKpiCard[];
  scorecardNote: string;
  trends: { enrollments: ReportPdfTrendChart | null; active: ReportPdfTrendChart | null; observations: ReportPdfNarrativeItem[] };
  courses: {
    status: ReportPdfStatusSegment[] | null;
    statusTotal: string | null;
    statusNote: string;
    concentration: ReportPdfConcentrationBar[];
    concentrationNote: string | null;
    backlog: ReportPdfConcentrationBar[];
    backlogNote: string | null;
    top: ReportPdfRankedCourse[];
    low: ReportPdfRankedCourse[];
    minSampleNote: string;
    rows: ReportPdfCourseRow[];
    portfolioLead: string;
    portfolioLegend: string;
    coverageNote: string | null;
    /** "Còn N khóa học khác — xem đầy đủ trong file Excel" when the table is capped. */
    moreCoursesNote: string | null;
    legacy: boolean;
  };
  organization: {
    level: string | null;
    rows: ReportPdfUnitRow[];
    unitCountLabel: string | null;
    /** Notes under the unit table (legend, definitions, overlap, others row). */
    footnotes: string[];
  };
  attention: ReportPdfAttentionCard[];
  watchlist: { lead: string; rows: ReportPdfWatchRow[] };
  recommendations: ReportPdfRecommendation[];
  appendix: {
    definitions: Array<{ label: string; text: string }>;
    scopeRows: Array<{ label: string; value: string }>;
    methodology: string[];
    limitations: string[];
    /** Limitations then methodology as printable rows (headings and bullets) that may continue on the next page. */
    methodRows: Array<{ kind: 'title' | 'item'; text: string }>;
  };
  /** Section numbers of the present sections ("01"…, "A", "B"); an omitted section shifts the next ones. */
  sectionNumbers: Partial<Record<ReportPdfSectionId, string>>;
  pages: ReportPdfSectionSlice[][];
}

/** The trend page keeps its observations short so they fit under the charts. */
const MAX_TREND_OBSERVATIONS = 3;
const TREND_OBSERVATION_IDS = new Set(['trend.enrollments.peak', 'trend.enrollments.momentum', 'trend.enrollments.vs_previous', 'trend.enrollments.spikes', 'trend.active.momentum']);

function scopePath(insights: ReportInsights, dict: ReportPdfDictionary): Array<{ level: string; name: string }> {
  const { scope } = insights;
  return [
    scope.groupName ? { level: dict.scope.group, name: scope.groupName } : null,
    scope.subgroupName ? { level: dict.scope.subgroup, name: scope.subgroupName } : null,
    scope.teamName ? { level: dict.scope.team, name: scope.teamName } : null,
  ].filter((item): item is { level: string; name: string } => item !== null);
}

function kpiCards(insights: ReportInsights, locale: ReportPdfLocale, dict: ReportPdfDictionary): ReportPdfKpiCard[] {
  return insights.kpis.map((kpi) => {
    const isRate = kpi.unit === 'percentage';
    const value = isRate ? formatReportPercent(kpi.current, locale) : formatReportNumber(kpi.current, locale);
    let deltaLabel: string | null = null;
    if (kpi.delta !== null) {
      // A percentage from a tiny comparison period ("+6.100%") is never shown: the absolute change stays.
      deltaLabel = isRate
        ? `${formatReportSignedNumber(kpi.delta, locale, 1)} ${dict.units.pp}`
        : `${formatReportSignedNumber(kpi.delta, locale)}${kpi.deltaPercent !== null ? ` · ${formatReportSignedNumber(kpi.deltaPercent, locale, 1)}%` : ''}`;
    }
    const deltaNote = kpi.smallBase ? (isRate ? dict.kpi.smallBaseRate : dict.kpi.smallBaseCount) : null;
    const previous = kpi.previous === null ? null : isRate ? formatReportPercent(kpi.previous, locale) : formatReportNumber(kpi.previous, locale);
    const spark = kpi.id === 'total_enrollments'
      ? insights.trends.enrollments?.points.map((point) => point.value) ?? null
      : kpi.id === 'active_learners' ? insights.trends.activeLearners?.points.map((point) => point.value) ?? null : null;
    return {
      id: kpi.id,
      label: dict.kpi[kpi.id].label,
      value,
      deltaLabel,
      direction: kpi.direction,
      tone: kpi.tone,
      previousLabel: previous === null ? dict.kpi.noComparison : dict.kpi.previous({ value: previous }),
      spark: spark && spark.length >= 2 ? spark : null,
      hint: kpi.id === 'completion_rate' ? dict.kpi.completionHint : null,
      deltaNote,
    };
  });
}

/** Notes under a trend chart: what a point is, partial edges, a coarsened request and the data check. */
function trendNotes(trend: ReportTrendInsight, insights: ReportInsights, locale: ReportPdfLocale, dict: ReportPdfDictionary): string[] {
  const t = dict.trends;
  const notes: string[] = [];
  const isEnrollments = trend.metric === 'enrollments';
  if (!isEnrollments) notes.push(t.activeNote);
  if (isEnrollments && insights.requestedGranularity && trend.granularity !== 'unknown') {
    const requested = t.granularityWord[insights.requestedGranularity];
    const shown = t.granularityWord[trend.granularity];
    notes.push(insights.requestedGranularity === 'quarter'
      ? t.requestedUnsupported({ requested, shown })
      : t.requestedTooFine({ requested, shown, days: formatReportNumber(REPORT_SNAPSHOT_BUCKET_RULE.maxBuckets, locale) }));
  }
  if (isEnrollments && trend.granularity === 'week') notes.push(t.weekAxisNote);
  if (trend.partialIndexes.length) notes.push(trend.granularity === 'month' ? t.partialMonthNote : t.partialWeekNote);
  const anomaly = trend.anomaly;
  if (anomaly) {
    const first = trend.points[anomaly.indexes[0]];
    notes.push(anomaly.kind === 'flat_tail'
      ? t.flatTailNote({ count: formatReportNumber(anomaly.indexes.length, locale), value: formatReportNumber(anomaly.value, locale) })
      : t.outlierNote({ when: formatReportBucketLabel(first.bucket, trend.granularity, locale, insights.period), value: formatReportNumber(anomaly.value, locale) }));
  }
  return notes;
}

function trendChart(trend: ReportTrendInsight | null, kind: 'area' | 'bars', insights: ReportInsights, locale: ReportPdfLocale, dict: ReportPdfDictionary, periodActiveLearners: number | null = null): ReportPdfTrendChart | null {
  if (!trend) return null;
  const granularity = trend.granularity;
  const period = insights.period;
  const isEnrollments = trend.metric === 'enrollments';
  const legend: ReportPdfTrendChart['legend'] = [{ key: 'current', label: dict.trends.legendCurrent }];
  if (trend.previousPoints) legend.push({ key: 'previous', label: dict.trends.legendPrevious });
  else if (trend.previousAverage !== null) legend.push({ key: 'previousAverage', label: dict.trends.legendPreviousAverage });
  legend.push({ key: 'average', label: dict.trends.legendAverage });
  if (trend.partialIndexes.length) legend.push({ key: 'partial', label: dict.trends.legendPartial });
  if (trend.anomaly) legend.push({ key: 'flagged', label: dict.trends.legendFlagged });
  const peakDate = trend.peak ? formatReportBucketLabel(trend.peak.bucket, granularity, locale, period) : null;
  const stats: ReportPdfTrendChart['stats'] = isEnrollments
    ? [
      { label: dict.trends.total, value: formatReportNumber(trend.total, locale), detail: null },
      { label: dict.trends.average[granularity], value: formatReportNumber(trend.mean, locale, 1), detail: null },
      { label: dict.trends.peak, value: trend.peak ? formatReportNumber(trend.peak.value, locale) : dict.courses.notAvailable, detail: peakDate },
      trend.previousAverage !== null
        ? { label: dict.trends.previousAverage, value: formatReportNumber(trend.previousAverage, locale, 1), detail: null }
        : { label: dict.trends.zeroBuckets[granularity], value: formatReportNumber(trend.zeroBuckets, locale), detail: null },
    ]
    : [
      ...(periodActiveLearners !== null ? [{ label: dict.trends.activePeriodTotal, value: formatReportNumber(periodActiveLearners, locale), detail: null }] : []),
      { label: dict.trends.average[granularity], value: formatReportNumber(trend.mean, locale, 1), detail: null },
      { label: dict.trends.peak, value: trend.peak ? formatReportNumber(trend.peak.value, locale) : dict.courses.notAvailable, detail: peakDate },
      ...(trend.previousAverage !== null ? [{ label: dict.trends.previousAverage, value: formatReportNumber(trend.previousAverage, locale, 1), detail: null }] : []),
    ];
  return {
    title: isEnrollments ? dict.trends.enrollmentsTitle[granularity] : dict.trends.activeTitle[granularity],
    kind,
    granularity,
    values: trend.points.map((point) => point.value),
    labels: trend.points.map((point) => formatReportBucketTick(point.bucket, granularity, locale, period)),
    previousValues: trend.previousPoints?.map((point, index) => (trend.previousPartialIndexes.includes(index) ? null : point.value)) ?? null,
    previousAverage: trend.previousPoints ? null : trend.previousAverage,
    average: trend.mean,
    peakIndex: trend.peak?.index ?? null,
    peakLabel: trend.peak ? formatReportNumber(trend.peak.value, locale) : null,
    partialIndexes: trend.partialIndexes,
    flaggedIndexes: trend.anomaly?.indexes ?? [],
    legend,
    stats,
    notes: trendNotes(trend, insights, locale, dict),
  };
}

function courseSection(insights: ReportInsights, locale: ReportPdfLocale, dict: ReportPdfDictionary, snapshot: StoredReportChatSnapshot): ReportPdfViewModel['courses'] {
  const n = (value: number | null) => (value === null ? dict.courses.notAvailable : formatReportNumber(value, locale));
  const pct = (value: number | null) => (value === null ? dict.courses.notAvailable : formatReportPercent(value, locale));
  const { courses, statusMix } = insights;
  // The table keeps the ranking order and stops at REPORT_PDF_MAX_COURSE_ROWS; the Excel export has every course.
  const shownRows = courses.rows.slice(0, REPORT_PDF_MAX_COURSE_ROWS);
  const hiddenCourses = Math.max(0, (courses.totalCourses ?? courses.rows.length) - shownRows.length);
  const totalEnrollments = insights.kpis.find((kpi) => kpi.id === 'total_enrollments')?.current ?? 0;
  const shownShare = totalEnrollments > 0 ? (shownRows.reduce((sum, row) => sum + row.enrollments, 0) / totalEnrollments) * 100 : null;
  const status = statusMix ? (['completed', 'in_progress', 'not_started'] as const).map((key) => {
    const count = key === 'completed' ? statusMix.completed : key === 'in_progress' ? statusMix.inProgress : statusMix.notStarted;
    const ratio = count / statusMix.total;
    return { key, label: dict.courses.status[key], count, countLabel: formatReportNumber(count, locale), shareLabel: formatReportPercent(ratio * 100, locale), ratio };
  }) : null;
  const maxEnrollments = Math.max(1, ...courses.rows.map((row) => row.enrollments));
  const totalIncomplete = insights.kpis.find((kpi) => kpi.id === 'incomplete_enrollments')?.current ?? 0;
  const backlogRows = [...courses.rows].filter((row) => row.incomplete > 0).sort((left, right) => right.incomplete - left.incomplete || right.enrollments - left.enrollments).slice(0, 5);
  const maxIncomplete = Math.max(1, ...backlogRows.map((row) => row.incomplete));
  const backlogBars = backlogRows.map((row) => ({
    name: row.name,
    ratio: row.incomplete / maxIncomplete,
    shareLabel: pct(row.incompleteShare),
    valueLabel: formatReportNumber(row.incomplete, locale),
  }));
  const ranked = (row: (typeof courses.rows)[number]) => ({
    name: row.name,
    rate: row.completionRate,
    rateLabel: formatReportPercent(row.completionRate, locale),
    detail: dict.courses.enrollmentsValue({ value: formatReportNumber(row.enrollments, locale) }),
  });
  return {
    status,
    statusTotal: statusMix ? formatReportNumber(statusMix.total, locale) : null,
    statusNote: dict.courses.statusShareNote,
    concentration: courses.rows.slice(0, 5).map((row) => ({
      name: row.name,
      ratio: row.enrollments / maxEnrollments,
      shareLabel: pct(row.enrollmentShare),
      valueLabel: formatReportNumber(row.enrollments, locale),
    })),
    concentrationNote: courses.topShare !== null && courses.rows.length >= 2
      ? dict.courses.concentrationNote({ n: formatReportNumber(courses.topN, locale), share: formatReportPercent(courses.topShare, locale) })
      : null,
    backlog: backlogBars,
    backlogNote: backlogBars.length >= 2 && totalIncomplete > 0
      ? dict.courses.backlogNote({ n: formatReportNumber(backlogBars.length, locale), share: formatReportPercent((backlogRows.reduce((acc, row) => acc + row.incomplete, 0) / totalIncomplete) * 100, locale) })
      : null,
    top: courses.topPerformers.map(ranked),
    low: courses.lowPerformers.map(ranked),
    minSampleNote: dict.courses.minSampleNote({ n: formatReportNumber(REPORT_INSIGHT_THRESHOLDS.minimumCourseSample, locale) }),
    rows: shownRows.map((row, index) => ({
      rank: index + 1,
      name: row.name,
      enrollments: n(row.enrollments),
      completed: n(row.completed),
      inProgress: n(row.inProgress),
      notStarted: n(row.notStarted),
      rate: Math.max(0, Math.min(100, row.completionRate)),
      rateLabel: formatReportPercent(row.completionRate, locale),
      share: pct(row.enrollmentShare),
      watch: row.watch,
    })),
    portfolioLead: dict.courses.portfolioLead({ n: formatReportNumber(shownRows.length, locale) }),
    portfolioLegend: dict.courses.portfolioLegend,
    coverageNote: shownShare !== null && (hiddenCourses > 0 || courses.truncated) ? dict.courses.coverageNote({ share: formatReportPercent(shownShare, locale) }) : null,
    moreCoursesNote: hiddenCourses > 0 ? dict.courses.moreCourses({ n: formatReportNumber(hiddenCourses, locale) })
      : courses.truncated ? dict.courses.moreCoursesUnknown : null,
    legacy: snapshot.version !== 2,
  };
}

function organizationSection(insights: ReportInsights, locale: ReportPdfLocale, dict: ReportPdfDictionary): ReportPdfViewModel['organization'] {
  const o = dict.organization;
  const units = insights.units;
  // Without units the section is left out; the appendix limitations say why.
  if (!units) return { level: null, rows: [], unitCountLabel: null, footnotes: [] };
  // The colour scale spans real units only: an "others" or "not in any unit" row at 0 % must not
  // wash out the differences between units.
  const unitRates = units.rows.filter((row) => row.kind === 'unit').map((row) => row.completionRate);
  const rates = unitRates.length > 0 ? unitRates : units.rows.map((row) => row.completionRate);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const n = (value: number) => formatReportNumber(value, locale);
  const learnerSum = units.rows.reduce((sum, row) => sum + row.learners, 0);
  const listed = units.rows.filter((row) => row.kind === 'unit').length;
  return {
    level: dict.scope[units.level],
    unitCountLabel: o.unitCount({ n: n(units.unitCount) }),
    footnotes: [
      `${o.heatLegend} ${o.deltaNote}`,
      o.learnersNote,
      ...(units.overlapping && units.scopeLearners !== null ? [o.overlapNote({ sum: n(learnerSum), total: n(units.scopeLearners) })] : []),
      ...(units.truncated ? [o.othersNote({ n: n(listed) })] : []),
    ],
    rows: units.rows.map((row) => ({
      name: row.kind === 'others' ? o.othersRow({ n: n(row.unitCount ?? 0) }) : row.kind === 'unassigned' ? o.unassignedRow : row.name,
      learners: n(row.learners),
      active: n(row.activeLearners),
      enrollments: n(row.enrollments),
      rate: row.completionRate,
      rateLabel: formatReportPercent(row.completionRate, locale),
      deltaLabel: row.deltaPp === null ? dict.courses.notAvailable : `${formatReportSignedNumber(row.deltaPp, locale, 1)} ${dict.units.pp}`,
      deltaTone: row.deltaPp === null || Math.abs(row.deltaPp) < REPORT_INSIGHT_THRESHOLDS.stableRateDeltaPp ? 'neutral' : row.deltaPp > 0 ? 'positive' : 'negative',
      heat: max > min ? Math.min(1, Math.max(0, (row.completionRate - min) / (max - min))) : 0.5,
      aggregate: row.kind !== 'unit',
    })),
  };
}

function appendix(insights: ReportInsights, input: { locale: ReportPdfLocale; dict: ReportPdfDictionary; narrative: ReportPdfNarrative; periodLabel: string; comparisonLabel: string | null; comparisonTitle: string; scopeDetail: string; generatedAtLabel: string; reference: string; templateVersion: string }): Omit<ReportPdfViewModel['appendix'], 'methodRows'> {
  const { dict, locale } = input;
  const a = dict.appendix;
  const pct = (value: number) => formatReportPercent(value, locale);
  const signals = REPORT_SIGNAL_THRESHOLDS;
  return {
    definitions: [
      { label: dict.kpi.total_learners.label, text: a.definitions.total_learners },
      { label: dict.kpi.active_learners.label, text: a.definitions.active_learners },
      { label: dict.kpi.total_enrollments.label, text: a.definitions.total_enrollments },
      { label: dict.kpi.completed_enrollments.label, text: a.definitions.completed_enrollments },
      { label: dict.kpi.incomplete_enrollments.label, text: a.definitions.incomplete_enrollments },
      { label: a.statusLabel, text: a.definitions.status },
      { label: a.courseRateLabel, text: a.definitions.course_rate },
    ],
    scopeRows: [
      { label: a.rows.period, value: input.periodLabel },
      { label: a.rows.comparison, value: input.comparisonLabel ?? dict.cover.noComparison },
      { label: a.rows.basis, value: input.comparisonTitle },
      { label: a.rows.scope, value: input.scopeDetail },
      { label: a.rows.timezone, value: a.rows.timezoneValue },
      { label: a.rows.snapshot, value: input.generatedAtLabel },
      { label: a.rows.freshness, value: a.rows.freshnessValue },
      { label: a.rows.narrative, value: input.narrative.source === 'ai' ? a.rows.narrativeAi : a.rows.narrativeRules },
      { label: a.rows.reference, value: input.reference },
      { label: a.rows.template, value: a.templateVersion({ version: input.templateVersion }) },
    ],
    methodology: [
      a.methodology.comparison,
      a.methodology.stability({ countPct: pct(REPORT_INSIGHT_THRESHOLDS.stableCountDeltaPercent), ratePp: formatReportPercentagePoints(REPORT_INSIGHT_THRESHOLDS.stableRateDeltaPp, locale) }),
      a.methodology.sample({ n: formatReportNumber(REPORT_INSIGHT_THRESHOLDS.minimumCourseSample, locale) }),
      a.methodology.concentration({ share: pct(REPORT_INSIGHT_THRESHOLDS.concentrationShare) }),
      a.methodology.activation({
        share: pct(REPORT_INSIGHT_THRESHOLDS.activationNotStartedShare),
        n: formatReportNumber(REPORT_INSIGHT_THRESHOLDS.activationMinimumEnrollments, locale),
        courseMin: formatReportNumber(REPORT_INSIGHT_THRESHOLDS.minimumCourseSample, locale),
      }),
      a.methodology.percentChange({
        base: formatReportNumber(REPORT_INSIGHT_THRESHOLDS.percentChangeMinimumBase, locale),
        max: pct(REPORT_INSIGHT_THRESHOLDS.percentChangeMaximum),
        minEnrollments: formatReportNumber(REPORT_INSIGHT_THRESHOLDS.rateChangeMinimumEnrollments, locale),
      }),
      a.methodology.buckets({
        dayMax: formatReportNumber(REPORT_SNAPSHOT_BUCKET_RULE.autoDayMaxDays, locale),
        weekMax: formatReportNumber(REPORT_SNAPSHOT_BUCKET_RULE.autoWeekMaxDays, locale),
      }),
      a.methodology.dataQuality({
        n: formatReportNumber(REPORT_INSIGHT_THRESHOLDS.flatTailMinimumBuckets, locale),
        value: formatReportNumber(REPORT_INSIGHT_THRESHOLDS.flatTailMinimumValue, locale),
        ratio: formatReportNumber(REPORT_INSIGHT_THRESHOLDS.outlierRatio, locale),
      }),
      a.methodology.anomaly({ sigma: formatReportNumber(REPORT_INSIGHT_THRESHOLDS.anomalySigma, locale), n: formatReportNumber(REPORT_INSIGHT_THRESHOLDS.anomalyMinimumBuckets, locale) }),
      a.methodology.momentum({ pct: pct(REPORT_INSIGHT_THRESHOLDS.momentumChangePercent) }),
      a.methodology.signals({
        pp: formatReportPercentagePoints(Math.abs(signals.completion_decline.decline_percentage_points), locale),
        minEnrollments: formatReportNumber(signals.completion_decline.minimum_current_enrollments, locale),
        courseMin: formatReportNumber(signals.high_enrollment_low_completion.minimum_enrollments, locale),
        courseMax: pct(signals.high_enrollment_low_completion.maximum_completion_rate),
      }),
      ...(insights.units ? [a.methodology.unitCounting, a.methodology.units({
        n: formatReportNumber(REPORT_INSIGHT_THRESHOLDS.minimumUnitSample, locale),
        pp: formatReportPercentagePoints(REPORT_INSIGHT_THRESHOLDS.unitDeclinePp, locale),
        max: pct(REPORT_INSIGHT_THRESHOLDS.unitLowCompletionRate),
        gap: formatReportPercentagePoints(REPORT_INSIGHT_THRESHOLDS.unitGapPp, locale),
      })] : []),
    ],
    limitations: insights.limitations.map((code) => a.limitations[code]),
  };
}

function withMethodRows(appendixData: Omit<ReportPdfViewModel['appendix'], 'methodRows'>, dict: ReportPdfDictionary): ReportPdfViewModel['appendix'] {
  const a = dict.appendix;
  // Limitations first: they qualify the figures of this report; the methodology is reference text.
  const methodRows: ReportPdfViewModel['appendix']['methodRows'] = [
    ...(appendixData.limitations.length
      ? [{ kind: 'title' as const, text: a.limitationsTitle }, ...appendixData.limitations.map((text) => ({ kind: 'item' as const, text }))]
      : []),
    { kind: 'title', text: a.methodologyTitle },
    ...appendixData.methodology.map((text) => ({ kind: 'item' as const, text })),
  ];
  return { ...appendixData, methodRows };
}

export function buildReportPdfViewModel(input: {
  snapshot: StoredReportChatSnapshot;
  snapshotHash: string;
  locale: ReportPdfLocale;
  tenant: ReportPdfTenantBranding;
  insights: ReportInsights;
  narrative: ReportPdfNarrative;
  templateVersion?: string;
}): ReportPdfViewModel {
  const { snapshot, locale, insights, narrative } = input;
  // Level and role names are the tenant's labels (insights.labels), the breakdown level included.
  const dict = getReportPdfDictionaryFor(locale, insights);
  const path = scopePath(insights, dict);
  const periodLabel = formatReportPeriod(insights.period.dateFrom, insights.period.dateTo, locale);
  const comparisonLabel = insights.comparison ? formatReportPeriod(insights.comparison.dateFrom, insights.comparison.dateTo, locale) : null;
  const comparisonTitle = dict.comparison[insights.comparisonBasis].title;
  const scopeLabel = path.length ? path.map((item) => item.name).join(' › ') : dict.scope.all;
  const generatedAtLabel = formatReportDateTime(snapshot.generated_at, locale);
  const reference = input.snapshotHash.slice(0, 12).toUpperCase();
  const templateVersion = input.templateVersion ?? REPORT_PDF_TEMPLATE_VERSION;
  const kpis = kpiCards(insights, locale, dict);
  const observations = insights.facts
    .filter((fact) => TREND_OBSERVATION_IDS.has(fact.id))
    .sort((left, right) => right.priority - left.priority)
    .map((fact) => ({ text: describeReportFact(fact, insights, locale) ?? '', factIds: [fact.id], tone: fact.tone }))
    .filter((item): item is ReportPdfNarrativeItem => Boolean(item.text))
    .slice(0, MAX_TREND_OBSERVATIONS);
  const attention = insights.attention.slice(0, 6).map((item) => {
    const fact = insights.facts.find((candidate) => candidate.id === item.factId);
    const text = narrative.risks.find((risk) => risk.factIds.includes(item.factId))?.text ?? (fact ? describeReportFact(fact, insights, locale) : null);
    return text ? { severity: item.severity, severityLabel: dict.attention.severity[item.severity], title: dict.attention.titles[item.kind], text } : null;
  }).filter((item): item is ReportPdfAttentionCard => item !== null);
  const base: Omit<ReportPdfViewModel, 'pages' | 'sectionNumbers'> = {
    locale,
    available: insights.available,
    dict,
    templateVersion,
    title: dict.meta.title,
    tenant: input.tenant,
    brandLine: buildReportPdfBrandLine(input.tenant.name, dict),
    periodLabel,
    comparisonLabel,
    comparisonTitle,
    scopeLabel,
    scopePath: path,
    generatedAtLabel,
    reference,
    entities: Object.fromEntries(insights.entities.map((entity) => [entity.token, entity.name])),
    narrative,
    kpis,
    coverKpis: ['completion_rate', 'total_enrollments', 'active_learners'].map((id) => kpis.find((kpi) => kpi.id === id)!),
    scorecardNote: dict.summary.scorecardNote({ suffix: dict.comparison[insights.comparisonBasis].suffix }),
    trends: {
      enrollments: trendChart(insights.trends.enrollments, 'area', insights, locale, dict),
      active: trendChart(insights.trends.activeLearners, 'bars', insights, locale, dict, insights.kpis.find((kpi) => kpi.id === 'active_learners')?.current ?? null),
      observations,
    },
    courses: courseSection(insights, locale, dict, snapshot),
    organization: organizationSection(insights, locale, dict),
    attention,
    watchlist: {
      lead: dict.attention.watchlistLead({
        min: formatReportNumber(REPORT_SIGNAL_THRESHOLDS.high_enrollment_low_completion.minimum_enrollments, locale),
        max: formatReportPercent(REPORT_SIGNAL_THRESHOLDS.high_enrollment_low_completion.maximum_completion_rate, locale),
      }),
      rows: insights.courses.watchlist.length >= 2 ? insights.courses.watchlist.slice(0, 8).map((row) => ({
        name: row.name,
        enrollments: formatReportNumber(row.enrollments, locale),
        notStarted: row.notStarted === null ? dict.courses.notAvailable : formatReportNumber(row.notStarted, locale),
        rate: Math.max(0, Math.min(100, row.completionRate)),
        rateLabel: formatReportPercent(row.completionRate, locale),
      })) : [],
    },
    recommendations: narrative.recommendations.map((item) => ({
      text: item.text,
      priority: item.priority ?? 'medium',
      priorityLabel: dict.recommendations.priority[item.priority ?? 'medium'],
      fromChat: item.origin === 'chat',
    })),
    appendix: withMethodRows(appendix(insights, {
      locale, dict, narrative, periodLabel, comparisonLabel, comparisonTitle, generatedAtLabel, reference, templateVersion,
      // The appendix names each level with the tenant's label: "Khối/Khu vực: Khối Kinh doanh › Đơn vị: Chi nhánh HCM".
      scopeDetail: path.length ? path.map((item) => `${item.level}: ${item.name}`).join(' › ') : dict.scope.all,
    }), dict),
  };
  const numbered = { ...base, sectionNumbers: reportPdfSectionNumbers(base) };
  return { ...numbered, pages: planReportPdfPages(numbered) };
}

/** Localized, ASCII-safe download file name. */
export function buildReportPdfFileName(input: { locale: ReportPdfLocale; dateFrom: string; dateTo: string; tenantSlug?: string }): string {
  const dict = getReportPdfDictionary(input.locale);
  const safeDate = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : 'unknown');
  const tenant = input.tenantSlug ? `${input.tenantSlug}_` : '';
  return `${dict.meta.fileNamePrefix}_${tenant}${safeDate(input.dateFrom)}_${dict.meta.fileNameRangeJoiner}_${safeDate(input.dateTo)}.pdf`;
}

