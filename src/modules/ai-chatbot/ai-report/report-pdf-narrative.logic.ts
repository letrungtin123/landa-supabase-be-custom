// ═══════════════════════════════════════════════════════════════
// Report PDF narrative: rule-based narrative from insight facts, the number
// validator for AI-written narratives (vi/en number formats), the Gemini
// request/response contract and the reuse of the stored chat narrative.
// No I/O. Entity names never reach the model: courses/units are {{C1}}/{{U1}}.
// ═══════════════════════════════════════════════════════════════
import { z } from 'zod';
import { isReportNarrativeAllowed, type StoredReportChatSnapshot } from './report-chat.service.js';
import {
  formatReportDate,
  formatReportDayRange,
  formatReportMonth,
  formatReportNumber,
  formatReportPercent,
  formatReportPercentagePoints,
  getReportPdfDictionary,
  getReportPdfDictionaryFor,
  type ReportBucketGranularity,
  type ReportPdfLocale,
} from './report-pdf-i18n.js';
import { REPORT_INSIGHT_THRESHOLDS, type ReportInsightFact, type ReportInsights, type ReportInsightTone, type ReportKpiInsight } from './report-insights.logic.js';
import {
  ENTITY_TOKEN, allowedValuesOf, blankEntityTokens, checkNumber, directionBefore, extractReportNarrativeNumbers,
  factDirection, reportLabelPattern, sameRounded, sentenceDirections, unitAccepts,
} from './report-pdf-narrative-numbers.logic.js';
import type { AllowedValue, Direction } from './report-pdf-narrative-numbers.logic.js';
export { extractReportNarrativeNumbers, reportLabelPattern } from './report-pdf-narrative-numbers.logic.js';
export type { ReportNarrativeUnit, ReportNarrativeNumber } from './report-pdf-narrative-numbers.logic.js';

export type ReportPdfNarrativePriority = 'high' | 'medium' | 'low';
export interface ReportPdfNarrativeItem {
  text: string;
  factIds: string[];
  tone: ReportInsightTone;
  priority?: ReportPdfNarrativePriority;
  origin?: 'chat';
  /** Recommendation candidate this action comes from (deterministic or rephrased by AI). */
  recId?: string;
}

/** A deterministic recommendation built from one detected signal, with its numbers and target. */
export interface ReportPdfRecommendationCandidate {
  id: string;
  text: string;
  factIds: string[];
  priority: ReportPdfNarrativePriority;
  tone: ReportInsightTone;
}
export interface ReportPdfNarrative {
  source: 'ai' | 'rules';
  headline: ReportPdfNarrativeItem;
  findings: ReportPdfNarrativeItem[];
  risks: ReportPdfNarrativeItem[];
  recommendations: ReportPdfNarrativeItem[];
  commentary: string[];
}

export const REPORT_PDF_NARRATIVE_LIMITS = {
  headlineMaxChars: 260,
  itemMaxChars: 280,
  minFindings: 3,
  maxFindings: 5,
  maxRisks: 4,
  minRecommendations: 2,
  maxRecommendations: 5,
  maxCommentary: 3,
} as const;

const VIETNAMESE_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const token = (value: string) => `{{${value}}}`;

function factYmd(values: Record<string, number>, prefix: string): string | null {
  const year = values[`${prefix}_year`];
  const month = values[`${prefix}_month`];
  if (!year || !month) return null;
  const day = values[`${prefix}_day`];
  return `${year}-${String(month).padStart(2, '0')}${day ? `-${String(day).padStart(2, '0')}` : ''}`;
}

function chartGranularity(insights: ReportInsights): ReportBucketGranularity {
  return insights.trends.enrollments?.granularity ?? insights.trends.activeLearners?.granularity ?? 'unknown';
}

/**
 * When a bucket happened, worded by its size: "vào ngày 15/07/2026",
 * "vào tuần 15/06–21/06/2026", "vào tháng 04/2026" (en "on …", "in the week of …", "in …").
 */
function formatFactWhen(values: Record<string, number>, prefix: string, insights: ReportInsights, locale: ReportPdfLocale): string {
  const t = getReportPdfDictionary(locale).narrative;
  const start = factYmd(values, prefix);
  if (!start) return '';
  const granularity = chartGranularity(insights);
  if (granularity === 'month' || start.length === 7) return t.whenMonth({ month: formatReportMonth(start.slice(0, 7), locale) });
  const end = factYmd(values, `${prefix}_end`);
  if (granularity === 'week' && end) return t.whenWeek({ range: formatReportDayRange(start, end, locale) });
  return t.whenDay({ date: formatReportDate(start, locale) });
}

function perUnit(insights: ReportInsights, locale: ReportPdfLocale): string {
  const units = getReportPdfDictionary(locale).units;
  const granularity = insights.trends.enrollments?.granularity;
  return granularity === 'week' ? units.perWeek : granularity === 'month' ? units.perMonth : units.perDay;
}

