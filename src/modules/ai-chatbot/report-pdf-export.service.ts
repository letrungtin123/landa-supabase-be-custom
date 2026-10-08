// ═══════════════════════════════════════════════════════════════
// Report PDF export jobs. Contract (unchanged shape): start -> poll -> download.
// - Permission (report_summary.can_view) is checked on every call and the
//   report scope is re-enforced against the stored snapshot before rendering
//   and again immediately before serving bytes.
// - PDFs are stored under the tenant prefix (REPORT_PDF_STORAGE_ENABLED) with a
//   deterministic key, and job ids are deterministic, so status/download keep
//   working after a restart or on another instance. Without storage the
//   artifact stays in memory for the job TTL (previous behavior).
// - One audit row per delivered PDF; per-user/tenant start rate limit.
// ═══════════════════════════════════════════════════════════════
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { hasPermission } from '../../middleware/authorize.js';
import type { TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { AppError } from '../../middleware/error-handler.js';
import type { UserRole } from '../../types/index.js';
import { enforceReportScope } from '../reports/report-access.service.js';
import { getReportSnapshotHash, loadStoredReportSnapshot } from './report-chat.service.js';
import { loadReportPdfTenantBranding, supabaseReportPdfArtifactStore, type ReportPdfArtifactStore } from './report-pdf-artifact.service.js';
import {
  buildReportPdfJobId,
  buildReportPdfStorageKey,
  isReportPdfExportTerminal,
  resolveReportPdfJobLocale,
  type ReportPdfExportPhase,
} from './report-pdf-export.logic.js';
import { slugifyReportText, type ReportPdfLocale } from './report-pdf-i18n.js';
import { createReportPdfAiNarrativeWriter } from './report-pdf-narrative.service.js';
import { getReportPdfRenderer, type ReportPdfRenderer } from './report-pdf-renderer.service.js';
import { consumeReportPdfExportAllowance, type ReportPdfRateLimitDecision } from './report-pdf-rate-limit.service.js';
import { appendReportPdfExportAudit, loadStoredReportChatNarrative, type StoredReportChatNarrative } from './report-pdf.repository.js';
import { composeReportPdfDocument, paginateReportPdfDocument, REPORT_PDF_TEMPLATE_VERSION, type ReportPdfAiNarrativeWriter } from './report-pdf.service.js';
import { buildReportPdfFileName, type ReportPdfTenantBranding } from './report-pdf-view-model.js';

const ACTIVE_JOB_MAX_AGE_MS = 20 * 60 * 1000;
const TERMINAL_JOB_TTL_MS = 15 * 60 * 1000;
const MAX_CACHED_JOBS = 20;
const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024;

export type ReportPdfExportActor = { userId: string; tenantId: string; role: UserRole };
export type ReportPdfPermissionChecker = (actor: ReportPdfExportActor) => Promise<boolean>;
export type ReportPdfReference = { conversationId: string; assistantMessageId: string };
export type ReportPdfAuditContext = { ipAddress?: string; username?: string; requestId: string };

export type ReportPdfExportStatus = {
  id: string;
  phase: ReportPdfExportPhase;
  locale: ReportPdfLocale;
  fileName: string | null;
  expiresAt: string | null;
  errorCode: string | null;
  updatedAt: string;
};

export type ReportPdfExportErrorCode = 'REPORT_PDF_PERMISSION_DENIED' | 'REPORT_PDF_SCOPE_DENIED' | 'REPORT_PDF_NOT_FOUND'
  | 'REPORT_PDF_SNAPSHOT_UNAVAILABLE' | 'REPORT_PDF_INVALID_REQUEST' | 'REPORT_PDF_JOB_NOT_FOUND' | 'REPORT_PDF_NOT_READY'
  | 'REPORT_PDF_QUEUE_FULL' | 'REPORT_PDF_RATE_LIMITED' | 'REPORT_PDF_ARTIFACT_TOO_LARGE' | 'REPORT_PDF_EXPORT_EXPIRED'
  | 'REPORT_PDF_RENDERER_UNAVAILABLE' | 'REPORT_PDF_RENDER_TIMEOUT' | 'REPORT_PDF_RENDER_BUSY' | 'REPORT_PDF_STORAGE_FAILED'
  | 'REPORT_PDF_AUDIT_FAILED' | 'REPORT_PDF_EXPORT_FAILED' | 'REPORT_PDF_DEMO_SESSION';

export class ReportPdfExportError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: ReportPdfExportErrorCode, public readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'ReportPdfExportError';
  }
}

