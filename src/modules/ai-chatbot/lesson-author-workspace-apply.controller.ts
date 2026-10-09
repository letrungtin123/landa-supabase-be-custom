import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import { WorkspaceApplyConflictError, type WorkspaceApplyConflictDetails } from './lesson-author-workspace-apply-conflict.logic.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const roles = new Set(['staff', 'superuser', 'superadmin']);
/** [HTTP status, Vietnamese, English]. Codes stay machine-only; messages are for people. */
export const WORKSPACE_APPLY_ERRORS = {
  AUTH_REQUIRED: [401, 'Chưa xác thực.', 'Authentication is required.'],
  WORKSPACE_APPLY_FORBIDDEN: [403, 'Bạn không có quyền áp dụng bản thảo này.', 'You do not have permission to apply this draft.'],
  WORKSPACE_APPLY_DISABLED: [503, 'Áp dụng bản thảo chưa được bật.', 'Draft Apply is not enabled.'],
  WORKSPACE_APPLY_INPUT_INVALID: [400, 'Thông tin áp dụng không hợp lệ.', 'The Apply request is invalid.'],
  WORKSPACE_APPLY_NOT_READY: [409, 'Phạm vi này chưa sẵn sàng để áp dụng.', 'This scope is not ready to apply.'],
  WORKSPACE_APPLY_CONFLICT: [409, 'Bản thảo hoặc khóa học đã thay đổi. Vui lòng tải lại.', 'The draft or course changed. Please reload.'],
  WORKSPACE_APPLY_VALIDATION_FAILED: [422, 'Nội dung chưa đạt kiểm tra trước khi áp dụng.', 'The content did not pass Apply validation.'],
  WORKSPACE_APPLY_UNAVAILABLE: [503, 'Chưa thể xác nhận áp dụng bản thảo. Hãy tải lại trước khi thử lại.', 'The Apply operation could not be confirmed. Reload before trying again.'],
  WORKSPACE_APPLY_COURSE_BUSY: [409, 'Có người khác đang đưa nội dung vào khoá học này. Vui lòng thử lại sau ít phút.',
    'Someone else is adding content to this course right now. Please try again in a few minutes.'],
  WORKSPACE_APPLY_COURSE_EDITED: [409, 'Khoá học đã được chỉnh sửa sau khi trợ lý AI soạn nội dung. Bạn có muốn thay các phần này bằng nội dung mới không?',
    'The course was edited after the AI assistant drafted this content. Do you want to replace these parts with the new content?'],
  WORKSPACE_APPLY_COURSE_STRUCTURE_CHANGED: [409, 'Một số phần của khoá học đã bị xoá hoặc chuyển chỗ sau lần đưa nội dung trước, nên không thể đưa nội dung mới vào đúng vị trí. Hãy tạo một bản thiết kế mới cho các phần này.',
    'Some parts of the course were deleted or moved after content was last added, so the new content cannot be put in the right place. Create a new course design for these parts.'],
} as const satisfies Record<string, readonly [number, string, string]>;
type External = keyof typeof WORKSPACE_APPLY_ERRORS;
type ApplyTarget = { tenantId: string; userId: string; courseId: string; conversationId: string; workspaceId: string; nodeId: string; operationId: string; };
export type WorkspaceApplyReceipt = { receipt_id: string; workspace_id: string; node_id: string; correlation_id: string; revision_set_hash: string; created_block_count: number; updated_block_count: number; replayed: boolean; };

/** HTTP has no authority to supply blocks, validation or source facts.  It only
 * transports a UUID idempotency key, a workspace CAS revision and, after the
 * author confirmed a listed overwrite, the server-issued confirmation token to
 * the transaction-owned repository. */
