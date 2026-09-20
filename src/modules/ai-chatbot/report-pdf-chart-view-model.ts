import type { ReportMetricFact, StoredReportChatSnapshot } from './report-chat.service.js';

export type ReportPdfLocale = 'vi' | 'en';

export interface ReportPdfTrendViewModel {
  title: string;
  subtitle: string;
  xAxisLabel: string;
  yAxisLabel: string;
  points: Array<{ bucket: string; label: string; value: number }>;
  xTicks: Array<{ index: number; label: string }>;
  yTicks: number[];
  yMax: number;
  peak: { index: number; value: number; valueLabel: string; dateLabel: string } | null;
  latest: { index: number; value: number; valueLabel: string; dateLabel: string } | null;
  summary: Array<{ label: string; value: string; detail: string }>;
}

export interface ReportPdfCourseBarViewModel {
  courseId: string;
  name: string;
  displayName: string;
  enrollments: number;
  barRatio: number;
  valueLabel: string;
}

export interface ReportPdfCompletionRowViewModel {
  courseId: string;
  name: string;
  completionRateLabel: string;
  enrollmentLabel: string;
  completedLabel: string;
  markerRatio: number;
  needsAttention: boolean;
}

export interface ReportPdfStatusDistributionViewModel {
  totalLabel: string;
  segments: Array<{
    key: 'completed' | 'in_progress' | 'not_started';
    label: string;
    countLabel: string;
    percentageLabel: string;
    ratio: number;
  }>;
}

export interface ReportPdfCourseSignalViewModel {
  title: string;
  body: string;
}

export interface ReportPdfChartViewModel {
  trend: ReportPdfTrendViewModel | null;
  topCourses: ReportPdfCourseBarViewModel[];
  completionRows: ReportPdfCompletionRowViewModel[];
  statusDistribution: ReportPdfStatusDistributionViewModel | null;
  courseSignal: ReportPdfCourseSignalViewModel | null;
}

function isEnglish(locale: ReportPdfLocale): boolean {
  return locale === 'en';
}

function number(value: number, locale: ReportPdfLocale, digits = 0): string {
  return new Intl.NumberFormat(isEnglish(locale) ? 'en-US' : 'vi-VN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(value);
}

function enrollmentLabel(value: number, locale: ReportPdfLocale): string {
  return isEnglish(locale) ? `${number(value, locale)} enrollments` : `${number(value, locale)} lượt ghi danh`;
}

function completedLabel(value: number, locale: ReportPdfLocale): string {
  return isEnglish(locale) ? `${number(value, locale)} completed` : `${number(value, locale)} lượt hoàn thành`;
}

function completionRateLabel(value: number, locale: ReportPdfLocale): string {
  return isEnglish(locale)
    ? `${number(value, locale, 1)}% completion`
    : `${number(value, locale, 1)}% hoàn thành`;
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3] ?? '1');
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value: string, locale: ReportPdfLocale, compact = false): string {
  const date = parseDate(value);
  if (!date) return value;
  return new Intl.DateTimeFormat(isEnglish(locale) ? 'en-GB' : 'vi-VN', compact
    ? { day: '2-digit', month: isEnglish(locale) ? 'short' : '2-digit', timeZone: 'UTC' }
    : { day: '2-digit', month: isEnglish(locale) ? 'short' : '2-digit', year: 'numeric', timeZone: 'UTC' },
  ).format(date);
}

function formatPeriod(snapshot: StoredReportChatSnapshot, locale: ReportPdfLocale): string {
  return `${formatDate(snapshot.filter.date_from, locale)} - ${formatDate(snapshot.filter.date_to, locale)}`;
}

function metric(snapshot: StoredReportChatSnapshot, id: ReportMetricFact['id']): ReportMetricFact | null {
  return snapshot.version === 2 ? snapshot.factual_metrics.find((item) => item.id === id) ?? null : null;
}

