import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createWorkspaceReadRepository, WorkspaceReadError } from './lesson-author-workspace-read.repository.js';
import { WorkspaceContractError } from './lesson-author-workspace.logic.js';
import type { WorkspaceCommitHint } from './lesson-author-workspace-stream.service.js';
import { env } from '../../config/env.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHOR_ROLES = new Set(['staff', 'superuser', 'superadmin']);
const HEARTBEAT_MS = 20_000;
type Locale = 'vi' | 'en';

export interface WorkspaceStreamDiagnostic {
  event: 'workspace_stream_opened' | 'workspace_stream_closed' | 'workspace_stream_failed';
  request_id: string; correlation_id: string | null; workspace_id: string | null; conversation_id: string | null;
  course_id_hash: string | null; failure_stage: 'workspace_stream_auth' | 'workspace_stream_input' | 'workspace_stream_repository' | 'workspace_stream_transport' | null;
  internal_failure_code: string | null; external_failure_code: string | null; duration_ms: number; delivered_events: number;
}

function numberQuery(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : null;
}
function message(res: Response, event: string, payload: Record<string, unknown>, id?: string) {
  if (id) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Authenticated, metadata-only SSE. Initial/reconnect state is still read via
 * the existing exact-owner repository; writes and provider calls are impossible
 * from this controller. The short lease deliberately forces a fresh HTTP auth
 * boundary instead of treating a long-lived socket as perpetual authority. */
export function createWorkspaceStreamHandler(deps: {
  enabled: () => boolean;
  db: GenerationJobSql;
  canRead: (user: AuthUser) => Promise<boolean>;
  subscribe: (workspaceId: string, listener: (hint: WorkspaceCommitHint | null) => void) => Promise<() => void>;
  report: (event: WorkspaceStreamDiagnostic) => void;
}) {
  return async (req: Request, res: Response): Promise<void> => {
    const started = performance.now(), requestId = randomUUID();
    const locale: Locale = req.query.ui_locale === 'en' ? 'en' : 'vi';
    const { workspaceId, conversationId, courseId } = req.params;
    let correlationId: string | null = null, delivered = 0;
    let stage: WorkspaceStreamDiagnostic['failure_stage'] = 'workspace_stream_auth';
    let unsubscribe: (() => void) | null = null, heartbeat: NodeJS.Timeout | null = null, lease: NodeJS.Timeout | null = null, closed = false;
    const summary = (event: WorkspaceStreamDiagnostic['event'], internal: string | null = null, external: string | null = null) => {
      try { deps.report({ event, request_id: requestId, correlation_id: correlationId,
        workspace_id: UUID.test(workspaceId ?? '') ? workspaceId : null, conversation_id: UUID.test(conversationId ?? '') ? conversationId : null,
        course_id_hash: typeof courseId === 'string' && courseId.length <= 255 ? createHash('sha256').update(courseId).digest('hex') : null,
        failure_stage: external ? stage : null, internal_failure_code: internal, external_failure_code: external,
        duration_ms: Math.max(0, Math.round(performance.now() - started)), delivered_events: delivered }); } catch { /* log safe metadata only */ }
    };
    const close = (reason: string | null = null) => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat); if (lease) clearTimeout(lease); heartbeat = null; lease = null;
      unsubscribe?.(); unsubscribe = null;
      summary(reason ? 'workspace_stream_failed' : 'workspace_stream_closed', reason, reason ? 'WORKSPACE_STREAM_UNAVAILABLE' : null);
      if (!res.writableEnded) res.end();
    };
    const reject = (status: number, code: string) => {
      const text = locale === 'en' ? 'The workspace stream is unavailable.' : 'Chưa thể kết nối luồng cập nhật bản thảo.';
      summary('workspace_stream_failed', code, code);
      res.status(status).json({ success: false, code, message: text, request_id: requestId });
    };
    const user = req.user ? Object.freeze({ ...req.user }) : null;
    if (!user || !user.tenantId || !UUID.test(user.tenantId) || !UUID.test(user.id) || !AUTHOR_ROLES.has(user.role) || user.sessionMode !== 'normal') {
      reject(user ? 403 : 401, user ? 'WORKSPACE_READ_FORBIDDEN' : 'AUTH_REQUIRED'); return;
    }
    stage = 'workspace_stream_input';
    const after = numberQuery(req.query.after_sequence ?? '0');
    if (!deps.enabled() || !UUID.test(workspaceId ?? '') || !UUID.test(conversationId ?? '') || typeof courseId !== 'string' || !courseId.trim()
      || courseId.length > 255 || /[\x00-\x1f\x7f]/.test(courseId) || after === null
      || Object.keys(req.query).some(key => key !== 'ui_locale' && key !== 'after_sequence')
      || (req.query.ui_locale !== undefined && req.query.ui_locale !== 'vi' && req.query.ui_locale !== 'en')) {
      reject(deps.enabled() ? 400 : 503, deps.enabled() ? 'WORKSPACE_READ_INPUT_INVALID' : 'WORKSPACE_READ_DISABLED'); return;
    }
    try {
      stage = 'workspace_stream_repository';
      if (!await deps.canRead(user)) { reject(403, 'WORKSPACE_READ_FORBIDDEN'); return; }
      const owner = { tenantId: user.tenantId, userId: user.id, conversationId, courseId };
      const repository = createWorkspaceReadRepository({ db: deps.db, canRead: () => deps.canRead(user) });
      const buffered: WorkspaceCommitHint[] = [];
      let liveWrite: ((hint: WorkspaceCommitHint) => void) | null = null;
      unsubscribe = await deps.subscribe(workspaceId, hint => {
        if (!hint) { close('WORKSPACE_STREAM_UNAVAILABLE'); return; }
        if (liveWrite) liveWrite(hint); else buffered.push(hint);
      });
      const status = await repository.status(owner, workspaceId);
      correlationId = status.correlation_id;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Request-ID', requestId);
      res.flushHeaders();
      const writeHint = (hint: WorkspaceCommitHint) => {
        if (hint.workspaceId.toLowerCase() !== workspaceId!.toLowerCase() || res.writableEnded) return;
        delivered++; const okay = res.write(`id: ${workspaceId}:${hint.sequence}\nevent: workspace_event\ndata: ${JSON.stringify({ delivery_contract_version: 1, workspace_id: workspaceId, correlation_id: correlationId, sequence: hint.sequence })}\n\n`);
        if (!okay) close('WORKSPACE_STREAM_SLOW_CONSUMER');
      };
      message(res, 'stream_ready', { delivery_contract_version: 1, workspace_id: workspaceId, correlation_id: correlationId, head: status.last_event_sequence });
      if (after! > status.last_event_sequence) message(res, 'resync_required', { delivery_contract_version: 1, workspace_id: workspaceId, head: status.last_event_sequence });
      liveWrite = writeHint;
      for (const hint of buffered.splice(0).sort((a, b) => a.sequence - b.sequence)) writeHint(hint);
      // The listener was installed before the status read. It now appends only
      // scalar committed hints; the browser replays the durable ledger.
      heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, HEARTBEAT_MS);
      lease = setTimeout(() => { if (!res.writableEnded) message(res, 'auth_expiring', { delivery_contract_version: 1, workspace_id: workspaceId }); close(); }, env.LESSON_AUTHOR_WORKSPACE_STREAM_AUTH_LEASE_MS);
      heartbeat.unref(); lease.unref();
      req.on('close', () => close());
      summary('workspace_stream_opened');
    } catch (error) {
      const code = error instanceof WorkspaceReadError || error instanceof WorkspaceContractError ? error.code : 'WORKSPACE_STREAM_UNAVAILABLE';
      if (!res.headersSent) reject(code === 'WORKSPACE_NOT_FOUND' ? 404 : code === 'WORKSPACE_READ_FORBIDDEN' ? 403 : 503, code);
      else close(code);
    }
  };
}
