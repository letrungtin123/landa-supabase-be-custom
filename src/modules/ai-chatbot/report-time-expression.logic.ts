// Deterministic VI/EN time-expression parser for report questions.
//
// It never guesses silently: every inference (missing year, rolling vs.
// calendar reading, future period without a year) lowers the confidence or
// produces an issue with concrete alternatives, which the router turns into a
// clarification turn with chips instead of an error or a silent override.

import {
  MAX_REPORT_RANGE_DAYS,
  addDays,
  addMonths,
  clampYmd,
  dayCountBetween,
  endOfMonth,
  formatYmd,
  isValidCalendarDate,
  monthRange,
  parseYmd,
  quarterOfMonth,
  quarterRange,
  resolveComparableReportPeriod,
  sameRange,
  shiftRangeYears,
  startOfWeek,
  yearRange,
  type ReportDateRangeYmd,
} from './report-date.logic.js';
import { foldReportText } from './report-text.logic.js';

export type ReportGranularity = 'day' | 'week' | 'month' | 'quarter';
export type ReportTimeConfidence = 'high' | 'medium' | 'none';
export type ReportTimeIssueCode =
  | 'invalid_date'
  | 'reversed_range'
  | 'range_too_long'
  | 'multiple_periods'
  | 'future_without_year'
  | 'open_range';

export interface ReportTimeParseResult {
  status: 'none' | 'resolved' | 'needs_clarification';
  /** Primary reading; null when nothing was found or the issue has no primary. */
  range: ReportDateRangeYmd | null;
  confidence: ReportTimeConfidence;
  /** The user wrote at least one year (four digits, or "năm nay/last year" attached to a period). */
  explicit_year: boolean;
  /** A calendar year was inferred for the primary range. */
  year_inferred: boolean;
  /** The primary range was shortened to end today (data after today cannot exist). */
  clamped_to_today: boolean;
  issue: ReportTimeIssueCode | null;
  /** Other plausible readings (issue options or medium-confidence alternatives). */
  alternatives: ReportDateRangeYmd[];
  /** Every independent period mentioned, in order. */
  periods: ReportDateRangeYmd[];
  granularity: ReportGranularity | null;
  compare: boolean;
}

type MentionKind = 'date' | 'day_only' | 'month' | 'quarter' | 'half' | 'year' | 'relative' | 'day_span' | 'open_end';
type MentionDraft = Omit<Mention, 'start' | 'end'>;

interface Mention {
  start: number;
  end: number;
  kind: MentionKind;
  year?: number;
  yearExplicit: boolean;
  month?: number;
  day?: number;
  /** day_span: last day of "1-15/7". */
  dayTo?: number;
  quarter?: number;
  half?: 1 | 2;
  /** Relative mentions are already resolved against today. */
  range?: ReportDateRangeYmd;
  /** "năm nay" / "last year": the calendar year it denotes when it qualifies a month or quarter. */
  yearRef?: number;
  medium?: boolean;
  alternative?: ReportDateRangeYmd;
}

interface ParseContext {
  today: string;
  todayYear: number;
  todayMonth: number;
}

interface Matcher {
  pattern: string;
  build: (match: RegExpExecArray, context: ParseContext, text: string) => MentionDraft | null;
}

const YEAR = '((?:19|20)\\d{2})';
const MONTH_NAME_NUMBERS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const FULL_MONTH_NAMES = new Set(['january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
const MONTH_NAMES = 'january|february|march|april|may|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec';
const ENGLISH_DATE_CONTEXT_BEFORE = /(?:^|\s)(?:in|of|during|for|since|from|to|until|till|by|last|this|between|and|through|before|after|on)\s*$/;
const ORDINAL_QUARTERS: Record<string, number> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 };
const ROMAN_QUARTERS: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4 };

function rolling(context: ParseContext, amount: number, unit: string): ReportDateRangeYmd | null {
  if (!Number.isInteger(amount) || amount < 1) return null;
  if (/^(?:ngay|days?)$/.test(unit)) return { date_from: addDays(context.today, -(amount - 1)), date_to: context.today };
  if (/^(?:tuan|weeks?)$/.test(unit)) return { date_from: addDays(context.today, -(amount * 7 - 1)), date_to: context.today };
  if (/^(?:thang|months?)$/.test(unit)) return { date_from: addDays(addMonths(context.today, -amount), 1), date_to: context.today };
  return null;
}

function previousWeek(context: ParseContext): ReportDateRangeYmd {
  const start = addDays(startOfWeek(context.today), -7);
  return { date_from: start, date_to: addDays(start, 6) };
}

function previousMonth(context: ParseContext): ReportDateRangeYmd {
  const parts = parseYmd(addMonths(`${context.today.slice(0, 8)}01`, -1))!;
  return monthRange(parts.year, parts.month);
}

