// ═══════════════════════════════════════════════════════════════
// Report PDF jobs seen by every API process
//
// A job runs in the process that started it, but the browser polls its status
// and downloads it through any API process. With several API processes the
// running process writes the job's status to Redis (renewed while it runs, so
// a crashed process's job disappears within a minute, as after a restart),
// and, when the PDF is not in Storage (REPORT_PDF_STORAGE_ENABLED=false or
// the Storage write failed), the PDF itself for the finished-job lifetime.
// With one API process nothing is written (jobDirectory is null).
// ═══════════════════════════════════════════════════════════════

import { cacheKey } from '../../../config/cache.js';
import { processRolePlan } from '../../../config/process-role.js';
import { getRedisClient, withRedisDeadline } from '../../../config/redis.js';
import type { ReportPdfExportPhase } from './report-pdf-export.logic.js';
import type { ReportPdfLocale } from './report-pdf-i18n.js';

/** A PDF of up to MAX_ARTIFACT_BYTES (15 MB) needs longer than one ordinary command. */
const ARTIFACT_DEADLINE_MS = 5_000;

export interface SharedReportPdfJob {
  id: string;
  phase: ReportPdfExportPhase;
  locale: ReportPdfLocale;
  fileName: string | null;
  expiresAt: string | null;
  errorCode: string | null;
  updatedAt: string;
  userId: string;
  tenantId: string;
  conversationId: string;
  assistantMessageId: string;
  storageKey: string | null;
  /** The PDF bytes are in the directory (saveArtifact). */
  artifactShared: boolean;
}

export interface ReportPdfJobDirectory {
  save(job: SharedReportPdfJob, ttlMs: number): Promise<void>;
  load(id: string): Promise<SharedReportPdfJob | null>;
  saveArtifact(id: string, pdf: Buffer, ttlMs: number): Promise<void>;
  loadArtifact(id: string): Promise<Buffer | null>;
}

/** The Redis commands the directory uses (injectable for tests). */
export interface ReportPdfJobRedisClient {
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

const jobKey = (id: string) => cacheKey('report-pdf-job', id.toLowerCase());
const artifactKey = (id: string) => cacheKey('report-pdf-artifact', id.toLowerCase());

export function createRedisReportPdfJobDirectory(options: {
  getClient?: () => ReportPdfJobRedisClient | null;
  deadline?: <T>(label: string, work: Promise<T>, deadlineMs?: number) => Promise<T>;
} = {}): ReportPdfJobDirectory {
  const getClient = options.getClient ?? (() => getRedisClient() as unknown as ReportPdfJobRedisClient | null);
  const deadline = options.deadline ?? (<T>(label: string, work: Promise<T>, deadlineMs?: number) => withRedisDeadline(label, work, deadlineMs));
  const client = () => {
    const current = getClient();
    if (!current) throw new Error('REPORT_PDF_JOB_DIRECTORY_UNAVAILABLE');
    return current;
  };
  return {
    async save(job, ttlMs) {
      await deadline('report pdf job write', client().set(jobKey(job.id), JSON.stringify(job), { PX: Math.max(1, ttlMs) }));
    },
    async load(id) {
      const raw = await deadline('report pdf job read', client().get(jobKey(id)));
      if (!raw) return null;
      try { return JSON.parse(raw) as SharedReportPdfJob; } catch { return null; }
    },
    async saveArtifact(id, pdf, ttlMs) {
      await deadline('report pdf artifact write',
        client().set(artifactKey(id), pdf.toString('base64'), { PX: Math.max(1, ttlMs) }), ARTIFACT_DEADLINE_MS);
    },
    async loadArtifact(id) {
      const raw = await deadline('report pdf artifact read', client().get(artifactKey(id)), ARTIFACT_DEADLINE_MS);
      return raw ? Buffer.from(raw, 'base64') : null;
    },
  };
}

const redisDirectory = createRedisReportPdfJobDirectory();

/** The directory of this process: only when several API processes answer the polls. */
export function defaultReportPdfJobDirectory(): ReportPdfJobDirectory | null {
  return processRolePlan.severalApiInstances ? redisDirectory : null;
}