function niceStep(maxValue: number): number {
  const rough = Math.max(maxValue, 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function yAxis(maxValue: number): { ticks: number[]; max: number } {
  const step = niceStep(maxValue);
  const max = Math.max(step * 4, Math.ceil(maxValue / step) * step);
  return { ticks: [0, 1, 2, 3, 4].map((index) => index * (max / 4)), max };
}

function xTickIndexes(size: number): number[] {
  if (size <= 0) return [];
  const target = size <= 4 ? size : size <= 10 ? 5 : 7;
  return [...new Set(Array.from({ length: target }, (_, index) => Math.round(index * (size - 1) / Math.max(target - 1, 1))))];
}

function displayName(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return value;
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= 34 || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === 2) break;
  }
  if (line && lines.length < 2) lines.push(line);
  const consumed = lines.join(' ').split(/\s+/).length;
  if (consumed < words.length) lines[lines.length - 1] = `${lines[lines.length - 1]}…`;
  return lines.join('\n');
}

function trendCopy(locale: ReportPdfLocale, granularity?: 'day' | 'week' | 'month') {
  const en = isEnglish(locale);
  const suffix = granularity === 'day'
    ? (en ? 'by day' : 'theo ngày')
    : granularity === 'week'
      ? (en ? 'by week' : 'theo tuần')
      : granularity === 'month'
        ? (en ? 'by month' : 'theo tháng')
        : (en ? 'during the reporting period' : 'trong kỳ báo cáo');
  return {
    title: en ? `Enrollment trend ${suffix}` : `Xu hướng lượt ghi danh ${suffix}`,
    xAxisLabel: granularity === 'day' ? (en ? 'Date' : 'Ngày') : granularity === 'week' ? (en ? 'Week' : 'Tuần') : granularity === 'month' ? (en ? 'Month' : 'Tháng') : (en ? 'Reporting period' : 'Kỳ báo cáo'),
    yAxisLabel: en ? 'Enrollments' : 'Lượt ghi danh',
    peak: en ? 'Peak' : 'Cao nhất',
    total: en ? 'Total in period' : 'Tổng trong kỳ',
    end: en ? 'End of period' : 'Cuối kỳ',
  };
}

function buildTrend(snapshot: StoredReportChatSnapshot, locale: ReportPdfLocale): ReportPdfTrendViewModel | null {
  const points = snapshot.enrollment_trend.filter((point) => Number.isFinite(point.value) && point.value >= 0);
  if (!points.length) return null;
  const granularity = snapshot.version === 2 ? snapshot.enrollment_trend_context?.granularity : undefined;
  const copy = trendCopy(locale, granularity);
  const peakValue = Math.max(...points.map((point) => point.value));
  const peakIndex = points.findIndex((point) => point.value === peakValue);
  const latestIndex = points.length - 1;
  const axis = yAxis(peakValue);
  const totalEnrollments = metric(snapshot, 'total_enrollments')?.current ?? snapshot.summary.overview.total_enrollments;
  const pointInfo = (index: number) => ({
    index,
    value: points[index].value,
    valueLabel: enrollmentLabel(points[index].value, locale),
    dateLabel: formatDate(points[index].bucket, locale),
  });
  return {
    title: copy.title,
    subtitle: `${formatPeriod(snapshot, locale)} · ${isEnglish(locale) ? 'Unit' : 'Đơn vị'}: ${copy.yAxisLabel.toLocaleLowerCase(isEnglish(locale) ? 'en-US' : 'vi-VN')}`,
    xAxisLabel: copy.xAxisLabel,
    yAxisLabel: copy.yAxisLabel,
    points,
    xTicks: xTickIndexes(points.length).map((index) => ({ index, label: formatDate(points[index].bucket, locale, true) })),
    yTicks: axis.ticks,
    yMax: axis.max,
    peak: pointInfo(peakIndex),
    latest: pointInfo(latestIndex),
    summary: [
      { label: copy.peak, value: enrollmentLabel(points[peakIndex].value, locale), detail: formatDate(points[peakIndex].bucket, locale) },
      { label: copy.total, value: enrollmentLabel(totalEnrollments, locale), detail: formatPeriod(snapshot, locale) },
      { label: copy.end, value: enrollmentLabel(points[latestIndex].value, locale), detail: formatDate(points[latestIndex].bucket, locale) },
    ],
  };
}

