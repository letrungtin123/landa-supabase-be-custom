// Locale-aware dictionary access and number/date formatting for the report PDF.
// Narrative numbers are produced only by these formatters, so the narrative
// validator (report-pdf-narrative.logic.ts) can parse them back exactly.
import { resolveReportPdfLabelWords, type ReportPdfLabelWords, type ReportTenantLabels } from './report-labels.logic.js';
import type { ReportUnitLevel } from './report-unit-breakdown.logic.js';
import { buildReportPdfEn, reportPdfEn } from './report-pdf-i18n.en.js';
import { buildReportPdfVi, reportPdfVi, type ReportPdfDictionary } from './report-pdf-i18n.vi.js';

export type ReportPdfLocale = 'vi' | 'en';
export type { ReportPdfDictionary } from './report-pdf-i18n.vi.js';

const REPORT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const NUMBER_LOCALE: Record<ReportPdfLocale, string> = { vi: 'vi-VN', en: 'en-US' };
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * Dictionary of a locale. Without label words it uses the default level and
 * role names; with them (resolved from the tenant's labels, see
 * report-labels.logic.ts) every level and role name is the tenant's.
 */
export function getReportPdfDictionary(locale: ReportPdfLocale, words?: ReportPdfLabelWords): ReportPdfDictionary {
  if (!words) return locale === 'en' ? reportPdfEn : reportPdfVi;
  return locale === 'en' ? buildReportPdfEn(words) : buildReportPdfVi(words);
}

/** Dictionary worded with the tenant's labels, naming the breakdown level of these insights. */
export function getReportPdfDictionaryFor(
  locale: ReportPdfLocale,
  insights: { labels: ReportTenantLabels; unitLevel: ReportUnitLevel | null },
): ReportPdfDictionary {
  return getReportPdfDictionary(locale, resolveReportPdfLabelWords(locale, insights.labels, insights.unitLevel));
}

export function normalizeReportPdfLocale(value: unknown): ReportPdfLocale | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (normalized === 'vi' || normalized.startsWith('vi-')) return 'vi';
  return null;
}

/** Formats a number with at most `digits` decimals (never padded with zeros). */
export function formatReportNumber(value: number, locale: ReportPdfLocale, digits = 0): string {
  const safe = Number.isFinite(value) ? value : 0;
  // Normalize negative zero so "-0" never reaches a document.
  const rounded = Math.round(safe * 10 ** digits) / 10 ** digits;
  return new Intl.NumberFormat(NUMBER_LOCALE[locale], {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
    useGrouping: true,
  }).format(Object.is(rounded, -0) ? 0 : rounded);
}

export function formatReportPercent(value: number, locale: ReportPdfLocale, digits = 1): string {
  return `${formatReportNumber(value, locale, digits)}%`;
}

export function formatReportPercentagePoints(value: number, locale: ReportPdfLocale): string {
  return `${formatReportNumber(Math.abs(value), locale, 1)} ${getReportPdfDictionary(locale).units.pp}`;
}

export function formatReportSignedNumber(value: number, locale: ReportPdfLocale, digits = 0): string {
  const formatted = formatReportNumber(Math.abs(value), locale, digits);
  if (Math.round(value * 10 ** digits) === 0) return formatted;
  return `${value > 0 ? '+' : '−'}${formatted}`;
}

function parseYmd(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3] ?? '1');
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

const pad2 = (value: number) => String(value).padStart(2, '0');

/** 2026-07-01 -> vi "01/07/2026", en "1 Jul 2026". */
export function formatReportDate(value: string, locale: ReportPdfLocale): string {
  const parts = parseYmd(value);
  if (!parts) return value;
  return locale === 'en'
    ? `${parts.day} ${EN_MONTHS[parts.month - 1]} ${parts.year}`
    : `${pad2(parts.day)}/${pad2(parts.month)}/${parts.year}`;
}

/** 2026-07-01 -> vi "01/07", en "1 Jul". */
export function formatReportShortDate(value: string, locale: ReportPdfLocale): string {
  const parts = parseYmd(value);
  if (!parts) return value;
  return locale === 'en' ? `${parts.day} ${EN_MONTHS[parts.month - 1]}` : `${pad2(parts.day)}/${pad2(parts.month)}`;
}

