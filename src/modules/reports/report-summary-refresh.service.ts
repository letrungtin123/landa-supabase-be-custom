// ═══════════════════════════════════════════════════════════════
// Report summary refresh: one rebuild at a time, then a short cooldown
//
// POST /api/reports/refresh runs refresh_report_summary(), which rebuilds the
// shared report summary of EVERY tenant. Anyone with report_summary.can_edit
// in any tenant may call it, so in this process:
// - calls that arrive while a rebuild runs wait for that rebuild and get its
//   outcome (a failure reaches every one of them as a failure);
// - a call less than REPORT_SUMMARY_REFRESH_COOLDOWN_MS after a successful
//   rebuild finished answers at once, without rebuilding.
// The state is per process: each API process of the PM2 cluster has its own.
// ═══════════════════════════════════════════════════════════════

import { refreshReportSummary } from './reports.service.js';

/** A successful rebuild is not repeated within this time (owner decision, wave 2). */
export const REPORT_SUMMARY_REFRESH_COOLDOWN_MS = 60_000;

export interface ReportSummaryRefreshOutcome {
  /** True when a rebuild finished less than the cooldown ago, so none ran. */
  skippedRecent: boolean;
}

export interface ReportSummaryRefresher {
  refresh(): Promise<ReportSummaryRefreshOutcome>;
  /** Forgets the running rebuild and the last success (tests). */
  forget(): void;
}

export function createReportSummaryRefresher(options: {
  rebuild: () => Promise<void>;
  cooldownMs: number;
  now?: () => number;
}): ReportSummaryRefresher {
  const now = options.now ?? (() => Date.now());
  let running: Promise<void> | null = null;
  let lastSuccessAt: number | null = null;

  return {
    async refresh() {
      if (running) {
        await running;
        return { skippedRecent: false };
      }
      if (lastSuccessAt !== null) {
        const age = now() - lastSuccessAt;
        if (age >= 0 && age < options.cooldownMs) return { skippedRecent: true };
      }
      const current = (async () => {
        await options.rebuild();
        lastSuccessAt = now();
      })();
      running = current;
      try {
        await current;
      } finally {
        if (running === current) running = null;
      }
      return { skippedRecent: false };
    },
    forget() {
      running = null;
      lastSuccessAt = null;
    },
  };
}

const refresher = createReportSummaryRefresher({
  rebuild: refreshReportSummary,
  cooldownMs: REPORT_SUMMARY_REFRESH_COOLDOWN_MS,
});

/** The rebuild behind POST /api/reports/refresh. A failed rebuild rejects. */
export function refreshReportSummaryOnce(): Promise<ReportSummaryRefreshOutcome> {
  return refresher.refresh();
}

/** Tests: start from no running rebuild and no recent success. */
export function forgetReportSummaryRefresh(): void {
  refresher.forget();
}