function comparisonSuffix(insights: ReportInsights, locale: ReportPdfLocale): string {
  return getReportPdfDictionary(locale).comparison[insights.comparisonBasis].suffix;
}

/** Localized change phrase of a KPI, e.g. "tăng 17, tương đương 35,4%, so với tháng trước". */
export function describeKpiChange(kpi: ReportKpiInsight, insights: ReportInsights, locale: ReportPdfLocale): string | null {
  const dict = getReportPdfDictionary(locale);
  if (kpi.direction === null || kpi.delta === null) return null;
  const suffix = comparisonSuffix(insights, locale);
  if (kpi.direction === 'flat') return dict.narrative.changeFlat({ suffix });
  const direction = dict.direction[kpi.direction];
  if (kpi.unit === 'percentage') return dict.narrative.changeRate({ direction, delta: formatReportPercentagePoints(kpi.delta, locale), suffix });
  const delta = formatReportNumber(Math.abs(kpi.delta), locale);
  if (kpi.smallBase) return dict.narrative.changeCountSmallBase({ direction, delta, suffix });
  return kpi.deltaPercent === null
    ? dict.narrative.changeCountNoPct({ direction, delta, suffix })
    : dict.narrative.changeCount({ direction, delta, pct: formatReportPercent(Math.abs(kpi.deltaPercent), locale), suffix });
}

function seriesName(factId: string, locale: ReportPdfLocale): string {
  const t = getReportPdfDictionary(locale).narrative;
  return factId.endsWith('active_learners') ? t.seriesActive : t.seriesEnrollments;
}

function anomalyOf(factId: string, insights: ReportInsights) {
  return (factId.endsWith('active_learners') ? insights.trends.activeLearners : insights.trends.enrollments)?.anomaly ?? null;
}

