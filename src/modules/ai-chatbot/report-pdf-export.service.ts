// ═══════════════════════════════════════════════════════════════
// Report PDF export jobs. Contract (unchanged shape): start -> poll -> download.
// - Permission (report_summary.can_view) is checked on every call and the
//   report scope is re-enforced against the stored snapshot before rendering
//   and again immediately before serving bytes.
// - PDFs are stored under the tenant prefix (REPORT_PDF_STORAGE_ENABLED) with a
//   deterministic key, and job ids are deterministic, so status/download keep
//   working after a restart or on another instance. Without storage the
//   artifact stays in memory for the job TTL (previous behavior).
// - With several API processes the running job's status (and a PDF kept only
//   in memory) is also written to Redis (report-pdf-job-directory.service.ts),
//   so polls and the download work on any process.
// - One audit row per delivered PDF; per-user/tenant start rate limit, charged
//   only after the per-process/per-tenant capacity of in-progress exports.
// ═══════════════════════════════════════════════════════════════
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { hasPermission } from '../../middleware/authorize.js';
import type { TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { AppError } from '../../middleware/error-handler.js';
import type { UserRole } from '../../types/index.js';
import { enforceReportScope, hasNoAccessibleReportScope } from '../reports/report-access.service.js';
import { getReportSnapshotHash, loadStoredReportSnapshot } from './report-chat.service.js';
import { loadReportPdfTenantBranding, loadReportPdfTenantLabels, supabaseReportPdfArtifactStore, type ReportPdfArtifactStore } from './report-pdf-artifact.service.js';
import { reportTenantLabelsKey, type ReportTenantLabels } from './report-labels.logic.js';
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
import { defaultReportPdfJobDirectory, type ReportPdfJobDirectory, type SharedReportPdfJob } from './report-pdf-job-directory.service.js';

const ACTIVE_JOB_MAX_AGE_MS = 20 * 60 * 1000;
const TERMINAL_JOB_TTL_MS = 15 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 15 * 1024 * 1024;
/** A running job's shared status lives this long unless its process renews it. */
const SHARED_ACTIVE_JOB_TTL_MS = 60 * 1000;
const SHARED_ACTIVE_JOB_RENEW_MS = 15 * 1000;

/**
 * Only in-progress exports (jobs and synchronous exports) count against the
 * capacity, per process and per tenant. Finished jobs stay available for
 * status/download until their TTL, outside the capacity, within a hard bound
 * on their number and in-memory bytes (oldest finished evicted first).
 */
export interface ReportPdfExportLimits {
  activeJobs: number;
  tenantActiveJobs: number;
  finishedJobs: number;
  finishedArtifactBytes: number;
}

const defaultReportPdfExportLimits = (): ReportPdfExportLimits => ({
  activeJobs: 20,
  tenantActiveJobs: env.REPORT_PDF_TENANT_ACTIVE_JOBS,
  finishedJobs: 100,
  finishedArtifactBytes: 200 * 1024 * 1024,
});

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
  /** The tenant's level/role labels, read at render time (snapshots never store them). */
  loadLabels: (tenantId: string) => Promise<ReportTenantLabels>;
  renderer: () => Pick<ReportPdfRenderer, 'render' | 'measure'>;
  aiWriter: (context: { tenantId: string; userId: string; conversationId: string; requestId: string }) => ReportPdfAiNarrativeWriter | undefined;
  store: () => ReportPdfArtifactStore | null;
  audit: (entry: TransactionalAuditEntry) => Promise<void>;
  rateLimit: (actor: ReportPdfExportActor) => Promise<ReportPdfRateLimitDecision>;
  log: (event: Record<string, unknown>) => void;
  limits?: Partial<ReportPdfExportLimits>;
  /** Jobs seen by the other API processes (null or absent: this process only). */
  jobDirectory?: () => ReportPdfJobDirectory | null;
}

const log = (event: Record<string, unknown>) => console.info(`[ReportPdf] ${JSON.stringify(event)}`);
const warn = (event: Record<string, unknown>) => console.warn(`[ReportPdf] ${JSON.stringify(event)}`);

