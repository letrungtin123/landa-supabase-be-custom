import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createWorkspaceEditRepository, WorkspaceEditError, type WorkspaceEditAcceptance, type WorkspaceEditContext } from './lesson-author-workspace-edit.repository.js';
import { createWorkspaceAuthority } from './lesson-author-workspace-authority.repository.js';
import { WorkspaceComponentError } from './lesson-author-workspace-component.logic.js';
import { WorkspaceContractError, WORKSPACE_CONTENT_MAX_BYTES, type WorkspaceRevisionCandidate } from './lesson-author-workspace.logic.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERRORS = {
  AUTH_REQUIRED: [401, 'Chưa xác thực.', 'Authentication is required.'],
  WORKSPACE_EDIT_FORBIDDEN: [403, 'Bạn không có quyền sửa bản thảo này.', 'You do not have permission to edit this draft.'],
  WORKSPACE_EDIT_DISABLED: [503, 'Chỉnh sửa bản thảo chưa được bật.', 'Draft editing is not enabled.'],
  WORKSPACE_EDIT_INPUT_INVALID: [400, 'Thông tin chỉnh sửa không hợp lệ.', 'The edit request is invalid.'],
  WORKSPACE_EDIT_NOT_FOUND: [404, 'Không tìm thấy mục nội dung.', 'The content node was not found.'],
  WORKSPACE_REVISION_CONFLICT: [409, 'Nội dung đã thay đổi. Vui lòng tải lại mục này.', 'The content has changed. Please reload this node.'],
  WORKSPACE_EDIT_IDEMPOTENCY_CONFLICT: [409, 'Mã thao tác đã được dùng cho một chỉnh sửa khác.', 'This operation ID was used for a different edit.'],
  WORKSPACE_NODE_NOT_READY: [409, 'Nội dung mục này chưa sẵn sàng để sửa.', 'This node is not ready for editing.'],
  WORKSPACE_EDIT_STATE_INVALID: [409, 'Bản thảo không còn ở trạng thái cho phép chỉnh sửa.', 'This draft no longer allows editing.'],
  WORKSPACE_SOURCE_CHANGED: [409, 'Tài liệu nguồn đã thay đổi hoặc không còn sẵn sàng. Bản sửa chưa được lưu.', 'The source changed or is no longer ready. The edit was not saved.'],
  WORKSPACE_EDIT_VALIDATION_REQUIRED: [422, 'Bản sửa chưa đáp ứng kiểm tra nội dung. Chưa lưu thay đổi.', 'The edit did not pass content validation. No changes were saved.'],
  WORKSPACE_EDIT_UNAVAILABLE: [503, 'Chưa thể xác nhận lưu bản sửa. Hãy tải lại trạng thái trước khi thử lại.', 'The save could not be confirmed. Reload the state before trying again.'],
} as const;
type ExternalCode = keyof typeof ERRORS;
export interface WorkspaceEditDiagnostic {
  event: 'workspace_edit_completed' | 'workspace_edit_failed';
  operation: 'save' | 'reset';
  failure_stage: 'workspace_edit_auth' | 'workspace_edit_input' | 'workspace_edit_gate' | 'workspace_edit_transaction' | null;
  internal_failure_code: string | null;
  external_failure_code: ExternalCode | null;
  correlation_id: string | null;
  request_id: string;
  operation_id: string | null;
  expected_revision: number | null;
  content_revision: number | null;
  event_sequence: number | null;
  replayed: boolean | null;
  workspace_id: string | null;
  conversation_id: string | null;
  node_id: string | null;
  course_id_hash: string | null;
  http_status: number;
  duration_ms: number;
}
interface Dependencies {
  enabled: () => boolean;
  db: GenerationJobDatabase;
  /** Required production materializer/gates, NOT supplied by this HTTP layer.
   * Must use tx and canonical persisted context; never trust a browser receipt. */
  validate: (tx: GenerationJobSql, context: WorkspaceEditContext, candidate: WorkspaceRevisionCandidate,
    allowed: ReadonlySet<CourseComponentType>) => Promise<WorkspaceEditAcceptance>;
  report: (record: WorkspaceEditDiagnostic) => void;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Save/Reset handler factory. Runtime routes have a separate default-off gate
 * and existing authenticate/tenantContext; this boundary cannot perform Apply. */
export function createWorkspaceEditHandlers(deps: Dependencies) {
  function handler(operation: 'save' | 'reset') {
    return async (req: Request, res: Response): Promise<void> => {
      const started = performance.now(), requestId = randomUUID();
      const locale = req.query.ui_locale === 'en' ? 'en' : 'vi';
      let correlationId: string | null = null;
      let committed: { revision: number; event_sequence: number; replayed: boolean } | null = null;
      let stage: WorkspaceEditDiagnostic['failure_stage'] = 'workspace_edit_auth';
      const { workspaceId, conversationId, courseId, nodeId } = req.params;
      const body: unknown = req.body;
      const operationId = object(body) && typeof body.operation_id === 'string' && UUID.test(body.operation_id) ? body.operation_id : null;
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Request-ID', requestId);
      const report = (status: number, internal: string | null, external: ExternalCode | null) => {
        try {
          deps.report({ event: external ? 'workspace_edit_failed' : 'workspace_edit_completed', operation,
            failure_stage: external ? stage : null, internal_failure_code: internal, external_failure_code: external,
            correlation_id: correlationId, request_id: requestId, operation_id: operationId,
            expected_revision: object(body) && typeof body.expected_revision === 'number' && Number.isSafeInteger(body.expected_revision) && body.expected_revision >= 0 ? body.expected_revision : null,
            content_revision: committed?.revision ?? null, event_sequence: committed?.event_sequence ?? null, replayed: committed?.replayed ?? null,
            workspace_id: UUID.test(workspaceId ?? '') ? workspaceId : null,
            conversation_id: UUID.test(conversationId ?? '') ? conversationId : null,
            node_id: UUID.test(nodeId ?? '') ? nodeId : null,
            course_id_hash: typeof courseId === 'string' && courseId.length <= 255 ? createHash('sha256').update(courseId).digest('hex') : null,
            http_status: status, duration_ms: Math.max(0, Math.round(performance.now() - started)) });
        } catch { /* Logging failures must not trigger an ambiguous retry after commit. */ }
      };
      const reject = (external: ExternalCode, internal: string = external) => {
        const [status, vi, en] = ERRORS[external]; report(status, internal, external);
        res.status(status).json({ success: false, code: external, message: locale === 'en' ? en : vi, request_id: requestId });
      };
      const user = req.user ? Object.freeze({ ...req.user }) : null;
      if (!user) { reject('AUTH_REQUIRED'); return; }
      if (!user.tenantId || !UUID.test(user.tenantId) || !UUID.test(user.id) || !['staff', 'superuser', 'superadmin'].includes(user.role)
        || user.sessionMode !== 'normal') { reject('WORKSPACE_EDIT_FORBIDDEN'); return; }
      stage = 'workspace_edit_input';
      if (!UUID.test(workspaceId ?? '') || !UUID.test(conversationId ?? '') || !UUID.test(nodeId ?? '')
        || typeof courseId !== 'string' || !courseId.trim() || courseId.length > 255 || /[\x00-\x1f\x7f]/.test(courseId)
        || Object.keys(req.query).some(k => k !== 'ui_locale')
        || (req.query.ui_locale !== undefined && !['vi', 'en'].includes(String(req.query.ui_locale)))
        || (req.query.ui_locale !== undefined && typeof req.query.ui_locale !== 'string')
        || !object(body) || !operationId || !Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 0
        || Object.keys(body).some(k => !['operation_id', 'expected_revision', ...(operation === 'save' ? ['changes'] : [])].includes(k))
        || (operation === 'save' && (!object(body.changes) || !Object.keys(body.changes).length
          || Object.keys(body.changes).some(k => !['title', 'purpose', 'data', 'implementation_notes'].includes(k))))) {
        reject('WORKSPACE_EDIT_INPUT_INVALID'); return;
      }
      try {
        if (Buffer.byteLength(JSON.stringify(body), 'utf8') > WORKSPACE_CONTENT_MAX_BYTES + 1024) { reject('WORKSPACE_EDIT_INPUT_INVALID'); return; }
        stage = 'workspace_edit_gate';
        if (!deps.enabled()) { reject('WORKSPACE_EDIT_DISABLED'); return; }
        stage = 'workspace_edit_transaction';
        const authority = createWorkspaceAuthority(user);
        const repository = createWorkspaceEditRepository({ db: deps.db, canEdit: authority.canEdit, currentSourceHash: authority.currentSourceHash,
          onAuthorizedCorrelation: id => { correlationId = id; },
          validate: async (tx, context, candidate) => deps.validate(tx, context, candidate, await authority.allowedComponents(tx, context.target)) });
        const target = { tenantId: user.tenantId, userId: user.id, workspaceId, conversationId, courseId, nodeId, operationId };
        const receipt = operation === 'save'
          ? await repository.save(target, { expected_revision: body.expected_revision, changes: body.changes })
          : await repository.reset(target, body.expected_revision);
        correlationId = receipt.correlation_id; committed = receipt; report(200, null, null);
        res.status(200).json({ success: true, data: receipt, request_id: requestId });
      } catch (error) {
        const internal = error instanceof WorkspaceEditError || error instanceof WorkspaceContractError || error instanceof WorkspaceComponentError
          ? error.code : 'WORKSPACE_EDIT_UNAVAILABLE';
        const external = Object.hasOwn(ERRORS, internal) ? internal as ExternalCode
          : error instanceof WorkspaceComponentError || ['WORKSPACE_CONTENT_INVALID', 'WORKSPACE_NODE_FIELD_PROTECTED'].includes(internal)
            ? 'WORKSPACE_EDIT_VALIDATION_REQUIRED' : 'WORKSPACE_EDIT_UNAVAILABLE';
        reject(external, internal);
      }
    };
  }
  return { save: handler('save'), reset: handler('reset') };
}
