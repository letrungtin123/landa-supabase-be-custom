// Pure routing decisions for admin report questions. The model only proposes
// structured parameters (ISO dates, unit names as written, granularity,
// compare, course); this module validates them, cross-checks them with the
// deterministic parser and resolver, and decides between answering directly,
// building a snapshot, asking for filters, or asking a clarification.

import { z } from 'zod';
import type { ReportChatFilterInput } from './report-chat.service.js';
import { MAX_REPORT_RANGE_DAYS, parseYmd, sameRange, type ReportDateRangeYmd } from './report-date.logic.js';
import {
  findReportUnitById,
  hasReportUnitWord,
  isReportUnitPermitted,
  permittedReportGroups,
  reportUnitFilter,
  reportUnitPath,
  type ReportGroupLabels,
  type ReportOrgUnit,
  type ReportOrgUnitCatalog,
  type ReportOrgUnitLevel,
  type ReportUnitResolution,
} from './report-org-unit.logic.js';
import { foldReportText } from './report-text.logic.js';
import {
  clampReportRangeToToday,
  reportRangesAgree,
  validateReportRange,
  type ReportGranularity,
  type ReportTimeIssueCode,
  type ReportTimeParseResult,
} from './report-time-expression.logic.js';

export interface ReportRouterModelOutput {
  tool: 'get_report_snapshot' | 'respond_directly';
  range: ReportDateRangeYmd | null;
  granularity: ReportGranularity | null;
  org_units: Array<{ name: string; level: ReportOrgUnitLevel | null }>;
  compare: boolean;
  course: string | null;
}

export type ReportClarificationReason =
  | 'date_conflict'
  | 'date_invalid'
  | 'date_reversed'
  | 'date_too_long'
  | 'date_multiple'
  | 'date_future'
  | 'date_open'
  | 'unit_ambiguous'
  | 'unit_not_found'
  | 'unit_forbidden'
  | 'unit_multiple'
  | 'scope_required';

export interface ReportClarificationOption {
  id: string;
  /** Complete filter applied when the chip is chosen. */
  filter: ReportChatFilterInput;
  period?: ReportDateRangeYmd;
  unit?: { id: string; level: ReportOrgUnitLevel; name: string; path: string[] };
  /** "All units I can access" (staff only). */
  all_scope?: true;
}

export interface ReportClarification {
  version: 1;
  reasons: ReportClarificationReason[];
  /** `mention` is only ever the text the user (or the model, copying it) wrote, never a catalog name. */
  params: { mention?: string; max_days?: number };
  options: ReportClarificationOption[];
}

export interface ReportRequestContext {
  period_source: 'parser' | 'model' | 'agreed' | 'default' | 'filters' | 'correction';
  clamped_to_today?: boolean;
  granularity?: ReportGranularity;
  compare?: boolean;
  course_hint?: string;
  unit_source?: 'question' | 'model' | 'filters' | 'own_scope';
}

export type ReportRouteDecision =
  | { kind: 'direct' }
  | { kind: 'filters'; suggested_filter: ReportChatFilterInput }
  | { kind: 'snapshot'; filter: ReportChatFilterInput; request: ReportRequestContext }
  | { kind: 'clarification'; clarification: ReportClarification; suggested_filter: ReportChatFilterInput };

export interface ReportActorScope {
  /** learner_plus: only their own groups may be reported. */
  restricted: boolean;
  allowedGroupIds: string[] | null;
  catalog: ReportOrgUnitCatalog | null;
}

const MAX_CLARIFICATION_OPTIONS = 6;

const ModelUnitSchema = z.object({
  name: z.string().trim().min(1).max(120),
  level: z.enum(['group', 'subgroup', 'team', 'unknown']).optional(),
});

function readIsoDate(value: unknown): string | null {
  return typeof value === 'string' && parseYmd(value.trim()) ? value.trim() : null;
}

/**
 * Validates every model field independently: a malformed field is dropped,
 * never trusted and never allowed to discard the valid ones.
 */
export function parseReportRouterToolCall(
  call: { name?: unknown; args?: unknown } | null | undefined,
  today: string,
): ReportRouterModelOutput {
  const args = call?.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args as Record<string, unknown> : {};
  const dateFrom = readIsoDate(args.date_from);
  const dateTo = readIsoDate(args.date_to);
  const units = Array.isArray(args.org_units)
    ? args.org_units.slice(0, 10).flatMap((item) => {
      const parsed = ModelUnitSchema.safeParse(typeof item === 'string' ? { name: item } : item);
      return parsed.success ? [{ name: parsed.data.name, level: parsed.data.level && parsed.data.level !== 'unknown' ? parsed.data.level : null }] : [];
    })
    : [];
  const granularity = z.enum(['day', 'week', 'month', 'quarter']).safeParse(args.granularity);
  const course = z.string().trim().min(1).max(200).safeParse(args.course);
  return {
    tool: call?.name === 'get_report_snapshot' ? 'get_report_snapshot' : 'respond_directly',
    // "since July" may come back with date_from only.
    range: dateFrom && (dateTo || dateFrom <= today) ? { date_from: dateFrom, date_to: dateTo ?? today } : null,
    granularity: granularity.success ? granularity.data : null,
    org_units: units,
    compare: args.compare === true,
    course: course.success ? course.data : null,
  };
}