/** 2026-07 -> vi "07/2026", en "Jul 2026". */
export function formatReportMonth(value: string, locale: ReportPdfLocale): string {
  const parts = parseYmd(value);
  if (!parts) return value;
  return locale === 'en' ? `${EN_MONTHS[parts.month - 1]} ${parts.year}` : `${pad2(parts.month)}/${parts.year}`;
}

export type ReportBucketGranularity = 'day' | 'week' | 'month' | 'unknown';

/**
 * A day range written as short as it stays clear:
 * vi "15/06–21/06/2026", "29/12/2025–04/01/2026";
 * en "15–21 Jun 2026", "29 Jun–5 Jul 2026", "29 Dec 2025–4 Jan 2026".
 */
export function formatReportDayRange(from: string, to: string, locale: ReportPdfLocale): string {
  const start = parseYmd(from);
  const end = parseYmd(to);
  if (!start || !end) return `${from}–${to}`;
  if (from === to) return formatReportDate(from, locale);
  const sameYear = start.year === end.year;
  if (locale === 'vi') return `${sameYear ? formatReportShortDate(from, locale) : formatReportDate(from, locale)}–${formatReportDate(to, locale)}`;
  if (sameYear && start.month === end.month) return `${start.day}–${formatReportDate(to, locale)}`;
  return `${sameYear ? formatReportShortDate(from, locale) : formatReportDate(from, locale)}–${formatReportDate(to, locale)}`;
}

/** Days of a chart bucket inside the period (a week or month may be cut by the period). */
export function reportBucketSpan(bucket: string, granularity: ReportBucketGranularity, period: { dateFrom: string; dateTo: string }): { from: string; to: string } {
  const parts = parseYmd(bucket);
  if (!parts || granularity === 'day' || granularity === 'unknown') return { from: bucket, to: bucket };
  const startMs = Date.UTC(parts.year, parts.month - 1, parts.day);
  const endMs = granularity === 'week' ? startMs + 6 * 86_400_000 : Date.UTC(parts.year, parts.month, 0);
  const end = new Date(endMs).toISOString().slice(0, 10);
  return { from: bucket > period.dateFrom ? bucket : period.dateFrom, to: end < period.dateTo ? end : period.dateTo };
}

/**
 * Short x-axis label of a bucket. Days and weeks (first day in the period)
 * show the year only when the period spans two calendar years; months are
 * vi "T4/2026", en "Apr 2026".
 */
export function formatReportBucketTick(bucket: string, granularity: ReportBucketGranularity, locale: ReportPdfLocale, period: { dateFrom: string; dateTo: string }): string {
  if (granularity === 'month') {
    const parts = parseYmd(bucket);
    if (!parts) return bucket;
    return locale === 'en' ? `${EN_MONTHS[parts.month - 1]} ${parts.year}` : `T${parts.month}/${parts.year}`;
  }
  const start = reportBucketSpan(bucket, granularity, period).from;
  return period.dateFrom.slice(0, 4) !== period.dateTo.slice(0, 4) ? formatReportDate(start, locale) : formatReportShortDate(start, locale);
}

/** Full label of a bucket: a date, a week's days in the period or a month. */
export function formatReportBucketLabel(bucket: string, granularity: ReportBucketGranularity, locale: ReportPdfLocale, period: { dateFrom: string; dateTo: string }): string {
  const trends = getReportPdfDictionary(locale).trends;
  if (granularity === 'month') return trends.bucketMonth({ month: formatReportMonth(bucket, locale) });
  if (granularity === 'week') {
    const span = reportBucketSpan(bucket, granularity, period);
    return trends.bucketWeek({ range: formatReportDayRange(span.from, span.to, locale) });
  }
  return formatReportDate(bucket, locale);
}

export function formatReportPeriod(dateFrom: string, dateTo: string, locale: ReportPdfLocale): string {
  return `${formatReportDate(dateFrom, locale)} – ${formatReportDate(dateTo, locale)}`;
}

/** ISO timestamp -> local Vietnam time, e.g. vi "20/09/2026 15:00 (GMT+7)". */
export function formatReportDateTime(value: string, locale: ReportPdfLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const ymd = `${read('year')}-${read('month')}-${read('day')}`;
  return `${formatReportDate(ymd, locale)}${locale === 'en' ? ',' : ''} ${read('hour')}:${read('minute')} (GMT+7)`;
}

/** ASCII-only slug used for file names and storage-safe identifiers. */
export function slugifyReportText(value: string, maxLength = 48): string {
  const slug = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength).replace(/-+$/g, '');
}
