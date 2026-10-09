import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createWorkspaceReadRepository, WorkspaceReadError } from './lesson-author-workspace-read.repository.js';
import { WorkspaceContractError } from './lesson-author-workspace.logic.js';

type ReadKind = 'status' | 'events' | 'detail' | 'graph';
type Locale = 'vi' | 'en';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHOR_ROLES = new Set(['staff', 'superuser', 'superadmin']);
const ERRORS = {
  AUTH_REQUIRED: [401, 'Chưa xác thực.', 'Authentication is required.'],
  WORKSPACE_READ_FORBIDDEN: [403, 'Bạn không có quyền xem bản thảo này.', 'You do not have permission to view this draft.'],
  WORKSPACE_READ_DISABLED: [503, 'Không gian bản thảo chưa được bật.', 'The draft workspace is not enabled.'],
  WORKSPACE_READ_INPUT_INVALID: [400, 'Thông tin yêu cầu không hợp lệ.', 'The request parameters are invalid.'],
  WORKSPACE_NOT_FOUND: [404, 'Không tìm thấy bản thảo.', 'The draft was not found.'],
  WORKSPACE_NODE_NOT_FOUND: [404, 'Không tìm thấy mục nội dung.', 'The content node was not found.'],
  WORKSPACE_REVISION_CONFLICT: [409, 'Nội dung đã thay đổi. Vui lòng tải lại mục này.', 'The content has changed. Please reload this node.'],
  WORKSPACE_EVENT_RESNAPSHOT_REQUIRED: [409, 'Cần tải lại trạng thái bản thảo.', 'Please reload the draft snapshot.'],
  WORKSPACE_READ_CONTRACT_INVALID: [500, 'Dữ liệu bản thiết kế khoá học không hợp lệ.', 'The course design response is invalid.'],
  WORKSPACE_READ_UNAVAILABLE: [503, 'Chưa thể đọc bản thảo. Vui lòng thử lại sau.', 'The draft is temporarily unavailable. Please try again later.'],
} as const;
type ExternalCode = keyof typeof ERRORS;

export interface WorkspaceReadDiagnostic {
  event: 'workspace_read_completed' | 'workspace_read_failed';
  failure_stage: 'workspace_read_auth' | 'workspace_read_input' | 'workspace_read_gate' | 'workspace_read_repository' | null;
  internal_failure_code: string | null;
  external_failure_code: ExternalCode | null;
  request_id: string;
  correlation_id: string | null;
  workspace_id: string | null;
  conversation_id: string | null;
  course_id_hash: string | null;
  node_id: string | null;
  operation: ReadKind;
  http_status: number;
  duration_ms: number;
}

interface Dependencies {
  enabled: () => boolean;
  db: GenerationJobSql;
  canRead: (user: AuthUser) => Promise<boolean>;
  /** Shared sessions: creator of the tenant/course session, so any course
   * editor (canRead) reads it read-only. Absent = caller-owned reads only. */
  resolveSessionOwner?: (input: { tenantId: string; courseId: string; conversationId: string }) => Promise<string | null>;
  report: (event: WorkspaceReadDiagnostic) => void;
}