function previousQuarter(context: ParseContext): ReportDateRangeYmd {
  const quarter = quarterOfMonth(context.todayMonth);
  return quarter === 1 ? quarterRange(context.todayYear - 1, 4) : quarterRange(context.todayYear, quarter - 1);
}

function relativeMention(key: string, context: ParseContext): MentionDraft | null {
  const today = context.today;
  const relative = (range: ReportDateRangeYmd, extra: Partial<MentionDraft> = {}): MentionDraft => ({
    kind: 'relative', yearExplicit: false, range, ...extra,
  });
  switch (key) {
    case 'today': return relative({ date_from: today, date_to: today });
    case 'yesterday': return relative({ date_from: addDays(today, -1), date_to: addDays(today, -1) });
    case 'this_week': return relative({ date_from: startOfWeek(today), date_to: today });
    case 'last_week': return relative(previousWeek(context));
    case 'past_week': return relative(previousWeek(context), { medium: true, alternative: rolling(context, 7, 'ngay')! });
    case 'rolling_week': return relative(rolling(context, 7, 'ngay')!, { medium: true, alternative: previousWeek(context) });
    case 'this_month': return relative({ date_from: `${today.slice(0, 8)}01`, date_to: today });
    case 'last_month': return relative(previousMonth(context));
    case 'past_month': return relative(previousMonth(context), { medium: true, alternative: rolling(context, 30, 'ngay')! });
    case 'rolling_month': return relative(rolling(context, 30, 'ngay')!, { medium: true, alternative: previousMonth(context) });
    case 'this_quarter': return relative({ date_from: quarterRange(context.todayYear, quarterOfMonth(context.todayMonth)).date_from, date_to: today });
    case 'last_quarter': return relative(previousQuarter(context));
    case 'this_year': return relative({ date_from: formatYmd(context.todayYear, 1, 1), date_to: today }, { yearRef: context.todayYear });
    case 'last_year': return relative(yearRange(context.todayYear - 1), { yearRef: context.todayYear - 1 });
    case 'past_year': return relative(yearRange(context.todayYear - 1), {
      yearRef: context.todayYear - 1, medium: true, alternative: { date_from: addDays(today, -364), date_to: today },
    });
    case 'rolling_year': return relative({ date_from: addDays(today, -364), date_to: today }, { medium: true, alternative: yearRange(context.todayYear - 1) });
    default: return null;
  }
}

const RELATIVE_PHRASES: Array<[string, string]> = [
  ['(?:tu\\s+)?dau\\s+nam(?:\\s+nay)?|year\\s+to\\s+date|ytd', 'this_year'],
  ['(?:tu\\s+)?dau\\s+thang(?:\\s+nay)?|month\\s+to\\s+date|mtd', 'this_month'],
  ['(?:tu\\s+)?dau\\s+quy(?:\\s+nay)?|quarter\\s+to\\s+date|qtd', 'this_quarter'],
  ['(?:tu\\s+)?dau\\s+tuan(?:\\s+nay)?|week\\s+to\\s+date|wtd', 'this_week'],
  ['hom\\s+nay|today', 'today'],
  ['hom\\s+qua|yesterday', 'yesterday'],
  ['tuan\\s+nay|this\\s+week|current\\s+week', 'this_week'],
  ['tuan\\s+(?:truoc|roi|vua\\s+roi)|last\\s+week|previous\\s+week|prior\\s+week', 'last_week'],
  ['tuan\\s+(?:qua|vua\\s+qua)', 'past_week'],
  ['(?:the\\s+)?past\\s+week', 'rolling_week'],
  ['thang\\s+nay|this\\s+month|current\\s+month', 'this_month'],
  ['thang\\s+(?:truoc|roi|vua\\s+roi)|last\\s+month|previous\\s+month|prior\\s+month', 'last_month'],
  ['thang\\s+(?:qua|vua\\s+qua)', 'past_month'],
  ['(?:the\\s+)?past\\s+month', 'rolling_month'],
  ['quy\\s+nay|this\\s+quarter|current\\s+quarter', 'this_quarter'],
  ['quy\\s+(?:truoc|roi|vua\\s+roi)|last\\s+quarter|previous\\s+quarter|prior\\s+quarter', 'last_quarter'],
  ['nam\\s+nay|this\\s+year|current\\s+year', 'this_year'],
  ['nam\\s+(?:ngoai|truoc|roi|vua\\s+roi)|last\\s+year|previous\\s+year|prior\\s+year', 'last_year'],
  ['nam\\s+(?:qua|vua\\s+qua)', 'past_year'],
  ['(?:the\\s+)?past\\s+year', 'rolling_year'],
];

function englishMonthAllowed(name: string, text: string, start: number, hasNumber: boolean): boolean {
  if (FULL_MONTH_NAMES.has(name)) return true;
  // "may", "sep" (folded "sếp"), "mar"... are also ordinary words: require a date context.
  return hasNumber || ENGLISH_DATE_CONTEXT_BEFORE.test(text.slice(Math.max(0, start - 16), start));
}

