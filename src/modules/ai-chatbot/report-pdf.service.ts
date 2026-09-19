import { Type } from '@google/genai';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { getGeminiClient } from './gemini.service.js';
import type { ReportChatSnapshot } from './report-chat.service.js';

const page = { width: 595.28, height: 841.89, margin: 44, footerHeight: 32 };
const bundledFontDirectory = path.resolve(process.cwd(), 'node_modules', '@embedpdf', 'fonts-latin', 'fonts');

function resolveUnicodeFont(environmentKey: string, fileNames: string[]): string | null {
  const configured = process.env[environmentKey]?.trim();
  const candidates = [
    configured,
    ...fileNames.map((fileName) => path.join(bundledFontDirectory, fileName)),
    ...(process.platform === 'win32'
      ? fileNames.map((fileName) => path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', fileName))
      : []),
    ...fileNames.flatMap((fileName) => [
      path.join('/usr/share/fonts/truetype/noto', fileName),
      path.join('/usr/share/fonts/truetype/dejavu', fileName),
      path.join('/Library/Fonts', fileName),
      path.join('/System/Library/Fonts/Supplemental', fileName),
    ]),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

// PDFKit embeds TrueType fonts reliably; subset WOFF webfonts rendered as missing glyphs in exported Vietnamese PDFs.
const regularFontPath = resolveUnicodeFont('REPORT_PDF_FONT_REGULAR', ['NotoSans-Regular.ttf', 'arial.ttf', 'DejaVuSans.ttf']);
const boldFontPath = resolveUnicodeFont('REPORT_PDF_FONT_BOLD', ['NotoSans-Bold.ttf', 'arialbd.ttf', 'DejaVuSans-Bold.ttf']);

const ReportPdfNarrativeSchema = z.object({
  headline: z.string().trim().min(1).max(180),
  highlights: z.array(z.string().trim().min(1).max(320)).min(1).max(4),
  risks: z.array(z.string().trim().min(1).max(320)).max(4),
  recommendations: z.array(z.string().trim().min(1).max(320)).min(1).max(4),
});

type ReportPdfNarrative = z.infer<typeof ReportPdfNarrativeSchema>;

function formatReaderDate(value: string, locale: 'vi' | 'en'): string {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'vi-VN', {
    day: '2-digit',
    month: locale === 'en' ? 'short' : '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatReaderDateTime(value: string, locale: 'vi' | 'en', timezone: string): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'vi-VN', {
    day: '2-digit',
    month: locale === 'en' ? 'short' : '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(value));
}

function snapshotPayload(snapshot: ReportChatSnapshot, locale: 'vi' | 'en'): string {
  return JSON.stringify({
    reporting_period: locale === 'en'
      ? `${formatReaderDate(snapshot.filter.date_from, locale)} to ${formatReaderDate(snapshot.filter.date_to, locale)}`
      : `${formatReaderDate(snapshot.filter.date_from, locale)} đến ${formatReaderDate(snapshot.filter.date_to, locale)}`,
    kpis: snapshot.summary.overview,
    trend: snapshot.enrollment_trend,
    top_courses: snapshot.top_courses,
    completion_ranking: snapshot.completion_ranking,
  });
}

function fallbackNarrative(snapshot: ReportChatSnapshot, locale: 'vi' | 'en'): ReportPdfNarrative {
  const kpis = snapshot.summary.overview;
  if (locale === 'en') {
    return {
      headline: 'Verified learning report summary',
      highlights: [`${kpis.total_enrollments} enrollments were recorded in the selected period.`, `Completion rate was ${kpis.completion_rate}% across ${kpis.total_learners} learners.`],
      risks: kpis.incomplete_enrollments > 0 ? [`${kpis.incomplete_enrollments} enrollments were not completed in the selected period.`] : [],
      recommendations: ['Review the verified course ranking and trend data before deciding follow-up actions.'],
    };
  }
  return {
    headline: 'Tóm tắt báo cáo học tập đã xác thực',
    highlights: [`Ghi nhận ${kpis.total_enrollments} lượt ghi danh trong khoảng thời gian đã chọn.`, `Tỷ lệ hoàn thành là ${kpis.completion_rate}% trên ${kpis.total_learners} người học.`],
    risks: kpis.incomplete_enrollments > 0 ? [`Có ${kpis.incomplete_enrollments} lượt ghi danh chưa hoàn thành trong kỳ.`] : [],
    recommendations: ['Rà soát bảng xếp hạng khóa học và xu hướng đã xác thực trước khi quyết định hành động tiếp theo.'],
  };
}

export async function generateReportPdfNarrative(input: {
  tenantId: string;
  model: string;
  locale: 'vi' | 'en';
  question: string;
  snapshot: ReportChatSnapshot;
}): Promise<ReportPdfNarrative> {
  const aiClient = await getGeminiClient(input.tenantId);
  try {
    const response = await aiClient.models.generateContent({
      model: input.model,
      contents: [{
        role: 'user',
        parts: [{ text: `USER_QUESTION:\n${input.question || '(report export)'}\n\nREPORT_SNAPSHOT:\n${snapshotPayload(input.snapshot, input.locale)}` }],
      }],
      config: {
        systemInstruction: input.locale === 'en'
          ? 'Write a precise executive reporting narrative using only REPORT_SNAPSHOT. Never invent causes or missing metrics. Use reader-friendly dates such as 19 Sep 2026, never ISO dates. Do not mention REPORT_SNAPSHOT, snapshots, scopes, databases, backends, tools, prompts, or implementation details. Return JSON matching the schema exactly.'
          : 'Viết phần nhận định báo cáo điều hành chính xác, chỉ dùng REPORT_SNAPSHOT. Không tự suy diễn nguyên nhân hoặc số liệu thiếu. Dùng ngày dễ đọc theo dạng 19/09/2026, không dùng YYYY-MM-DD. Không nhắc REPORT_SNAPSHOT, snapshot, phạm vi kỹ thuật, cơ sở dữ liệu, backend, công cụ, prompt hoặc chi tiết triển khai. Chỉ trả JSON đúng schema.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            headline: { type: Type.STRING },
            highlights: { type: Type.ARRAY, items: { type: Type.STRING } },
            risks: { type: Type.ARRAY, items: { type: Type.STRING } },
            recommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['headline', 'highlights', 'risks', 'recommendations'],
        },
        maxOutputTokens: 1_800,
      } as any,
    });
    return ReportPdfNarrativeSchema.parse(JSON.parse(response.text || '{}'));
  } catch (error) {
    console.warn('[ReportPdf] Narrative fallback:', error instanceof Error ? error.message : String(error));
    return fallbackNarrative(input.snapshot, input.locale);
  }
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[character] || character));
}

function lineChartSvg(points: ReportChatSnapshot['enrollment_trend']): string {
  const width = 500;
  const height = 172;
  const padding = { left: 34, right: 42, top: 14, bottom: 30 };
  const values = points.map((point) => point.value);
  const max = Math.max(...values, 1);
  const drawableWidth = width - padding.left - padding.right;
  const drawableHeight = height - padding.top - padding.bottom;
  const coordinates = points.map((point, index) => {
    const x = padding.left + (points.length <= 1 ? drawableWidth / 2 : (index / (points.length - 1)) * drawableWidth);
    const y = padding.top + drawableHeight - (point.value / max) * drawableHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const grid = [0, 0.5, 1].map((ratio) => {
    const y = padding.top + drawableHeight - drawableHeight * ratio;
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="#dbe4f0" stroke-width="1"/>`;
  }).join('');
  const labels = points.length <= 6 ? points : [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]].filter(Boolean);
  const labelSvg = labels.map((point, labelIndex) => {
    const index = points.indexOf(point);
    const x = padding.left + (points.length <= 1 ? drawableWidth / 2 : (index / (points.length - 1)) * drawableWidth);
    return `<text x="${x}" y="${height - 9}" text-anchor="middle" font-size="8" fill="#64748b">${escapeXml(point.label.slice(0, 14))}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#f8fafc" rx="8"/>
    ${grid}
    <text x="${padding.left}" y="12" font-size="8" fill="#64748b">${max}</text>
    ${coordinates ? `<polyline fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${coordinates}"/>` : ''}
    ${points.map((point, index) => {
      const x = padding.left + (points.length <= 1 ? drawableWidth / 2 : (index / (points.length - 1)) * drawableWidth);
      const y = padding.top + drawableHeight - (point.value / max) * drawableHeight;
      return `<circle cx="${x}" cy="${y}" r="3" fill="#2563eb"/>`;
    }).join('')}
    ${labelSvg}
  </svg>`;
}

function formatNumber(value: number, locale: 'vi' | 'en', digits = 0): string {
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'vi-VN', { maximumFractionDigits: digits }).format(value);
}

function formatDateRange(snapshot: ReportChatSnapshot, locale: 'vi' | 'en'): string {
  const separator = locale === 'en' ? ' to ' : ' đến ';
  return `${formatReaderDate(snapshot.filter.date_from, locale)}${separator}${formatReaderDate(snapshot.filter.date_to, locale)}`;
}

function registerPdfFonts(document: PDFKit.PDFDocument): void {
  if (regularFontPath && boldFontPath) {
    document.registerFont('ReportSans', regularFontPath);
    document.registerFont('ReportSansBold', boldFontPath);
    document.font('ReportSans');
    return;
  }
  throw new Error('Không tìm thấy font Unicode cho PDF. Cấu hình REPORT_PDF_FONT_REGULAR và REPORT_PDF_FONT_BOLD bằng đường dẫn .ttf hợp lệ.');
}

export async function renderReportPdf(input: {
  snapshot: ReportChatSnapshot;
  narrative: ReportPdfNarrative;
  locale: 'vi' | 'en';
}): Promise<Buffer> {
  const document = new PDFDocument({
    size: 'A4',
    margins: { top: page.margin, left: page.margin, right: page.margin, bottom: page.margin + page.footerHeight },
    bufferPages: true,
    info: { Title: input.locale === 'en' ? 'Learning report' : 'Báo cáo học tập' },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });
  registerPdfFonts(document);
  const regular = 'ReportSans';
  const bold = 'ReportSansBold';
  const labels = input.locale === 'en'
    ? { title: 'Learning performance report', period: 'Period', generated: 'Report created', kpis: 'Key performance indicators', trend: 'Enrollment trend', courses: 'Top courses by enrollment', ranking: 'Course completion ranking', insights: 'Executive insights', risks: 'Watch items', recommendations: 'Recommended actions', learners: 'Learners', active: 'Active learners', enrollment: 'Enrollments', completion: 'Completion rate', complete: 'Completed' }
    : { title: 'Báo cáo hiệu quả học tập', period: 'Thời gian', generated: 'Thời điểm tạo báo cáo', kpis: 'Chỉ số trọng yếu', trend: 'Xu hướng ghi danh', courses: 'Khóa học có nhiều ghi danh', ranking: 'Xếp hạng hoàn thành khóa học', insights: 'Nhận định điều hành', risks: 'Điểm cần theo dõi', recommendations: 'Hành động đề xuất', learners: 'Người học', active: 'Người học hoạt động', enrollment: 'Lượt ghi danh', completion: 'Tỷ lệ hoàn thành', complete: 'Đã hoàn thành' };
  const ensureSpace = (height: number) => {
    if (document.y + height > page.height - page.margin - page.footerHeight) document.addPage();
  };
  const section = (title: string) => {
    ensureSpace(30);
    document.x = page.margin;
    document.moveDown(0.65).font(bold).fontSize(12).fillColor('#0f172a').text(title);
    document.moveDown(0.3);
  };
  const bulletList = (items: string[]) => {
    for (const item of items) {
      ensureSpace(36);
      document.font(regular).fontSize(9.5).fillColor('#334155').text(`• ${item}`, { indent: 6, lineGap: 3 });
      document.moveDown(0.2);
    }
  };

  document.font(bold).fontSize(21).fillColor('#0f172a').text(labels.title);
  document.moveDown(0.35).font(regular).fontSize(9).fillColor('#475569').text(`${labels.period}: ${formatDateRange(input.snapshot, input.locale)}`);
  document.text(`${labels.generated}: ${formatReaderDateTime(input.snapshot.generated_at, input.locale, input.snapshot.timezone)}`);
  document.moveDown(0.9);

  section(labels.kpis);
  const kpis = input.snapshot.summary.overview;
  const cards = [
    [labels.learners, formatNumber(kpis.total_learners, input.locale)],
    [labels.active, formatNumber(kpis.active_learners, input.locale)],
    [labels.enrollment, formatNumber(kpis.total_enrollments, input.locale)],
    [labels.completion, `${formatNumber(kpis.completion_rate, input.locale, 1)}%`],
  ];
  const cardWidth = (page.width - page.margin * 2 - 18) / 2;
  const cardStartY = document.y;
  cards.forEach(([label, value], index) => {
    const x = page.margin + (index % 2) * (cardWidth + 18);
    const y = cardStartY + Math.floor(index / 2) * 58;
    document.roundedRect(x, y, cardWidth, 46, 6).fillAndStroke('#eff6ff', '#bfdbfe');
    document.font(regular).fontSize(8).fillColor('#475569').text(label, x + 12, y + 9, { width: cardWidth - 24 });
    document.font(bold).fontSize(16).fillColor('#1d4ed8').text(value, x + 12, y + 22, { width: cardWidth - 24 });
  });
  document.y = cardStartY + 124;

  section(labels.trend);
  if (input.snapshot.enrollment_trend.length > 0) {
    SVGtoPDF(document, lineChartSvg(input.snapshot.enrollment_trend), page.margin, document.y, {
      width: page.width - page.margin * 2,
      height: 172,
      fontCallback: () => regular,
    });
    document.x = page.margin;
    document.y += 180;
  } else {
    document.font(regular).fontSize(9.5).fillColor('#64748b').text(input.locale === 'en' ? 'No trend data is available for this period.' : 'Không có dữ liệu xu hướng trong khoảng thời gian này.');
  }

  section(labels.insights);
  document.font(bold).fontSize(11).fillColor('#0f172a').text(input.narrative.headline);
  document.moveDown(0.35);
  bulletList(input.narrative.highlights);
  if (input.narrative.risks.length > 0) {
    section(labels.risks);
    bulletList(input.narrative.risks);
  }
  section(labels.recommendations);
  bulletList(input.narrative.recommendations);

  section(labels.courses);
  for (const [index, course] of input.snapshot.top_courses.entries()) {
    ensureSpace(27);
    document.font(bold).fontSize(9.5).fillColor('#0f172a').text(`${index + 1}. ${course.name}`, { continued: true, width: 380 });
    document.font(regular).fillColor('#475569').text(` ${formatNumber(course.enrollments, input.locale)} ${labels.enrollment.toLowerCase()}`, { align: 'right' });
    document.moveDown(0.15);
  }

  section(labels.ranking);
  for (const [index, course] of input.snapshot.completion_ranking.entries()) {
    ensureSpace(30);
    document.font(bold).fontSize(9.5).fillColor('#0f172a').text(`${index + 1}. ${course.name}`, { continued: true, width: 330 });
    document.font(regular).fillColor('#475569').text(`${formatNumber(course.completion_rate, input.locale, 1)}%`, { align: 'right' });
    document.font(regular).fontSize(8.5).fillColor('#64748b').text(`${labels.complete}: ${formatNumber(course.completed_enrollments, input.locale)} / ${formatNumber(course.total_enrollments, input.locale)}`);
    document.moveDown(0.2);
  }

  const footer = input.locale === 'en'
    ? 'Created from verified report data. AI commentary is limited to the information shown in this report.'
    : 'Báo cáo được tạo từ dữ liệu đã xác thực. Nhận định AI chỉ dựa trên thông tin hiển thị trong báo cáo.';
  const bufferedPages = document.bufferedPageRange();
  for (let index = 0; index < bufferedPages.count; index += 1) {
    document.switchToPage(index);
    document.page.margins.bottom = 0;
    document.font(regular).fontSize(7.5).fillColor('#64748b').text(
      `${footer}  ${index + 1}/${bufferedPages.count}`,
      page.margin,
      page.height - page.margin + 10,
      { width: page.width - page.margin * 2, align: 'center', lineBreak: false },
    );
  }
  document.end();
  return result;
}