function uint(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

/** Authenticated READS only. Poll/reconnect cannot generate, save, Reset or Apply.
 * The router must install authenticate + tenantContext before these handlers.
 * ui_locale affects safe messages only; content_locale is always the stored value.
 */
export function createWorkspaceReadHandlers(deps: Dependencies) {
  function handler(operation: ReadKind) {
    return async (req: Request, res: Response): Promise<void> => {
      const started = performance.now();
      const requestId = randomUUID();
      const locale: Locale = req.query.ui_locale === 'en' ? 'en' : 'vi';
      const { workspaceId, conversationId, courseId, nodeId } = req.params;
      let correlationId: string | null = null;
      let stage: WorkspaceReadDiagnostic['failure_stage'] = 'workspace_read_auth';
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Request-ID', requestId);
      const report = (status: number, internal: string | null, external: ExternalCode | null) => {
        try {
          deps.report({ event: external ? 'workspace_read_failed' : 'workspace_read_completed',
            failure_stage: external ? stage : null, internal_failure_code: internal, external_failure_code: external,
            request_id: requestId, correlation_id: correlationId,
            workspace_id: UUID.test(workspaceId ?? '') ? workspaceId : null,
            conversation_id: UUID.test(conversationId ?? '') ? conversationId : null,
            course_id_hash: typeof courseId === 'string' && courseId.length <= 255
              ? createHash('sha256').update(courseId).digest('hex') : null,
            node_id: UUID.test(nodeId ?? '') ? nodeId : null,
            operation, http_status: status, duration_ms: Math.max(0, Math.round(performance.now() - started)) });
        } catch { /* Logging must never convert an accepted read into failure/retry. */ }
      };
      const reject = (code: ExternalCode, internal: string = code) => {
        const [status, vi, en] = ERRORS[code];
        report(status, internal, code);
        res.status(status).json({ success: false, code, message: locale === 'en' ? en : vi, request_id: requestId });
      };
      const user = req.user ? Object.freeze({ ...req.user }) : null;
      if (!user) { reject('AUTH_REQUIRED'); return; }
      if (!user.tenantId || !UUID.test(user.tenantId) || !UUID.test(user.id)
        || !AUTHOR_ROLES.has(user.role) || user.sessionMode !== 'normal') {
        reject('WORKSPACE_READ_FORBIDDEN'); return;
      }
      stage = 'workspace_read_input';
      const allowedQuery = new Set(['ui_locale', ...(operation === 'events' ? ['after_sequence'] : []),
        ...(operation === 'graph' ? ['snapshot_sequence', 'after_node_id'] : []),
        ...(operation === 'detail' ? ['expected_revision'] : [])]);
      const after = operation === 'events' ? uint(req.query.after_sequence) : undefined;
      const revision = operation === 'detail' ? (req.query.expected_revision === 'none' ? null : uint(req.query.expected_revision)) : undefined;
      const snapshot = req.query.snapshot_sequence === undefined ? undefined : uint(req.query.snapshot_sequence);
      const afterNode = req.query.after_node_id;
      if (!UUID.test(workspaceId ?? '') || !UUID.test(conversationId ?? '')
        || typeof courseId !== 'string' || !courseId.trim() || courseId.length > 255 || /[\x00-\x1f\x7f]/.test(courseId)
        || (operation === 'detail' && (!UUID.test(nodeId ?? '') || revision === undefined))
        || (operation === 'events' && after === undefined)
        || (operation === 'graph' && ((req.query.snapshot_sequence !== undefined && snapshot === undefined)
          || (afterNode !== undefined && (typeof afterNode !== 'string' || !UUID.test(afterNode) || snapshot === undefined))))
        || Object.keys(req.query).some(key => !allowedQuery.has(key))
        || (req.query.ui_locale !== undefined && req.query.ui_locale !== 'vi' && req.query.ui_locale !== 'en')) {
        reject('WORKSPACE_READ_INPUT_INVALID'); return;
      }
      try {
        stage = 'workspace_read_gate';
        if (!deps.enabled()) { reject('WORKSPACE_READ_DISABLED'); return; }
        stage = 'workspace_read_repository';
        const creatorId = deps.resolveSessionOwner
          ? await deps.resolveSessionOwner({ tenantId: user.tenantId, courseId, conversationId }) : null;
        const owner = { tenantId: user.tenantId, userId: creatorId ?? user.id, conversationId, courseId };
        // Closure binds the authenticated principal to this request only. The
        // repository checks permission on each operation and exact ownership in SQL.
        const repository = createWorkspaceReadRepository({ db: deps.db, canRead: () => deps.canRead(user) });
        const data = operation === 'status' ? await repository.status(owner, workspaceId)
          : operation === 'events' ? await repository.events(owner, workspaceId, after!)
            : operation === 'graph' ? await repository.graph(owner, workspaceId,
              { snapshot_sequence: snapshot, after_node_id: afterNode as string | undefined })
            : await repository.detail(owner, workspaceId, nodeId, revision!);
        correlationId = data.correlation_id;
        report(200, null, null);
        res.status(200).json({ success: true, data, request_id: requestId });
      } catch (error) {
        const internal = error instanceof WorkspaceReadError || error instanceof WorkspaceContractError
          ? error.code : 'WORKSPACE_READ_UNAVAILABLE';
        const external: ExternalCode = Object.hasOwn(ERRORS, internal)
          ? internal as ExternalCode : 'WORKSPACE_READ_UNAVAILABLE';
        reject(external, internal);
      }
    };
  }
  return { status: handler('status'), events: handler('events'), detail: handler('detail'), graph: handler('graph') };
}