/** One localized, tokenized sentence per fact. Every number comes from fact.values. */
export function describeReportFact(fact: ReportInsightFact, insights: ReportInsights, locale: ReportPdfLocale): string | null {
  const dict = getReportPdfDictionaryFor(locale, insights);
  const t = dict.narrative;
  const v = fact.values;
  const n = (value: number | undefined, digits = 0) => formatReportNumber(value ?? 0, locale, digits);
  const pct = (value: number | undefined) => formatReportPercent(value ?? 0, locale);
  const pp = (value: number | undefined) => formatReportPercentagePoints(value ?? 0, locale);
  const suffix = comparisonSuffix(insights, locale);
  const entity = (index = 0) => (fact.entities[index] ? token(fact.entities[index]) : '');
  switch (fact.kind) {
    case 'kpi': {
      const kpi = insights.kpis.find((item) => `kpi.${item.id}` === fact.id);
      if (!kpi) return null;
      const label = dict.kpi[kpi.id].sentence;
      const change = describeKpiChange(kpi, insights, locale);
      if (kpi.unit === 'percentage') {
        if (kpi.smallBase && kpi.previous !== null) return t.kpiRateSmallSample({ current: pct(v.current), previous: pct(v.previous) });
        return change && kpi.previous !== null
          ? t.kpiRate({ current: pct(v.current), previous: pct(v.previous), change })
          : t.kpiPlain({ label, current: pct(v.current) });
      }
      return change ? t.kpiCount({ label, current: n(v.current), change }) : t.kpiPlain({ label, current: n(v.current) });
    }
    case 'status_mix':
      return t.statusMix({ total: n(v.total), completed: pct(v.completed_share), inProgress: pct(v.in_progress_share), notStarted: pct(v.not_started_share) });
    case 'concentration':
      return t.concentration({ n: n(v.n), share: pct(v.share), course: entity(), topShare: pct(v.top_share) });
    case 'top_performer':
      return t.topPerformer({ course: entity(), rate: pct(v.rate), enrollments: n(v.enrollments) });
    case 'low_performer':
      return t.lowPerformer({ course: entity(), rate: pct(v.rate), enrollments: n(v.enrollments) });
    case 'spread':
      return t.spread({ spread: pp(v.spread), best: pct(v.best), worst: pct(v.worst) });
    case 'trend_peak':
      return t.trendPeak({ when: formatFactWhen(v, 'peak', insights, locale), value: n(v.value), ratio: n(v.ratio, 1) });
    case 'trend_momentum':
      return (v.direction > 0 ? t.trendMomentumUp : t.trendMomentumDown)({ last: n(v.last, 1), first: n(v.first, 1), unit: perUnit(insights, locale) });
    case 'trend_vs_previous': {
      const direction = dict.direction[v.direction > 0 ? 'up' : 'down'];
      // Without a meaningful percentage (tiny comparison period) only the two averages are given.
      return v.pct === undefined
        ? t.trendVsPreviousSmallBase({ avg: n(v.avg, 1), unit: perUnit(insights, locale), direction, previous: n(v.previous, 1) })
        : t.trendVsPrevious({ avg: n(v.avg, 1), unit: perUnit(insights, locale), direction, pct: pct(v.pct), previous: n(v.previous, 1) });
    }
    case 'trend_spikes':
      return t.trendSpikes({ count: n(v.count), when: formatFactWhen(v, 'spike', insights, locale), value: n(v.value) });
    case 'course_activation_risk': {
      const params = { course: entity(), notStarted: n(v.not_started), enrollments: n(v.enrollments), share: pct(v.share), threshold: pct(v.threshold) };
      return v.count > 1 ? t.courseActivation({ ...params, count: n(v.count) }) : t.courseActivationOne(params);
    }
    case 'data_anomaly': {
      const anomaly = anomalyOf(fact.id, insights);
      if (!anomaly) return null;
      return anomaly.kind === 'flat_tail'
        ? t.dataFlatTail({ count: n(v.count), series: seriesName(fact.id, locale), value: n(v.value) })
        : t.dataOutlier({ series: seriesName(fact.id, locale), when: formatFactWhen(v, 'start', insights, locale), value: n(v.value) });
    }
    case 'active_trend_momentum':
      return (v.direction > 0 ? t.activeTrendMomentumUp : t.activeTrendMomentumDown)({ last: n(v.last, 1), first: n(v.first, 1) });
    case 'unit_ranking':
      return t.unitRanking({ best: entity(0), bestRate: pct(v.best_rate), worst: entity(1), worstRate: pct(v.worst_rate), gap: pp(v.gap) });
    case 'completion_decline':
      return t.completionDecline({ delta: pp(v.delta), previous: pct(v.previous), current: pct(v.current), suffix });
    case 'course_watchlist':
      return t.watchlist({ count: n(v.count), min: n(v.min), max: pct(v.max), course: entity(), rate: pct(v.rate), enrollments: n(v.enrollments) });
    case 'activation_risk':
      return t.activationRisk({ share: pct(v.share), count: n(v.count), threshold: pct(v.threshold) });
    case 'activity_drop':
      return t.activityDrop({ recent: n(v.recent), preceding: n(v.preceding) });
    case 'enrollment_drop':
      return v.pct === undefined ? t.enrollmentDropSmallBase({ delta: n(v.delta), suffix }) : t.enrollmentDrop({ delta: n(v.delta), pct: pct(v.pct), suffix });
    case 'active_learner_drop':
      return v.pct === undefined ? t.activeDropSmallBase({ delta: n(v.delta), suffix }) : t.activeDrop({ delta: n(v.delta), pct: pct(v.pct), suffix });
    case 'backlog_concentration':
      return t.backlog({ course: entity(), share: pct(v.share), count: n(v.count) });
    case 'unit_gap':
      return t.unitGap({ gap: pp(v.gap), best: entity(1), bestRate: pct(v.best_rate), worst: entity(0), worstRate: pct(v.worst_rate) });
    case 'unit_decline':
      return t.unitDecline({ unit: entity(), delta: pp(v.delta), previous: pct(v.previous), current: pct(v.current), suffix });
    case 'unit_low_completion':
      return v.count > 1
        ? t.unitLowCompletion({ count: n(v.count), min: n(v.min), max: pct(v.max), unit: entity(), rate: pct(v.rate), enrollments: n(v.enrollments) })
        : t.unitLowCompletionOne({ unit: entity(), rate: pct(v.rate), enrollments: n(v.enrollments), max: pct(v.max) });
    default:
      return null;
  }
}

const RISK_KINDS = new Set<ReportInsightFact['kind']>(['completion_decline', 'course_watchlist', 'activity_drop', 'activation_risk',
  'course_activation_risk', 'backlog_concentration', 'enrollment_drop', 'active_learner_drop', 'unit_gap', 'unit_decline', 'unit_low_completion']);
/** Facts that are never findings: risks have their own section, data checks are chart notes and actions. */
const NON_FINDING_KINDS = new Set<ReportInsightFact['kind']>([...RISK_KINDS, 'data_anomaly']);

function buildHeadline(insights: ReportInsights, locale: ReportPdfLocale): ReportPdfNarrativeItem {
  const t = getReportPdfDictionary(locale).narrative;
  const kpi = (id: ReportKpiInsight['id']) => insights.kpis.find((item) => item.id === id)!;
  const enrollments = kpi('total_enrollments');
  const rate = kpi('completion_rate');
  const active = kpi('active_learners');
  if (!insights.available) return { text: t.headlineEmpty, factIds: ['kpi.total_enrollments'], tone: 'neutral' };
  const enrollmentChange = describeKpiChange(enrollments, insights, locale);
  const rateChange = describeKpiChange(rate, insights, locale);
  const tone: ReportInsightTone = rate.tone === 'negative' || enrollments.tone === 'negative' ? 'attention' : rate.tone === 'positive' ? 'positive' : 'neutral';
  if (enrollmentChange && rateChange) {
    return {
      text: t.headlineCompared({
        enrollments: formatReportNumber(enrollments.current, locale),
        enrollmentChange,
        rate: formatReportPercent(rate.current, locale),
        rateChange,
      }),
      factIds: ['kpi.total_enrollments', 'kpi.completion_rate'],
      tone,
    };
  }
  return {
    text: t.headlinePlain({
      enrollments: formatReportNumber(enrollments.current, locale),
      active: formatReportNumber(active.current, locale),
      rate: formatReportPercent(rate.current, locale),
    }),
    factIds: ['kpi.total_enrollments', 'kpi.active_learners', 'kpi.completion_rate'],
    tone,
  };
}