export function createWorkspaceApplyHandler(deps: {
  enabled: () => boolean;
  apply: (user: AuthUser, target: ApplyTarget, expectedWorkspaceRevision: number,
    options: { overwriteConfirmation: string | null }) => Promise<WorkspaceApplyReceipt>;
  report: (event: Record<string, unknown>) => void;
}) {
  return async (req: Request, res: Response): Promise<void> => {
    const started = performance.now(), requestId = randomUUID(), locale = req.query.ui_locale === 'en' ? 'en' : 'vi';
    const user = req.user, { courseId, conversationId, workspaceId, nodeId } = req.params;
    const body = req.body as Record<string, unknown> | null;
    const operationId = body && typeof body.operation_id === 'string' ? body.operation_id : null;
    const fail = (external: External, internal: string = external, conflict?: WorkspaceApplyConflictDetails) => {
      const [status, vi, en] = WORKSPACE_APPLY_ERRORS[external];
      try { deps.report({ event: 'workspace_apply_failed', request_id: requestId, correlation_id: null,
        workspace_id: UUID.test(workspaceId ?? '') ? workspaceId : null, node_id: UUID.test(nodeId ?? '') ? nodeId : null,
        course_id_hash: typeof courseId === 'string' ? createHash('sha256').update(courseId).digest('hex') : null,
        operation_id: operationId, failure_stage: 'workspace_apply', internal_failure_code: internal,
        external_failure_code: external, http_status: status, conflict_count: conflict?.total ?? null,
        duration_ms: Math.round(performance.now() - started) }); } catch { /* telemetry never changes commit semantics */ }
      res.status(status).json({ success: false, code: external, message: locale === 'en' ? en : vi, request_id: requestId,
        ...(conflict ? { conflict } : {}) });
    };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Request-ID', requestId);
    if (!user) { fail('AUTH_REQUIRED'); return; }
    if (!user.tenantId || !roles.has(user.role) || user.sessionMode !== 'normal' || !UUID.test(user.id) || !UUID.test(user.tenantId)) { fail('WORKSPACE_APPLY_FORBIDDEN'); return; }
    if (!deps.enabled()) { fail('WORKSPACE_APPLY_DISABLED'); return; }
    if (!UUID.test(conversationId ?? '') || !UUID.test(workspaceId ?? '') || !UUID.test(nodeId ?? '') || !operationId || !UUID.test(operationId)
      || !courseId || courseId.length > 255 || /[\x00-\x1f\x7f]/.test(courseId)
      || Object.keys(req.query).some(key => key !== 'ui_locale') || !body
      || Object.keys(body).some(key => !['operation_id', 'expected_workspace_revision', 'overwrite_confirmation'].includes(key))
      || body.overwrite_confirmation !== undefined && (typeof body.overwrite_confirmation !== 'string' || !HASH.test(body.overwrite_confirmation))
      || !Number.isSafeInteger(body.expected_workspace_revision) || Number(body.expected_workspace_revision) < 0) { fail('WORKSPACE_APPLY_INPUT_INVALID'); return; }
    try {
      const receipt = await deps.apply(user, { tenantId: user.tenantId, userId: user.id, courseId, conversationId, workspaceId, nodeId, operationId },
        Number(body.expected_workspace_revision), { overwriteConfirmation: typeof body.overwrite_confirmation === 'string' ? body.overwrite_confirmation : null });
      try { deps.report({ event: 'workspace_apply_completed', request_id: requestId, correlation_id: receipt.correlation_id,
        workspace_id: receipt.workspace_id, node_id: receipt.node_id, operation_id: operationId, receipt_id: receipt.receipt_id,
        created_block_count: receipt.created_block_count, updated_block_count: receipt.updated_block_count, replayed: receipt.replayed,
        http_status: 200, duration_ms: Math.round(performance.now() - started) }); } catch { /* no ambiguous retry after a commit */ }
      res.status(200).json({ success: true, data: receipt, request_id: requestId });
    } catch (error) {
      if (error instanceof WorkspaceApplyConflictError) { fail(error.code, error.code, error.details); return; }
      const internal = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'WORKSPACE_APPLY_UNAVAILABLE';
      const external: External = internal === 'WORKSPACE_APPLY_COURSE_BUSY' ? 'WORKSPACE_APPLY_COURSE_BUSY'
        : internal.includes('FORBIDDEN') ? 'WORKSPACE_APPLY_FORBIDDEN'
        : internal.includes('CONFLICT') || internal.includes('TARGET_CHANGED') || internal.includes('SOURCE_CHANGED') || internal.includes('REVISION') ? 'WORKSPACE_APPLY_CONFLICT'
        : internal.includes('READY') || internal.includes('DEPENDENCY') || internal.includes('STATE') ? 'WORKSPACE_APPLY_NOT_READY'
        : internal.includes('VALIDATION') ? 'WORKSPACE_APPLY_VALIDATION_FAILED' : 'WORKSPACE_APPLY_UNAVAILABLE';
      fail(external, internal);
    }
  };
}
