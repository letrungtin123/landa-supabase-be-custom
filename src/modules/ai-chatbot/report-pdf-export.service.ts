import { randomUUID } from 'node:crypto';
import { getTenantAiRuntimeSettings } from './ai-settings.service.js';
import { estimateTokensFromText, finalizeTenantAiTokens, releaseTenantAiTokenReservation, reserveTenantAiTokens } from './ai-token-quota.service.js';
import { getReportSnapshotHash, loadStoredReportSnapshot } from './report-chat.service.js';
import { generateReportPdfNarrative, renderReportPdf } from './report-pdf.service.js';
import { enforceReportScope } from '../reports/report-access.service.js';
import { AppError } from '../../middleware/error-handler.js';
import type { UserRole } from '../../types/index.js';
import { isReportPdfExportTerminal, type ReportPdfExportPhase } from './report-pdf-export.logic.js';

const ACTIVE_JOB_MAX_AGE_MS = 20 * 60 * 1000;
const TERMINAL_JOB_TTL_MS = 15 * 60 * 1000;
const MAX_CACHED_JOBS = 20;
const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024;

export type ReportPdfExportActor = {
  userId: string;
  tenantId: string;
  role: UserRole;
};

export type ReportPdfExportStatus = {
  id: string;
  phase: ReportPdfExportPhase;
  locale: 'vi' | 'en';
  fileName: string | null;
  expiresAt: string | null;
  errorCode: string | null;
  updatedAt: string;
};

type ReportPdfExportJob = ReportPdfExportStatus & {
  key: string;
  userId: string;
  tenantId: string;
  conversationId: string;
  assistantMessageId: string;
  artifact: Buffer | null;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number | null;
};

export class ReportPdfExportError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ReportPdfExportError';
  }
}

const jobsById = new Map<string, ReportPdfExportJob>();
const jobIdByKey = new Map<string, string>();

function exportKey(input: Pick<ReportPdfExportActor, 'userId' | 'tenantId'> & { conversationId: string; assistantMessageId: string }): string {
  return `${input.tenantId}:${input.userId}:${input.conversationId}:${input.assistantMessageId}`;
}

function toIso(value: number | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function toPublicStatus(job: ReportPdfExportJob): ReportPdfExportStatus {
  return {
    id: job.id,
    phase: job.phase,
    locale: job.locale,
    fileName: job.fileName,
    expiresAt: job.expiresAt,
    errorCode: job.errorCode,
    updatedAt: job.updatedAt,
  };
}

function touchJob(job: ReportPdfExportJob): void {
  job.updatedAtMs = Date.now();
  job.updatedAt = new Date(job.updatedAtMs).toISOString();
}

function setPhase(job: ReportPdfExportJob, phase: ReportPdfExportPhase): void {
  if (isReportPdfExportTerminal(job.phase)) return;
  job.phase = phase;
  touchJob(job);
}

function removeJob(job: ReportPdfExportJob): void {
  jobsById.delete(job.id);
  if (jobIdByKey.get(job.key) === job.id) jobIdByKey.delete(job.key);
}

function purgeStaleJobs(): void {
  const now = Date.now();
  for (const job of jobsById.values()) {
    if (!isReportPdfExportTerminal(job.phase) && now - job.updatedAtMs > ACTIVE_JOB_MAX_AGE_MS) {
      job.phase = 'failed';
      job.errorCode = 'REPORT_PDF_EXPORT_EXPIRED';
      job.artifact = null;
      job.expiresAtMs = now + TERMINAL_JOB_TTL_MS;
      job.expiresAt = toIso(job.expiresAtMs);
      touchJob(job);
    }
    if (isReportPdfExportTerminal(job.phase)
      && job.expiresAtMs !== null
      && now >= job.expiresAtMs) {
      removeJob(job);
    }
  }
}

function normalizeExportError(error: unknown): ReportPdfExportError {
  if (error instanceof ReportPdfExportError) return error;
  if (error instanceof AppError) {
    return new ReportPdfExportError(error.message, error.statusCode, error.code || 'REPORT_PDF_EXPORT_FAILED');
  }
  const source = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown } | null;
  const status = typeof source?.status === 'number'
    ? source.status
    : typeof source?.statusCode === 'number'
      ? source.statusCode
      : 500;
  const code = typeof source?.code === 'string' && source.code.trim()
    ? source.code
    : status === 403
      ? 'REPORT_PDF_SCOPE_DENIED'
      : status === 404
        ? 'REPORT_PDF_NOT_FOUND'
        : status === 409
          ? 'REPORT_PDF_SNAPSHOT_UNAVAILABLE'
          : status === 400
            ? 'REPORT_PDF_INVALID_REQUEST'
            : 'REPORT_PDF_EXPORT_FAILED';
  const message = typeof source?.message === 'string' && source.message.trim()
    ? source.message
    : 'Không thể xuất PDF báo cáo.';
  return new ReportPdfExportError(message, status, code);
}

