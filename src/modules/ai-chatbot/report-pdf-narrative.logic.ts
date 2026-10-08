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
  formatReportMonth,
  formatReportNumber,
  formatReportPercent,
  formatReportPercentagePoints,
  getReportPdfDictionary,
  type ReportPdfLocale,
} from './report-pdf-i18n.js';
import { REPORT_INSIGHT_THRESHOLDS, type ReportInsightFact, type ReportInsights, type ReportInsightTone, type ReportKpiInsight } from './report-insights.logic.js';

export type ReportPdfNarrativePriority = 'high' | 'medium' | 'low';
export interface ReportPdfNarrativeItem {
  text: string;
  factIds: string[];
  tone: ReportInsightTone;
  priority?: ReportPdfNarrativePriority;
  origin?: 'chat';
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

const ENTITY_TOKEN = /\{\{([CU]\d{1,3})\}\}/g;
const VIETNAMESE_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const token = (value: string) => `{{${value}}}`;

function formatFactDate(values: Record<string, number>, prefix: string, locale: ReportPdfLocale): string {
  const year = values[`${prefix}_year`];
  const month = values[`${prefix}_month`];
  const day = values[`${prefix}_day`];
  if (!year || !month) return '';
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  return day ? formatReportDate(`${ym}-${String(day).padStart(2, '0')}`, locale) : formatReportMonth(ym, locale);
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
  return kpi.deltaPercent === null
    ? dict.narrative.changeCountNoPct({ direction, delta, suffix })
    : dict.narrative.changeCount({ direction, delta, pct: formatReportPercent(Math.abs(kpi.deltaPercent), locale), suffix });
}

/** One localized, tokenized sentence per fact. Every number comes from fact.values. */
export function describeReportFact(fact: ReportInsightFact, insights: ReportInsights, locale: ReportPdfLocale): string | null {
  const dict = getReportPdfDictionary(locale);
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
      return t.trendPeak({ date: formatFactDate(v, 'peak', locale), value: n(v.value), ratio: n(v.ratio, 1) });
    case 'trend_momentum':
      return (v.direction > 0 ? t.trendMomentumUp : t.trendMomentumDown)({ last: n(v.last, 1), first: n(v.first, 1), unit: perUnit(insights, locale) });
    case 'trend_vs_previous':
      return t.trendVsPrevious({ avg: n(v.avg, 1), unit: perUnit(insights, locale), direction: dict.direction[v.direction > 0 ? 'up' : 'down'], pct: pct(v.pct), previous: n(v.previous, 1) });
    case 'trend_spikes':
      return t.trendSpikes({ count: n(v.count), date: formatFactDate(v, 'spike', locale), value: n(v.value) });
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
      return t.enrollmentDrop({ delta: n(v.delta), pct: pct(v.pct), suffix });
    case 'active_learner_drop':
      return t.activeDrop({ delta: n(v.delta), pct: pct(v.pct), suffix });
    case 'backlog_concentration':
      return t.backlog({ course: entity(), share: pct(v.share), count: n(v.count) });
    case 'unit_gap':
      return t.unitRanking({ best: entity(1), bestRate: pct(v.best_rate), worst: entity(0), worstRate: pct(v.worst_rate), gap: pp(v.gap) });
    default:
      return null;
  }
}

const RISK_KINDS = new Set<ReportInsightFact['kind']>(['completion_decline', 'course_watchlist', 'activity_drop', 'activation_risk',
  'backlog_concentration', 'enrollment_drop', 'active_learner_drop', 'unit_gap']);

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
  const riskIds = new Set(insights.facts.filter((fact) => RISK_KINDS.has(fact.kind)).map((fact) => fact.id));
  const watchTokens = new Set(insights.facts.find((fact) => fact.id === 'risk.watchlist')?.entities ?? []);
  const excluded = new Set(headline.factIds);
  if (riskIds.has('risk.unit_gap')) excluded.add('units.ranking');
  const candidates = insights.facts
    .filter((fact) => fact.kind !== 'context' && !RISK_KINDS.has(fact.kind) && !excluded.has(fact.id))
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

