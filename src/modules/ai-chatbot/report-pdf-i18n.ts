// Locale-aware dictionary access and number/date formatting for the report PDF.
// Narrative numbers are produced only by these formatters, so the narrative
// validator (report-pdf-narrative.logic.ts) can parse them back exactly.
import { reportPdfEn } from './report-pdf-i18n.en.js';
import { reportPdfVi, type ReportPdfDictionary } from './report-pdf-i18n.vi.js';

export type ReportPdfLocale = 'vi' | 'en';
export type { ReportPdfDictionary } from './report-pdf-i18n.vi.js';

const REPORT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const NUMBER_LOCALE: Record<ReportPdfLocale, string> = { vi: 'vi-VN', en: 'en-US' };
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function getReportPdfDictionary(locale: ReportPdfLocale): ReportPdfDictionary {
  return locale === 'en' ? reportPdfEn : reportPdfVi;
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

export function formatReportBucket(bucket: string, granularity: ReportBucketGranularity, locale: ReportPdfLocale, compact: boolean): string {
  if (granularity === 'month') return formatReportMonth(bucket, locale);
  return compact ? formatReportShortDate(bucket, locale) : formatReportDate(bucket, locale);
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
