import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../../types/express.js';
import { isAiIdActor } from './lesson-author-ai-id-access.logic.js';
import { readWorkspaceReviewResolveBody, WorkspaceReviewError, type WorkspaceReviewList,
  type WorkspaceReviewResolveInput } from './lesson-author-workspace-review.logic.js';
import type { WorkspaceReviewOwner, WorkspaceReviewReceipt, WorkspaceReviewTarget } from './lesson-author-workspace-review.repository.js';
import { TENANT_DATA_LIMIT_REACHED_CODE, TENANT_DATA_LIMIT_REACHED_SQLSTATE, TENANT_DATA_QUOTA_RECONCILING_CODE,
  TENANT_DATA_QUOTA_RECONCILING_SQLSTATE } from '../../tenants/tenant-data-quota.constants.js';
import { UUID_PATTERN } from '../../../utils/uuid.js';
import { hasControlCharacter } from './lesson-author-workspace-apply-reason.logic.js';

/** [HTTP status, Vietnamese, English]. Codes stay machine-only; messages are for people. */
export const WORKSPACE_REVIEW_ERRORS = {
  AUTH_REQUIRED: [401, 'Chưa xác thực.', 'Authentication is required.'],
  WORKSPACE_REVIEW_FORBIDDEN: [403, 'Bạn không có quyền duyệt bản thiết kế khoá học này.', 'You do not have permission to review this course design.'],
  WORKSPACE_REVIEW_DISABLED: [503, 'Chức năng duyệt chưa được bật.', 'Reviewing is not enabled.'],
  WORKSPACE_REVIEW_INPUT_INVALID: [400, 'Thông tin duyệt không hợp lệ. Hãy tải lại rồi thử lại.', 'The review request is invalid. Reload and try again.'],
  WORKSPACE_REVIEW_NOT_FOUND: [404, 'Không tìm thấy bản thiết kế khoá học.', 'The course design was not found.'],
  WORKSPACE_REVIEW_ITEM_NOT_FOUND: [404, 'Không tìm thấy mục cần duyệt này. Hãy tải lại danh sách.', 'This review item was not found. Reload the list.'],
  WORKSPACE_REVIEW_STATE_INVALID: [409, 'Bản thiết kế này hiện không còn chờ duyệt. Hãy tải lại danh sách.',
    'This course design is no longer waiting for review. Reload the list.'],
  WORKSPACE_REVIEW_ALREADY_RESOLVED: [409, 'Mục này đã được duyệt rồi. Hãy tải lại danh sách để xem kết quả.',
    'This item was already reviewed. Reload the list to see the result.'],
  WORKSPACE_REVIEW_COMPONENT_INVALID: [422, 'Câu hỏi bạn chọn không thuộc bài học này hoặc chưa sẵn sàng. Hãy chọn lại.',
    'The question you chose is not in this lesson or is not ready. Choose again.'],
  TENANT_DATA_LIMIT_REACHED: [409, 'Không thể lưu thêm dữ liệu vì doanh nghiệp đã dùng hết dung lượng được cấp. Vui lòng xóa bớt dữ liệu hoặc liên hệ quản trị viên để tăng dung lượng.',
    'Nothing more can be saved because the organization has used all of its storage. Delete some data or ask an administrator for more storage.'],
  TENANT_DATA_QUOTA_RECONCILING: [503, 'Hệ thống đang cập nhật dung lượng của doanh nghiệp. Vui lòng thử lại sau ít phút.',
    'The organization storage is being updated. Please try again in a few minutes.'],
  WORKSPACE_REVIEW_READ_UNAVAILABLE: [503, 'Chưa thể tải danh sách chờ duyệt. Vui lòng thử lại sau ít phút.',
    'The review list could not be loaded. Please try again in a few minutes.'],
  WORKSPACE_REVIEW_UNAVAILABLE: [503, 'Chưa thể lưu kết quả duyệt. Vui lòng thử lại sau ít phút.', 'The review could not be saved. Please try again in a few minutes.'],
} as const satisfies Record<string, readonly [number, string, string]>;
type External = keyof typeof WORKSPACE_REVIEW_ERRORS;

interface Dependencies {
  /** Same gate as workspace reads. */
  readEnabled: () => boolean;
  /** Same gates as Apply: resolving changes durable review evidence. */
  resolveEnabled: () => boolean;
  canRead: (user: AuthUser) => Promise<boolean>;
  /** Shared sessions: the creator, so every course editor reads the same list. */
  resolveSessionOwner: (input: { tenantId: string; courseId: string; conversationId: string }) => Promise<string | null>;
  list: (owner: WorkspaceReviewOwner, workspaceId: string) => Promise<WorkspaceReviewList>;
  resolve: (user: AuthUser, target: WorkspaceReviewTarget, obligationId: string,
    input: WorkspaceReviewResolveInput) => Promise<WorkspaceReviewReceipt>;
  report: (event: Record<string, unknown>) => void;
}

const validCourse = (courseId: unknown): courseId is string => typeof courseId === 'string' && !!courseId.trim()
  && courseId.length <= 255 && !hasControlCharacter(courseId);