function halfYearQualifier(word: string | undefined, context: ParseContext): number | undefined {
  if (!word) return undefined;
  return word === 'nay' || word === 'this' ? context.todayYear : context.todayYear - 1;
}

/** Priority order: earlier matchers own their span; later overlapping matches are ignored. */
const MATCHERS: Matcher[] = [
  {
    pattern: `\\b(?:(nua\\s+dau|6\\s+thang\\s+dau|sau\\s+thang\\s+dau)|nua\\s+cuoi|6\\s+thang\\s+cuoi|sau\\s+thang\\s+cuoi)\\s+nam(?:\\s+(nay|ngoai|truoc|roi))?\\b(?:\\s*,?\\s*(?:nam\\s+)?${YEAR})?`,
    build: (match, context) => {
      const year = match[3] ? Number(match[3]) : halfYearQualifier(match[2], context);
      return { kind: 'half', half: match[1] ? 1 : 2, ...(year ? { year } : {}), yearExplicit: year !== undefined };
    },
  },
  {
    pattern: `\\b(?:(h1|first\\s+half)|h2|second\\s+half)\\b(?:\\s+of)?(?:\\s+the)?(?:\\s+(this|last)\\s+year)?(?:\\s*(?:of|,|/)?\\s*${YEAR})?`,
    build: (match, context) => {
      const year = match[3] ? Number(match[3]) : halfYearQualifier(match[2], context);
      return { kind: 'half', half: match[1] ? 1 : 2, ...(year ? { year } : {}), yearExplicit: year !== undefined };
    },
  },
  {
    pattern: '\\b(\\d{1,3})\\s+(ngay|tuan|thang)\\s+(qua|gan\\s+day|gan\\s+nhat|vua\\s+qua|tro\\s+lai\\s+day|truoc|vua\\s+roi)\\b',
    build: (match, context) => {
      const range = rolling(context, Number(match[1]), match[2]);
      return range ? { kind: 'relative', yearExplicit: false, range, ...(match[3] === 'truoc' ? { medium: true } : {}) } : null;
    },
  },
  {
    pattern: '\\b(?:in\\s+)?(?:the\\s+)?(?:last|past|previous|recent)\\s+(\\d{1,3})\\s+(days?|weeks?|months?)\\b',
    build: (match, context) => {
      const range = rolling(context, Number(match[1]), match[2]);
      return range ? { kind: 'relative', yearExplicit: false, range } : null;
    },
  },
  ...RELATIVE_PHRASES.map(([phrase, key]): Matcher => ({
    pattern: `\\b(?:${phrase})\\b`,
    build: (_match, context) => relativeMention(key, context),
  })),
  {
    pattern: '\\b(?:den|toi|cho\\s+den|cho\\s+toi)\\s+(?:nay|hien\\s+tai|bay\\s+gio|gio)\\b|\\b(?:until|till|up\\s+to|through|to)\\s+(?:now|the\\s+present)\\b|\\bto\\s+date\\b|\\bso\\s+far\\b',
    build: () => ({ kind: 'open_end', yearExplicit: false }),
  },
  {
    pattern: `\\b${YEAR}([-/.])(\\d{1,2})\\2(\\d{1,2})\\b`,
    build: (match) => ({ kind: 'date', year: Number(match[1]), yearExplicit: true, month: Number(match[3]), day: Number(match[4]) }),
  },
  {
    pattern: '(?<![/.\\d])\\b(\\d{1,2})\\s*-\\s*(\\d{1,2})\\s*\\/\\s*(\\d{1,2})(?:\\s*\\/\\s*((?:19|20)\\d{2}))?\\b(?!\\/\\d)',
    build: (match) => ({
      kind: 'day_span', day: Number(match[1]), dayTo: Number(match[2]), month: Number(match[3]),
      ...(match[4] ? { year: Number(match[4]) } : {}), yearExplicit: Boolean(match[4]),
    }),
  },
  {
    pattern: '(?<![/.\\d])\\b(\\d{1,2})([/.-])(\\d{1,2})\\2((?:19|20)\\d{2}|\\d{2})\\b',
    build: (match) => ({
      kind: 'date', day: Number(match[1]), month: Number(match[3]),
      year: match[4].length === 2 ? 2000 + Number(match[4]) : Number(match[4]), yearExplicit: true,
      ...(match[4].length === 2 ? { medium: true } : {}),
    }),
  },
  {
    pattern: `\\b(?:ngay|mung|mong)\\s+(\\d{1,2})\\s*(?:thang|/|-)\\s*(\\d{1,2})(?:\\s*(?:,|nam|/|-)?\\s*${YEAR})?\\b`,
    build: (match) => ({
      kind: 'date', day: Number(match[1]), month: Number(match[2]),
      ...(match[3] ? { year: Number(match[3]) } : {}), yearExplicit: Boolean(match[3]),
    }),
  },
  {
    pattern: `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})\\b\\.?(?:,?\\s+${YEAR})?`,
    build: (match) => ({
      kind: 'date', day: Number(match[1]), month: MONTH_NAME_NUMBERS[match[2]],
      ...(match[3] ? { year: Number(match[3]) } : {}), yearExplicit: Boolean(match[3]),
    }),
  },
  {
    pattern: `\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?![/.:-]\\d)(?:,?\\s+${YEAR})?`,
    build: (match, _context, text) => {
      const year = match[3] ? Number(match[3]) : undefined;
      if (!englishMonthAllowed(match[1], text, match.index, Boolean(year))) return null;
      return { kind: 'date', day: Number(match[2]), month: MONTH_NAME_NUMBERS[match[1]], ...(year ? { year } : {}), yearExplicit: Boolean(year) };
    },
  },
  {
    pattern: `\\b(?:thang\\s*(\\d{1,2})|t(\\d{1,2})|month\\s+(\\d{1,2}))\\s*(?:[/.-]|,|\\s+nam|\\s+of|\\s+year)?\\s*${YEAR}\\b`,
    build: (match) => ({ kind: 'month', month: Number(match[1] ?? match[2] ?? match[3]), year: Number(match[4]), yearExplicit: true }),
  },
  {
    pattern: `(?<![/.\\d])\\b(\\d{1,2})[/.-]${YEAR}\\b`,
    build: (match) => ({ kind: 'month', month: Number(match[1]), year: Number(match[2]), yearExplicit: true }),
  },
  {
    pattern: '\\b(?:thang|month)\\s*(\\d{1,2})\\b(?![/.-]\\d)',
    build: (match) => ({ kind: 'month', month: Number(match[1]), yearExplicit: false }),
  },
  {
    pattern: `\\b(${MONTH_NAMES})\\b\\.?(?:,?\\s+${YEAR})?`,
    build: (match, _context, text) => {
      const year = match[2] ? Number(match[2]) : undefined;
      if (!englishMonthAllowed(match[1], text, match.index, Boolean(year))) return null;
      return { kind: 'month', month: MONTH_NAME_NUMBERS[match[1]], ...(year ? { year } : {}), yearExplicit: Boolean(year) };
    },
  },
  {
    pattern: `\\b(?:quy|quarter)\\s*([1-4]|iv|iii|ii|i)\\b(?:\\s*(?:[/.-]|,|nam|of|year)?\\s*${YEAR})?`,
    build: (match) => ({
      kind: 'quarter', quarter: ROMAN_QUARTERS[match[1]] ?? Number(match[1]),
      ...(match[2] ? { year: Number(match[2]) } : {}), yearExplicit: Boolean(match[2]),
    }),
  },
  {
    pattern: `\\bq([1-4])\\b(?:\\s*(?:[/.-]|,)?\\s*${YEAR})?`,
    build: (match, _context, text) => {
      // "Q1" is also a Ho Chi Minh City district ("Chi nhánh Q1"): require a year or a date preposition.
      if (!match[2] && !ENGLISH_DATE_CONTEXT_BEFORE.test(text.slice(Math.max(0, match.index - 16), match.index))) return null;
      return { kind: 'quarter', quarter: Number(match[1]), ...(match[2] ? { year: Number(match[2]) } : {}), yearExplicit: Boolean(match[2]) };
    },
  },
  {
    pattern: `\\b(first|second|third|fourth|1st|2nd|3rd|4th)\\s+quarter\\b(?:\\s+(?:of\\s+)?${YEAR})?`,
    build: (match) => ({ kind: 'quarter', quarter: ORDINAL_QUARTERS[match[1]], ...(match[2] ? { year: Number(match[2]) } : {}), yearExplicit: Boolean(match[2]) }),
  },
  {
    pattern: '\\b(?:ngay|mung)\\s+(\\d{1,2})\\b(?!\\s*(?:thang|[/.-]\\s*\\d))',
    build: (match) => ({ kind: 'day_only', day: Number(match[1]), yearExplicit: false }),
  },
  {
    pattern: `(?<![/.\\d])\\b(\\d{1,2})\\/(\\d{1,2})\\b(?![/.]\\d)(?:\\s*,?\\s*(?:nam|year)\\s+${YEAR})?`,
    build: (match) => {
      const day = Number(match[1]);
      const month = Number(match[2]);
      const year = match[3] ? Number(match[3]) : undefined;
      // dd/mm is the Vietnamese and en-GB convention. Only an impossible
      // dd/mm reading that is a possible mm/dd reading is flipped (medium).
      if (month > 12 && day <= 12) return { kind: 'date', day: month, month: day, ...(year ? { year } : {}), yearExplicit: Boolean(year), medium: true };
      return { kind: 'date', day, month, ...(year ? { year } : {}), yearExplicit: Boolean(year) };
    },
  },
  {
    pattern: `\\b(?:nam|year|fy|in|of|for|during)\\s+${YEAR}\\b`,
    build: (match) => ({ kind: 'year', year: Number(match[1]), yearExplicit: true }),
  },
  {
    pattern: `\\b${YEAR}\\b(?!\\s*(?:hoc\\s+vien|nguoi|luot|khoa|learners?|students?|courses?|enrollments?|users?))`,
    build: (match, context) => {
      const year = Number(match[1]);
      return year >= context.todayYear - 15 && year <= context.todayYear + 1 ? { kind: 'year', year, yearExplicit: true } : null;
    },
  },
];