export interface ReportPdfExportDeps {
  permissionChecker: ReportPdfPermissionChecker;
  loadSnapshot: typeof loadStoredReportSnapshot;
  enforceScope: typeof enforceReportScope;
  loadNarrative: (input: ReportPdfReference & { userId: string; tenantId: string }) => Promise<StoredReportChatNarrative | null>;
  loadBranding: (tenantId: string) => Promise<ReportPdfTenantBranding>;
  renderer: () => Pick<ReportPdfRenderer, 'render' | 'measure'>;
  aiWriter: (context: { tenantId: string; userId: string; conversationId: string; requestId: string }) => ReportPdfAiNarrativeWriter | undefined;
  store: () => ReportPdfArtifactStore | null;
  audit: (entry: TransactionalAuditEntry) => Promise<void>;
  rateLimit: (actor: ReportPdfExportActor) => Promise<ReportPdfRateLimitDecision>;
  log: (event: Record<string, unknown>) => void;
}

const log = (event: Record<string, unknown>) => console.info(`[ReportPdf] ${JSON.stringify(event)}`);

export const defaultReportPdfExportDeps: ReportPdfExportDeps = {
  permissionChecker: (actor) => hasPermission({ id: actor.userId, tenantId: actor.tenantId, role: actor.role }, 'report_summary', 'can_view'),
  loadSnapshot: loadStoredReportSnapshot,
  enforceScope: enforceReportScope,
  loadNarrative: loadStoredReportChatNarrative,
  loadBranding: (tenantId) => loadReportPdfTenantBranding(tenantId, log),
  renderer: getReportPdfRenderer,
  aiWriter: (context) => createReportPdfAiNarrativeWriter(context),
  store: () => (env.REPORT_PDF_STORAGE_ENABLED ? supabaseReportPdfArtifactStore : null),
  audit: appendReportPdfExportAudit,
  rateLimit: (actor) => consumeReportPdfExportAllowance(actor, { log }),
  log,
};

type Job = ReportPdfExportStatus & ReportPdfReference & {
  userId: string;
  tenantId: string;
  storageKey: string | null;
  artifact: Buffer | null;
  updatedAtMs: number;
  expiresAtMs: number | null;
};

export function getReportPdfExportError(error: unknown): ReportPdfExportError {
  if (error instanceof ReportPdfExportError) return error;
  const code = (error as { code?: unknown })?.code;
  if (code === 'REPORT_PDF_RENDERER_UNAVAILABLE') return new ReportPdfExportError('Report PDF renderer unavailable', 503, code);
  if (code === 'REPORT_PDF_RENDER_TIMEOUT') return new ReportPdfExportError('Report PDF rendering timed out', 504, code);
  if (code === 'REPORT_PDF_RENDER_BUSY') return new ReportPdfExportError('Report PDF renderer busy', 429, code);
  if (error instanceof AppError && error.statusCode < 500) {
    const mapped = error.statusCode === 403 ? 'REPORT_PDF_SCOPE_DENIED' : error.statusCode === 404 ? 'REPORT_PDF_NOT_FOUND' : 'REPORT_PDF_INVALID_REQUEST';
    return new ReportPdfExportError(error.message, error.statusCode, mapped);
  }
  const source = error as { status?: unknown; statusCode?: unknown } | null;
  const status = typeof source?.status === 'number' ? source.status : typeof source?.statusCode === 'number' ? source.statusCode : 500;
  const mapped: ReportPdfExportErrorCode = status === 403 ? 'REPORT_PDF_SCOPE_DENIED'
    : status === 404 ? 'REPORT_PDF_NOT_FOUND'
      : status === 409 ? 'REPORT_PDF_SNAPSHOT_UNAVAILABLE'
        : status === 400 ? 'REPORT_PDF_INVALID_REQUEST'
          : 'REPORT_PDF_EXPORT_FAILED';
  return new ReportPdfExportError(error instanceof Error ? error.message : 'Report PDF export failed', status >= 400 && status < 600 ? status : 500, mapped);
}