function buildFindings(insights: ReportInsights, locale: ReportPdfLocale, headline: ReportPdfNarrativeItem): ReportPdfNarrativeItem[] {
  const limits = REPORT_PDF_NARRATIVE_LIMITS;
  if (!insights.available) return [{ text: getReportPdfDictionary(locale).narrative.emptyFinding, factIds: ['kpi.total_enrollments'], tone: 'neutral' }];
  const watchTokens = new Set(insights.facts.find((fact) => fact.id === 'risk.watchlist')?.entities ?? []);
  // The unit ranking stays in the summary even with a unit-gap risk: the risk
  // card words the gap differently.
  const excluded = new Set(headline.factIds);
  const candidates = insights.facts
    .filter((fact) => fact.kind !== 'context' && !NON_FINDING_KINDS.has(fact.kind) && !excluded.has(fact.id))
    .filter((fact) => !(fact.kind === 'low_performer' && fact.entities.some((entity) => watchTokens.has(entity))))
    .filter((fact) => !(fact.kind === 'kpi' && ['kpi.completed_enrollments', 'kpi.incomplete_enrollments'].includes(fact.id)))
    .sort((left, right) => right.priority - left.priority);
  const selected: ReportInsightFact[] = [];
  let trendCount = 0;
  for (const fact of candidates) {
    if (selected.length >= limits.maxFindings) break;
    const isTrend = fact.kind.startsWith('trend') || fact.kind === 'active_trend_momentum';
    if (isTrend && trendCount >= 2) continue;
    if (isTrend) trendCount += 1;
    selected.push(fact);
  }
  if (selected.length < limits.minFindings) {
    const padding = insights.facts.filter((fact) => fact.kind === 'kpi' && !selected.includes(fact)).sort((left, right) => right.priority - left.priority);
    selected.push(...padding.slice(0, limits.minFindings - selected.length));
  }
  return selected
    .map((fact) => ({ text: describeReportFact(fact, insights, locale) ?? '', factIds: [fact.id], tone: fact.tone }))
    .filter((item) => item.text);
}

function buildRisks(insights: ReportInsights, locale: ReportPdfLocale): ReportPdfNarrativeItem[] {
  return insights.attention.slice(0, REPORT_PDF_NARRATIVE_LIMITS.maxRisks).flatMap((item) => {
    const fact = insights.facts.find((candidate) => candidate.id === item.factId);
    const text = fact ? describeReportFact(fact, insights, locale) : null;
    return text ? [{ text, factIds: [item.factId], tone: fact!.tone }] : [];
  });
}

/**
 * Every recommendation the report may make, one per detected signal, in
 * priority order. Each one says who to act on, what to do and the target,
 * with numbers taken only from the fact it cites. The rule-based narrative
 * keeps the first maxRecommendations; an AI narrative may only select and
 * rephrase these (validateReportPdfNarrative checks the rec ids).
 */