const YEAR_QUALIFIABLE_KINDS: ReadonlySet<MentionKind> = new Set(['date', 'day_only', 'month', 'quarter', 'half', 'day_span']);

function collectMentions(text: string, context: ParseContext): Mention[] {
  const mentions: Mention[] = [];
  const overlaps = (start: number, end: number) => mentions.some((mention) => start < mention.end && end > mention.start);
  for (const matcher of MATCHERS) {
    const pattern = new RegExp(matcher.pattern, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) continue;
      const built = matcher.build(match, context, text);
      if (built) mentions.push({ ...built, start, end });
    }
  }
  return attachYearQualifiers(mentions.sort((left, right) => left.start - right.start), text);
}

/**
 * "tháng 7, năm 2025", "quý 3 năm ngoái", "July last year": a year right
 * after a yearless period qualifies it instead of being a second period.
 */
function attachYearQualifiers(mentions: Mention[], text: string): Mention[] {
  const output: Mention[] = [];
  for (const mention of mentions) {
    const previous = output[output.length - 1];
    const qualifierYear = mention.kind === 'year' ? mention.year : mention.yearRef;
    if (qualifierYear !== undefined
      && previous
      && !previous.yearExplicit
      && YEAR_QUALIFIABLE_KINDS.has(previous.kind)
      && /^[\s,]*(?:nam|year|of)?[\s,]*$/.test(text.slice(previous.end, mention.start))) {
      output[output.length - 1] = { ...previous, year: qualifierYear, yearExplicit: true, end: mention.end };
      continue;
    }
    output.push(mention);
  }
  return output;
}

