// Pure helpers of the report PDF export job API (no I/O).
import { createHash } from 'node:crypto';
import type { ReportPdfLocale } from './report-pdf-i18n.js';

export const REPORT_PDF_EXPORT_PHASES = ['validating', 'narrative', 'rendering', 'ready', 'failed'] as const;

export type ReportPdfExportPhase = (typeof REPORT_PDF_EXPORT_PHASES)[number];

export function isReportPdfExportTerminal(phase: ReportPdfExportPhase): boolean {
  return phase === 'ready' || phase === 'failed';
}

export function getReportPdfExportPhaseIndex(phase: ReportPdfExportPhase): number {
  return REPORT_PDF_EXPORT_PHASES.indexOf(phase);
}

export const REPORT_PDF_STORAGE_FOLDER = 'report-exports';
export const REPORT_PDF_LOCALES: readonly ReportPdfLocale[] = ['vi', 'en'];

const sha256 = (parts: string[]) => createHash('sha256').update(parts.join('|')).digest('hex');

/**
 * Tenant-prefixed, deterministic storage key. The same message + snapshot hash
 * + locale + template version always maps to the same object, so a download
 * after a restart (or on another instance) finds the stored PDF. The digest
 * makes the object name unguessable without the snapshot hash.
 */
export function buildReportPdfStorageKey(input: {
  tenantId: string;
  conversationId: string;
  assistantMessageId: string;
  snapshotHash: string;
  locale: ReportPdfLocale;
  templateVersion: string;
}): string {
  const digest = sha256(['report-pdf', input.templateVersion, input.assistantMessageId, input.snapshotHash, input.locale]).slice(0, 40);
  return `${input.tenantId}/${REPORT_PDF_STORAGE_FOLDER}/${input.conversationId}/${input.assistantMessageId}/${input.locale}-${digest}.pdf`;
}

/**
 * Deterministic job id (UUID-shaped) per user + message + locale + template.
 * Status/download requests can be answered from storage when the in-memory
 * job is gone (restart, other instance).
 */
export function buildReportPdfJobId(input: {
  tenantId: string;
  userId: string;
  conversationId: string;
  assistantMessageId: string;
  locale: ReportPdfLocale;
  templateVersion: string;
}): string {
  const hex = sha256(['report-pdf-job', input.templateVersion, input.tenantId, input.userId, input.conversationId, input.assistantMessageId, input.locale]);
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Locale whose deterministic job id equals `jobId`, or null. */
export function resolveReportPdfJobLocale(jobId: string, input: Omit<Parameters<typeof buildReportPdfJobId>[0], 'locale'>): ReportPdfLocale | null {
  return REPORT_PDF_LOCALES.find((locale) => buildReportPdfJobId({ ...input, locale }) === jobId.toLowerCase()) ?? null;
}

/** Fixed-window rate-limit keys (shared across instances through Redis). */
export function buildReportPdfRateLimitKeys(input: { tenantId: string; userId: string; nowMs: number; windowSeconds: number }): {
  user: string;
  tenant: string;
  retryAfterSeconds: number;
} {
  const windowMs = input.windowSeconds * 1000;
  const bucket = Math.floor(input.nowMs / windowMs);
  return {
    user: `report-pdf:rl:v1:user:${input.tenantId}:${input.userId}:${bucket}`,
    tenant: `report-pdf:rl:v1:tenant:${input.tenantId}:${bucket}`,
    retryAfterSeconds: Math.max(1, Math.ceil(((bucket + 1) * windowMs - input.nowMs) / 1000)),
  };
}