export function buildReportRecommendationCandidates(insights: ReportInsights, locale: ReportPdfLocale): ReportPdfRecommendationCandidate[] {
  const t = getReportPdfDictionaryFor(locale, insights).narrative;
  const n = (value: number | undefined, digits = 0) => formatReportNumber(value ?? 0, locale, digits);
  const pct = (value: number | undefined) => formatReportPercent(value ?? 0, locale);
  const items: ReportPdfRecommendationCandidate[] = [];
  const push = (text: string, factIds: string[], priority: ReportPdfNarrativePriority, tone: ReportInsightTone = 'attention') => {
    if (!items.some((item) => item.text === text)) items.push({ id: `rec.${factIds[0]}`, text, factIds, priority, tone });
  };
  if (!insights.available) {
    push(t.recStart, ['kpi.total_enrollments'], 'medium', 'neutral');
    return items;
  }
  const fact = (id: string) => insights.facts.find((candidate) => candidate.id === id);
  for (const item of insights.attention) {
    const risk = fact(item.factId)!;
    const v = risk.values;
    const entity = risk.entities[0] ? token(risk.entities[0]) : '';
    switch (risk.kind) {
      case 'completion_decline': push(t.recCompletionDecline({ previous: pct(v.previous) }), [risk.id], 'high'); break;
      case 'course_watchlist': {
        const params = { course: entity, rate: pct(v.rate), max: pct(v.max) };
        push(v.count > 1 ? t.recWatchlist({ ...params, count: n(v.count) }) : t.recWatchlistOne(params), [risk.id], 'high');
        break;
      }
      case 'activation_risk':
        push(t.recActivation({ count: n(v.count), share: pct(v.share), threshold: pct(v.threshold) }), [risk.id], v.share >= 50 ? 'high' : 'medium');
        break;
      case 'course_activation_risk': {
        const params = { course: entity, notStarted: n(v.not_started), share: pct(v.share), threshold: pct(v.threshold) };
        push(v.count > 1 ? t.recCourseActivation({ ...params, count: n(v.count) }) : t.recCourseActivationOne(params), [risk.id], v.share >= 50 ? 'high' : 'medium');
        break;
      }
      case 'activity_drop': push(t.recActivityDrop, [risk.id], 'medium'); break;
      case 'enrollment_drop': push(t.recEnrollmentDrop({ previous: n(v.previous) }), [risk.id], 'medium'); break;
      case 'active_learner_drop': push(t.recActiveDrop({ previous: n(v.previous) }), [risk.id], 'medium'); break;
      case 'backlog_concentration': push(t.recBacklog({ course: entity, share: pct(v.share), count: n(v.count) }), [risk.id], 'medium'); break;
      case 'unit_gap': {
        // The lowest unit may already have its own low-completion action.
        const lowUnit = fact('risk.unit_low_completion')?.entities[0];
        if (risk.entities[0] !== lowUnit) push(t.recUnitGap({ unit: entity, rate: pct(v.worst_rate), best: pct(v.best_rate) }), [risk.id], 'medium');
        break;
      }
      case 'unit_decline': push(t.recUnitDecline({ unit: entity, previous: pct(v.previous) }), [risk.id], 'high'); break;
      case 'unit_low_completion':
        push(v.count > 1 ? t.recUnitLowCompletion({ unit: entity, count: n(v.count), max: pct(v.max) }) : t.recUnitLowCompletionOne({ unit: entity, max: pct(v.max) }), [risk.id], 'medium');
        break;
      default: break;
    }
  }
  const momentum = fact('trend.enrollments.momentum');
  if (momentum && momentum.values.direction < 0) push(t.recMomentum({ first: n(momentum.values.first, 1), unit: perUnit(insights, locale) }), [momentum.id], 'medium');
  const low = fact('courses.low');
  const watchTokens = new Set(fact('risk.watchlist')?.entities ?? []);
  if (low?.entities[0] && low.tone === 'negative' && !watchTokens.has(low.entities[0])) {
    push(t.recReviewCourse({ course: token(low.entities[0]), rate: pct(low.values.rate) }), [low.id], 'medium');
  }
  const status = fact('status.mix');
  if (status && status.values.in_progress_share >= REPORT_INSIGHT_THRESHOLDS.inProgressNudgeShare) {
    push(t.recNudgeInProgress({ count: n(status.values.in_progress) }), [status.id], 'medium', 'neutral');
  }
  for (const anomaly of insights.facts.filter((candidate) => candidate.kind === 'data_anomaly')) {
    const series = seriesName(anomaly.id, locale);
    const kind = anomalyOf(anomaly.id, insights)?.kind;
    if (kind === 'flat_tail') push(t.recDataFlatTail({ series, count: n(anomaly.values.count), value: n(anomaly.values.value) }), [anomaly.id], 'medium', 'neutral');
    else if (kind === 'outlier') push(t.recDataOutlier({ series, when: formatFactWhen(anomaly.values, 'start', insights, locale) }), [anomaly.id], 'medium', 'neutral');
  }
  const concentration = fact('courses.concentration');
  if (concentration && concentration.tone === 'attention') {
    push(t.recConcentration({ n: n(concentration.values.n), share: pct(concentration.values.share) }), [concentration.id], 'low', 'neutral');
  }
  const top = fact('courses.top');
  if (top?.entities[0]) push(t.recReplicate({ course: token(top.entities[0]), rate: pct(top.values.rate) }), [top.id], 'low', 'positive');
  // Only without any signal: a report always closes with one action.
  if (!items.length) push(t.recMonitor, ['kpi.total_enrollments'], 'low', 'neutral');
  const rank: Record<ReportPdfNarrativePriority, number> = { high: 0, medium: 1, low: 2 };
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => rank[left.item.priority] - rank[right.item.priority] || left.index - right.index)
    .map(({ item }) => item);
}

function buildRecommendations(insights: ReportInsights, locale: ReportPdfLocale): ReportPdfNarrativeItem[] {
  return buildReportRecommendationCandidates(insights, locale)
    .slice(0, REPORT_PDF_NARRATIVE_LIMITS.maxRecommendations)
    .map((candidate) => ({ text: candidate.text, factIds: candidate.factIds, priority: candidate.priority, tone: candidate.tone, recId: candidate.id }));
}