export const defaultReportPdfExportDeps: ReportPdfExportDeps = {
  permissionChecker: (actor) => hasPermission({ id: actor.userId, tenantId: actor.tenantId, role: actor.role }, 'report_summary', 'can_view'),
  loadSnapshot: loadStoredReportSnapshot,
  enforceScope: enforceReportScope,
  loadNarrative: loadStoredReportChatNarrative,
  loadBranding: (tenantId) => loadReportPdfTenantBranding(tenantId, log),
  loadLabels: loadReportPdfTenantLabels,
  renderer: getReportPdfRenderer,
  aiWriter: (context) => createReportPdfAiNarrativeWriter(context),
  store: () => (env.REPORT_PDF_STORAGE_ENABLED ? supabaseReportPdfArtifactStore : null),
  audit: appendReportPdfExportAudit,
  // The limiter only logs when it fails open (Redis missing, failing or slow): a warning.
  rateLimit: (actor) => consumeReportPdfExportAllowance(actor, { log: warn }),
  log,
  jobDirectory: defaultReportPdfJobDirectory,
};

type Job = ReportPdfExportStatus & ReportPdfReference & {
  userId: string;
  tenantId: string;
  storageKey: string | null;
  artifact: Buffer | null;
  updatedAtMs: number;
  expiresAtMs: number | null;
  /** Writes of the shared status, one after the other (the last one wins). */
  sharing?: Promise<void>;
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
  /** In-flight synchronous exports per tenant: they render too, so they count as active. */
  private readonly inlineExports = new Map<string, number>();
  private readonly limits: ReportPdfExportLimits;

  constructor(private readonly deps: ReportPdfExportDeps = defaultReportPdfExportDeps) {
    this.limits = { ...defaultReportPdfExportLimits(), ...deps.limits };
  }

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
    // A learner_plus without any group gets all-undefined ids, which would
    // otherwise match a tenant-wide snapshot (e.g. one taken before a demotion).
    if (hasNoAccessibleReportScope(scope)) throw new ReportPdfExportError('Report scope no longer allowed', 403, 'REPORT_PDF_SCOPE_DENIED');
    if (scope.groupId !== stored.snapshot.scope.groupId || scope.subgroupId !== stored.snapshot.scope.subgroupId || scope.teamId !== stored.snapshot.scope.teamId) {
      throw new ReportPdfExportError('Report scope no longer allowed', 403, 'REPORT_PDF_SCOPE_DENIED');
    }
    return { ...stored, snapshotHash: getReportSnapshotHash(stored.snapshot) };
  }

  private storageKey(actor: ReportPdfExportActor, reference: ReportPdfReference, snapshotHash: string, locale: ReportPdfLocale, labels: ReportTenantLabels): string {
    return buildReportPdfStorageKey({
      tenantId: actor.tenantId, ...reference, snapshotHash, locale, templateVersion: REPORT_PDF_TEMPLATE_VERSION, labelsKey: reportTenantLabelsKey(labels),
    });
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
    const [branding, labels] = await Promise.all([this.deps.loadBranding(actor.tenantId), this.deps.loadLabels(actor.tenantId)]);
    const fileName = this.fileNameFor(locale, stored.snapshot, branding.name);
    const store = this.deps.store();
    const storageKey = store ? this.storageKey(actor, reference, stored.snapshotHash, locale, labels) : null;
    if (store && storageKey && await store.exists(storageKey)) return { fileName, storageKey, pdf: null, cached: true };

    input.onPhase?.('narrative');
    const chatNarrative = await this.deps.loadNarrative({ ...reference, userId: actor.userId, tenantId: actor.tenantId });
    const composed = await composeReportPdfDocument({
      snapshot: stored.snapshot,
      snapshotHash: stored.snapshotHash,
      locale,
      tenant: branding,
      labels,
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
        // audit_logs.entity_type is the DB enum audit_entity_type: 'report_pdf' is not a value (the
        // insert failed and blocked every download). The export comes from a chatbot conversation.
        entityType: 'chatbot',
        entityId: reference.assistantMessageId,
        entityName: fileName,
        ipAddress: context.ipAddress,
        event: { code: 'report.pdf.exported', context: { file_name: fileName, file_size_bytes: bytes } },
      });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      this.deps.log({ event: 'report_pdf_audit_failed', request_id: context.requestId, tenant_id: actor.tenantId,
        reason: error instanceof Error ? error.name : 'unknown', ...(typeof code === 'string' ? { db_code: code } : {}) });
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
    this.evictFinished();
  }

  /** Keeps finished jobs within their hard bounds, evicting the oldest finished first. */
  private evictFinished(): void {
    const finished = [...this.jobs.values()]
      .filter((job) => isReportPdfExportTerminal(job.phase))
      .sort((left, right) => (left.expiresAtMs ?? 0) - (right.expiresAtMs ?? 0));
    let count = finished.length;
    let bytes = finished.reduce((sum, job) => sum + (job.artifact?.byteLength ?? 0), 0);
    for (const job of finished) {
      if (count <= this.limits.finishedJobs && bytes <= this.limits.finishedArtifactBytes) break;
      this.jobs.delete(job.id);
      count -= 1;
      bytes -= job.artifact?.byteLength ?? 0;
    }
  }

  private activeCount(tenantId?: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (!isReportPdfExportTerminal(job.phase) && (tenantId === undefined || job.tenantId === tenantId)) count += 1;
    }
    for (const [tenant, inline] of this.inlineExports) {
      if (tenantId === undefined || tenant === tenantId) count += inline;
    }
    return count;
  }

  /** Checked before the rate limiter, so a refused attempt does not consume allowance. */
  private assertCapacity(tenantId: string): void {
    const scope = this.activeCount() >= this.limits.activeJobs ? 'process'
      : this.activeCount(tenantId) >= this.limits.tenantActiveJobs ? 'tenant'
        : null;
    if (!scope) return;
    this.deps.log({ event: 'report_pdf_queue_full', tenant_id: tenantId, scope });
    throw new ReportPdfExportError('Report PDF queue full', 429, 'REPORT_PDF_QUEUE_FULL');
  }

  private ownedJob(actor: ReportPdfExportActor, reference: ReportPdfReference, jobId: string): Job | null {
    this.purge();
    const job = this.jobs.get(jobId.toLowerCase());
    if (!job || job.userId !== actor.userId || job.tenantId !== actor.tenantId
      || job.conversationId !== reference.conversationId || job.assistantMessageId !== reference.assistantMessageId) return null;
    return job;
  }

  private directory(): ReportPdfJobDirectory | null {
    return this.deps.jobDirectory?.() ?? null;
  }

  private logShareFailure(event: string, tenantId: string, error: unknown): void {
    this.deps.log({ event, tenant_id: tenantId, reason: error instanceof Error ? error.message : 'unknown' });
  }

  /** Writes the job's current status (and a PDF kept only in memory) for the other API processes. */
  private async writeShared(job: Job): Promise<void> {
    const directory = this.directory();
    if (!directory) return;
    const terminal = isReportPdfExportTerminal(job.phase);
    let artifactShared = false;
    if (job.phase === 'ready' && job.artifact && !job.storageKey) {
      try {
        await directory.saveArtifact(job.id, job.artifact, TERMINAL_JOB_TTL_MS);
        artifactShared = true;
      } catch (error) {
        this.logShareFailure('report_pdf_artifact_share_failed', job.tenantId, error);
      }
    }
    const shared: SharedReportPdfJob = {
      id: job.id, phase: job.phase, locale: job.locale, fileName: job.fileName, expiresAt: job.expiresAt,
      errorCode: job.errorCode, updatedAt: job.updatedAt, userId: job.userId, tenantId: job.tenantId,
      conversationId: job.conversationId, assistantMessageId: job.assistantMessageId, storageKey: job.storageKey, artifactShared,
    };
    try {
      await directory.save(shared, terminal ? TERMINAL_JOB_TTL_MS : SHARED_ACTIVE_JOB_TTL_MS);
    } catch (error) {
      // The other processes then cannot see the job (as after a restart).
      this.logShareFailure('report_pdf_job_share_failed', job.tenantId, error);
    }
  }

  private share(job: Job): Promise<void> {
    if (!this.directory()) return Promise.resolve();
    job.sharing = (job.sharing ?? Promise.resolve()).then(() => this.writeShared(job));
    return job.sharing;
  }

  /** A job another API process runs or ran, when it belongs to this actor and report. */
  private async sharedJob(actor: ReportPdfExportActor, reference: ReportPdfReference, jobId: string): Promise<SharedReportPdfJob | null> {
    const directory = this.directory();
    if (!directory) return null;
    let job: SharedReportPdfJob | null;
    try {
      job = await directory.load(jobId);
    } catch (error) {
      this.logShareFailure('report_pdf_job_lookup_failed', actor.tenantId, error);
      return null;
    }
    if (!job || job.userId !== actor.userId || job.tenantId !== actor.tenantId
      || job.conversationId !== reference.conversationId || job.assistantMessageId !== reference.assistantMessageId) return null;
    return job;
  }

  private async sharedArtifact(job: SharedReportPdfJob): Promise<Buffer | null> {
    const directory = this.directory();
    if (!directory || !job.artifactShared) return null;
    try {
      return await directory.loadArtifact(job.id);
    } catch (error) {
      this.logShareFailure('report_pdf_artifact_lookup_failed', job.tenantId, error);
      return null;
    }
  }

  private static sharedStatus(job: SharedReportPdfJob): ReportPdfExportStatus {
    return { id: job.id, phase: job.phase, locale: job.locale, fileName: job.fileName, expiresAt: job.expiresAt, errorCode: job.errorCode, updatedAt: job.updatedAt };
  }

  private jobLocale(actor: ReportPdfExportActor, reference: ReportPdfReference, jobId: string): ReportPdfLocale | null {
    return resolveReportPdfJobLocale(jobId, { tenantId: actor.tenantId, userId: actor.userId, ...reference, templateVersion: REPORT_PDF_TEMPLATE_VERSION });
  }

  private async run(job: Job, actor: ReportPdfExportActor): Promise<void> {
    const requestId = randomUUID();
    // While it runs, its shared status is renewed; a crashed process's job disappears.
    const renew = this.directory() ? setInterval(() => { void this.share(job); }, SHARED_ACTIVE_JOB_RENEW_MS) : null;
    renew?.unref();
    try {
      const artifact = await this.buildArtifact({
        actor, reference: job, locale: job.locale, requestId,
        onPhase: (phase) => {
          if (isReportPdfExportTerminal(job.phase)) return;
          ReportPdfExportService.touch(job, { phase });
          void this.share(job);
        },
      });
      ReportPdfExportService.finish(job, { phase: 'ready', fileName: artifact.fileName, storageKey: artifact.storageKey, artifact: artifact.storageKey ? null : artifact.pdf, errorCode: null });
    } catch (error) {
      const normalized = getReportPdfExportError(error);
      ReportPdfExportService.finish(job, { phase: 'failed', artifact: null, errorCode: normalized.code });
      if (normalized.statusCode >= 500) this.deps.log({ event: 'report_pdf_export_failed', request_id: requestId, tenant_id: actor.tenantId, code: normalized.code });
    }
    if (renew) clearInterval(renew);
    await this.share(job);
    this.evictFinished();
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
    // Started (or finished) by another API process: never render it twice.
    const elsewhere = await this.sharedJob(actor, reference, id);
    if (elsewhere && elsewhere.phase !== 'failed') return ReportPdfExportService.sharedStatus(elsewhere);
    this.assertCapacity(actor.tenantId);
    await this.enforceRateLimit(actor);
    // The same job may have been started, or the capacity taken, while the limiter answered.
    const raced = this.jobs.get(id);
    if (raced && raced.phase !== 'failed') return ReportPdfExportService.toStatus(raced);
    this.assertCapacity(actor.tenantId);
    const now = Date.now();
    const job: Job = {
      id, ...reference, userId: actor.userId, tenantId: actor.tenantId, phase: 'validating', locale: input.locale,
      fileName: null, expiresAt: null, errorCode: null, updatedAt: new Date(now).toISOString(), updatedAtMs: now,
      expiresAtMs: null, storageKey: null, artifact: null,
    };
    this.jobs.set(id, job);
    void this.share(job);
    void this.run(job, actor);
    return ReportPdfExportService.toStatus(job);
  }

  async get(input: JobInput & { jobId: string }): Promise<ReportPdfExportStatus> {
    const { actor, reference } = split(input);
    await this.assertPermission(actor);
    const job = this.ownedJob(actor, reference, input.jobId);
    if (job) return ReportPdfExportService.toStatus(job);
    // Running or finished in another API process.
    const elsewhere = await this.sharedJob(actor, reference, input.jobId);
    if (elsewhere) return ReportPdfExportService.sharedStatus(elsewhere);
    // Stateless recovery (restart / other instance): the deterministic job id names the locale.
    const locale = this.jobLocale(actor, reference, input.jobId);
    const store = this.deps.store();
    if (!locale || !store) throw new ReportPdfExportError('Report PDF job not found', 404, 'REPORT_PDF_JOB_NOT_FOUND');
    const stored = await this.loadAuthorizedSnapshot(actor, reference);
    if (!await store.exists(this.storageKey(actor, reference, stored.snapshotHash, locale, await this.deps.loadLabels(actor.tenantId)))) {
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
    // Rendered by another API process: its status, and its PDF when it is not in Storage.
    const elsewhere = job ? null : await this.sharedJob(actor, reference, input.jobId);
    if (elsewhere && elsewhere.phase !== 'ready') throw new ReportPdfExportError('Report PDF not ready', 409, 'REPORT_PDF_NOT_READY');
    const locale = job?.locale ?? elsewhere?.locale ?? this.jobLocale(actor, reference, input.jobId);
    if (!locale) throw new ReportPdfExportError('Report PDF job not found', 404, 'REPORT_PDF_JOB_NOT_FOUND');
    // Access is rechecked immediately before serving the artifact.
    const stored = await this.loadAuthorizedSnapshot(actor, reference);
    let pdf = job?.artifact ?? (elsewhere ? await this.sharedArtifact(elsewhere) : null);
    const store = this.deps.store();
    if (!pdf && store) {
      // The job's own key first: the labels may have changed since it rendered.
      const key = job?.storageKey ?? elsewhere?.storageKey
        ?? this.storageKey(actor, reference, stored.snapshotHash, locale, await this.deps.loadLabels(actor.tenantId));
      if (await store.exists(key)) pdf = await store.get(key);
    }
    if (!pdf) {
      throw job || elsewhere
        ? new ReportPdfExportError('Report PDF not ready', 409, 'REPORT_PDF_NOT_READY')
        : new ReportPdfExportError('Report PDF job not found', 404, 'REPORT_PDF_JOB_NOT_FOUND');
    }
    const fileName = job?.fileName ?? elsewhere?.fileName
      ?? this.fileNameFor(locale, stored.snapshot, (await this.deps.loadBranding(actor.tenantId)).name);
    await this.auditDelivery(actor, reference, fileName, pdf.byteLength, input.audit);
    return { pdf, fileName };
  }

  /** Synchronous variant (POST /report-pdf): render or reuse, audit, return bytes. */
  async exportNow(input: JobInput & { locale: ReportPdfLocale; audit: ReportPdfAuditContext }): Promise<{ pdf: Buffer; fileName: string }> {
    const { actor, reference } = split(input);
    await this.assertPermission(actor);
    this.purge();
    this.assertCapacity(actor.tenantId);
    await this.enforceRateLimit(actor);
    this.assertCapacity(actor.tenantId);
    this.inlineExports.set(actor.tenantId, (this.inlineExports.get(actor.tenantId) ?? 0) + 1);
    try {
      const artifact = await this.buildArtifact({ actor, reference, locale: input.locale, requestId: input.audit.requestId });
      const store = this.deps.store();
      const pdf = artifact.pdf ?? (store && artifact.storageKey ? await store.get(artifact.storageKey) : null);
      if (!pdf) throw new ReportPdfExportError('Report PDF not ready', 409, 'REPORT_PDF_NOT_READY');
      await this.auditDelivery(actor, reference, artifact.fileName, pdf.byteLength, input.audit);
      return { pdf, fileName: artifact.fileName };
    } finally {
      const left = (this.inlineExports.get(actor.tenantId) ?? 1) - 1;
      if (left > 0) this.inlineExports.set(actor.tenantId, left);
      else this.inlineExports.delete(actor.tenantId);
    }
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