function buildCourseSignal(snapshot: StoredReportChatSnapshot, locale: ReportPdfLocale): ReportPdfCourseSignalViewModel | null {
  if (snapshot.version !== 2) return null;
  const signal = snapshot.signals.find((item) => item.id === 'high_enrollment_low_completion');
  const evidence = signal?.evidence;
  if (!evidence?.course_name || evidence.enrollment_count === undefined || evidence.completion_rate === undefined) return null;
  const title = isEnglish(locale) ? 'Item to watch' : 'Điểm cần theo dõi';
  const body = isEnglish(locale)
    ? `${evidence.course_name}: ${enrollmentLabel(evidence.enrollment_count, locale)} · ${completionRateLabel(evidence.completion_rate, locale)}.`
    : `${evidence.course_name}: ${enrollmentLabel(evidence.enrollment_count, locale)} · ${completionRateLabel(evidence.completion_rate, locale)}.`;
  return { title, body };
}

export function buildReportPdfChartViewModel(snapshot: StoredReportChatSnapshot, locale: ReportPdfLocale): ReportPdfChartViewModel {
  const topCourses = [...snapshot.top_courses]
    .sort((left, right) => right.enrollments - left.enrollments || left.name.localeCompare(right.name))
    .slice(0, 5);
  const maxEnrollments = Math.max(...topCourses.map((course) => course.enrollments), 1);
  const attentionIds = new Set(snapshot.version === 2
    ? snapshot.signals.filter((signal) => signal.id === 'high_enrollment_low_completion').map((signal) => signal.evidence.course_id).filter((id): id is string => Boolean(id))
    : []);
  const completionRows = snapshot.completion_ranking.slice(0, 5).map((course) => ({
    courseId: course.course_id,
    name: course.name,
    completionRateLabel: completionRateLabel(course.completion_rate, locale),
    enrollmentLabel: enrollmentLabel(course.total_enrollments, locale),
    completedLabel: completedLabel(course.completed_enrollments, locale),
    markerRatio: Math.max(0, Math.min(course.completion_rate, 100)) / 100,
    needsAttention: attentionIds.has(course.course_id),
  }));
  const distribution = snapshot.version === 2 ? snapshot.completion_status_distribution : null;
  const distributionTotal = distribution ? distribution.completed + distribution.in_progress + distribution.not_started : 0;
  const statusLabels = isEnglish(locale)
    ? { completed: 'Completed', in_progress: 'In progress', not_started: 'Not started' }
    : { completed: 'Đã hoàn thành', in_progress: 'Đang học', not_started: 'Chưa bắt đầu' };
  return {
    trend: buildTrend(snapshot, locale),
    topCourses: topCourses.map((course) => ({
      courseId: course.course_id,
      name: course.name,
      displayName: displayName(course.name),
      enrollments: course.enrollments,
      barRatio: course.enrollments / maxEnrollments,
      valueLabel: enrollmentLabel(course.enrollments, locale),
    })),
    completionRows,
    statusDistribution: distribution && distributionTotal > 0 ? {
      totalLabel: isEnglish(locale) ? `Total: ${number(distributionTotal, locale)} enrollments` : `Tổng: ${number(distributionTotal, locale)} lượt ghi danh`,
      segments: (['completed', 'in_progress', 'not_started'] as const).map((key) => ({
        key,
        label: statusLabels[key],
        countLabel: isEnglish(locale) ? `${number(distribution[key], locale)} enrollments` : `${number(distribution[key], locale)} lượt`,
        percentageLabel: `${number((distribution[key] / distributionTotal) * 100, locale, 1)}%`,
        ratio: distribution[key] / distributionTotal,
      })),
    } : null,
    courseSignal: buildCourseSignal(snapshot, locale),
  };
}