/** Deterministic narrative written only from insight facts (used when AI is off or rejected). */
export function buildRuleBasedReportNarrative(insights: ReportInsights, locale: ReportPdfLocale): ReportPdfNarrative {
  const headline = buildHeadline(insights, locale);
  return {
    source: 'rules',
    headline,
    findings: buildFindings(insights, locale, headline),
    risks: buildRisks(insights, locale),
    recommendations: buildRecommendations(insights, locale),
    commentary: [],
  };
}

export interface ReportNarrativeValidation { ok: boolean; issues: string[] }

interface ValidationContext {
  facts: Map<string, ReportInsightFact>;
  insights: ReportInsights;
  entities: Set<string>;
  locale: ReportPdfLocale;
  maxChars: number;
  contextValues: AllowedValue[];
  /** Relative changes withheld for a small comparison base (never quotable). */
  hiddenPercents: number[];
  /** The tenant's labels (reportLabelPattern): blanked like entity tokens. */
  labels: RegExp | null;
}

/** A tenant label counts like an entity token in the length limit: at most 64 characters, it is a name, not prose. */
const LABEL_LENGTH_PLACEHOLDER = '{{U1}}';

function validateItem(item: ReportPdfNarrativeItem, label: string, context: ValidationContext, options: { describesData: boolean }): string[] {
  const issues: string[] = [];
  const text = item.text.trim();
  if (!text) return [`${label}: empty`];
  const measured = context.labels ? text.normalize('NFC').replace(context.labels, LABEL_LENGTH_PLACEHOLDER) : text;
  if (measured.length > context.maxChars) issues.push(`${label}: too_long`);
  for (const match of text.matchAll(ENTITY_TOKEN)) {
    if (!context.entities.has(match[1])) issues.push(`${label}: unknown_entity:${match[1]}`);
  }
  const stripped = blankEntityTokens(text, context.labels);
  if (/[{}]/.test(stripped)) issues.push(`${label}: malformed_token`);
  if (/[<>]/.test(stripped)) issues.push(`${label}: markup`);
  const cited = item.factIds.map((id) => context.facts.get(id));
  const unknownFacts = item.factIds.filter((_id, index) => !cited[index]);
  if (unknownFacts.length) issues.push(`${label}: unknown_fact:${unknownFacts.join(',')}`);
  const facts = cited.filter((fact): fact is ReportInsightFact => Boolean(fact));
  const allowed = [...context.contextValues, ...facts.flatMap((fact) => allowedValuesOf(fact, context.insights))];
  let previousEnd = 0;
  for (const number of extractReportNarrativeNumbers(text, context.locale, context.labels)) {
    // "+795,7%" from 47 to 421 enrollments was withheld on purpose: quoting it is an error of its own.
    const hidden = number.unit === 'percent' && context.hiddenPercents.some((value) => sameRounded(value, number))
      && !allowed.some((value) => sameRounded(value.value, number) && unitAccepts(number.unit, value.unit));
    const issue = hidden ? 'small_base_percent' : checkNumber(number, allowed, directionBefore(stripped, previousEnd, number.start));
    if (issue) issues.push(`${label}: ${issue}:${number.raw}`);
    previousEnd = number.end;
  }
  // Without any number, "Tỉ lệ hoàn thành giảm" still claims a direction: it
  // must match at least one cited change. Recommendations are actions
  // ("Giảm số lượt chưa bắt đầu..."), not claims, so they are exempt.
  const words = sentenceDirections(stripped);
  if (options.describesData && words.size === 1) {
    const [claimed] = [...words];
    const moving = facts.map((fact) => factDirection(fact, context.insights)).filter((direction): direction is Direction => direction !== null);
    if (moving.length && !moving.includes(claimed)) issues.push(`${label}: direction_mismatch`);
  }
  return issues;
}

/**
 * Every number of every sentence must match a value of the facts that
 * sentence cites (unit and sign included) and every direction word must agree
 * with the sign of the cited change. Any issue rejects the AI narrative.
 */