function buildRecommendations(insights: ReportInsights, locale: ReportPdfLocale): ReportPdfNarrativeItem[] {
  const t = getReportPdfDictionary(locale).narrative;
  const n = (value: number | undefined) => formatReportNumber(value ?? 0, locale);
  const pct = (value: number | undefined) => formatReportPercent(value ?? 0, locale);
  const items: ReportPdfNarrativeItem[] = [];
  const push = (text: string, factIds: string[], priority: ReportPdfNarrativePriority, tone: ReportInsightTone = 'attention') => {
    if (!items.some((item) => item.text === text)) items.push({ text, factIds, priority, tone });
  };
  if (!insights.available) {
    push(t.recStart, ['kpi.total_enrollments'], 'medium', 'neutral');
    push(t.recMonitor, ['kpi.total_enrollments'], 'low', 'neutral');
    return items;
  }
  for (const item of insights.attention) {
    const fact = insights.facts.find((candidate) => candidate.id === item.factId)!;
    const v = fact.values;
    const entity = fact.entities[0] ? token(fact.entities[0]) : '';
    switch (fact.kind) {
      case 'completion_decline': push(t.recCompletionDecline, [fact.id], 'high'); break;
      case 'course_watchlist': push(t.recWatchlist({ course: entity, count: n(v.count) }), [fact.id], 'high'); break;
      case 'activation_risk': push(t.recActivation({ count: n(v.count) }), [fact.id], v.share >= 50 ? 'high' : 'medium'); break;
      case 'activity_drop': push(t.recActivityDrop, [fact.id], 'medium'); break;
      case 'enrollment_drop': push(t.recEnrollmentDrop, [fact.id], 'medium'); break;
      case 'active_learner_drop': push(t.recActiveDrop, [fact.id], 'medium'); break;
      case 'backlog_concentration': push(t.recBacklog({ course: entity, share: pct(v.share) }), [fact.id], 'medium'); break;
      case 'unit_gap': push(t.recUnitGap({ unit: entity }), [fact.id], 'medium'); break;
      default: break;
    }
  }
  const fact = (id: string) => insights.facts.find((candidate) => candidate.id === id);
  const momentum = fact('trend.enrollments.momentum');
  if (momentum && momentum.values.direction < 0) push(t.recMomentum, [momentum.id], 'medium');
  const low = fact('courses.low');
  const watchTokens = new Set(fact('risk.watchlist')?.entities ?? []);
  if (low?.entities[0] && low.tone === 'negative' && !watchTokens.has(low.entities[0])) push(t.recReviewCourse({ course: token(low.entities[0]) }), [low.id], 'medium');
  const status = fact('status.mix');
  if (status && status.values.in_progress_share >= REPORT_INSIGHT_THRESHOLDS.inProgressNudgeShare) {
    push(t.recNudgeInProgress({ count: n(status.values.in_progress) }), [status.id], 'medium', 'neutral');
  }
  const concentration = insights.facts.find((fact) => fact.id === 'courses.concentration');
  if (concentration && concentration.tone === 'attention') {
    push(t.recConcentration({ n: n(concentration.values.n), share: pct(concentration.values.share) }), [concentration.id], 'low', 'neutral');
  }
  const top = insights.facts.find((fact) => fact.id === 'courses.top');
  if (top?.entities[0]) push(t.recReplicate({ course: token(top.entities[0]) }), [top.id], 'low', 'positive');
  if (items.length < REPORT_PDF_NARRATIVE_LIMITS.minRecommendations) push(t.recMonitor, ['kpi.total_enrollments'], 'low', 'neutral');
  const rank: Record<ReportPdfNarrativePriority, number> = { high: 0, medium: 1, low: 2 };
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => rank[left.item.priority ?? 'medium'] - rank[right.item.priority ?? 'medium'] || left.index - right.index)
    .map(({ item }) => item)
    .slice(0, REPORT_PDF_NARRATIVE_LIMITS.maxRecommendations);
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