export function getReportPdfExportError(error: unknown): ReportPdfExportError {
  return normalizeExportError(error);
}

function buildReportPdfFileName(locale: 'vi' | 'en', dateFrom: string, dateTo: string): string {
  return locale === 'en'
    ? `learning-report-${dateFrom}-to-${dateTo}.pdf`
    : `bao-cao-hoc-tap-${dateFrom}-den-${dateTo}.pdf`;
}

export async function buildReportPdfArtifact(input: {
  actor: ReportPdfExportActor;
  conversationId: string;
  assistantMessageId: string;
  onPhase?: (phase: Extract<ReportPdfExportPhase, 'validating' | 'narrative' | 'rendering'>) => void;
}): Promise<{ pdf: Buffer; locale: 'vi' | 'en'; fileName: string }> {
  input.onPhase?.('validating');
  const { actor, conversationId, assistantMessageId } = input;
  const stored = await loadStoredReportSnapshot({
    assistantMessageId,
    conversationId,
    userId: actor.userId,
    tenantId: actor.tenantId,
  });
  const reportSnapshotHash = getReportSnapshotHash(stored.snapshot);
  const currentScope = await enforceReportScope(
    { userId: actor.userId, tenantId: actor.tenantId, role: actor.role },
    {
      groupId: stored.snapshot.filter.group_id,
      subgroupId: stored.snapshot.filter.subgroup_id,
      teamId: stored.snapshot.filter.team_id,
    },
  );
  if (currentScope.groupId !== stored.snapshot.scope.groupId
    || currentScope.subgroupId !== stored.snapshot.scope.subgroupId
    || currentScope.teamId !== stored.snapshot.scope.teamId) {
    throw new ReportPdfExportError('Bạn không còn quyền xuất phạm vi báo cáo này', 403, 'REPORT_PDF_SCOPE_DENIED');
  }

  const settings = await getTenantAiRuntimeSettings(actor.tenantId);
  if (!settings.hasGoogleAiStudioKey) {
    throw new ReportPdfExportError('Chưa cấu hình API key Google AI Studio cho doanh nghiệp này.', 400, 'AI_PROVIDER_KEY_MISSING');
  }

  const inputTokens = estimateTokensFromText(JSON.stringify(stored.snapshot), stored.question);
  let reservationId: string | null = null;
  try {
    const reservation = await reserveTenantAiTokens({
      tenantId: actor.tenantId,
      userId: actor.userId,
      conversationId,
      target: 'admin',
      engine: settings.activeEngine,
      provider: settings.provider,
      model: settings.chatModel,
      operation: 'chat',
      minimumTokens: Math.max(1_000, inputTokens + 500),
      maximumTokens: Math.min(30_000, Math.max(4_500, inputTokens + 3_000)),
      budget: {
        inputTokens,
        outputTokens: 2_000,
        maxOutputTokens: 2_000,
        metadata: { report_chat: true, report_stage: 'pdf' },
      },
    });
    reservationId = reservation.id;
    input.onPhase?.('narrative');
    const narrative = await generateReportPdfNarrative({
      tenantId: actor.tenantId,
      model: settings.chatModel,
      locale: stored.locale,
      question: stored.question,
      snapshot: stored.snapshot,
    });
    input.onPhase?.('rendering');
    const pdf = await renderReportPdf({ snapshot: stored.snapshot, narrative, locale: stored.locale });
    if (pdf.byteLength > MAX_ARTIFACT_BYTES) {
      throw new ReportPdfExportError('PDF báo cáo vượt quá dung lượng tạm thời cho phép.', 413, 'REPORT_PDF_ARTIFACT_TOO_LARGE');
    }
    await finalizeTenantAiTokens({
      reservationId,
      tenantId: actor.tenantId,
      usage: {
        inputTokens,
        outputTokens: estimateTokensFromText(JSON.stringify(narrative)),
        embeddingTokens: 0,
        totalTokens: inputTokens + estimateTokensFromText(JSON.stringify(narrative)),
      },
      source: { service: 'report_pdf', assistant_message_id: assistantMessageId },
      metadata: { report_chat: true, report_stage: 'pdf', report_snapshot_hash: reportSnapshotHash },
    });
    reservationId = null;
    return {
      pdf,
      locale: stored.locale,
      fileName: buildReportPdfFileName(stored.locale, stored.snapshot.filter.date_from, stored.snapshot.filter.date_to),
    };
  } catch (error) {
    if (reservationId) await releaseTenantAiTokenReservation(reservationId, actor.tenantId).catch(() => undefined);
    throw normalizeExportError(error);
  }
}

