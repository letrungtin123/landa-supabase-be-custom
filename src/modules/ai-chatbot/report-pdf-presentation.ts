import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import type { ReportMetricFact, StoredReportChatSnapshot } from './report-chat.service.js';
import { buildReportPdfChartViewModel, type ReportPdfLocale } from './report-pdf-chart-view-model.js';
import { reportPdfTheme } from './report-pdf-theme.js';

export type ReportPdfNarrative = { headline: string; highlights: string[]; risks: string[]; recommendations: string[] };

type SectionKind = 'header' | 'kpis' | 'summary' | 'trend' | 'courses' | 'status' | 'completion';
type Section = { kind: SectionKind; height: number };
type PagePlan = { sections: Section[]; used: number };
type Kpi = { label: string; value: string; fact: ReportMetricFact | null };

const theme = reportPdfTheme;
const page = theme.page;
const contentWidth = page.width - page.marginX * 2;
const contentHeight = page.height - page.top - page.bottom - page.footer;
const fontDir = path.resolve(process.cwd(), 'node_modules', '@embedpdf', 'fonts-latin', 'fonts');
const font = { regular: 'NessoReport', bold: 'NessoReportBold' };

function copy(locale: ReportPdfLocale) {
  return locale === 'en' ? {
    brand: 'LEARNING ANALYTICS', title: 'Learning performance report', scope: 'All authorized scope', generated: 'Generated', overview: 'Executive overview', learners: 'Total learners created', active: 'Learners with learning activity', completion: 'Average completion rate', enrollments: 'Enrollments in period', summary: 'Management takeaway', detail: 'Report prepared from verified data in the authorized scope.', courseChart: 'Courses with the most enrollments', courseSubtitle: 'Selected reporting period · Unit: enrollments', status: 'Learning status distribution', completionPerformance: 'Completion performance', completionSubtitle: 'Completion rate is based on learning progress.', completionRate: 'Completion rate', verified: 'NESSO Learning Analytics', noComparison: 'No comparison data', noTrend: 'No enrollment trend is available for this period.', noChange: 'No change', increase: 'Increase', decrease: 'Decrease', comparison: 'vs comparison period',
  } : {
    brand: 'LEARNING ANALYTICS', title: 'Báo cáo hiệu quả học tập', scope: 'Toàn bộ phạm vi được phép xem', generated: 'Thời điểm tạo', overview: 'Tổng quan điều hành', learners: 'Tổng học viên đã tạo', active: 'Học viên có hoạt động học', completion: 'Tỷ lệ hoàn thành trung bình', enrollments: 'Lượt ghi danh trong kỳ', summary: 'Điểm chính dành cho quản lý', detail: 'Báo cáo được tổng hợp từ dữ liệu đã xác thực trong phạm vi được phép xem.', courseChart: 'Khóa học có nhiều lượt ghi danh', courseSubtitle: 'Kỳ báo cáo đã chọn · Đơn vị: lượt ghi danh', status: 'Phân bố trạng thái học tập', completionPerformance: 'Hiệu suất hoàn thành', completionSubtitle: 'Tỷ lệ hoàn thành dựa trên tiến độ học tập.', completionRate: 'Tỷ lệ hoàn thành', verified: 'NESSO Learning Analytics', noComparison: 'Chưa có dữ liệu so sánh', noTrend: 'Không có dữ liệu xu hướng ghi danh trong kỳ này.', noChange: 'Không thay đổi', increase: 'Tăng', decrease: 'Giảm', comparison: 'so với kỳ đối chiếu',
  };
}

