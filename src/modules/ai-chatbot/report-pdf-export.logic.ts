export const REPORT_PDF_EXPORT_PHASES = ['validating', 'narrative', 'rendering', 'ready', 'failed'] as const;

export type ReportPdfExportPhase = (typeof REPORT_PDF_EXPORT_PHASES)[number];

export function isReportPdfExportTerminal(phase: ReportPdfExportPhase): boolean {
  return phase === 'ready' || phase === 'failed';
}

export function getReportPdfExportPhaseIndex(phase: ReportPdfExportPhase): number {
  return REPORT_PDF_EXPORT_PHASES.indexOf(phase);
}
