import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { SourceDocumentHint } from './lesson-author-source-stream.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHOR_ROLES = new Set(['staff', 'superuser', 'superadmin']);
const HEARTBEAT_MS = 20_000;
const AUTH_LEASE_MS = 60_000;

interface SourceRow extends Record<string, unknown> {
  document_id: string;
  kb_id: string;
  name: string;
  type: string;
  status: 'learning' | 'learned' | 'error';
  source_info: Record<string, unknown> | null;
  updated_at: Date | string;
}

export interface SourceStreamDiagnostic {
  event: 'source_stream_opened' | 'source_stream_closed' | 'source_stream_failed';
  request_id: string;
  document_id: string | null;
  tenant_id: string | null;
  failure_code: string | null;
  duration_ms: number;
  delivered_events: number;
}

function writeEvent(res: Response, event: string, payload: Record<string, unknown>) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Exact-document authenticated SSE. Subscription is installed before the
 * initial read so a worker transition cannot be lost between upload receipt
 * and browser observation. Every wake hint is re-authorized by an exact DB
 * read; the latest-50 source list is never used as readiness authority. */
export function createSourceDocumentStreamHandler(deps: {
  db: GenerationJobSql;
  canRead: (user: AuthUser) => Promise<boolean>;
  subscribe: (documentId: string, listener: (hint: SourceDocumentHint | null) => void) => Promise<() => void>;
  report: (event: SourceStreamDiagnostic) => void;
}) {
  return async (req: Request, res: Response): Promise<void> => {
    const started = performance.now(), requestId = randomUUID();
    const locale = req.query.ui_locale === 'en' ? 'en' : 'vi';
    const user = req.user ? Object.freeze({ ...req.user }) : null;
    const documentId = req.params.documentId;
    let delivered = 0, closed = false, reading = false, pending = false, transportReady = false;
    let unsubscribe: (() => void) | null = null, heartbeat: NodeJS.Timeout | null = null, lease: NodeJS.Timeout | null = null;
    const report = (event: SourceStreamDiagnostic['event'], failure: string | null = null) => {
      try { deps.report({ event, request_id: requestId, document_id: UUID.test(documentId ?? '') ? documentId : null,
        tenant_id: user?.tenantId && UUID.test(user.tenantId) ? user.tenantId : null, failure_code: failure,
        duration_ms: Math.max(0, Math.round(performance.now() - started)), delivered_events: delivered }); } catch { /* logging cannot fail request */ }
    };
    const close = (failure: string | null = null) => {
      if (closed) return; closed = true;
      if (heartbeat) clearInterval(heartbeat); if (lease) clearTimeout(lease);
      heartbeat = null; lease = null; unsubscribe?.(); unsubscribe = null;
      report(failure ? 'source_stream_failed' : 'source_stream_closed', failure);
      if (!res.writableEnded) res.end();
    };
    const reject = (status: number, code: string) => {
      report('source_stream_failed', code);
      res.status(status).json({ success: false, code,
        message: locale === 'en' ? 'The source status stream is unavailable.' : 'Chưa thể theo dõi trạng thái tài liệu.', request_id: requestId });
    };
    if (!user || !user.tenantId || !UUID.test(user.tenantId) || !UUID.test(user.id)
      || !AUTHOR_ROLES.has(user.role) || user.sessionMode !== 'normal') {
      reject(user ? 403 : 401, user ? 'SOURCE_STREAM_FORBIDDEN' : 'AUTH_REQUIRED'); return;
    }
    if (!UUID.test(documentId ?? '') || Object.keys(req.query).some(key => key !== 'ui_locale')
      || (req.query.ui_locale !== undefined && req.query.ui_locale !== 'vi' && req.query.ui_locale !== 'en')) {
      reject(400, 'SOURCE_STREAM_INPUT_INVALID'); return;
    }
    try {
      if (!await deps.canRead(user)) { reject(403, 'SOURCE_STREAM_FORBIDDEN'); return; }
      const read = async (): Promise<SourceRow | null> => {
        const result = await deps.db.query<SourceRow>(
          `SELECT d.id::text AS document_id, d.kb_id::text AS kb_id, d.name, d.type, d.status, d.source_info, d.updated_at
             FROM kb_documents d
             JOIN tenant_kb_assignments a ON a.tenant_id = d.tenant_id AND a.kb_id = d.kb_id AND a.target = 'lesson_author'
            WHERE d.id = $1 AND d.tenant_id = $2 AND d.type = 'file'
              AND d.status IN ('learning', 'learned', 'error')
            LIMIT 1`, [documentId, user.tenantId]);
        return result.rows[0] ?? null;
      };
      const publish = async () => {
        if (closed) return;
        if (!transportReady || reading) { pending = true; return; }
        reading = true;
        try {
          const row = await read();
          if (!row) { close('SOURCE_DOCUMENT_NOT_FOUND'); return; }
          delivered++;
          writeEvent(res, 'source_status', { delivery_contract_version: 1, document_id: row.document_id, kb_id: row.kb_id,
            name: row.name, type: row.type, status: row.status, source_info: row.source_info,
            updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at });
          if (row.status === 'learned' || row.status === 'error') close();
        } finally {
          reading = false;
          if (pending && !closed) { pending = false; void publish().catch(() => close('SOURCE_STREAM_READ_FAILED')); }
        }
      };
      unsubscribe = await deps.subscribe(documentId, hint => {
        if (!hint) { close('SOURCE_STREAM_UNAVAILABLE'); return; }
        if (hint.documentId.toLowerCase() === documentId.toLowerCase() && hint.tenantId.toLowerCase() === user.tenantId!.toLowerCase()) {
          void publish().catch(() => close('SOURCE_STREAM_READ_FAILED'));
        }
      });
      const initial = await read();
      if (!initial) { unsubscribe(); unsubscribe = null; reject(404, 'SOURCE_DOCUMENT_NOT_FOUND'); return; }
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Request-ID', requestId);
      res.flushHeaders();
      delivered++;
      writeEvent(res, 'source_status', { delivery_contract_version: 1, document_id: initial.document_id, kb_id: initial.kb_id,
        name: initial.name, type: initial.type, status: initial.status, source_info: initial.source_info,
        updated_at: initial.updated_at instanceof Date ? initial.updated_at.toISOString() : initial.updated_at });
      if (initial.status === 'learned' || initial.status === 'error') { close(); return; }
      transportReady = true;
      if (pending) { pending = false; void publish().catch(() => close('SOURCE_STREAM_READ_FAILED')); }
      heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, HEARTBEAT_MS);
      lease = setTimeout(() => { if (!res.writableEnded) writeEvent(res, 'auth_expiring', { delivery_contract_version: 1, document_id: documentId }); close(); }, AUTH_LEASE_MS);
      heartbeat.unref(); lease.unref(); req.on('close', () => close()); report('source_stream_opened');
    } catch {
      if (!res.headersSent) reject(503, 'SOURCE_STREAM_UNAVAILABLE'); else close('SOURCE_STREAM_UNAVAILABLE');
    }
  };
}