type ArtifactResult = { fileName: string; storageKey: string | null; pdf: Buffer | null; cached: boolean };
type BuildInput = {
  actor: ReportPdfExportActor;
  reference: ReportPdfReference;
  locale: ReportPdfLocale;
  requestId: string;
  onPhase?: (phase: Extract<ReportPdfExportPhase, 'validating' | 'narrative' | 'rendering'>) => void;
};
type JobInput = ReportPdfExportActor & ReportPdfReference;

const split = (input: JobInput) => ({
  actor: { userId: input.userId, tenantId: input.tenantId, role: input.role },
  reference: { conversationId: input.conversationId, assistantMessageId: input.assistantMessageId },
});

export class ReportPdfExportService {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly deps: ReportPdfExportDeps = defaultReportPdfExportDeps) {}

  private async assertPermission(actor: ReportPdfExportActor): Promise<void> {
    if (await this.deps.permissionChecker(actor)) return;
    throw new ReportPdfExportError('Report permission revoked', 403, 'REPORT_PDF_PERMISSION_DENIED');
  }

  /** Loads the integrity-checked snapshot and re-enforces the actor's current scope on it. */
  private async loadAuthorizedSnapshot(actor: ReportPdfExportActor, reference: ReportPdfReference) {
    const stored = await this.deps.loadSnapshot({ ...reference, userId: actor.userId, tenantId: actor.tenantId });
    const scope = await this.deps.enforceScope(
      { userId: actor.userId, tenantId: actor.tenantId, role: actor.role },
      { groupId: stored.snapshot.filter.group_id, subgroupId: stored.snapshot.filter.subgroup_id, teamId: stored.snapshot.filter.team_id },
    );
    if (scope.groupId !== stored.snapshot.scope.groupId || scope.subgroupId !== stored.snapshot.scope.subgroupId || scope.teamId !== stored.snapshot.scope.teamId) {
      throw new ReportPdfExportError('Report scope no longer allowed', 403, 'REPORT_PDF_SCOPE_DENIED');
    }
    return { ...stored, snapshotHash: getReportSnapshotHash(stored.snapshot) };
  }

  private storageKey(actor: ReportPdfExportActor, reference: ReportPdfReference, snapshotHash: string, locale: ReportPdfLocale): string {
    return buildReportPdfStorageKey({ tenantId: actor.tenantId, ...reference, snapshotHash, locale, templateVersion: REPORT_PDF_TEMPLATE_VERSION });
  }

  private fileNameFor(locale: ReportPdfLocale, snapshot: { filter: { date_from: string; date_to: string } }, tenantName: string): string {
    return buildReportPdfFileName({ locale, dateFrom: snapshot.filter.date_from, dateTo: snapshot.filter.date_to, tenantSlug: slugifyReportText(tenantName, 32) || undefined });
  }

  /** Validates access, then returns the stored PDF key or renders (and stores) a new PDF. */
  async buildArtifact(input: BuildInput): Promise<ArtifactResult> {
    const { actor, reference, locale } = input;
    await this.assertPermission(actor);
    input.onPhase?.('validating');
    const stored = await this.loadAuthorizedSnapshot(actor, reference);
    const branding = await this.deps.loadBranding(actor.tenantId);
    const fileName = this.fileNameFor(locale, stored.snapshot, branding.name);
    const store = this.deps.store();
    const storageKey = store ? this.storageKey(actor, reference, stored.snapshotHash, locale) : null;
    if (store && storageKey && await store.exists(storageKey)) return { fileName, storageKey, pdf: null, cached: true };

    input.onPhase?.('narrative');
    const chatNarrative = await this.deps.loadNarrative({ ...reference, userId: actor.userId, tenantId: actor.tenantId });
    const composed = await composeReportPdfDocument({
      snapshot: stored.snapshot,
      snapshotHash: stored.snapshotHash,
      locale,
      tenant: branding,
      ...(chatNarrative && chatNarrative.snapshotHash === stored.snapshotHash ? { storedNarrative: chatNarrative.narrative, storedNarrativeLocale: chatNarrative.locale } : {}),
      writeAiNarrative: this.deps.aiWriter({ tenantId: actor.tenantId, userId: actor.userId, conversationId: reference.conversationId, requestId: input.requestId }),
    });
    input.onPhase?.('rendering');
    const renderer = this.deps.renderer();
    const document = await paginateReportPdfDocument(composed, renderer);
    const rendered = await renderer.render(document.html);
    const base = { request_id: input.requestId, tenant_id: actor.tenantId };
    if (rendered.overflow.length) this.deps.log({ event: 'report_pdf_layout_overflow', ...base, pages: rendered.overflow });
    if (rendered.pdf.byteLength > MAX_ARTIFACT_BYTES) throw new ReportPdfExportError('Report PDF too large', 413, 'REPORT_PDF_ARTIFACT_TOO_LARGE');
    this.deps.log({ event: 'report_pdf_rendered', ...base, pages: rendered.pageCount, bytes: rendered.pdf.byteLength, duration_ms: rendered.durationMs, narrative: document.narrative.source, locale });
    if (store && storageKey) {
      try {
        await store.put(storageKey, rendered.pdf);
        return { fileName, storageKey, pdf: rendered.pdf, cached: false };
      } catch (error) {
        // Degraded mode: the job keeps the bytes in memory (previous behavior).
        this.deps.log({ event: 'report_pdf_storage_failed', ...base, reason: (error as { code?: string })?.code ?? (error instanceof Error ? error.name : 'unknown') });
      }
    }
    return { fileName, storageKey: null, pdf: rendered.pdf, cached: false };
  }

  private async auditDelivery(actor: ReportPdfExportActor, reference: ReportPdfReference, fileName: string, bytes: number, context: ReportPdfAuditContext): Promise<void> {
    try {
      await this.deps.audit({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        actorUsername: context.username,
        action: 'CREATE',
        entityType: 'report_pdf',
        entityId: reference.assistantMessageId,
        entityName: fileName,
        ipAddress: context.ipAddress,
        event: { code: 'report.pdf.exported', context: { file_name: fileName, file_size_bytes: bytes } },
      });
    } catch (error) {
      this.deps.log({ event: 'report_pdf_audit_failed', request_id: context.requestId, tenant_id: actor.tenantId, reason: error instanceof Error ? error.name : 'unknown' });
      throw new ReportPdfExportError('Report PDF audit failed', 503, 'REPORT_PDF_AUDIT_FAILED');
    }
  }

  private static toStatus(job: Job): ReportPdfExportStatus {
    return { id: job.id, phase: job.phase, locale: job.locale, fileName: job.fileName, expiresAt: job.expiresAt, errorCode: job.errorCode, updatedAt: job.updatedAt };
  }

  private static touch(job: Job, patch: Partial<Job>): void {
    Object.assign(job, patch);
    job.updatedAtMs = Date.now();
    job.updatedAt = new Date(job.updatedAtMs).toISOString();
  }

  private static finish(job: Job, patch: Partial<Job>): void {
    const expiresAtMs = Date.now() + TERMINAL_JOB_TTL_MS;
    ReportPdfExportService.touch(job, { ...patch, expiresAtMs, expiresAt: new Date(expiresAtMs).toISOString() });
  }

  private purge(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (!isReportPdfExportTerminal(job.phase) && now - job.updatedAtMs > ACTIVE_JOB_MAX_AGE_MS) {
        ReportPdfExportService.finish(job, { phase: 'failed', errorCode: 'REPORT_PDF_EXPORT_EXPIRED', artifact: null });
      }
      if (isReportPdfExportTerminal(job.phase) && job.expiresAtMs !== null && now >= job.expiresAtMs) this.jobs.delete(job.id);
    }
  }

  private ownedJob(actor: ReportPdfExportActor, reference: ReportPdfReference, jobId: string): Job | null {
    this.purge();
    const job = this.jobs.get(jobId.toLowerCase());
    if (!job || job.userId !== actor.userId || job.tenantId !== actor.tenantId
      || job.conversationId !== reference.conversationId || job.assistantMessageId !== reference.assistantMessageId) return null;
    return job;
  }

  private jobLocale(actor: ReportPdfExportActor, reference: ReportPdfReference, jobId: string): ReportPdfLocale | null {
    return resolveReportPdfJobLocale(jobId, { tenantId: actor.tenantId, userId: actor.userId, ...reference, templateVersion: REPORT_PDF_TEMPLATE_VERSION });
  }

  private async run(job: Job, actor: ReportPdfExportActor): Promise<void> {
    const requestId = randomUUID();
    try {
      const artifact = await this.buildArtifact({
        actor, reference: job, locale: job.locale, requestId,
        onPhase: (phase) => { if (!isReportPdfExportTerminal(job.phase)) ReportPdfExportService.touch(job, { phase }); },
      });
      ReportPdfExportService.finish(job, { phase: 'ready', fileName: artifact.fileName, storageKey: artifact.storageKey, artifact: artifact.storageKey ? null : artifact.pdf, errorCode: null });
    } catch (error) {
      const normalized = getReportPdfExportError(error);
      ReportPdfExportService.finish(job, { phase: 'failed', artifact: null, errorCode: normalized.code });
      if (normalized.statusCode >= 500) this.deps.log({ event: 'report_pdf_export_failed', request_id: requestId, tenant_id: actor.tenantId, code: normalized.code });
    }
  }

  private async enforceRateLimit(actor: ReportPdfExportActor): Promise<void> {
    const decision = await this.deps.rateLimit(actor);
    if (!decision.allowed) throw new ReportPdfExportError('Report PDF export rate limited', 429, 'REPORT_PDF_RATE_LIMITED', decision.retryAfterSeconds);
  }

  async start(input: JobInput & { locale: ReportPdfLocale }): Promise<ReportPdfExportStatus> {
    const { actor, reference } = split(input);
    await this.assertPermission(actor);
    this.purge();
    const id = buildReportPdfJobId({ ...actor, ...reference, locale: input.locale, templateVersion: REPORT_PDF_TEMPLATE_VERSION });
    const existing = this.jobs.get(id);
    if (existing && existing.phase !== 'failed') return ReportPdfExportService.toStatus(existing);
    if (existing) this.jobs.delete(id);
    await this.enforceRateLimit(actor);
    if (this.jobs.size >= MAX_CACHED_JOBS) throw new ReportPdfExportError('Report PDF queue full', 429, 'REPORT_PDF_QUEUE_FULL');
    const now = Date.now();
    const job: Job = {
      id, ...reference, userId: actor.userId, tenantId: actor.tenantId, phase: 'validating', locale: input.locale,
      fileName: null, expiresAt: null, errorCode: null, updatedAt: new Date(now).toISOString(), updatedAtMs: now,
      expiresAtMs: null, storageKey: null, artifact: null,
    };
    this.jobs.set(id, job);
    void this.run(job, actor);
    return ReportPdfExportService.toStatus(job);
  }

  async get(input: JobInput & { jobId: string }): Promise<ReportPdfExportStatus> {
    const { actor, reference } = split(input);
    await this.assertPermission(actor);
    const job = this.ownedJob(actor, reference, input.jobId);
    if (job) return ReportPdfExportService.toStatus(job);
    // Stateless recovery (restart / other instance): the deterministic job id names the locale.
    const locale = this.jobLocale(actor, reference, input.jobId);
    const store = this.deps.store();
    if (!locale || !store) throw new ReportPdfExportError('Report PDF job not found', 404, 'REPORT_PDF_JOB_NOT_FOUND');
    const stored = await this.loadAuthorizedSnapshot(actor, reference);
    if (!await store.exists(this.storageKey(actor, reference, stored.snapshotHash, locale))) {
      throw new ReportPdfExportError('Report PDF job not found', 404, 'REPORT_PDF_JOB_NOT_FOUND');
    }
    const branding = await this.deps.loadBranding(actor.tenantId);
    return { id: input.jobId.toLowerCase(), phase: 'ready', locale, fileName: this.fileNameFor(locale, stored.snapshot, branding.name), expiresAt: null, errorCode: null, updatedAt: new Date().toISOString() };
  }

  async download(input: JobInput & { jobId: string; audit: ReportPdfAuditContext }): Promise<{ pdf: Buffer; fileName: string }> {
    const { actor, reference } = split(input);
    await this.assertPermission(actor);
    const job = this.ownedJob(actor, reference, input.jobId);
    if (job && job.phase !== 'ready') throw new ReportPdfExportError('Report PDF not ready', 409, 'REPORT_PDF_NOT_READY');
    const locale = job?.locale ?? this.jobLocale(actor, reference, input.jobId);
    if (!locale) throw new ReportPdfExportError('Report PDF job not found', 404, 'REPORT_PDF_JOB_NOT_FOUND');
    // Access is rechecked immediately before serving the artifact.
    const stored = await this.loadAuthorizedSnapshot(actor, reference);
    let pdf = job?.artifact ?? null;
    const store = this.deps.store();
    if (!pdf && store) {
      const key = this.storageKey(actor, reference, stored.snapshotHash, locale);
      if (await store.exists(key)) pdf = await store.get(key);
    }
    if (!pdf) {
      throw job
        ? new ReportPdfExportError('Report PDF not ready', 409, 'REPORT_PDF_NOT_READY')
        : new ReportPdfExportError('Report PDF job not found', 404, 'REPORT_PDF_JOB_NOT_FOUND');
    }
    const fileName = job?.fileName ?? this.fileNameFor(locale, stored.snapshot, (await this.deps.loadBranding(actor.tenantId)).name);
    await this.auditDelivery(actor, reference, fileName, pdf.byteLength, input.audit);
    return { pdf, fileName };
  }

  /** Synchronous variant (POST /report-pdf): render or reuse, audit, return bytes. */
  async exportNow(input: JobInput & { locale: ReportPdfLocale; audit: ReportPdfAuditContext }): Promise<{ pdf: Buffer; fileName: string }> {
    const { actor, reference } = split(input);
    await this.assertPermission(actor);
    await this.enforceRateLimit(actor);
    const artifact = await this.buildArtifact({ actor, reference, locale: input.locale, requestId: input.audit.requestId });
    const store = this.deps.store();
    const pdf = artifact.pdf ?? (store && artifact.storageKey ? await store.get(artifact.storageKey) : null);
    if (!pdf) throw new ReportPdfExportError('Report PDF not ready', 409, 'REPORT_PDF_NOT_READY');
    await this.auditDelivery(actor, reference, artifact.fileName, pdf.byteLength, input.audit);
    return { pdf, fileName: artifact.fileName };
  }
}