export function validateReportPdfNarrative(narrative: ReportPdfNarrative, insights: ReportInsights, locale: ReportPdfLocale): ReportNarrativeValidation {
  const limits = REPORT_PDF_NARRATIVE_LIMITS;
  const facts = new Map(insights.facts.map((fact) => [fact.id, fact]));
  const context: ValidationContext = {
    facts,
    insights,
    entities: new Set(insights.entities.map((entity) => entity.token)),
    locale,
    maxChars: limits.itemMaxChars,
    contextValues: Object.values(facts.get('context.period')?.values ?? {}).map((value) => ({ value, unit: 'count' as const, signed: false, direction: null })),
    hiddenPercents: insights.hiddenPercentChanges,
    labels: reportLabelPattern(insights.labels),
  };
  const issues: string[] = [];
  const data = { describesData: true };
  issues.push(...validateItem(narrative.headline, 'headline', { ...context, maxChars: limits.headlineMaxChars }, data));
  const minFindings = insights.available ? limits.minFindings : 1;
  if (narrative.findings.length < minFindings || narrative.findings.length > limits.maxFindings) issues.push('findings: count');
  if (narrative.risks.length > limits.maxRisks) issues.push('risks: count');
  if (narrative.recommendations.length < 1 || narrative.recommendations.length > limits.maxRecommendations) issues.push('recommendations: count');
  narrative.findings.forEach((item, index) => issues.push(...validateItem(item, `findings[${index}]`, context, data)));
  narrative.risks.forEach((item, index) => issues.push(...validateItem(item, `risks[${index}]`, context, data)));
  // An action is one of the deterministic candidates (selected, maybe reworded):
  // it cites that candidate's facts and names only that candidate's courses/units.
  const candidates = new Map(buildReportRecommendationCandidates(insights, locale).map((candidate) => [candidate.id, candidate]));
  narrative.recommendations.forEach((item, index) => {
    if (item.origin === 'chat') return;
    const label = `recommendations[${index}]`;
    const candidate = item.recId ? candidates.get(item.recId) : undefined;
    if (!candidate) {
      issues.push(`${label}: unknown_recommendation`);
      return;
    }
    const allowedTokens = new Set([...candidate.text.matchAll(ENTITY_TOKEN)].map((match) => match[1]));
    for (const match of item.text.matchAll(ENTITY_TOKEN)) {
      if (!allowedTokens.has(match[1])) issues.push(`${label}: recommendation_entity:${match[1]}`);
    }
    issues.push(...validateItem({ ...item, factIds: candidate.factIds }, label, context, { describesData: false }));
  });
  // Tenant labels are names in any language ("Bộ phận" in an English report): the language check skips them.
  const allText = [narrative.headline, ...narrative.findings, ...narrative.risks, ...narrative.recommendations]
    .map((item) => blankEntityTokens(item.text, context.labels)).join(' ');
  if (locale === 'vi' && !VIETNAMESE_CHARS.test(allText)) issues.push('language: expected_vietnamese');
  if (locale === 'en' && VIETNAMESE_CHARS.test(allText)) issues.push('language: expected_english');
  return { ok: issues.length === 0, issues };
}

// ── Stored chat narrative reuse ───────────────────────────────

const StoredChatNarrativeSchema = z.object({
  selected_signal_ids: z.array(z.string().trim().min(1).max(80)).max(5),
  interpretation: z.array(z.string().trim().min(1).max(220)).max(3),
  recommended_actions: z.array(z.object({
    signal_id: z.string().trim().min(1).max(80).nullable(),
    priority: z.enum(['high', 'medium', 'low']),
    action: z.string().trim().min(1).max(220),
  })).max(3),
  limitations: z.array(z.string().trim().min(1).max(180)).max(5),
});

const SIGNAL_TO_FACT: Record<string, string> = {
  completion_decline: 'signal.completion_decline',
  high_enrollment_low_completion: 'risk.watchlist',
  end_period_activity_drop: 'signal.activity_drop',
  enrollment_period_change: 'kpi.total_enrollments',
};

/**
 * The chat card already showed this narrative. It is reused only when it is
 * valid for the snapshot (no numbers, known signal ids), written in the PDF
 * locale, and substantive (the chat fallback has no interpretation lines).
 */
export function mergeStoredChatNarrative(input: {
  narrative: ReportPdfNarrative;
  stored: unknown;
  storedLocale: ReportPdfLocale;
  locale: ReportPdfLocale;
  snapshot: StoredReportChatSnapshot;
}): ReportPdfNarrative {
  if (input.snapshot.version !== 2 || input.storedLocale !== input.locale) return input.narrative;
  const parsed = StoredChatNarrativeSchema.safeParse(input.stored);
  if (!parsed.success || !parsed.data.interpretation.length || !isReportNarrativeAllowed(parsed.data, input.snapshot)) return input.narrative;
  const language = parsed.data.interpretation.join(' ');
  if ((input.locale === 'vi') !== VIETNAMESE_CHARS.test(language)) return input.narrative;
  // The report's own actions carry the numbers and targets. A chat action is
  // kept only when it is tied to a detected signal the report has no action
  // for yet; untied (generic) chat actions are dropped.
  const coveredFacts = new Set(input.narrative.recommendations.flatMap((item) => item.factIds));
  const chatActions: ReportPdfNarrativeItem[] = parsed.data.recommended_actions.flatMap((action) => {
    const factId = action.signal_id ? SIGNAL_TO_FACT[action.signal_id] : undefined;
    if (!factId || coveredFacts.has(factId)) return [];
    coveredFacts.add(factId);
    return [{ text: action.action, factIds: [factId], priority: action.priority, tone: 'attention' as const, origin: 'chat' as const }];
  });
  return {
    ...input.narrative,
    commentary: parsed.data.interpretation.slice(0, REPORT_PDF_NARRATIVE_LIMITS.maxCommentary),
    recommendations: [...input.narrative.recommendations, ...chatActions].slice(0, REPORT_PDF_NARRATIVE_LIMITS.maxRecommendations),
  };
}