const REPORT_CUE = /\b(?:bao cao|thong ke|phan tich|so lieu|dashboard|reports?|analytics?|metrics?|statistics?|stats|tong hop|tinh hinh)\b/;
const LEARNING_CUE = /\b(?:hoc vien|nguoi hoc|khoa hoc|dao tao|tien do|hoan thanh|ghi danh|dang ky|enrollments?|enrolments?|completions?|learners?|students?|courses?|trainings?|progress|participants?)\b/;
const RANKING_CUE = /\b(?:bang xep hang|xep hang|rankings?|top|leaderboard)\b/;
const EXPLICIT_METRIC_CUE = /\b(?:t[yi] le hoan thanh|luot dang ky|luot ghi danh|tinh hinh hoc tap|completion rates?|enrollments?|enrolments?|active learners?)\b/;
const QUANTITY_CUE = /\b(?:bao nhieu|how many|so luong|number of|tong so)\b/;
const LEARNER_CUE = /\b(?:hoc vien|nguoi hoc|learners?|students?|participants?)\b/;
const DEFINITION_CUE = /\b(?:la gi|nghia la|dinh nghia|giai thich|cach tinh|tinh nhu the nao|what is|what are|what does|meaning of|define|definition|explain)\b/;

/**
 * Deterministic report intent. It keeps a report card when the model declines
 * the tool for an obvious report request, and lets definition questions
 * ("tỷ lệ hoàn thành là gì?") go to the normal chat.
 */
export function detectReportIntent(question: string, options: { labels?: ReportGroupLabels; hasTimeExpression?: boolean } = {}): boolean {
  const text = foldReportText(question);
  const unit = hasReportUnitWord(question, options.labels);
  const time = Boolean(options.hasTimeExpression);
  if (DEFINITION_CUE.test(text) && !time && !unit) return false;
  const learning = LEARNING_CUE.test(text);
  return (REPORT_CUE.test(text) && (learning || unit))
    || (RANKING_CUE.test(text) && (learning || unit))
    || EXPLICIT_METRIC_CUE.test(text)
    || (QUANTITY_CUE.test(text) && LEARNER_CUE.test(text) && (unit || time));
}

type PeriodOutcome =
  | { kind: 'resolved'; range: ReportDateRangeYmd | null; source: ReportRequestContext['period_source']; clamped: boolean }
  | { kind: 'clarify'; reason: ReportClarificationReason; options: ReportDateRangeYmd[] };

const ISSUE_REASONS: Record<ReportTimeIssueCode, ReportClarificationReason> = {
  invalid_date: 'date_invalid',
  reversed_range: 'date_reversed',
  range_too_long: 'date_too_long',
  multiple_periods: 'date_multiple',
  future_without_year: 'date_future',
  open_range: 'date_open',
  // "Cùng kỳ năm ngoái" without a period: two readings are offered.
  ambiguous_period: 'date_conflict',
};

function validated(outcome: PeriodOutcome, today: string): PeriodOutcome {
  if (outcome.kind !== 'resolved' || !outcome.range) return outcome;
  const validation = validateReportRange(outcome.range, { today });
  return validation.issue
    ? { kind: 'clarify', reason: ISSUE_REASONS[validation.issue], options: validation.alternatives }
    : outcome;
}

/**
 * Cross-checks the deterministic reading with the model's ISO range. The
 * parser never silently overrides the model nor the reverse: disagreement
 * becomes a "date_conflict" clarification offering both readings.
 */
