// Pure calendar helpers for chat reports. Every report date is a local
// Asia/Ho_Chi_Minh calendar day in YYYY-MM-DD form; no Date arithmetic here
// depends on the server time zone.

export const REPORT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
export const MAX_REPORT_RANGE_DAYS = 366;

export interface YmdParts {
  year: number;
  month: number;
  day: number;
}

export interface ReportDateRangeYmd {
  date_from: string;
  date_to: string;
}

export interface ReportComparisonPeriod {
  date_from: string;
  date_to: string;
  basis: 'calendar_month' | 'month_to_date' | 'calendar_week' | 'year_to_date' | 'calendar_year' | 'equal_length';
}

export function localYmd(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)
    && year >= 1900 && year <= 2999
    && month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth(year, month);
}

export function parseYmd(value: string): YmdParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidCalendarDate(year, month, day) ? { year, month, day } : null;
}

export function formatYmd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Clamps the day to the last day of the month; null for an impossible month/year. */
export function clampYmd(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1) return null;
  return formatYmd(year, month, Math.min(day, daysInMonth(year, month)));
}

export function addDays(value: string, offset: number): string {
  const parts = parseYmd(value);
  if (!parts) return value;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() + offset);
  return formatYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Moves by whole months and clamps the day (31 Mar - 1 month = 28/29 Feb). */
export function addMonths(value: string, offset: number): string {
  const parts = parseYmd(value);
  if (!parts) return value;
  const monthIndex = parts.year * 12 + (parts.month - 1) + offset;
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  return clampYmd(year, month, parts.day) ?? value;
}

export function startOfWeek(value: string): string {
  const parts = parseYmd(value);
  if (!parts) return value;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const offset = (date.getUTCDay() + 6) % 7;
  return addDays(value, -offset);
}

export function endOfMonth(year: number, month: number): string {
  return formatYmd(year, month, daysInMonth(year, month));
}

export function monthRange(year: number, month: number): ReportDateRangeYmd {
  return { date_from: formatYmd(year, month, 1), date_to: endOfMonth(year, month) };
}

export function quarterOfMonth(month: number): number {
  return Math.floor((month - 1) / 3) + 1;
}

export function quarterRange(year: number, quarter: number): ReportDateRangeYmd {
  const firstMonth = (quarter - 1) * 3 + 1;
  return { date_from: formatYmd(year, firstMonth, 1), date_to: endOfMonth(year, firstMonth + 2) };
}

export function yearRange(year: number): ReportDateRangeYmd {
  return { date_from: formatYmd(year, 1, 1), date_to: formatYmd(year, 12, 31) };
}

export function dayCountBetween(dateFrom: string, dateTo: string): number {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  if (!from || !to) return 0;
  const fromMs = Date.UTC(from.year, from.month - 1, from.day);
  const toMs = Date.UTC(to.year, to.month - 1, to.day);
  return Math.floor((toMs - fromMs) / 86_400_000) + 1;
}

export function shiftRangeYears(range: ReportDateRangeYmd, years: number): ReportDateRangeYmd {
  return { date_from: addMonths(range.date_from, years * 12), date_to: addMonths(range.date_to, years * 12) };
}

export function sameRange(left: ReportDateRangeYmd | null | undefined, right: ReportDateRangeYmd | null | undefined): boolean {
  return Boolean(left && right && left.date_from === right.date_from && left.date_to === right.date_to);
}

export function isValidReportRange(range: ReportDateRangeYmd): boolean {
  return Boolean(parseYmd(range.date_from) && parseYmd(range.date_to));
}

export interface ReportNearestDataPeriod extends ReportDateRangeYmd {
  direction: 'before' | 'after';
}

/**
 * The calendar month (ending no later than today) around the closest date
 * that has data, before or after an empty requested range.
 */
