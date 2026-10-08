// ═══════════════════════════════════════════════════════════════
// Report PDF composition: snapshot -> insights -> narrative (validated AI or
// rule-based, plus the stored chat narrative when valid) -> view model ->
// self-contained HTML -> PDF through the shared browser renderer.
// The immutable snapshot remains the only factual source of the document.
// ═══════════════════════════════════════════════════════════════
import type { StoredReportChatSnapshot } from './report-chat.service.js';
import type { ReportPdfLocale } from './report-pdf-i18n.js';
import { buildReportInsights, type ReportInsights } from './report-insights.logic.js';
import {
  buildRuleBasedReportNarrative,
  mergeStoredChatNarrative,
  validateReportPdfNarrative,
  type ReportPdfNarrative,
} from './report-pdf-narrative.logic.js';
import { getReportPdfRenderer, type ReportPdfRenderer } from './report-pdf-renderer.service.js';
import { planReportPdfPages, toReportPdfLayoutMeasurements } from './report-pdf-layout.logic.js';
import { renderReportPdfHtml, renderReportPdfMeasureHtml } from './report-pdf-template/document.js';
import {
  buildReportPdfViewModel,
  REPORT_PDF_TEMPLATE_VERSION,
  type ReportPdfTenantBranding,
  type ReportPdfViewModel,
} from './report-pdf-view-model.js';

export { REPORT_PDF_TEMPLATE_VERSION } from './report-pdf-view-model.js';
export type { ReportPdfNarrative } from './report-pdf-narrative.logic.js';

export type ReportPdfAiNarrativeWriter = (insights: ReportInsights, locale: ReportPdfLocale) => Promise<ReportPdfNarrative | null>;

export interface ReportPdfComposeInput {
  snapshot: StoredReportChatSnapshot;
  snapshotHash: string;
  locale: ReportPdfLocale;
  tenant: ReportPdfTenantBranding;
  storedNarrative?: unknown;
  storedNarrativeLocale?: ReportPdfLocale;
  writeAiNarrative?: ReportPdfAiNarrativeWriter;
  fontCss?: string;
}

export interface ReportPdfComposition {
  html: string;
  insights: ReportInsights;
  narrative: ReportPdfNarrative;
  model: ReportPdfViewModel;
}

/** Pure composition (plus the optional, already-guarded AI writer). */
export async function composeReportPdfDocument(input: ReportPdfComposeInput): Promise<ReportPdfComposition> {
  const insights = buildReportInsights(input.snapshot);
  let narrative = buildRuleBasedReportNarrative(insights, input.locale);
  if (input.writeAiNarrative) {
    const candidate = await input.writeAiNarrative(insights, input.locale);
    // The writer validates too; this second check keeps the guarantee local.
    if (candidate && validateReportPdfNarrative(candidate, insights, input.locale).ok) narrative = candidate;
  }
  if (input.storedNarrative !== undefined && input.storedNarrativeLocale) {
    narrative = mergeStoredChatNarrative({
      narrative,
      stored: input.storedNarrative,
      storedLocale: input.storedNarrativeLocale,
      locale: input.locale,
      snapshot: input.snapshot,
    });
  }
  const model = buildReportPdfViewModel({
    snapshot: input.snapshot,
    snapshotHash: input.snapshotHash,
    locale: input.locale,
    tenant: input.tenant,
    insights,
    narrative,
    templateVersion: REPORT_PDF_TEMPLATE_VERSION,
  });
  return { html: renderReportPdfHtml(model, input.fontCss ? { fontCss: input.fontCss } : {}), insights, narrative, model };
}

export interface ReportPdfRenderOutput {
  pdf: Buffer;
  pageCount: number;
  narrativeSource: ReportPdfNarrative['source'];
  overflow: string[];
  durationMs: number;
}

/**
 * Second layout pass: measure every section and table row in the real browser
 * and paginate with exact heights (long tables are split with a header).
 */
export async function paginateReportPdfDocument(
  composition: ReportPdfComposition,
  renderer: Pick<ReportPdfRenderer, 'measure'>,
  fontCss?: string,
): Promise<ReportPdfComposition> {
  const options = fontCss ? { fontCss } : {};
  const raw = await renderer.measure(renderReportPdfMeasureHtml(composition.model, options));
  const pages = planReportPdfPages(composition.model, toReportPdfLayoutMeasurements(raw, composition.model));
  const model = { ...composition.model, pages };
  return { ...composition, model, html: renderReportPdfHtml(model, options) };
}

export async function renderReportPdf(
  input: ReportPdfComposeInput,
  renderer: ReportPdfRenderer = getReportPdfRenderer(),
): Promise<ReportPdfRenderOutput> {
  const composition = await paginateReportPdfDocument(await composeReportPdfDocument(input), renderer, input.fontCss);
  const result = await renderer.render(composition.html);
  return {
    pdf: result.pdf,
    pageCount: result.pageCount,
    narrativeSource: composition.narrative.source,
    overflow: result.overflow,
    durationMs: result.durationMs,
  };
}