export function reconcileReportPeriod(parse: ReportTimeParseResult, model: ReportDateRangeYmd | null, today: string): PeriodOutcome {
  const modelRange = model && model.date_from <= model.date_to ? model : null;
  if (parse.status === 'needs_clarification') {
    // Only an unambiguous agreement ends the question: the model chose the
    // past reading of a yearless month, or one of the "since when" options.
    const agreedAlternative = modelRange && (parse.issue === 'future_without_year' || parse.issue === 'open_range')
      ? parse.alternatives.find((candidate) => candidate.date_from <= today
        && sameRange(candidate, clampReportRangeToToday(modelRange, today)))
      : null;
    if (agreedAlternative) return validated({ kind: 'resolved', range: agreedAlternative, source: 'agreed', clamped: false }, today);
    return { kind: 'clarify', reason: ISSUE_REASONS[parse.issue!], options: parse.alternatives };
  }
  if (parse.status === 'resolved' && parse.range) {
    if (!modelRange) return validated({ kind: 'resolved', range: parse.range, source: 'parser', clamped: parse.clamped_to_today }, today);
    if (reportRangesAgree(parse.range, modelRange, today, parse.year_inferred && !parse.explicit_year)) {
      return validated({ kind: 'resolved', range: parse.range, source: 'agreed', clamped: parse.clamped_to_today }, today);
    }
    const modelClamped = clampReportRangeToToday(modelRange, today);
    const alternative = parse.alternatives.find((candidate) => sameRange(candidate, modelClamped));
    if (alternative) return validated({ kind: 'resolved', range: alternative, source: 'agreed', clamped: false }, today);
    return { kind: 'clarify', reason: 'date_conflict', options: [parse.range, modelClamped] };
  }
  if (!modelRange) return { kind: 'resolved', range: null, source: 'default', clamped: false };
  const clamped = clampReportRangeToToday(modelRange, today);
  const todayYear = Number(today.slice(0, 4));
  if (!parse.explicit_year && Number(clamped.date_from.slice(0, 4)) < todayYear - 1) {
    // The user wrote no year, yet the model picked an old one: ask instead of trusting either.
    const rebased = {
      date_from: `${todayYear}${clamped.date_from.slice(4)}`,
      date_to: `${todayYear}${clamped.date_to.slice(4)}`,
    };
    const options = parseYmd(rebased.date_from) && parseYmd(rebased.date_to) && rebased.date_from <= today
      ? [clampReportRangeToToday(rebased, today), clamped]
      : [clamped];
    return { kind: 'clarify', reason: 'date_conflict', options };
  }
  return validated({ kind: 'resolved', range: clamped, source: 'model', clamped: !sameRange(clamped, modelRange) }, today);
}

interface UnitChoice {
  unit: ReportOrgUnit | null;
  allScope?: boolean;
}

type UnitOutcome =
  | { kind: 'resolved'; unit: ReportOrgUnit | null; source?: ReportRequestContext['unit_source'] }
  | { kind: 'clarify'; reason: ReportClarificationReason; choices: UnitChoice[]; mention?: string };

function permittedGroupsOf(scope: ReportActorScope): ReportOrgUnit[] {
  return scope.restricted && scope.catalog && scope.allowedGroupIds ? permittedReportGroups(scope.catalog, scope.allowedGroupIds) : [];
}

function decideUnits(units: ReportUnitResolution, scope: ReportActorScope): UnitOutcome {
  const permitted = permittedGroupsOf(scope);
  switch (units.status) {
    case 'resolved':
      return { kind: 'resolved', unit: units.unit, source: units.source };
    case 'ambiguous':
      return { kind: 'clarify', reason: 'unit_ambiguous', mention: units.mention, choices: units.candidates.map((unit) => ({ unit })) };
    case 'not_found': {
      // Also the answer for a learner_plus naming a unit outside their groups
      // (the resolver hides it): chips are their own groups.
      const choices: UnitChoice[] = units.suggestions.map((unit) => ({ unit }));
      if (scope.restricted) {
        for (const group of permitted) if (!choices.some((choice) => choice.unit?.id === group.id)) choices.push({ unit: group });
      } else {
        choices.push({ unit: null, allScope: true });
      }
      return { kind: 'clarify', reason: 'unit_not_found', mention: units.mention, choices };
    }
    case 'multiple':
      return { kind: 'clarify', reason: 'unit_multiple', choices: units.units.map((unit) => ({ unit })) };
    default:
      if (!scope.restricted) return { kind: 'resolved', unit: null };
      // learner_plus never silently defaults to "the first group": one group is
      // their whole scope (shown on the card); several groups need a choice.
      if (permitted.length === 1) return { kind: 'resolved', unit: permitted[0], source: 'own_scope' };
      if (permitted.length > 1) return { kind: 'clarify', reason: 'scope_required', choices: permitted.map((unit) => ({ unit })) };
      return { kind: 'resolved', unit: null };
  }
}

function filterFor(range: ReportDateRangeYmd | null, unit: ReportOrgUnit | null): ReportChatFilterInput {
  return { ...(range ?? {}), ...(unit ? reportUnitFilter(unit) : {}) };
}

