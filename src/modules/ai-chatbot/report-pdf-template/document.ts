// Assembles the complete, self-contained HTML document of the report PDF, and
// the measurement document used to paginate with exact browser heights.
import { reportPdfSectionOrder } from '../report-pdf-layout.logic.js';
import type { ReportPdfViewModel } from '../report-pdf-view-model.js';
import { getReportPdfFontCss } from './fonts.js';
import { escapeHtml } from './html.js';
import { renderContentPage, renderCover, renderReportPdfSection } from './sections.js';
import { REPORT_PDF_CSS } from './styles.js';

/** Defense in depth on top of the renderer sandbox: no scripts, no network, data: assets only. */
export const REPORT_PDF_CONTENT_SECURITY_POLICY = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";

function documentShell(model: Pick<ReportPdfViewModel, 'locale' | 'title' | 'tenant' | 'periodLabel'>, body: string, fontCss: string): string {
  const title = `${model.title} — ${model.tenant.name} — ${model.periodLabel}`;
  return `<!doctype html><html lang="${model.locale}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${REPORT_PDF_CONTENT_SECURITY_POLICY}">`
    + `<title>${escapeHtml(title)}</title><style>${fontCss}\n${REPORT_PDF_CSS}</style></head>`
    + `<body>${body}</body></html>`;
}

export function renderReportPdfHtml(model: ReportPdfViewModel, options: { fontCss?: string } = {}): string {
  const totalPages = model.pages.length + 1;
  const pages = [
    renderCover(model).value,
    ...model.pages.map((sections, index) => renderContentPage(model, sections, index + 2, totalPages).value),
  ];
  return documentShell(model, pages.join('\n'), options.fontCss ?? getReportPdfFontCss());
}

/**
 * Every section rendered once at page-body width, plus the continuation header
 * of each splittable table. Elements carry data-measure keys read by the renderer.
 */
export function renderReportPdfMeasureHtml(model: Omit<ReportPdfViewModel, 'pages'>, options: { fontCss?: string } = {}): string {
  const full = { ...model, pages: [] } as ReportPdfViewModel;
  const blocks = reportPdfSectionOrder(model).map((id) => `<div data-measure="section:${id}">${renderReportPdfSection(full, { id }).value}</div>`);
  blocks.push(`<div data-measure="cont:portfolio">${renderReportPdfSection(full, { id: 'portfolio', from: model.courses.rows.length, to: model.courses.rows.length }).value}</div>`);
  if (model.organization.rows.length) {
    blocks.push(`<div data-measure="cont:organization">${renderReportPdfSection(full, { id: 'organization', from: model.organization.rows.length, to: model.organization.rows.length }).value}</div>`);
  }
  return documentShell(model, `<div class="measure-root">${blocks.join('\n')}</div>`, options.fontCss ?? getReportPdfFontCss());
}