export function resolveNearestReportDataPeriod(input: {
  before: string | null;
  after: string | null;
  range: ReportDateRangeYmd;
  today: string;
}): ReportNearestDataPeriod | null {
  const candidates: Array<{ date: string; direction: 'before' | 'after'; distance: number }> = [];
  if (input.before && parseYmd(input.before) && input.before < input.range.date_from) {
    candidates.push({ date: input.before, direction: 'before', distance: dayCountBetween(input.before, input.range.date_from) });
  }
  if (input.after && parseYmd(input.after) && input.after > input.range.date_to && input.after <= input.today) {
    candidates.push({ date: input.after, direction: 'after', distance: dayCountBetween(input.range.date_to, input.after) });
  }
  const nearest = candidates.sort((left, right) => left.distance - right.distance)[0];
  if (!nearest) return null;
  const parts = parseYmd(nearest.date)!;
  const month = monthRange(parts.year, parts.month);
  return {
    date_from: month.date_from,
    date_to: month.date_to > input.today ? input.today : month.date_to,
    direction: nearest.direction,
  };
}

function isCalendarMonth(dateFrom: string, dateTo: string): boolean {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  return Boolean(from
    && to
    && from.year === to.year
    && from.month === to.month
    && from.day === 1
    && dateTo === endOfMonth(to.year, to.month));
}

function isCalendarWeek(dateFrom: string, dateTo: string): boolean {
  return startOfWeek(dateFrom) === dateFrom && dayCountBetween(dateFrom, dateTo) === 7;
}

function isCalendarYear(dateFrom: string, dateTo: string): boolean {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  return Boolean(from && to && from.month === 1 && from.day === 1 && to.month === 12 && to.day === 31);
}

function isMonthToDate(dateFrom: string, dateTo: string): boolean {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  return Boolean(from
    && to
    && from.year === to.year
    && from.month === to.month
    && from.day === 1
    && to.day < daysInMonth(to.year, to.month));
}

function isYearToDate(dateFrom: string, dateTo: string): boolean {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  return Boolean(from
    && to
    && from.year === to.year
    && from.month === 1
    && from.day === 1
    && !(to.month === 12 && to.day === 31));
}

function sameCalendarDateInYear(dateFrom: string, dateTo: string, targetYear: number): ReportDateRangeYmd {
  const from = parseYmd(dateFrom)!;
  const to = parseYmd(dateTo)!;
  return {
    date_from: clampYmd(targetYear, from.month, from.day)!,
    date_to: clampYmd(targetYear, to.month, to.day)!,
  };
}

export function resolveComparableReportPeriod(dateFrom: string, dateTo: string): ReportComparisonPeriod {
  const from = parseYmd(dateFrom);
  const to = parseYmd(dateTo);
  if (!from || !to) throw { status: 400, message: 'Khoảng ngày báo cáo không hợp lệ' };

  if (isCalendarYear(dateFrom, dateTo)) {
    return {
      date_from: formatYmd(from.year - 1, 1, 1),
      date_to: formatYmd(from.year - 1, 12, 31),
      basis: 'calendar_year',
    };
  }
  if (isYearToDate(dateFrom, dateTo)) {
    return { ...sameCalendarDateInYear(dateFrom, dateTo, from.year - 1), basis: 'year_to_date' };
  }
  if (isCalendarMonth(dateFrom, dateTo)) {
    const previousMonth = from.month === 1 ? 12 : from.month - 1;
    const previousYear = from.month === 1 ? from.year - 1 : from.year;
    return {
      date_from: formatYmd(previousYear, previousMonth, 1),
      date_to: endOfMonth(previousYear, previousMonth),
      basis: 'calendar_month',
    };
  }
  if (isCalendarWeek(dateFrom, dateTo)) {
    return { date_from: addDays(dateFrom, -7), date_to: addDays(dateTo, -7), basis: 'calendar_week' };
  }
  if (isMonthToDate(dateFrom, dateTo)) {
    const previousMonth = from.month === 1 ? 12 : from.month - 1;
    const previousYear = from.month === 1 ? from.year - 1 : from.year;
    return {
      date_from: formatYmd(previousYear, previousMonth, 1),
      date_to: clampYmd(previousYear, previousMonth, to.day)!,
      basis: 'month_to_date',
    };
  }
  const days = dayCountBetween(dateFrom, dateTo);
  return {
    date_from: addDays(dateFrom, -days),
    date_to: addDays(dateFrom, -1),
    basis: 'equal_length',
  };
}