export function buildReportClarification(input: {
  reasons: ReportClarificationReason[];
  periods: Array<ReportDateRangeYmd | null>;
  units: UnitChoice[];
  mention?: string;
}): ReportClarification {
  const options: ReportClarificationOption[] = [];
  for (const choice of input.units.length > 0 ? input.units : [{ unit: null }]) {
    for (const period of input.periods.length > 0 ? input.periods : [null]) {
      if (options.length >= MAX_CLARIFICATION_OPTIONS) break;
      if (!choice.unit && !choice.allScope && !period) continue;
      options.push({
        id: `option-${options.length + 1}`,
        filter: filterFor(period, choice.unit),
        ...(period ? { period } : {}),
        ...(choice.unit ? {
          unit: { id: choice.unit.id, level: choice.unit.level, name: choice.unit.name, path: reportUnitPath(choice.unit) },
        } : {}),
        ...(choice.allScope ? { all_scope: true as const } : {}),
      });
    }
  }
  return {
    version: 1,
    reasons: input.reasons,
    params: {
      ...(input.mention ? { mention: input.mention } : {}),
      ...(input.reasons.includes('date_too_long') ? { max_days: MAX_REPORT_RANGE_DAYS } : {}),
    },
    options,
  };
}

export function decideReportRoute(input: {
  today: string;
  parse: ReportTimeParseResult;
  model: ReportRouterModelOutput | null;
  deterministicIntent: boolean;
  units: ReportUnitResolution;
  scope: ReportActorScope;
}): ReportRouteDecision {
  const modelWantsReport = input.model?.tool === 'get_report_snapshot';
  if (!modelWantsReport && !input.deterministicIntent) return { kind: 'direct' };

  const period = reconcileReportPeriod(input.parse, input.model?.range ?? null, input.today);
  const unit = decideUnits(input.units, input.scope);
  const resolvedRange = period.kind === 'resolved' ? period.range : null;
  const resolvedUnit = unit.kind === 'resolved' ? unit.unit : null;

  if (period.kind === 'clarify' || unit.kind === 'clarify') {
    const reasons = [
      ...(unit.kind === 'clarify' ? [unit.reason] : []),
      ...(period.kind === 'clarify' ? [period.reason] : []),
    ];
    return {
      kind: 'clarification',
      clarification: buildReportClarification({
        reasons,
        periods: period.kind === 'clarify' ? period.options : [resolvedRange],
        units: unit.kind === 'clarify' ? unit.choices : [{ unit: resolvedUnit }],
        mention: unit.kind === 'clarify' ? unit.mention : undefined,
      }),
      suggested_filter: filterFor(resolvedRange, resolvedUnit),
    };
  }

  // The model declined (or was unavailable) and the question names no
  // period: keep a report card and let the user choose the filters.
  if (!modelWantsReport && !resolvedRange) {
    return { kind: 'filters', suggested_filter: filterFor(null, resolvedUnit) };
  }

  const granularity = input.parse.granularity ?? input.model?.granularity ?? null;
  const compare = input.parse.compare || Boolean(input.model?.compare);
  return {
    kind: 'snapshot',
    filter: filterFor(resolvedRange, resolvedUnit),
    request: {
      period_source: period.source,
      ...(period.clamped ? { clamped_to_today: true } : {}),
      ...(granularity ? { granularity } : {}),
      ...(compare ? { compare: true } : {}),
      ...(input.model?.course ? { course_hint: input.model.course } : {}),
      ...(resolvedUnit && unit.kind === 'resolved' && unit.source ? { unit_source: unit.source } : {}),
    },
  };
}

/**
 * Filters chosen in the UI (or replayed from a previous report) are checked
 * against the actor's scope before any data is read: learner_plus gets an
 * explicit clarification instead of a silent default or a generic error. A
 * unit outside their groups is refused with the generic text, never by name.
 */
export function checkReportFilterScope(filter: ReportChatFilterInput, scope: ReportActorScope):
  | { kind: 'ok'; filter: ReportChatFilterInput }
  | { kind: 'clarification'; clarification: ReportClarification; suggested_filter: ReportChatFilterInput } {
  if (!scope.restricted) return { kind: 'ok', filter };
  const allowed = scope.allowedGroupIds ?? [];
  const period = filter.date_from && filter.date_to ? { date_from: filter.date_from, date_to: filter.date_to } : null;
  const permitted = permittedGroupsOf(scope);
  const requestedId = filter.team_id ?? filter.subgroup_id ?? filter.group_id;
  if (!requestedId) {
    if (allowed.length === 1) return { kind: 'ok', filter: { ...filter, group_id: allowed[0] } };
    if (allowed.length === 0) return { kind: 'ok', filter };
    return {
      kind: 'clarification',
      clarification: buildReportClarification({ reasons: ['scope_required'], periods: [period], units: permitted.map((unit) => ({ unit })) }),
      suggested_filter: period ?? {},
    };
  }
  const unit = scope.catalog ? findReportUnitById(scope.catalog, requestedId) : null;
  if (unit && !isReportUnitPermitted(unit, allowed)) {
    return {
      kind: 'clarification',
      clarification: buildReportClarification({
        reasons: ['unit_forbidden'], periods: [period], units: permitted.map((candidate) => ({ unit: candidate })),
      }),
      suggested_filter: period ?? {},
    };
  }
  return { kind: 'ok', filter };
}