// ── Number validator ──────────────────────────────────────────

export interface ReportNarrativeNumber { raw: string; value: number; decimals: number }

/** Extracts numbers written in the locale's format (vi: 1.234,5 · en: 1,234.5). */
export function extractReportNarrativeNumbers(text: string, locale: ReportPdfLocale): ReportNarrativeNumber[] {
  const stripped = text.replace(ENTITY_TOKEN, ' ');
  const pattern = locale === 'vi'
    ? /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g
    : /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
  return [...stripped.matchAll(pattern)].map((match) => {
    const raw = match[0];
    const [integer, fraction = ''] = locale === 'vi' ? raw.split(',') : raw.split('.');
    const normalized = `${integer.replace(/[.,]/g, '')}${fraction ? `.${fraction}` : ''}`;
    return { raw, value: Number(normalized), decimals: fraction.length };
  });
}

function matchesAllowedNumber(number: ReportNarrativeNumber, allowed: number[]): boolean {
  return allowed.some((candidate) => {
    const value = Math.abs(candidate);
    const factor = 10 ** number.decimals;
    return Math.abs(Math.round(value * factor) / factor - number.value) < 1e-9;
  });
}

export interface ReportNarrativeValidation { ok: boolean; issues: string[] }

function validateItem(item: ReportPdfNarrativeItem, label: string, context: {
  facts: Map<string, ReportInsightFact>; entities: Set<string>; locale: ReportPdfLocale; maxChars: number; contextNumbers: number[];
}): string[] {
  const issues: string[] = [];
  const text = item.text.trim();
  if (!text) return [`${label}: empty`];
  if (text.length > context.maxChars) issues.push(`${label}: too_long`);
  for (const match of text.matchAll(ENTITY_TOKEN)) {
    if (!context.entities.has(match[1])) issues.push(`${label}: unknown_entity:${match[1]}`);
  }
  if (/[{}]/.test(text.replace(ENTITY_TOKEN, ''))) issues.push(`${label}: malformed_token`);
  if (/[<>]/.test(text)) issues.push(`${label}: markup`);
  const unknownFacts = item.factIds.filter((id) => !context.facts.has(id));
  if (unknownFacts.length) issues.push(`${label}: unknown_fact:${unknownFacts.join(',')}`);
  const allowed = [...context.contextNumbers, ...item.factIds.flatMap((id) => Object.values(context.facts.get(id)?.values ?? {}))];
  for (const number of extractReportNarrativeNumbers(text, context.locale)) {
    if (!matchesAllowedNumber(number, allowed)) issues.push(`${label}: number_not_in_facts:${number.raw}`);
  }
  return issues;
}