interface PeriodDraft {
  from: Mention;
  to: Mention | 'today' | null;
}

const RANGE_CONNECTOR = /^\s*,?\s*(?:-|den(?:\s+het)?|toi|cho\s+den|cho\s+toi|to|until|till|through|thru|and|va)\s*(?:ngay\s+|het\s+)?$/;
const BETWEEN_BEFORE = /(?:^|\s)(?:giua|between)\s*$/;
const OPEN_START_BEFORE = /(?:^|\s)(?:tu|tu\s+ngay|ke\s+tu|bat\s+dau\s+tu|from|since|starting(?:\s+from)?)\s*$/;

function needsYear(mention: Mention): boolean {
  return !mention.range && !mention.yearExplicit;
}

function assemblePeriods(mentions: Mention[], text: string): { periods: PeriodDraft[]; loneOpenEnd: boolean } {
  // A year that only gives context ("năm 2025, từ tháng 3 đến tháng 5") is not a period of its own.
  const yearIsContext = mentions.some((mention) => mention.kind !== 'year' && mention.kind !== 'open_end' && needsYear(mention));
  const candidates = mentions.filter((mention) => !(mention.kind === 'year' && yearIsContext));
  const periods: PeriodDraft[] = [];
  let loneOpenEnd = false;
  for (let index = 0; index < candidates.length; index += 1) {
    const mention = candidates[index];
    if (mention.kind === 'open_end') {
      loneOpenEnd = true;
      continue;
    }
    const next = candidates[index + 1];
    const gap = next ? text.slice(mention.end, next.start) : '';
    const before = text.slice(Math.max(0, mention.start - 24), mention.start);
    if (next?.kind === 'open_end' && /^\s*,?\s*$/.test(gap)) {
      periods.push({ from: mention, to: 'today' });
      index += 1;
      continue;
    }
    const connected = next
      && RANGE_CONNECTOR.test(gap)
      && (!/\b(?:and|va)\b/.test(gap) || BETWEEN_BEFORE.test(before));
    if (connected) {
      periods.push({ from: mention, to: next });
      index += 1;
      continue;
    }
    periods.push({ from: mention, to: OPEN_START_BEFORE.test(before) ? 'today' : null });
  }
  return { periods, loneOpenEnd: loneOpenEnd && periods.length === 0 };
}

interface Bounds {
  from: string | null;
  to: string | null;
  invalid: boolean;
  clamped: ReportDateRangeYmd | null;
}

