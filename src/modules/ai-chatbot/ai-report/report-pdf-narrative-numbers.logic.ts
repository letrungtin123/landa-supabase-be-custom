// Numbers and direction words of a report narrative: extraction in the vi/en number formats,
// the values and directions a cited fact allows, and the check of one number. Split out of
// report-pdf-narrative.logic.ts (move only), whose narrative validator uses them and which
// re-exports the public names.

import type { ReportPdfLocale } from './report-pdf-i18n.js';
import type { ReportInsightFact, ReportInsights } from './report-insights.logic.js';
import { reportLabelTerms, type ReportTenantLabels } from './report-labels.logic.js';

export const ENTITY_TOKEN = /\{\{([CU]\d{1,3})\}\}/g;

// ── Number validator ──────────────────────────────────────────
// A number in the text must equal (after the text's own rounding) a value of
// a fact the sentence cites, with a compatible unit (a "%" from a percentage
// or percentage-point field, "điểm %"/"pp" from a percentage-point field, a
// plain number from a count/average/ratio/date field) and a compatible sign.
// A direction word ("tăng/giảm", "rose/fell", "up/down"...) must agree with
// the sign of the change it describes.

/** Unit of a number: `count` covers every plain number (counts, averages, ratios, dates, days). */
export type ReportNarrativeUnit = 'count' | 'percent' | 'pp';
export type Direction = -1 | 0 | 1;

export interface ReportNarrativeNumber {
  raw: string;
  value: number;
  decimals: number;
  /** An explicit "-"/"−" or "+" attached to the number, else null. */
  sign: -1 | 1 | null;
  unit: ReportNarrativeUnit;
  /** Offsets in the text with entity tokens blanked out. */
  start: number;
  end: number;
}

