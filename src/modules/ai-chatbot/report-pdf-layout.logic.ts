// Deterministic pagination of the report PDF. Heights (mm) come from a
// measurement pass in the real browser (exact) or from conservative estimates
// (tests / no browser). Long tables are split across pages with a
// "continued" header; other sections are never split.
import type { ReportPdfSectionId, ReportPdfSectionSlice, ReportPdfViewModel } from './report-pdf-view-model.js';

export const REPORT_PDF_PAGE_BODY_MM = 253;
export const REPORT_PDF_SECTION_GAP_MM = 8;
/** Safety margin for sub-pixel rounding between the measure pass and the print pass. */
const SAFETY_MM = 2;
const PX_PER_MM = 96 / 25.4;
const PAGE_BREAK_BEFORE = new Set<ReportPdfSectionId>(['trends', 'courses', 'appendixDefinitions']);
export type ReportPdfSplittableSection = 'portfolio' | 'organization';
const SPLITTABLE: ReadonlyArray<ReportPdfSplittableSection> = ['portfolio', 'organization'];

type LayoutModel = Omit<ReportPdfViewModel, 'pages'>;

export interface ReportPdfLayoutMeasurements {
  sections: Record<ReportPdfSectionId, number>;
  rows: Record<ReportPdfSplittableSection, number[]>;
  continuation: Record<ReportPdfSplittableSection, number>;
}

export function reportPdfSectionOrder(model: LayoutModel): ReportPdfSectionId[] {
  if (!model.available) return ['summary', 'kpis', 'organization', 'attention', 'recommendations', 'appendixDefinitions', 'appendixData'];
  return ['summary', 'kpis', 'trends', 'courses', ...(model.courses.rows.length ? ['portfolio' as const] : []),
    'organization', 'attention', 'recommendations', 'appendixDefinitions', 'appendixData'];
}

const lines = (text: string, charsPerLine: number, max = 99) => Math.min(max, Math.max(1, Math.ceil(text.length / charsPerLine)));

/** Conservative estimate used when no browser measurement is available. */
export function estimateReportPdfLayout(model: LayoutModel): ReportPdfLayoutMeasurements {
  const portfolioRows = model.courses.rows.map((row) => 8 + (lines(row.name, 36, 2) - 1) * 5 + (row.watch ? 5 : 0));
  const unitRows = model.organization.rows.map((row) => 8 + (lines(row.name, 40, 2) - 1) * 5);
  const narrative = model.narrative;
  const attentionRows = Math.ceil(model.attention.length / 2);
  const sections: Record<ReportPdfSectionId, number> = {
    summary: 24 + 16 + lines(narrative.headline.text, 68) * 7 + 10
      + narrative.findings.reduce((sum, item) => sum + 4 + lines(item.text, 88) * 5.6, 0)
      + (narrative.commentary.length ? 14 + narrative.commentary.reduce((sum, text) => sum + lines(text, 95) * 5.2, 0) : 0),
    kpis: 12 + 2 * 36 + 4 + 8,
    trends: 24 + (model.trends.enrollments ? 100 : 16) + (model.trends.active ? 96 : 0) + 12
      + model.trends.observations.reduce((sum, item) => sum + 3 + lines(item.text, 95) * 5.2, 0),
    courses: 24 + 86 + 8 + 76 + (model.courses.backlog.length ? 8 + 22 + model.courses.backlog.length * 9 : 0) + 10,
    portfolio: 34 + 12 + portfolioRows.reduce((sum, height) => sum + height, 0) + (model.courses.coverageNote ? 9 : 0),
    organization: 24 + 34 + (unitRows.length ? 26 + unitRows.reduce((sum, height) => sum + height, 0) + 9 : 26),
    attention: 24 + (attentionRows ? attentionRows * 38 : 18) + (model.watchlist.rows.length ? 26 + model.watchlist.rows.length * 9 : 0),
    recommendations: 24 + model.recommendations.reduce((sum, item) => sum + 12 + lines(item.text, 85) * 5.4, 0),
    appendixDefinitions: 34 + model.appendix.definitions.reduce((sum, row) => sum + 5 + lines(row.text, 70) * 5.2, 0) + 128,
    appendixData: 34 + model.appendix.scopeRows.reduce((sum, row) => sum + 4 + lines(row.value, 70) * 5.2, 0)
      + 14 + model.appendix.methodology.reduce((sum, text) => sum + 3 + lines(text, 95) * 5.2, 0)
      + (model.appendix.limitations.length ? 14 + model.appendix.limitations.reduce((sum, text) => sum + 3 + lines(text, 95) * 5.2, 0) : 0),
  };
  return { sections, rows: { portfolio: portfolioRows, organization: unitRows }, continuation: { portfolio: 28, organization: 28 } };
}

/** Converts browser measurements (CSS px keyed by data-measure) into millimetres. */
export function toReportPdfLayoutMeasurements(rawPx: Record<string, number>, model: LayoutModel): ReportPdfLayoutMeasurements {
  const fallback = estimateReportPdfLayout(model);
  const mm = (key: string, estimate: number) => (Number.isFinite(rawPx[key]) && rawPx[key] > 0 ? rawPx[key] / PX_PER_MM : estimate);
  const sections = { ...fallback.sections };
  for (const id of Object.keys(sections) as ReportPdfSectionId[]) sections[id] = mm(`section:${id}`, sections[id]);
  const rows = {
    portfolio: fallback.rows.portfolio.map((estimate, index) => mm(`row:portfolio:${index}`, estimate)),
    organization: fallback.rows.organization.map((estimate, index) => mm(`row:organization:${index}`, estimate)),
  };
  return {
    sections,
    rows,
    continuation: { portfolio: mm('cont:portfolio', fallback.continuation.portfolio), organization: mm('cont:organization', fallback.continuation.organization) },
  };
}

export function planReportPdfPages(model: LayoutModel, measurements: ReportPdfLayoutMeasurements = estimateReportPdfLayout(model)): ReportPdfSectionSlice[][] {
  const limit = REPORT_PDF_PAGE_BODY_MM - SAFETY_MM;
  const pages: ReportPdfSectionSlice[][] = [];
  let used = 0;
  const newPage = () => { pages.push([]); used = 0; };
  const fits = (height: number) => (used === 0 ? height <= limit : used + REPORT_PDF_SECTION_GAP_MM + height <= limit);
  const place = (slice: ReportPdfSectionSlice, height: number) => {
    if (used > 0) used += REPORT_PDF_SECTION_GAP_MM;
    pages.at(-1)!.push(slice);
    used += height;
  };
  for (const id of reportPdfSectionOrder(model)) {
    if (!pages.length || PAGE_BREAK_BEFORE.has(id)) newPage();
    const height = measurements.sections[id];
    const splittable = (SPLITTABLE as ReadonlyArray<string>).includes(id) ? id as ReportPdfSplittableSection : null;
    const rows = splittable ? measurements.rows[splittable] : [];
    if (fits(height) || !splittable || rows.length === 0) {
      if (!fits(height) && used > 0) newPage();
      place({ id }, height);
      continue;
    }
    if (used > 0) newPage();
    const overhead = Math.max(0, height - rows.reduce((sum, row) => sum + row, 0));
    let start = 0;
    while (start < rows.length) {
      let total = start === 0 ? overhead : measurements.continuation[splittable];
      let end = start;
      while (end < rows.length && total + rows[end] <= limit) {
        total += rows[end];
        end += 1;
      }
      if (end === start) {
        total += rows[end];
        end += 1;
      }
      place({ id, from: start, to: end }, total);
      start = end;
      if (start < rows.length) newPage();
    }
  }
  return pages;
}