function dayBound(year: number, month: number, day: number): { value: string | null; clamped: string | null } {
  if (isValidCalendarDate(year, month, day)) return { value: formatYmd(year, month, day), clamped: null };
  return { value: null, clamped: clampYmd(year, month, day) };
}

function mentionBounds(mention: Mention, year: number, monthFallback: number): Bounds {
  if (mention.range) return { from: mention.range.date_from, to: mention.range.date_to, invalid: false, clamped: null };
  switch (mention.kind) {
    case 'date':
    case 'day_only': {
      const bound = dayBound(year, mention.month ?? monthFallback, mention.day ?? 1);
      return {
        from: bound.value, to: bound.value, invalid: !bound.value,
        clamped: bound.clamped ? { date_from: bound.clamped, date_to: bound.clamped } : null,
      };
    }
    case 'day_span': {
      const from = dayBound(year, mention.month ?? 1, mention.day ?? 1);
      const to = dayBound(year, mention.month ?? 1, mention.dayTo ?? 1);
      const fromValue = from.value ?? from.clamped;
      const toValue = to.value ?? to.clamped;
      return {
        from: from.value, to: to.value, invalid: !from.value || !to.value,
        clamped: fromValue && toValue ? { date_from: fromValue, date_to: toValue } : null,
      };
    }
    case 'month':
      return (mention.month ?? 0) >= 1 && (mention.month ?? 0) <= 12
        ? { ...monthRangeBounds(year, mention.month!), invalid: false, clamped: null }
        : { from: null, to: null, invalid: true, clamped: null };
    case 'quarter': {
      const range = quarterRange(year, mention.quarter ?? 1);
      return { from: range.date_from, to: range.date_to, invalid: false, clamped: null };
    }
    case 'half':
      return mention.half === 1
        ? { from: formatYmd(year, 1, 1), to: formatYmd(year, 6, 30), invalid: false, clamped: null }
        : { from: formatYmd(year, 7, 1), to: formatYmd(year, 12, 31), invalid: false, clamped: null };
    case 'year':
      return { from: formatYmd(year, 1, 1), to: formatYmd(year, 12, 31), invalid: false, clamped: null };
    default:
      return { from: null, to: null, invalid: true, clamped: null };
  }
}

function monthRangeBounds(year: number, month: number): { from: string; to: string } {
  return { from: formatYmd(year, month, 1), to: endOfMonth(year, month) };
}

interface ResolvedPeriod {
  range: ReportDateRangeYmd | null;
  invalid: boolean;
  clamped: ReportDateRangeYmd | null;
  yearInferred: boolean;
  medium: boolean;
  alternative: ReportDateRangeYmd | null;
}

function knownYear(mention: Mention): number | undefined {
  if (mention.yearExplicit) return mention.year;
  return mention.range ? Number(mention.range.date_from.slice(0, 4)) : undefined;
}

function contextYearFor(mention: Mention, mentions: Mention[]): number | undefined {
  const explicit = mentions.filter((candidate) => candidate !== mention && candidate.yearExplicit && candidate.year !== undefined);
  if (explicit.length === 0) return undefined;
  return [...explicit].sort((left, right) => Math.abs(left.start - mention.start) - Math.abs(right.start - mention.start))[0].year;
}

function monthOf(value: string | null): number {
  return value ? Number(value.slice(5, 7)) : 0;
}

function resolvePeriod(period: PeriodDraft, mentions: Mention[], context: ParseContext): ResolvedPeriod {
  const start = period.from;
  const finish = period.to && period.to !== 'today' ? period.to : null;
  let yearInferred = false;
  let startYear = knownYear(start);
  let finishYear = finish ? knownYear(finish) : undefined;
  if (finish && startYear === undefined && finishYear !== undefined) startYear = finishYear;
  if (finish && finishYear === undefined && startYear !== undefined) finishYear = startYear;
  if (startYear === undefined) {
    const contextYear = contextYearFor(start, mentions);
    startYear = contextYear ?? context.todayYear;
    if (finish && finishYear === undefined) finishYear = startYear;
    yearInferred = contextYear === undefined;
  }
  finishYear = finishYear ?? startYear;

  const startMonthFallback = finish?.month ?? start.month ?? context.todayMonth;
  const finishMonthFallback = start.month ?? startMonthFallback;
  let from = mentionBounds(start, startYear, startMonthFallback);
  if (period.to === 'today' && needsYear(start) && yearInferred && from.from && from.from > context.today) {
    // "Từ tháng 11 đến nay" asked in March means last November.
    from = mentionBounds(start, startYear - 1, startMonthFallback);
  }
  let to = finish ? mentionBounds(finish, finishYear, finishMonthFallback) : from;
  // Cross-year range with an inferred side: "từ tháng 11 đến tháng 2 năm 2026", "15/12 - 10/1".
  if (finish && from.from && to.to && from.from > to.to && monthOf(from.from) > monthOf(to.to)) {
    if (needsYear(start)) {
      from = mentionBounds(start, startYear - 1, startMonthFallback);
    } else if (needsYear(finish)) {
      to = mentionBounds(finish, finishYear + 1, finishMonthFallback);
    }
  }
  const medium = Boolean(start.medium || finish?.medium || (start.kind === 'day_only' && !finish && period.to !== 'today'));
  const invalid = from.invalid || to.invalid;
  const rangeTo = period.to === 'today' ? context.today : to.to;
  const clampedFrom = from.from ?? from.clamped?.date_from ?? null;
  const clampedTo = period.to === 'today' ? context.today : to.to ?? to.clamped?.date_to ?? null;
  return {
    range: !invalid && from.from && rangeTo ? { date_from: from.from, date_to: rangeTo } : null,
    invalid,
    clamped: invalid && clampedFrom && clampedTo ? { date_from: clampedFrom, date_to: clampedTo } : null,
    yearInferred,
    medium,
    alternative: start.alternative && !finish && period.to !== 'today' ? start.alternative : null,
  };
}