/** "Chờ duyệt" HTTP boundary: GET the held questions of a run, POST one decision.
 * The router installs authenticate + tenantContext; the repository re-checks
 * ownership in SQL and the actor's fresh course-editor authority on a write. */
export function createWorkspaceReviewHandlers(deps: Dependencies) {
  function handler(operation: 'list' | 'resolve') {
    return async (req: Request, res: Response): Promise<void> => {
      const started = performance.now(), requestId = randomUUID();
      const locale = req.query.ui_locale === 'en' ? 'en' : 'vi';
      const { courseId, conversationId, workspaceId, obligationId } = req.params;
      const body = operation === 'resolve' ? req.body as unknown : null;
      const operationId = body && typeof body === 'object' && typeof (body as Record<string, unknown>).operation_id === 'string'
        && UUID_PATTERN.test((body as Record<string, string>).operation_id) ? (body as Record<string, string>).operation_id : null;
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Request-ID', requestId);
      const report = (status: number, internal: string | null, external: External | null, extra: Record<string, unknown> = {}) => {
        try {
          deps.report({ event: external ? 'workspace_review_failed' : 'workspace_review_completed', operation, request_id: requestId,
            workspace_id: UUID_PATTERN.test(workspaceId ?? '') ? workspaceId : null,
            obligation_id: UUID_PATTERN.test(obligationId ?? '') ? obligationId : null,
            course_id_hash: validCourse(courseId) ? createHash('sha256').update(courseId).digest('hex') : null,
            operation_id: operationId, internal_failure_code: internal, external_failure_code: external,
            http_status: status, duration_ms: Math.max(0, Math.round(performance.now() - started)), ...extra });
        } catch { /* telemetry never changes the answer */ }
      };
      const fail = (external: External, internal: string = external, extra: Record<string, unknown> = {}) => {
        const [status, vi, en] = WORKSPACE_REVIEW_ERRORS[external];
        report(status, internal, external, extra);
        res.status(status).json({ success: false, code: external, message: locale === 'en' ? en : vi, request_id: requestId });
      };
      const user = req.user;
      if (!user) { fail('AUTH_REQUIRED'); return; }
      if (!isAiIdActor(user)) { fail('WORKSPACE_REVIEW_FORBIDDEN'); return; }
      const input = operation === 'resolve' ? readWorkspaceReviewResolveBody(body) : null;
      if (!UUID_PATTERN.test(conversationId ?? '') || !UUID_PATTERN.test(workspaceId ?? '') || !validCourse(courseId)
        || Object.keys(req.query).some(key => key !== 'ui_locale')
        || (req.query.ui_locale !== undefined && req.query.ui_locale !== 'vi' && req.query.ui_locale !== 'en')
        || (operation === 'resolve' && (!UUID_PATTERN.test(obligationId ?? '') || !input))) {
        fail('WORKSPACE_REVIEW_INPUT_INVALID'); return;
      }
      if (!(operation === 'list' ? deps.readEnabled() : deps.resolveEnabled())) { fail('WORKSPACE_REVIEW_DISABLED'); return; }
      try {
        if (operation === 'list') {
          if (!await deps.canRead(user)) { fail('WORKSPACE_REVIEW_FORBIDDEN'); return; }
          const creatorId = await deps.resolveSessionOwner({ tenantId: user.tenantId, courseId, conversationId });
          const data = await deps.list({ tenantId: user.tenantId, userId: creatorId ?? user.id, conversationId, courseId }, workspaceId);
          report(200, null, null, { open_count: data.open_count, total_count: data.total_count });
          res.status(200).json({ success: true, data, request_id: requestId });
          return;
        }
        const receipt = await deps.resolve(user, { tenantId: user.tenantId, courseId, conversationId, workspaceId }, obligationId, input!);
        report(200, null, null, { decision: receipt.decision, replayed: receipt.replayed, open_count: receipt.open_count });
        res.status(200).json({ success: true, data: receipt, request_id: requestId });
      } catch (error) {
        const sqlstate = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
        if (sqlstate === TENANT_DATA_LIMIT_REACHED_SQLSTATE) { fail(TENANT_DATA_LIMIT_REACHED_CODE); return; }
        if (sqlstate === TENANT_DATA_QUOTA_RECONCILING_SQLSTATE) { fail(TENANT_DATA_QUOTA_RECONCILING_CODE); return; }
        if (error instanceof WorkspaceReviewError) {
          fail(operation === 'list' && error.code === 'WORKSPACE_REVIEW_UNAVAILABLE' ? 'WORKSPACE_REVIEW_READ_UNAVAILABLE' : error.code, error.code);
          return;
        }
        // Unknown failure: only a PostgreSQL SQLSTATE token is logged, never a message.
        fail(operation === 'list' ? 'WORKSPACE_REVIEW_READ_UNAVAILABLE' : 'WORKSPACE_REVIEW_UNAVAILABLE', 'WORKSPACE_REVIEW_UNEXPECTED',
          typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate) ? { sqlstate } : {});
      }
    };
  }
  return { list: handler('list'), resolve: handler('resolve') };
}