/** Every number of every sentence must match a value of the facts that sentence cites. */
export function validateReportPdfNarrative(narrative: ReportPdfNarrative, insights: ReportInsights, locale: ReportPdfLocale): ReportNarrativeValidation {
  const limits = REPORT_PDF_NARRATIVE_LIMITS;
  const facts = new Map(insights.facts.map((fact) => [fact.id, fact]));
  const context = {
    facts,
    entities: new Set(insights.entities.map((entity) => entity.token)),
    locale,
    maxChars: limits.itemMaxChars,
    contextNumbers: Object.values(facts.get('context.period')?.values ?? {}),
  };
  const issues: string[] = [];
  issues.push(...validateItem(narrative.headline, 'headline', { ...context, maxChars: limits.headlineMaxChars }));
  const minFindings = insights.available ? limits.minFindings : 1;
  if (narrative.findings.length < minFindings || narrative.findings.length > limits.maxFindings) issues.push('findings: count');
  if (narrative.risks.length > limits.maxRisks) issues.push('risks: count');
  if (narrative.recommendations.length < 1 || narrative.recommendations.length > limits.maxRecommendations) issues.push('recommendations: count');
  narrative.findings.forEach((item, index) => issues.push(...validateItem(item, `findings[${index}]`, context)));
  narrative.risks.forEach((item, index) => issues.push(...validateItem(item, `risks[${index}]`, context)));
  narrative.recommendations.filter((item) => item.origin !== 'chat')
    .forEach((item, index) => issues.push(...validateItem(item, `recommendations[${index}]`, context)));
  const allText = [narrative.headline, ...narrative.findings, ...narrative.risks, ...narrative.recommendations]
    .map((item) => item.text.replace(ENTITY_TOKEN, '')).join(' ');
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
  const chatActions: ReportPdfNarrativeItem[] = parsed.data.recommended_actions.map((action) => ({
    text: action.action,
    factIds: action.signal_id && SIGNAL_TO_FACT[action.signal_id] ? [SIGNAL_TO_FACT[action.signal_id]] : [],
    priority: action.priority,
    tone: 'attention',
    origin: 'chat',
  }));
  const coveredFacts = new Set(chatActions.flatMap((action) => action.factIds));
  const remaining = input.narrative.recommendations.filter((item) => !item.factIds.some((id) => coveredFacts.has(id)));
  return {
    ...input.narrative,
    commentary: parsed.data.interpretation.slice(0, REPORT_PDF_NARRATIVE_LIMITS.maxCommentary),
    recommendations: [...chatActions, ...remaining].slice(0, REPORT_PDF_NARRATIVE_LIMITS.maxRecommendations),
  };
}

// ── Gemini contract ───────────────────────────────────────────

const AiItemSchema = z.object({
  text: z.string().trim().min(1).max(REPORT_PDF_NARRATIVE_LIMITS.itemMaxChars),
  fact_ids: z.array(z.string().trim().min(1).max(64)).min(1).max(6),
});
export const ReportPdfAiNarrativeSchema = z.object({
  headline: AiItemSchema.extend({ text: z.string().trim().min(1).max(REPORT_PDF_NARRATIVE_LIMITS.headlineMaxChars) }),
  findings: z.array(AiItemSchema).min(1).max(REPORT_PDF_NARRATIVE_LIMITS.maxFindings),
  risks: z.array(AiItemSchema).max(REPORT_PDF_NARRATIVE_LIMITS.maxRisks),
  recommendations: z.array(AiItemSchema.extend({ priority: z.enum(['high', 'medium', 'low']) })).min(1).max(REPORT_PDF_NARRATIVE_LIMITS.maxRecommendations),
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
    'Refer to courses and units only with their tokens such as {{C1}} or {{U1}}, exactly as given. Never invent names.',
    'Do not speculate about causes. Recommendations must be concrete operational actions tied to risk or finding facts.',
    'headline: one sentence. findings: 3 to 5 sentences. risks: 0 to 4 sentences built from risk facts. recommendations: 2 to 5 actions with priority high, medium or low.',
    'Do not mention AI, prompts, tools, databases, snapshots, tokens or fact ids in the text.',
  ].join(' ');
  return {
    systemInstruction,
    payload: JSON.stringify({
      period_days: insights.period.days,
      comparison: insights.comparisonBasis,
      data_available: insights.available,
      facts,
    }),
  };
}

/** Converts a schema-valid Gemini response into a narrative (validation happens separately). */
export function toReportPdfAiNarrative(raw: unknown, insights: ReportInsights): ReportPdfNarrative | null {
  const parsed = ReportPdfAiNarrativeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const facts = new Map(insights.facts.map((fact) => [fact.id, fact]));
  const toneOf = (ids: string[]): ReportInsightTone => facts.get(ids[0])?.tone ?? 'neutral';
  const item = (value: { text: string; fact_ids: string[] }) => ({ text: value.text, factIds: value.fact_ids, tone: toneOf(value.fact_ids) });
  return {
    source: 'ai',
    headline: item(parsed.data.headline),
    findings: parsed.data.findings.map(item),
    risks: parsed.data.risks.map(item),
    recommendations: parsed.data.recommendations.map((value) => ({ ...item(value), priority: value.priority })),
    commentary: [],
  };
}