function detectGranularity(text: string): ReportGranularity | null {
  const match = /\b(?:theo|tung|hang|moi|chia\s+theo|by|per|each)\s+(ngay|tuan|thang|quy|day|week|month|quarter)\b(?!\s*(?:\d|nay|truoc|qua|roi|ngoai))/.exec(text)
    ?? /\b(daily|weekly|monthly|quarterly)\b/.exec(text);
  if (!match) return null;
  const word = match[1];
  if (/^(?:ngay|day|daily)$/.test(word)) return 'day';
  if (/^(?:tuan|week|weekly)$/.test(word)) return 'week';
  if (/^(?:thang|month|monthly)$/.test(word)) return 'month';
  return 'quarter';
}

export function hasReportCompareCue(question: string): boolean {
  return /\b(?:so\s+sanh|so\s+voi|doi\s+chieu|compare[ds]?|comparison|versus|vs)\b/.test(foldReportText(question));
}

function clampToToday(range: ReportDateRangeYmd, today: string): { range: ReportDateRangeYmd; clamped: boolean } {
  return range.date_from <= today && range.date_to > today
    ? { range: { date_from: range.date_from, date_to: today }, clamped: true }
    : { range, clamped: false };
}

export function clampReportRangeToToday(range: ReportDateRangeYmd, today: string): ReportDateRangeYmd {
  return clampToToday(range, today).range;
}

/** Deterministic validation shared by the parser, the model output and UI filters. */
export function validateReportRange(range: ReportDateRangeYmd): {
  issue: Extract<ReportTimeIssueCode, 'reversed_range' | 'range_too_long' | 'invalid_date'> | null;
  alternatives: ReportDateRangeYmd[];
} {
  if (!parseYmd(range.date_from) || !parseYmd(range.date_to)) return { issue: 'invalid_date', alternatives: [] };
  if (range.date_from > range.date_to) {
    const swapped = { date_from: range.date_to, date_to: range.date_from };
    return { issue: 'reversed_range', alternatives: dayCountBetween(swapped.date_from, swapped.date_to) <= MAX_REPORT_RANGE_DAYS ? [swapped] : [] };
  }
  if (dayCountBetween(range.date_from, range.date_to) > MAX_REPORT_RANGE_DAYS) {
    return {
      issue: 'range_too_long',
      alternatives: [
        { date_from: addDays(range.date_to, -(MAX_REPORT_RANGE_DAYS - 1)), date_to: range.date_to },
        { date_from: range.date_from, date_to: addDays(range.date_from, MAX_REPORT_RANGE_DAYS - 1) },
      ],
    };
  }
  return { issue: null, alternatives: [] };
}

export function uniqueReportRanges(ranges: Array<ReportDateRangeYmd | null | undefined>): ReportDateRangeYmd[] {
  const output: ReportDateRangeYmd[] = [];
  for (const range of ranges) {
    if (range && !output.some((existing) => sameRange(existing, range))) output.push(range);
  }
  return output;
}

type ParseBase = Pick<ReportTimeParseResult, 'explicit_year' | 'year_inferred' | 'clamped_to_today' | 'periods' | 'granularity' | 'compare'>;

function clarification(base: ParseBase, issue: ReportTimeIssueCode, alternatives: Array<ReportDateRangeYmd | null>): ReportTimeParseResult {
  return { ...base, status: 'needs_clarification', issue, alternatives: uniqueReportRanges(alternatives), range: null, confidence: 'medium' };
}

function openRangeAlternatives(today: string): ReportDateRangeYmd[] {
  return [
    { date_from: formatYmd(Number(today.slice(0, 4)), 1, 1), date_to: today },
    { date_from: addDays(today, -(MAX_REPORT_RANGE_DAYS - 1)), date_to: today },
    { date_from: `${today.slice(0, 8)}01`, date_to: today },
  ];
}