/** Public surface used by the controller (and its test doubles). */
export type ReportPdfExportApi = Pick<ReportPdfExportService, 'buildArtifact' | 'start' | 'get' | 'download' | 'exportNow'>;

export function createReportPdfExportService(deps: ReportPdfExportDeps = defaultReportPdfExportDeps): ReportPdfExportService {
  return new ReportPdfExportService(deps);
}

let sharedService: ReportPdfExportService | null = null;
export function getReportPdfExportService(): ReportPdfExportService {
  sharedService ??= createReportPdfExportService();
  return sharedService;
}

// Backward-compatible function exports: chat.controller.ts still imports them
// (its old PDF handlers are no longer routed; see ai-chatbot.routes.ts).
export const startReportPdfExportJob = (input: ReportPdfExportActor & ReportPdfReference) => getReportPdfExportService().start({ ...input, locale: 'vi' });
export const getReportPdfExportJob = (input: ReportPdfExportActor & ReportPdfReference & { jobId: string }) => getReportPdfExportService().get(input);
export const downloadReportPdfExportJob = (input: ReportPdfExportActor & ReportPdfReference & { jobId: string }) => getReportPdfExportService().download({ ...input, audit: { requestId: randomUUID() } });
export const buildReportPdfArtifact = async (input: { actor: ReportPdfExportActor } & ReportPdfReference) => {
  const result = await getReportPdfExportService().exportNow({ ...input.actor, conversationId: input.conversationId, assistantMessageId: input.assistantMessageId, locale: 'vi', audit: { requestId: randomUUID() } });
  return { pdf: result.pdf, fileName: result.fileName, locale: 'vi' as const };
};