// ── Gemini contract ───────────────────────────────────────────

const AiItemSchema = z.object({
  text: z.string().trim().min(1).max(REPORT_PDF_NARRATIVE_LIMITS.itemMaxChars),
  fact_ids: z.array(z.string().trim().min(1).max(64)).min(1).max(6),
});
/** An AI recommendation only selects and rewords a deterministic candidate (its id, facts and priority are kept). */
const AiRecommendationSchema = z.object({
  rec_id: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(REPORT_PDF_NARRATIVE_LIMITS.itemMaxChars),
});
export const ReportPdfAiNarrativeSchema = z.object({
  headline: AiItemSchema.extend({ text: z.string().trim().min(1).max(REPORT_PDF_NARRATIVE_LIMITS.headlineMaxChars) }),
  findings: z.array(AiItemSchema).min(1).max(REPORT_PDF_NARRATIVE_LIMITS.maxFindings),
  risks: z.array(AiItemSchema).max(REPORT_PDF_NARRATIVE_LIMITS.maxRisks),
  recommendations: z.array(AiRecommendationSchema).min(1).max(REPORT_PDF_NARRATIVE_LIMITS.maxRecommendations),
});

export function buildReportPdfAiNarrativeRequest(insights: ReportInsights, locale: ReportPdfLocale): { systemInstruction: string; payload: string } {
  const language = locale === 'vi' ? 'Vietnamese (vi-VN)' : 'English (en)';
  const numberFormat = locale === 'vi' ? 'thousands separator "." and decimal comma "," (e.g. 1.234,5)' : 'thousands separator "," and decimal point "." (e.g. 1,234.5)';
  const facts = insights.facts.filter((fact) => fact.kind !== 'context').map((fact) => ({
    id: fact.id,
    kind: fact.kind,
    tone: fact.tone,
    priority: Math.round(fact.priority),
    statement: describeReportFact(fact, insights, locale),
  })).filter((fact) => fact.statement);
  const systemInstruction = [
    'You write the executive narrative of a corporate learning-analytics PDF report. Return JSON only.',
    `Write every sentence in ${language}. Numbers must use the ${numberFormat} format.`,
    'Use ONLY the supplied facts. Every item must list in fact_ids the ids of the facts it uses.',
    'Copy numbers exactly as written in the cited fact statements. Never compute, round differently, estimate or invent numbers, dates, ratios or rankings.',
    'Keep the unit (%, percentage points, counts) and the direction (increase or decrease) each number has in its statement.',
    'Refer to courses and units only with their tokens such as {{C1}} or {{U1}}, exactly as given. Never invent names.',
    'Organization level names in the statements are the organization\'s own terms: keep them exactly as written, never translate or replace them.',
    'Do not speculate about causes.',
    'recommendations: select 1 to 5 entries of recommendation_candidates, most important first. For each, set rec_id to the candidate id and rewrite its statement in plain words; keep every number, target and token it contains and add no other action, number or name.',
    'headline: one sentence. findings: 3 to 5 sentences. risks: 0 to 4 sentences built from risk facts.',
    'Do not mention AI, prompts, tools, databases, snapshots, tokens or fact ids in the text.',
  ].join(' ');
  return {
    systemInstruction,
    payload: JSON.stringify({
      period_days: insights.period.days,
      comparison: insights.comparisonBasis,
      data_available: insights.available,
      facts,
      recommendation_candidates: buildReportRecommendationCandidates(insights, locale).map((candidate) => ({ id: candidate.id, priority: candidate.priority, statement: candidate.text })),
    }),
  };
}

/** Converts a schema-valid Gemini response into a narrative (validation happens separately). */
export function toReportPdfAiNarrative(raw: unknown, insights: ReportInsights, locale: ReportPdfLocale): ReportPdfNarrative | null {
  const parsed = ReportPdfAiNarrativeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const candidates = new Map(buildReportRecommendationCandidates(insights, locale).map((candidate) => [candidate.id, candidate]));
  const facts = new Map(insights.facts.map((fact) => [fact.id, fact]));
  const toneOf = (ids: string[]): ReportInsightTone => facts.get(ids[0])?.tone ?? 'neutral';
  const item = (value: { text: string; fact_ids: string[] }) => ({ text: value.text, factIds: value.fact_ids, tone: toneOf(value.fact_ids) });
  return {
    source: 'ai',
    headline: item(parsed.data.headline),
    findings: parsed.data.findings.map(item),
    risks: parsed.data.risks.map(item),
    // Facts and priority come from the selected candidate; an unknown rec_id is rejected by the validator.
    recommendations: parsed.data.recommendations.map((value) => {
      const candidate = candidates.get(value.rec_id);
      return { text: value.text, recId: value.rec_id, factIds: candidate?.factIds ?? [], priority: candidate?.priority ?? 'medium', tone: candidate?.tone ?? 'neutral' };
    }),
    commentary: [],
  };
}