export function parseReportTimeExpression(question: string, options: { today: string }): ReportTimeParseResult {
  const todayParts = parseYmd(options.today);
  if (!todayParts) throw new Error('REPORT_TIME_REFERENCE_INVALID');
  const context: ParseContext = { today: options.today, todayYear: todayParts.year, todayMonth: todayParts.month };
  const text = foldReportText(question);
  const granularity = detectGranularity(text);
  const compare = hasReportCompareCue(question);
  const mentions = collectMentions(text, context);
  const { periods: drafts, loneOpenEnd } = assemblePeriods(mentions, text);
  const base: ParseBase = {
    explicit_year: mentions.some((mention) => mention.yearExplicit),
    year_inferred: false,
    clamped_to_today: false,
    periods: [],
    granularity,
    compare,
  };
  if (loneOpenEnd) return clarification(base, 'open_range', openRangeAlternatives(options.today));
  if (drafts.length === 0) {
    return { ...base, status: 'none', range: null, confidence: 'none', issue: null, alternatives: [] };
  }

  const resolved = drafts.map((draft) => resolvePeriod(draft, mentions, context));
  base.year_inferred = resolved.some((period) => period.yearInferred);
  base.periods = uniqueReportRanges(resolved.map((period) => period.range));

  const invalid = resolved.find((period) => period.invalid);
  if (invalid) return clarification(base, 'invalid_date', invalid.clamped ? [invalid.clamped] : []);

  let primary = resolved[0];
  if (base.periods.length > 1) {
    const [earlier, later] = [...base.periods].sort((left, right) => left.date_from.localeCompare(right.date_from));
    const comparison = base.periods.length === 2 && compare && earlier.date_to < later.date_from
      ? resolveComparableReportPeriod(later.date_from, later.date_to)
      : null;
    // The snapshot always compares with the period before it; a requested
    // comparison is satisfied when the earlier period is that period (or
    // overlaps it, e.g. "tháng này so với tháng trước").
    if (!comparison || earlier.date_from > comparison.date_to || earlier.date_to < comparison.date_from) {
      const covering = {
        date_from: base.periods.map((range) => range.date_from).sort()[0],
        date_to: base.periods.map((range) => range.date_to).sort().slice(-1)[0],
      };
      return clarification(base, 'multiple_periods', [...base.periods, validateReportRange(covering).issue ? null : covering]);
    }
    // "So sánh tháng 6 với tháng 5": the later period's snapshot already compares with the earlier one.
    primary = resolved.find((period) => sameRange(period.range, later))!;
  }

  const range = primary.range!;
  const validation = validateReportRange(range);
  if (validation.issue) return clarification(base, validation.issue, validation.alternatives);

  if (primary.yearInferred && range.date_from > options.today) {
    return clarification(base, 'future_without_year', [shiftRangeYears(range, -1), range]);
  }

  const clamped = clampToToday(range, options.today);
  const alternative = primary.alternative ? clampToToday(primary.alternative, options.today).range : null;
  return {
    ...base,
    year_inferred: primary.yearInferred,
    status: 'resolved',
    range: clamped.range,
    clamped_to_today: clamped.clamped,
    confidence: primary.medium ? 'medium' : 'high',
    issue: null,
    alternatives: uniqueReportRanges([alternative]).filter((candidate) => !sameRange(candidate, clamped.range)),
  };
}

/**
 * Two readings agree when they are equal after removing days that cannot have
 * data yet (a model often answers "this month" with the full month). When the
 * user wrote no year and only the year differs, the parser's inferred year
 * wins: the model has no better source for it than the parser.
 */
export function reportRangesAgree(
  parsed: ReportDateRangeYmd,
  model: ReportDateRangeYmd,
  today: string,
  parsedYearWasInferred: boolean,
): boolean {
  const left = clampToToday(parsed, today).range;
  const right = clampToToday(model, today).range;
  if (sameRange(left, right)) return true;
  if (!parsedYearWasInferred) return false;
  return parsed.date_from.slice(5) === model.date_from.slice(5)
    && parsed.date_to.slice(5) === model.date_to.slice(5)
    && dayCountBetween(parsed.date_from, parsed.date_to) === dayCountBetween(model.date_from, model.date_to);
}

/** Snapshot chart series are capped at 62 buckets; a too-fine request is coarsened, never truncated. */
export function resolveSnapshotChartGranularity(
  requested: ReportGranularity | null | undefined,
  range: ReportDateRangeYmd,
): 'auto' | 'day' | 'week' | 'month' {
  if (!requested) return 'auto';
  const days = dayCountBetween(range.date_from, range.date_to);
  if (requested === 'day') return days <= 62 ? 'day' : days <= 62 * 7 ? 'week' : 'month';
  if (requested === 'week') return days <= 62 * 7 ? 'week' : 'month';
  return 'month';
}
