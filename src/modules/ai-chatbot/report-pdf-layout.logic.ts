// Deterministic pagination of the report PDF. Heights (mm) come from a
// measurement pass in the real browser (exact) or from conservative estimates
// (tests / no browser). Long tables are split across pages with a
// "continued" header; flow text (trend observations, appendix methodology)
// follows its block and moves on when the page is full; other sections are
// never split.
import type { ReportPdfSectionId, ReportPdfSectionSlice, ReportPdfViewModel } from './report-pdf-view-model.js';

export const REPORT_PDF_PAGE_BODY_MM = 253;
export const REPORT_PDF_SECTION_GAP_MM = 8;
/** Safety margin for sub-pixel rounding between the measure pass and the print pass. */
const SAFETY_MM = 2;
const PX_PER_MM = 96 / 25.4;
const PAGE_BREAK_BEFORE = new Set<ReportPdfSectionId>(['trends', 'courses', 'appendixDefinitions']);
/**
 * Text that follows a chart or table block. At the top of a page it carries a
 * "continued" heading, and a page holding only such text does not force the
 * next section onto another page.
 */
export const REPORT_PDF_FLOW_SECTIONS: ReadonlySet<ReportPdfSectionId> = new Set<ReportPdfSectionId>(['trendObservations', 'appendixMethods']);
const FLOW_SECTIONS = REPORT_PDF_FLOW_SECTIONS;
export type ReportPdfSplittableSection = 'portfolio' | 'organization' | 'appendixMethods';
const SPLITTABLE: ReadonlyArray<ReportPdfSplittableSection> = ['portfolio', 'organization', 'appendixMethods'];

type LayoutModel = Omit<ReportPdfViewModel, 'pages' | 'sectionNumbers'>;
type SectionOrderModel = Pick<ReportPdfViewModel, 'available' | 'courses' | 'organization'>;

export interface ReportPdfLayoutMeasurements {
  /** Height of each section where it follows another block. */
  sections: Record<ReportPdfSectionId, number>;
  /** Flow text kept in one block, printed at the top of a page with its "continued" heading. */
  firstOnPage: Partial<Record<ReportPdfSectionId, number>>;
  rows: Record<ReportPdfSplittableSection, number[]>;
  /** Heading of a slice that continues on a new page. */
  continuation: Record<ReportPdfSplittableSection, number>;
}

/**
 * Sections in print order. The unit breakdown is left out when there is no
 * unit row (older snapshot, team scope, no child unit): the appendix
 * limitations say why, instead of a half-empty page.
 */
export function reportPdfSectionOrder(model: SectionOrderModel): ReportPdfSectionId[] {
  const organization = model.organization.rows.length ? ['organization' as const] : [];
  const appendix = ['appendixDefinitions', 'appendixData', 'appendixMethods'] as const;
  if (!model.available) return ['summary', 'kpis', ...organization, 'attention', 'recommendations', ...appendix];
  return ['summary', 'kpis', 'trends', 'trendObservations', 'courses', ...(model.courses.rows.length ? ['portfolio' as const] : []),
    ...organization, 'attention', 'recommendations', ...appendix];
}

/** Sections printed under the number of the one before them. */
const SECTION_NUMBER_SHARED_WITH: Partial<Record<ReportPdfSectionId, ReportPdfSectionId>> = {
  kpis: 'summary', trendObservations: 'trends', portfolio: 'courses', appendixMethods: 'appendixData',
};

/** Consecutive numbers ("01", "02"…) for the present sections, letters for the appendices. */
export function reportPdfSectionNumbers(model: SectionOrderModel): Partial<Record<ReportPdfSectionId, string>> {
  const numbers: Partial<Record<ReportPdfSectionId, string>> = { appendixDefinitions: 'A', appendixData: 'B', appendixMethods: 'B' };
  let next = 1;
  for (const id of reportPdfSectionOrder(model)) {
    if (numbers[id]) continue;
    const shared = SECTION_NUMBER_SHARED_WITH[id];
    if (shared && numbers[shared]) {
      numbers[id] = numbers[shared];
      continue;
    }
    numbers[id] = String(next).padStart(2, '0');
    next += 1;
  }
  return numbers;
}