function isEnglish(locale: ReportPdfLocale): boolean { return locale === 'en'; }
function number(value: number, locale: ReportPdfLocale, digits = 0): string { return new Intl.NumberFormat(isEnglish(locale) ? 'en-US' : 'vi-VN', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value); }
function date(value: string, locale: ReportPdfLocale, includeTime = false): string {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(isEnglish(locale) ? 'en-GB' : 'vi-VN', includeTime
    ? { day: '2-digit', month: isEnglish(locale) ? 'short' : '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' }
    : { day: '2-digit', month: isEnglish(locale) ? 'short' : '2-digit', year: 'numeric', timeZone: 'UTC' },
  ).format(parsed);
}
function metric(snapshot: StoredReportChatSnapshot, id: ReportMetricFact['id']): ReportMetricFact | null { return snapshot.version === 2 ? snapshot.factual_metrics.find((item) => item.id === id) ?? null : null; }
function deltaValue(fact: ReportMetricFact | null): number | null { return fact?.unit === 'percentage' ? fact.delta_percentage_points : fact?.delta_absolute ?? null; }

function registerFonts(doc: PDFKit.PDFDocument): void {
  const resolve = (env: string, name: string) => [process.env[env]?.trim(), path.join(fontDir, name), process.platform === 'win32' ? path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', name) : '', path.join('/usr/share/fonts/truetype/noto', name)].find((candidate) => Boolean(candidate) && fs.existsSync(candidate!));
  const regular = resolve('REPORT_PDF_FONT_REGULAR', 'NotoSans-Regular.ttf') ?? resolve('REPORT_PDF_FONT_REGULAR', 'arial.ttf');
  const bold = resolve('REPORT_PDF_FONT_BOLD', 'NotoSans-Bold.ttf') ?? resolve('REPORT_PDF_FONT_BOLD', 'arialbd.ttf');
  if (!regular || !bold) throw new Error('Không tìm thấy font Unicode cho PDF báo cáo.');
  doc.registerFont(font.regular, regular);
  doc.registerFont(font.bold, bold);
}

function divider(doc: PDFKit.PDFDocument, y: number, x = page.marginX, width = contentWidth): void { doc.moveTo(x, y).lineTo(x + width, y).lineWidth(0.65).strokeColor(theme.color.divider).stroke(); }
function sectionHeading(doc: PDFKit.PDFDocument, title: string, y: number): void { doc.font(font.bold).fontSize(theme.type.section).fillColor(theme.color.ink).text(title, page.marginX, y, { lineBreak: false }); }
function chartSubtitle(doc: PDFKit.PDFDocument, title: string, y: number): void { doc.font(font.regular).fontSize(theme.type.label).fillColor(theme.color.muted).text(title, page.marginX, y, { lineBreak: false }); }

function buildModel(snapshot: StoredReportChatSnapshot, narrative: ReportPdfNarrative, locale: ReportPdfLocale) {
  const labels = copy(locale);
  const scope = snapshot.version === 2 ? [snapshot.scope_display?.group_name, snapshot.scope_display?.subgroup_name, snapshot.scope_display?.team_name].filter(Boolean).join(' / ') : '';
  const kpis: Kpi[] = [
    { label: labels.learners, value: number(snapshot.summary.overview.total_learners, locale), fact: metric(snapshot, 'total_learners') },
    { label: labels.active, value: number(snapshot.summary.overview.active_learners, locale), fact: metric(snapshot, 'active_learners') },
    { label: labels.completion, value: `${number(snapshot.summary.overview.completion_rate, locale, 1)}%`, fact: metric(snapshot, 'completion_rate') },
    { label: labels.enrollments, value: number(snapshot.summary.overview.total_enrollments, locale), fact: metric(snapshot, 'total_enrollments') },
  ];
  return { snapshot, locale, labels, scope: scope || labels.scope, kpis, takeaway: narrative.highlights[0]?.trim() || narrative.headline.trim() || labels.detail, charts: buildReportPdfChartViewModel(snapshot, locale) };
}

type Model = ReturnType<typeof buildModel>;

function deltaLabel(fact: ReportMetricFact | null, model: Model): string {
  const value = deltaValue(fact);
  if (!fact || fact.previous === null || value === null) return model.labels.noComparison;
  if (value === 0) return `${model.labels.noChange} ${model.labels.comparison}`;
  const unit = fact.unit === 'percentage'
    ? (isEnglish(model.locale) ? ' percentage points' : ' điểm %')
    : fact.id === 'total_enrollments'
      ? (isEnglish(model.locale) ? ' enrollments' : ' lượt ghi danh')
      : (isEnglish(model.locale) ? ' learners' : ' học viên');
  return `${value > 0 ? model.labels.increase : model.labels.decrease} ${number(Math.abs(value), model.locale, fact.unit === 'percentage' ? 1 : 0)}${unit} ${model.labels.comparison}`;
}

function drawHeader(doc: PDFKit.PDFDocument, model: Model, y: number): void {
  doc.rect(page.marginX, y, contentWidth, 3).fill(theme.color.primary);
  doc.font(font.bold).fontSize(theme.type.eyebrow).fillColor(theme.color.primary).text('NESSO', page.marginX, y + 14, { characterSpacing: 1.2, lineBreak: false });
  doc.font(font.regular).fontSize(theme.type.eyebrow).fillColor(theme.color.muted).text(model.labels.brand, page.marginX, y + 26, { characterSpacing: 0.7, lineBreak: false });
  doc.font(font.bold).fontSize(theme.type.title).fillColor(theme.color.ink).text(model.labels.title, page.marginX, y + 42, { width: 322, lineBreak: false });
  doc.font(font.regular).fontSize(theme.type.body).fillColor(theme.color.text).text(`${date(model.snapshot.filter.date_from, model.locale)} - ${date(model.snapshot.filter.date_to, model.locale)}`, page.marginX, y + 69, { lineBreak: false });
  const metaX = page.marginX + 356;
  doc.font(font.bold).fontSize(theme.type.label).fillColor(theme.color.ink).text(model.scope, metaX, y + 16, { width: contentWidth - 356, lineBreak: false, ellipsis: true });
  doc.font(font.regular).fontSize(theme.type.label).fillColor(theme.color.muted).text(model.labels.generated, metaX, y + 39, { lineBreak: false });
  doc.font(font.regular).fontSize(theme.type.body).fillColor(theme.color.text).text(date(model.snapshot.generated_at, model.locale, true), metaX, y + 51, { width: contentWidth - 356, lineBreak: false });
  divider(doc, y + 87);
}

function drawKpis(doc: PDFKit.PDFDocument, model: Model, y: number): void {
  sectionHeading(doc, model.labels.overview, y);
  const top = y + 25; const gap = 12; const cardWidth = (contentWidth - gap) / 2;
  model.kpis.forEach((kpi, index) => {
    const x = page.marginX + (index % 2) * (cardWidth + gap); const rowY = top + Math.floor(index / 2) * 52;
    doc.rect(x, rowY, cardWidth, 2).fill(theme.color.primary); doc.rect(x, rowY + 2, cardWidth, 46).fill(theme.color.surface);
    doc.font(font.bold).fontSize(theme.type.eyebrow).fillColor(theme.color.muted).text(kpi.label.toUpperCase(), x + 10, rowY + 10, { width: cardWidth - 20, lineBreak: false });
    doc.font(font.bold).fontSize(theme.type.kpi).fillColor(theme.color.ink).text(kpi.value, x + 10, rowY + 21, { width: cardWidth - 20, lineBreak: false });
    doc.font(font.regular).fontSize(6.9).fillColor(theme.color.text).text(deltaLabel(kpi.fact, model), x + 68, rowY + 35, { width: cardWidth - 78, lineBreak: false, ellipsis: true });
  });
}

function drawSummary(doc: PDFKit.PDFDocument, model: Model, y: number): void {
  sectionHeading(doc, model.labels.summary, y);
  doc.font(font.regular).fontSize(11.2).fillColor(theme.color.ink).text(model.takeaway, page.marginX, y + 23, { width: contentWidth, lineGap: 3 });
  divider(doc, y + 67);
}

function pointAt(points: Array<{ value: number }>, index: number, x: number, y: number, width: number, height: number, max: number): { x: number; y: number } { return { x: x + (points.length <= 1 ? width / 2 : index * width / (points.length - 1)), y: y + height - (points[index].value / max) * height }; }

function drawTrend(doc: PDFKit.PDFDocument, model: Model, y: number): void {
  const chart = model.charts.trend;
  if (!chart) { sectionHeading(doc, model.labels.enrollments, y); chartSubtitle(doc, model.labels.noTrend, y + 17); return; }
  sectionHeading(doc, chart.title, y); chartSubtitle(doc, chart.subtitle, y + 17);
  const axisX = page.marginX + 37; const axisY = y + 50; const plotWidth = contentWidth - 46; const plotHeight = 112;
  chart.yTicks.forEach((tick) => { const tickY = axisY + plotHeight - (tick / chart.yMax) * plotHeight; doc.moveTo(axisX, tickY).lineTo(axisX + plotWidth, tickY).lineWidth(0.55).strokeColor(theme.color.divider).stroke(); doc.font(font.regular).fontSize(6.8).fillColor(theme.color.muted).text(number(tick, model.locale), page.marginX, tickY - 3, { width: 30, align: 'right', lineBreak: false }); });
  const points = chart.points.map((_, index) => pointAt(chart.points, index, axisX, axisY, plotWidth, plotHeight, chart.yMax));
  if (points.length > 1) {
    doc.save().fillColor(theme.color.primary).fillOpacity(0.08).moveTo(points[0].x, axisY + plotHeight); points.forEach((point) => doc.lineTo(point.x, point.y)); doc.lineTo(points.at(-1)!.x, axisY + plotHeight).closePath().fill().restore();
    doc.save().lineWidth(2.1).strokeColor(theme.color.primary).moveTo(points[0].x, points[0].y); points.slice(1).forEach((point) => doc.lineTo(point.x, point.y)); doc.stroke().restore();
  }
  const peak = chart.peak ? points[chart.peak.index] : null; const latest = chart.latest ? points[chart.latest.index] : null;
  if (peak) doc.circle(peak.x, peak.y, 3.5).fill(theme.color.canvas).lineWidth(1.7).strokeColor(theme.color.primary).stroke();
  if (latest && (!peak || latest.x !== peak.x || latest.y !== peak.y)) doc.circle(latest.x, latest.y, 2.8).fill(theme.color.primary);
  chart.xTicks.forEach((tick) => { const point = points[tick.index]; doc.font(font.regular).fontSize(6.6).fillColor(theme.color.muted).text(tick.label, point.x - 27, axisY + plotHeight + 7, { width: 54, align: 'center', lineBreak: false }); });
  doc.font(font.regular).fontSize(6.8).fillColor(theme.color.muted).text(`${isEnglish(model.locale) ? 'X-axis' : 'Trục X'}: ${chart.xAxisLabel} · ${isEnglish(model.locale) ? 'Y-axis' : 'Trục Y'}: ${chart.yAxisLabel}`, page.marginX, axisY + plotHeight + 21, { lineBreak: false });
  const summaryY = axisY + plotHeight + 39;
  chart.summary.forEach((item, index) => { const columnWidth = contentWidth / chart.summary.length; const x = page.marginX + index * columnWidth; if (index) doc.moveTo(x, summaryY).lineTo(x, summaryY + 35).lineWidth(0.6).strokeColor(theme.color.divider).stroke(); const offset = index ? 10 : 0; doc.font(font.bold).fontSize(6.8).fillColor(theme.color.muted).text(item.label.toUpperCase(), x + offset, summaryY, { width: columnWidth - 10, lineBreak: false }); doc.font(font.bold).fontSize(8.9).fillColor(theme.color.ink).text(item.value, x + offset, summaryY + 10, { width: columnWidth - 10, lineBreak: false, ellipsis: true }); doc.font(font.regular).fontSize(6.7).fillColor(theme.color.text).text(item.detail, x + offset, summaryY + 22, { width: columnWidth - 10, lineBreak: false, ellipsis: true }); });
}

function courseSectionHeight(model: Model): number { return 45 + model.charts.topCourses.length * 48 + (model.charts.courseSignal ? 42 : 0); }
function drawCourses(doc: PDFKit.PDFDocument, model: Model, y: number): void {
  sectionHeading(doc, model.labels.courseChart, y); chartSubtitle(doc, model.labels.courseSubtitle, y + 17);
  const nameWidth = 223; const barX = page.marginX + 248; const barWidth = 137; const valueX = barX + barWidth + 12; let rowY = y + 38;
  model.charts.topCourses.forEach((course, index) => { if (index) divider(doc, rowY - 7); doc.font(font.bold).fontSize(8.7).fillColor(theme.color.ink).text(course.displayName, page.marginX, rowY, { width: nameWidth, height: 31, lineGap: 1.2, ellipsis: true }); const barY = rowY + 18; doc.roundedRect(barX, barY, barWidth, 5, 2.5).fill(theme.color.track); if (course.barRatio > 0) doc.roundedRect(barX, barY, Math.max(3, barWidth * course.barRatio), 5, 2.5).fill(theme.color.primary); doc.font(font.bold).fontSize(7.7).fillColor(theme.color.text).text(course.valueLabel, valueX, rowY + 13, { width: page.marginX + contentWidth - valueX, align: 'right', lineBreak: false }); rowY += 48; });
  if (model.charts.courseSignal) { divider(doc, rowY - 7); doc.font(font.bold).fontSize(7.4).fillColor(theme.color.warning).text(model.charts.courseSignal.title.toUpperCase(), page.marginX, rowY + 2, { characterSpacing: 0.25, lineBreak: false }); doc.font(font.regular).fontSize(8.2).fillColor(theme.color.ink).text(model.charts.courseSignal.body, page.marginX, rowY + 14, { width: contentWidth, lineGap: 1.5 }); }
}

function drawStatusDistribution(doc: PDFKit.PDFDocument, model: Model, y: number): void {
  const status = model.charts.statusDistribution; if (!status) return;
  sectionHeading(doc, model.labels.status, y); chartSubtitle(doc, status.totalLabel, y + 17);
  const barY = y + 37; let x = page.marginX; const colors = { completed: theme.color.success, in_progress: theme.color.primary, not_started: theme.color.warning } as const;
  status.segments.forEach((segment) => { const width = contentWidth * segment.ratio; if (width > 0) doc.rect(x, barY, width, 9).fill(colors[segment.key]); x += width; });
  status.segments.forEach((segment, index) => { const columnWidth = contentWidth / status.segments.length; const columnX = page.marginX + index * columnWidth; doc.font(font.bold).fontSize(7.4).fillColor(theme.color.ink).text(segment.label, columnX, barY + 19, { width: columnWidth - 7, lineBreak: false }); doc.font(font.regular).fontSize(7.4).fillColor(theme.color.text).text(`${segment.countLabel} · ${segment.percentageLabel}`, columnX, barY + 31, { width: columnWidth - 7, lineBreak: false }); });
}

function completionSectionHeight(model: Model): number { return 42 + model.charts.completionRows.length * 54; }
function drawCompletionRows(doc: PDFKit.PDFDocument, model: Model, y: number): void {
  sectionHeading(doc, model.labels.completionPerformance, y); chartSubtitle(doc, model.labels.completionSubtitle, y + 17); let rowY = y + 36;
  model.charts.completionRows.forEach((course, index) => { if (index) divider(doc, rowY - 6); const accent = course.needsAttention ? theme.color.warning : theme.color.primary; doc.font(font.bold).fontSize(9).fillColor(theme.color.ink).text(course.name, page.marginX, rowY, { width: contentWidth - 128, height: 22, lineGap: 1.2, ellipsis: true }); doc.font(font.bold).fontSize(11.5).fillColor(accent).text(course.completionRateLabel, page.marginX + contentWidth - 120, rowY, { width: 120, align: 'right', lineBreak: false }); doc.font(font.regular).fontSize(6.8).fillColor(theme.color.muted).text(model.labels.completionRate, page.marginX + contentWidth - 120, rowY + 14, { width: 120, align: 'right', lineBreak: false }); doc.font(font.regular).fontSize(7.5).fillColor(theme.color.text).text(`${course.enrollmentLabel} · ${course.completedLabel}`, page.marginX, rowY + 25, { width: contentWidth - 128, lineBreak: false }); const trackX = page.marginX + contentWidth - 108; const trackY = rowY + 31; const trackWidth = 96; doc.moveTo(trackX, trackY).lineTo(trackX + trackWidth, trackY).lineWidth(1).strokeColor(theme.color.track).stroke(); doc.circle(trackX + trackWidth * course.markerRatio, trackY, 2.7).fill(accent); rowY += 54; });
}

function add(pages: PagePlan[], section: Section): void { let current = pages.at(-1)!; if (current.used && current.used + section.height > contentHeight) { current = { sections: [], used: 0 }; pages.push(current); } current.sections.push(section); current.used += section.height; }
export function composeReportPdfPages(model: Model): PagePlan[] {
  const pages: PagePlan[] = [{ sections: [], used: 0 }];
  add(pages, { kind: 'header', height: 96 }); add(pages, { kind: 'kpis', height: 134 }); add(pages, { kind: 'summary', height: 82 }); if (model.charts.trend) add(pages, { kind: 'trend', height: 248 });
  const courseHeight = model.charts.topCourses.length ? courseSectionHeight(model) : 0;
  if (courseHeight && model.charts.trend && pages.at(-1)!.used > contentHeight * 0.64) pages.push({ sections: [], used: 0 });
  if (courseHeight) add(pages, { kind: 'courses', height: courseHeight }); if (model.charts.statusDistribution) add(pages, { kind: 'status', height: 91 }); if (model.charts.completionRows.length) add(pages, { kind: 'completion', height: completionSectionHeight(model) });
  return pages;
}

function renderPage(doc: PDFKit.PDFDocument, model: Model, plan: PagePlan): void { let y = page.top; plan.sections.forEach((section) => { if (section.kind === 'header') drawHeader(doc, model, y); if (section.kind === 'kpis') drawKpis(doc, model, y); if (section.kind === 'summary') drawSummary(doc, model, y); if (section.kind === 'trend') drawTrend(doc, model, y); if (section.kind === 'courses') drawCourses(doc, model, y); if (section.kind === 'status') drawStatusDistribution(doc, model, y); if (section.kind === 'completion') drawCompletionRows(doc, model, y); y += section.height; }); }
function footer(doc: PDFKit.PDFDocument, model: Model, pageNumber: number, pageCount: number): void { const y = page.height - page.bottom - 10; divider(doc, y - 8); doc.font(font.regular).fontSize(6.8).fillColor(theme.color.muted).text(model.labels.verified, page.marginX, y, { lineBreak: false }); doc.font(font.bold).fontSize(6.8).fillColor(theme.color.text).text(`${pageNumber} / ${pageCount}`, page.width - page.marginX - 42, y, { width: 42, align: 'right', lineBreak: false }); }

export async function renderExecutiveReportPdf(input: { snapshot: StoredReportChatSnapshot; narrative: ReportPdfNarrative; locale: ReportPdfLocale }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: page.top, left: page.marginX, right: page.marginX, bottom: page.bottom + page.footer }, bufferPages: true, info: { Title: input.locale === 'en' ? 'Learning performance report' : 'Báo cáo hiệu quả học tập' } });
  const chunks: Buffer[] = []; const result = new Promise<Buffer>((resolve, reject) => { doc.on('data', (chunk: Buffer) => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  registerFonts(doc); const model = buildModel(input.snapshot, input.narrative, input.locale); const pages = composeReportPdfPages(model);
  pages.forEach((plan, index) => { if (index) doc.addPage(); renderPage(doc, model, plan); });
  const buffered = doc.bufferedPageRange(); for (let index = 0; index < buffered.count; index += 1) { doc.switchToPage(index); doc.page.margins.bottom = 0; footer(doc, model, index + 1, buffered.count); }
  doc.end(); return result;
}
