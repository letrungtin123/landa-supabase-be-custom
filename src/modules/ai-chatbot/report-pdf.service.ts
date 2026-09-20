import { getReportComparisonDisplay, type ReportAnalyticsSignal, type ReportMetricFact, type StoredReportChatSnapshot } from './report-chat.service.js';
import { renderExecutiveReportPdf, type ReportPdfNarrative } from './report-pdf-presentation.js';

export type { ReportPdfNarrative } from './report-pdf-presentation.js';

function snapshotMetric(snapshot: StoredReportChatSnapshot, id: ReportMetricFact['id']): ReportMetricFact | null {
  return snapshot.version === 2 ? snapshot.factual_metrics.find((metric) => metric.id === id) ?? null : null;
}

function metricDelta(metric: ReportMetricFact | null): number | null {
  return metric?.unit === 'percentage' ? metric.delta_percentage_points : metric?.delta_absolute ?? null;
}

function signalFor(snapshot: StoredReportChatSnapshot, id: string): ReportAnalyticsSignal | null {
  return snapshot.version === 2 ? snapshot.signals.find((signal) => signal.id === id) ?? null : null;
}

function fallbackNarrative(snapshot: StoredReportChatSnapshot, locale: 'vi' | 'en'): ReportPdfNarrative {
  const comparison = snapshot.version === 2 ? getReportComparisonDisplay(snapshot.comparison, locale) : null;
  const suffix = comparison?.delta_suffix ?? (locale === 'en' ? 'vs the comparison period' : 'so với giai đoạn so sánh');
  const completion = metricDelta(snapshotMetric(snapshot, 'completion_rate'));
  const enrollments = metricDelta(snapshotMetric(snapshot, 'total_enrollments'));
  const highlights: string[] = [];
  if (completion !== null && completion !== 0) highlights.push(locale === 'en' ? `Completion ${completion > 0 ? 'improved' : 'declined'} ${suffix}.` : `Tỷ lệ hoàn thành ${completion > 0 ? 'cải thiện' : 'giảm'} ${suffix}.`);
  if (enrollments !== null && enrollments !== 0) highlights.push(locale === 'en' ? `Enrollment volume ${enrollments > 0 ? 'increased' : 'decreased'} ${suffix}.` : `Lượt ghi danh ${enrollments > 0 ? 'tăng' : 'giảm'} ${suffix}.`);
  if (!highlights.length) highlights.push(locale === 'en' ? 'The selected period did not show a material change in the available comparison metrics.' : 'Giai đoạn đã chọn chưa cho thấy thay đổi đáng kể ở các chỉ số có dữ liệu so sánh.');

  const risks: string[] = [];
  const recommendations: string[] = [];
  const course = signalFor(snapshot, 'high_enrollment_low_completion')?.evidence.course_name;
  if (course) {
    risks.push(locale === 'en' ? `${course} has high participation with a low completion rate.` : `${course} có lượng tham gia cao nhưng tỷ lệ hoàn thành thấp.`);
    recommendations.push(locale === 'en' ? `Review incomplete learner cohorts and the delivery schedule for ${course}.` : `Rà soát nhóm người học chưa hoàn thành và lịch triển khai của ${course}.`);
  }
  if (signalFor(snapshot, 'completion_decline')) {
    risks.push(locale === 'en' ? 'Average completion rate declined against the comparison period.' : 'Tỷ lệ hoàn thành trung bình giảm so với giai đoạn so sánh.');
    recommendations.push(locale === 'en' ? 'Review courses and learner cohorts with incomplete progress.' : 'Rà soát các khóa học và nhóm người học có tiến độ chưa hoàn thành.');
  }
  if (signalFor(snapshot, 'end_period_activity_drop')) {
    risks.push(locale === 'en' ? 'Learning activity fell near the end of the reporting period.' : 'Hoạt động học giảm ở cuối kỳ báo cáo.');
    recommendations.push(locale === 'en' ? 'Check the learning schedule and reminders near the end of the period.' : 'Kiểm tra lịch học và nhắc nhở người học trong giai đoạn cuối kỳ.');
  }
  return { headline: locale === 'en' ? 'Executive summary' : 'Tóm tắt điều hành', highlights: highlights.slice(0, 3), risks: risks.slice(0, 3), recommendations: recommendations.slice(0, 3) };
}

export async function generateReportPdfNarrative(input: { tenantId: string; model: string; locale: 'vi' | 'en'; question: string; snapshot: StoredReportChatSnapshot }): Promise<ReportPdfNarrative> {
  // The immutable snapshot remains the only factual source for PDF content.
  void input.tenantId; void input.model; void input.question;
  return fallbackNarrative(input.snapshot, input.locale);
}

export async function renderReportPdf(input: { snapshot: StoredReportChatSnapshot; narrative: ReportPdfNarrative; locale: 'vi' | 'en' }): Promise<Buffer> {
  return renderExecutiveReportPdf(input);
}