const lines = (text: string, charsPerLine: number, max = 99) => Math.min(max, Math.max(1, Math.ceil(text.length / charsPerLine)));

/** Conservative estimate used when no browser measurement is available. */
export function estimateReportPdfLayout(model: LayoutModel): ReportPdfLayoutMeasurements {
  const portfolioRows = model.courses.rows.map((row) => 8 + (lines(row.name, 36, 2) - 1) * 5 + (row.watch ? 5 : 0));
  const unitRows = model.organization.rows.map((row) => 8 + (lines(row.name, 40, 2) - 1) * 5);
  const methodRows = model.appendix.methodRows.map((row) => (row.kind === 'title' ? 9 : 2 + lines(row.text, 95) * 5.2));
  const narrative = model.narrative;
  const attentionRows = Math.ceil(model.attention.length / 2);
  const sections: Record<ReportPdfSectionId, number> = {
    summary: 24 + 16 + lines(narrative.headline.text, 68) * 7 + 10
      + narrative.findings.reduce((sum, item) => sum + 4 + lines(item.text, 88) * 5.6, 0)
      + (narrative.commentary.length ? 14 + narrative.commentary.reduce((sum, text) => sum + lines(text, 95) * 5.2, 0) : 0),
    kpis: 12 + 2 * 42 + 4 + 8,
    trends: 24 + (model.trends.enrollments ? 92 : 16) + (model.trends.active ? 88 : 0)
      + [...(model.trends.enrollments?.notes ?? []), ...(model.trends.active?.notes ?? [])].reduce((sum, text) => sum + 2 + lines(text, 110) * 4.4, 0),
    trendObservations: 12 + model.trends.observations.reduce((sum, item) => sum + 3 + lines(item.text, 95) * 5.2, 0),
    courses: 24 + 86 + 8 + 76 + 12 + (model.courses.backlog.length ? 8 + 22 + model.courses.backlog.length * 9 : 0) + 10,
    portfolio: 34 + 12 + portfolioRows.reduce((sum, height) => sum + height, 0) + 14
      + (model.courses.coverageNote ? 9 : 0) + (model.courses.moreCoursesNote ? 9 : 0),
    organization: 24 + 34
      + (unitRows.length
        ? 26 + unitRows.reduce((sum, height) => sum + height, 0) + 4 + model.organization.footnotes.reduce((sum, text) => sum + 1 + lines(text, 100) * 4.6, 0)
        : 0),
    attention: 24 + (attentionRows ? attentionRows * 38 : 18) + (model.watchlist.rows.length ? 26 + model.watchlist.rows.length * 9 : 0),
    recommendations: 24 + model.recommendations.reduce((sum, item) => sum + 12 + lines(item.text, 85) * 5.4, 0),
    appendixDefinitions: 34 + model.appendix.definitions.reduce((sum, row) => sum + 5 + lines(row.text, 70) * 5.2, 0) + 128,
    appendixData: 34 + model.appendix.scopeRows.reduce((sum, row) => sum + 4 + lines(row.value, 70) * 5.2, 0),
    appendixMethods: methodRows.reduce((sum, height) => sum + height, 0),
  };
  return {
    sections,
    firstOnPage: { trendObservations: sections.trendObservations + 26 },
    rows: { portfolio: portfolioRows, organization: unitRows, appendixMethods: methodRows },
    continuation: { portfolio: 28, organization: 28, appendixMethods: 26 },
  };
}