const PP_SUFFIX = /^\s?(?:điểm\s?(?:%|phần\s+trăm)|điểm(?![\p{L}\p{N}])|pp(?![\p{L}\p{N}])|p\.p\.|percentage\s+points?(?![\p{L}\p{N}])|points?(?![\p{L}\p{N}]))/iu;
const PERCENT_SUFFIX = /^\s?(?:%|phần\s+trăm(?![\p{L}\p{N}])|per\s?cent(?![\p{L}\p{N}]))/iu;
const SIGN_PREFIX = /(?:^|[\s([:;,])([-−+])$/u;

/**
 * Extracts numbers written in the locale's format (vi: 1.234,5 · en: 1,234.5)
 * with their sign and unit. Entity tokens and tenant labels (`labels`, from
 * reportLabelPattern) are not part of the claim and are skipped.
 */
export function extractReportNarrativeNumbers(text: string, locale: ReportPdfLocale, labels: RegExp | null = null): ReportNarrativeNumber[] {
  const stripped = blankEntityTokens(text, labels);
  const pattern = locale === 'vi'
    ? /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g
    : /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
  return [...stripped.matchAll(pattern)].map((match) => {
    const raw = match[0];
    const start = match.index ?? 0;
    const end = start + raw.length;
    const [integer, fraction = ''] = locale === 'vi' ? raw.split(',') : raw.split('.');
    const normalized = `${integer.replace(/[.,]/g, '')}${fraction ? `.${fraction}` : ''}`;
    const sign = SIGN_PREFIX.exec(stripped.slice(Math.max(0, start - 2), start))?.[1];
    const after = stripped.slice(end);
    const unit: ReportNarrativeUnit = PP_SUFFIX.test(after) ? 'pp' : PERCENT_SUFFIX.test(after) ? 'percent' : 'count';
    return { raw, value: Number(normalized), decimals: fraction.length, sign: sign === undefined ? null : sign === '+' ? 1 : -1, unit, start, end };
  });
}

/** NFC text with entity tokens (and tenant labels) replaced by blanks of the same length (offsets stay valid). */
export function blankEntityTokens(text: string, labels: RegExp | null = null): string {
  const blank = (match: string) => ' '.repeat(match.length);
  const tokensBlanked = text.normalize('NFC').replace(ENTITY_TOKEN, blank);
  return labels ? tokensBlanked.replace(labels, blank) : tokensBlanked;
}

/**
 * Whole-word, case-insensitive pattern of the tenant's configured labels, or
 * null without any. A label is a name, like an entity token: its digits,
 * direction words or language are never read as a claim.
 */
export function reportLabelPattern(labels: ReportTenantLabels): RegExp | null {
  const terms = reportLabelTerms(labels).map((term) => term.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'));
  return terms.length ? new RegExp(`${WORD_START}(?:${terms.join('|')})${WORD_END}`, 'giu') : null;
}

// Direction words. "Strong" words carry a direction anywhere in their clause;
// the short "up/down/lên/xuống" only right before the number they qualify.
// Compounds that are not a change of the metric ("tăng cường", "giảm thiểu")
// are excluded.
const WORD_START = '(?<![\\p{L}\\p{N}])';
const WORD_END = '(?![\\p{L}\\p{N}])';
const UP_WORDS = new RegExp(`${WORD_START}(?:tăng(?!\\s+cường)|gia tăng|cao hơn|nhiều hơn|rose|risen|rises?|rising|increased?|increases|increasing|grew|grown|grows?|growing|climbed|gained|higher)${WORD_END}`, 'giu');
const DOWN_WORDS = new RegExp(`${WORD_START}(?:giảm(?!\\s+thiểu)|sụt|thấp hơn|ít hơn|chậm lại|fell|fallen|falls?|falling|decreased?|decreases|decreasing|declined?|declines|declining|dropped|drops?|dropping|lower|slowed|shrank|shrunk)${WORD_END}`, 'giu');
const WEAK_DIRECTION_TAIL = new RegExp(`${WORD_START}(up|down|lên|xuống)(?:\\s+by)?\\s*$`, 'iu');
const CLAUSE_BOUNDARY = new RegExp(`[,;:.!?()\\[\\]]|${WORD_START}(?:và|nhưng|trong khi|còn|and|but|while|whereas)${WORD_END}`, 'giu');

function lastStrongDirection(text: string): { direction: Direction; index: number } | null {
  let last: { direction: Direction; index: number } | null = null;
  for (const [pattern, direction] of [[UP_WORDS, 1], [DOWN_WORDS, -1]] as const) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (!last || index > last.index) last = { direction, index };
    }
  }
  return last;
}

/** Direction word qualifying a number: the last one in its clause, between the previous number and it. */
export function directionBefore(text: string, previousEnd: number, start: number): Direction | null {
  let clause = text.slice(previousEnd, start);
  let cut = 0;
  for (const match of clause.matchAll(CLAUSE_BOUNDARY)) cut = (match.index ?? 0) + match[0].length;
  clause = clause.slice(cut);
  const weak = WEAK_DIRECTION_TAIL.exec(clause)?.[1]?.toLowerCase();
  if (weak) return weak === 'up' || weak === 'lên' ? 1 : -1;
  return lastStrongDirection(clause)?.direction ?? null;
}

/** Directions of the strong direction words of a sentence. */
export function sentenceDirections(text: string): Set<Direction> {
  const directions = new Set<Direction>();
  if (text.match(UP_WORDS)) directions.add(1);
  if (text.match(DOWN_WORDS)) directions.add(-1);
  return directions;
}

export interface AllowedValue {
  value: number;
  unit: ReportNarrativeUnit;
  /** A change (delta) value: `value` carries the sign of the change. */
  signed: boolean;
  /** Direction of the change the fact describes, null when it describes none. */
  direction: Direction | null;
}

const FACT_VALUE_UNITS: Partial<Record<ReportInsightFact['kind'], Record<string, ReportNarrativeUnit>>> = {
  status_mix: { completed_share: 'percent', in_progress_share: 'percent', not_started_share: 'percent' },
  concentration: { share: 'percent', top_share: 'percent', threshold: 'percent' },
  top_performer: { rate: 'percent' },
  low_performer: { rate: 'percent' },
  spread: { spread: 'pp', best: 'percent', worst: 'percent' },
  trend_vs_previous: { pct: 'percent' },
  trend_momentum: { pct: 'percent' },
  active_trend_momentum: { pct: 'percent' },
  unit_ranking: { best_rate: 'percent', worst_rate: 'percent', gap: 'pp' },
  unit_gap: { best_rate: 'percent', worst_rate: 'percent', gap: 'pp' },
  unit_decline: { current: 'percent', previous: 'percent', delta: 'pp', threshold: 'pp' },
  unit_low_completion: { max: 'percent', rate: 'percent' },
  completion_decline: { current: 'percent', previous: 'percent', delta: 'pp', threshold: 'pp' },
  course_watchlist: { max: 'percent', rate: 'percent' },
  activation_risk: { share: 'percent', threshold: 'percent' },
  course_activation_risk: { share: 'percent', threshold: 'percent' },
  enrollment_drop: { pct: 'percent' },
  active_learner_drop: { pct: 'percent' },
  backlog_concentration: { share: 'percent' },
};

/** Change values: stored as magnitudes, signed here with the fact's direction. */
const SIGNED_FACT_VALUES: Partial<Record<ReportInsightFact['kind'], readonly string[]>> = {
  kpi: ['delta', 'delta_percent'],
  trend_vs_previous: ['pct'],
  trend_momentum: ['pct'],
  active_trend_momentum: ['pct'],
  completion_decline: ['delta'],
  enrollment_drop: ['delta', 'pct'],
  active_learner_drop: ['delta', 'pct'],
  unit_decline: ['delta'],
};

const DECLINE_KINDS = new Set<ReportInsightFact['kind']>(['completion_decline', 'enrollment_drop', 'active_learner_drop', 'activity_drop', 'unit_decline']);
const SIGNED_TREND_KINDS = new Set<ReportInsightFact['kind']>(['trend_vs_previous', 'trend_momentum', 'active_trend_momentum']);

const sign = (value: number): Direction => (value > 0 ? 1 : value < 0 ? -1 : 0);

export function factDirection(fact: ReportInsightFact, insights: ReportInsights): Direction | null {
  if (fact.kind === 'kpi') {
    const delta = insights.kpis.find((kpi) => `kpi.${kpi.id}` === fact.id)?.delta;
    return delta === null || delta === undefined ? null : sign(delta);
  }
  if (SIGNED_TREND_KINDS.has(fact.kind)) return fact.values.direction === undefined ? null : sign(fact.values.direction);
  return DECLINE_KINDS.has(fact.kind) ? -1 : null;
}

function factValueUnit(fact: ReportInsightFact, key: string, insights: ReportInsights): ReportNarrativeUnit {
  if (fact.kind === 'kpi') {
    const percentage = insights.kpis.find((kpi) => `kpi.${kpi.id}` === fact.id)?.unit === 'percentage';
    if (key === 'delta') return percentage ? 'pp' : 'count';
    if (key === 'delta_percent') return 'percent';
    return percentage ? 'percent' : 'count';
  }
  return FACT_VALUE_UNITS[fact.kind]?.[key] ?? 'count';
}

export function allowedValuesOf(fact: ReportInsightFact, insights: ReportInsights): AllowedValue[] {
  const direction = factDirection(fact, insights);
  const signedKeys = SIGNED_FACT_VALUES[fact.kind] ?? [];
  return Object.entries(fact.values)
    // `direction` is a ±1 marker, never a number the text may quote.
    .filter(([key]) => key !== 'direction')
    .map(([key, value]) => {
      const signed = direction !== null && signedKeys.includes(key);
      return { value: signed && direction === -1 ? -value : value, unit: factValueUnit(fact, key, insights), signed, direction };
    });
}

export function sameRounded(candidate: number, number: ReportNarrativeNumber): boolean {
  const factor = 10 ** number.decimals;
  return Math.abs(Math.round(Math.abs(candidate) * factor) / factor - number.value) < 1e-9;
}

export function unitAccepts(text: ReportNarrativeUnit, value: ReportNarrativeUnit): boolean {
  return text === 'percent' ? value === 'percent' || value === 'pp' : text === value;
}

/** A change quoted with a direction must have that sign; a level must belong to a fact moving that way (or to none). */
function directionAccepts(direction: Direction, value: AllowedValue): boolean {
  return value.signed ? sign(value.value) === direction : value.direction === null || value.direction === direction;
}

export function checkNumber(number: ReportNarrativeNumber, allowed: AllowedValue[], direction: Direction | null): string | null {
  const sameValue = allowed.filter((value) => sameRounded(value.value, number));
  if (!sameValue.length) return 'number_not_in_facts';
  const sameUnit = sameValue.filter((value) => unitAccepts(number.unit, value.unit));
  if (!sameUnit.length) return 'number_unit_mismatch';
  const sameSign = number.sign === null ? sameUnit : sameUnit.filter((value) => value.signed && sign(value.value) === number.sign);
  if (!sameSign.length) return 'number_sign_mismatch';
  if (direction !== null && !sameSign.some((value) => directionAccepts(direction, value))) return 'direction_mismatch';
  return null;
}