function findJob(input: ReportPdfExportActor & { conversationId: string; assistantMessageId: string; jobId: string }): ReportPdfExportJob {
  purgeStaleJobs();
  const job = jobsById.get(input.jobId);
  if (!job
    || job.userId !== input.userId
    || job.tenantId !== input.tenantId
    || job.conversationId !== input.conversationId
    || job.assistantMessageId !== input.assistantMessageId) {
    throw new ReportPdfExportError('Không tìm thấy tiến trình xuất báo cáo.', 404, 'REPORT_PDF_JOB_NOT_FOUND');
  }
  return job;
}

async function runJob(job: ReportPdfExportJob, actor: ReportPdfExportActor): Promise<void> {
  try {
    const artifact = await buildReportPdfArtifact({
      actor,
      conversationId: job.conversationId,
      assistantMessageId: job.assistantMessageId,
      onPhase: (phase) => setPhase(job, phase),
    });
    if (!jobsById.has(job.id)) return;
    job.phase = 'ready';
    job.locale = artifact.locale;
    job.fileName = artifact.fileName;
    job.artifact = artifact.pdf;
    job.errorCode = null;
    job.expiresAtMs = Date.now() + TERMINAL_JOB_TTL_MS;
    job.expiresAt = toIso(job.expiresAtMs);
    touchJob(job);
  } catch (error) {
    if (!jobsById.has(job.id)) return;
    const normalized = normalizeExportError(error);
    job.phase = 'failed';
    job.artifact = null;
    job.errorCode = normalized.code;
    job.expiresAtMs = Date.now() + TERMINAL_JOB_TTL_MS;
    job.expiresAt = toIso(job.expiresAtMs);
    touchJob(job);
    if (normalized.statusCode >= 500) {
      console.error('[ReportPdf] export job failed:', normalized);
    }
  }
}

export function startReportPdfExportJob(input: ReportPdfExportActor & {
  conversationId: string;
  assistantMessageId: string;
}): ReportPdfExportStatus {
  purgeStaleJobs();
  const key = exportKey(input);
  const existingId = jobIdByKey.get(key);
  const existing = existingId ? jobsById.get(existingId) : null;
  if (existing && existing.phase !== 'failed') return toPublicStatus(existing);
  if (existing) removeJob(existing);
  if (jobsById.size >= MAX_CACHED_JOBS) {
    throw new ReportPdfExportError('Hệ thống đang xử lý nhiều báo cáo. Vui lòng thử lại sau.', 429, 'REPORT_PDF_QUEUE_FULL');
  }

  const now = Date.now();
  const job: ReportPdfExportJob = {
    id: randomUUID(),
    key,
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    assistantMessageId: input.assistantMessageId,
    phase: 'validating',
    locale: 'vi',
    fileName: null,
    expiresAt: null,
    errorCode: null,
    updatedAt: new Date(now).toISOString(),
    artifact: null,
    createdAtMs: now,
    updatedAtMs: now,
    expiresAtMs: null,
  };
  jobsById.set(job.id, job);
  jobIdByKey.set(key, job.id);
  void runJob(job, input);
  return toPublicStatus(job);
}

export function getReportPdfExportJob(input: ReportPdfExportActor & {
  conversationId: string;
  assistantMessageId: string;
  jobId: string;
}): ReportPdfExportStatus {
  return toPublicStatus(findJob(input));
}

export async function downloadReportPdfExportJob(input: ReportPdfExportActor & {
  conversationId: string;
  assistantMessageId: string;
  jobId: string;
}): Promise<{ pdf: Buffer; fileName: string }> {
  const job = findJob(input);
  if (job.phase !== 'ready' || !job.artifact || !job.fileName) {
    throw new ReportPdfExportError('PDF báo cáo chưa sẵn sàng để tải.', 409, 'REPORT_PDF_NOT_READY');
  }

  // The job is short-lived, but access is rechecked immediately before serving the artifact.
  const stored = await loadStoredReportSnapshot({
    assistantMessageId: input.assistantMessageId,
    conversationId: input.conversationId,
    userId: input.userId,
    tenantId: input.tenantId,
  });
  const currentScope = await enforceReportScope(
    { userId: input.userId, tenantId: input.tenantId, role: input.role },
    {
      groupId: stored.snapshot.filter.group_id,
      subgroupId: stored.snapshot.filter.subgroup_id,
      teamId: stored.snapshot.filter.team_id,
    },
  );
  if (currentScope.groupId !== stored.snapshot.scope.groupId
    || currentScope.subgroupId !== stored.snapshot.scope.subgroupId
    || currentScope.teamId !== stored.snapshot.scope.teamId) {
    throw new ReportPdfExportError('Bạn không còn quyền xuất phạm vi báo cáo này', 403, 'REPORT_PDF_SCOPE_DENIED');
  }
  return { pdf: job.artifact, fileName: job.fileName };
}