/** Converts browser measurements (CSS px keyed by data-measure) into millimetres. */
export function toReportPdfLayoutMeasurements(rawPx: Record<string, number>, model: LayoutModel): ReportPdfLayoutMeasurements {
  const fallback = estimateReportPdfLayout(model);
  const mm = (key: string, estimate: number) => (Number.isFinite(rawPx[key]) && rawPx[key] > 0 ? rawPx[key] / PX_PER_MM : estimate);
  const sections = { ...fallback.sections };
  for (const id of Object.keys(sections) as ReportPdfSectionId[]) sections[id] = mm(`section:${id}`, sections[id]);
  const firstOnPage = Object.fromEntries(Object.entries(fallback.firstOnPage).map(([id, estimate]) => [id, mm(`first:${id}`, estimate)]));
  const rows = Object.fromEntries(SPLITTABLE.map((id) => [id, fallback.rows[id].map((estimate, index) => mm(`row:${id}:${index}`, estimate))])) as ReportPdfLayoutMeasurements['rows'];
  const continuation = Object.fromEntries(SPLITTABLE.map((id) => [id, mm(`cont:${id}`, fallback.continuation[id])])) as ReportPdfLayoutMeasurements['continuation'];
  return { sections, firstOnPage, rows, continuation };
}

/** A heading row must not be the last row of a page slice. */
function keepsWithNext(model: LayoutModel, id: ReportPdfSplittableSection, index: number): boolean {
  return id === 'appendixMethods' && model.appendix.methodRows[index]?.kind === 'title';
}

export function planReportPdfPages(model: LayoutModel, measurements: ReportPdfLayoutMeasurements = estimateReportPdfLayout(model)): ReportPdfSectionSlice[][] {
  const limit = REPORT_PDF_PAGE_BODY_MM - SAFETY_MM;
  const pages: ReportPdfSectionSlice[][] = [];
  let used = 0;
  const newPage = () => { pages.push([]); used = 0; };
  const fits = (height: number) => (used === 0 ? height <= limit : used + REPORT_PDF_SECTION_GAP_MM + height <= limit);
  const room = () => (used === 0 ? limit : limit - used - REPORT_PDF_SECTION_GAP_MM);
  const place = (slice: ReportPdfSectionSlice, height: number) => {
    if (used > 0) used += REPORT_PDF_SECTION_GAP_MM;
    pages.at(-1)!.push(slice);
    used += height;
  };
  for (const id of reportPdfSectionOrder(model)) {
    const inline = measurements.sections[id];
    const onlyFlowText = pages.length > 0 && pages.at(-1)!.length > 0 && pages.at(-1)!.every((slice) => FLOW_SECTIONS.has(slice.id));
    if (!pages.length || (PAGE_BREAK_BEFORE.has(id) && !(onlyFlowText && fits(inline)))) newPage();
    const splittable = (SPLITTABLE as ReadonlyArray<string>).includes(id) ? id as ReportPdfSplittableSection : null;
    const rows = splittable ? measurements.rows[splittable] : [];
    if (splittable && FLOW_SECTIONS.has(id) && rows.length) {
      // Flow rows fill the rest of the current page, then continue under a "continued" heading.
      const inlineOverhead = Math.max(0, inline - rows.reduce((sum, row) => sum + row, 0));
      let start = 0;
      while (start < rows.length) {
        let total = used === 0 ? measurements.continuation[splittable] : inlineOverhead;
        let end = start;
        while (end < rows.length && total + rows[end] <= room()) {
          total += rows[end];
          end += 1;
        }
        // A slice never ends on a heading while more rows follow.
        while (end > start && end < rows.length && keepsWithNext(model, splittable, end - 1)) {
          end -= 1;
          total -= rows[end];
        }
        if (end === start) {
          if (used > 0) {
            newPage();
            continue;
          }
          // A single row taller than a page is placed alone.
          total += rows[end];
          end += 1;
        }
        place({ id, from: start, to: end }, total);
        start = end;
        if (start < rows.length) newPage();
      }
      continue;
    }
    if (fits(inline) || !splittable || rows.length === 0) {
      if (!fits(inline) && used > 0) newPage();
      // At the top of a page flow text gets its "continued" heading.
      place({ id }, used === 0 && FLOW_SECTIONS.has(id) ? measurements.firstOnPage[id] ?? inline : inline);
      continue;
    }
    if (used > 0) newPage();
    const overhead = Math.max(0, inline - rows.reduce((sum, row) => sum + row, 0));
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
