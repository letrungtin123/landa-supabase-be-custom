// HTTP boundary of the author recovery actions on an AI course design run:
//   GET  …/workspaces/:workspaceId/recovery  what can be stopped, continued or rewritten now
//   POST …/workspaces/:workspaceId/stop      stop the running design, keep what is done
//   POST …/workspaces/:workspaceId/resume    re-run the free validations/finalizer of a stopped design
//   POST …/workspaces/:workspaceId/nodes/:nodeId/regenerate
//                                            rewrite the lessons without content of a lesson/chapter/course
// Mount after authenticate + tenantContext + the session-owner guard. Input is
// validated here (zod); the service and repository own every rule.

import { createHash, randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { AuthUser } from '../../../../../types/express.js';
import { UUID_PATTERN } from '../../../../../utils/uuid.js';
import { isAiIdActor } from '../../shared/lesson-author-ai-id-access.logic.js';
import {
  OrchestrationV2RecoveryError,
  type OrchestrationV2RecoveryErrorCode,
} from './lesson-author-orchestration-v2-recovery.logic.js';
import type { OrchestrationV2RecoveryTarget, createOrchestrationV2RecoveryService } from './lesson-author-orchestration-v2-recovery.service.js';
import { requestLocale } from '../../sessions/lesson-author-session-access.controller.js';

type RecoveryService = ReturnType<typeof createOrchestrationV2RecoveryService>;
type ExternalCode = OrchestrationV2RecoveryErrorCode | 'AUTH_REQUIRED';
export type OrchestrationV2RecoveryOperation = 'describe' | 'stop' | 'resume' | 'regenerate';

/** [HTTP status, Vietnamese, English]: plain words for authors, never a code or a technical term. */
export const ORCHESTRATION_V2_RECOVERY_ERRORS: Record<ExternalCode, readonly [number, string, string]> = {
  AUTH_REQUIRED: [401, 'Bạn cần đăng nhập lại để tiếp tục.', 'Please sign in again to continue.'],
  RECOVERY_DISABLED: [503, 'Tính năng dừng, chạy tiếp và viết lại chưa được bật cho đơn vị của bạn.',
    'Stopping, continuing and rewriting are not turned on for your organization yet.'],
  RECOVERY_FORBIDDEN: [403, 'Bạn không có quyền thực hiện thao tác này với bản thiết kế khoá học.',
    'You do not have permission to do this on this course design.'],
  RECOVERY_INPUT_INVALID: [400, 'Yêu cầu không hợp lệ. Vui lòng tải lại trang rồi thử lại.',
    'The request is not valid. Please reload the page and try again.'],
  RECOVERY_NOT_FOUND: [404, 'Không tìm thấy bản thiết kế khoá học hoặc phần nội dung này.',
    'This course design or this part of the content was not found.'],
  RECOVERY_STATE_CHANGED: [409, 'Bản thiết kế vừa thay đổi. Vui lòng tải lại rồi thử lại.',
    'The course design has just changed. Please reload it and try again.'],
  RECOVERY_UNIT_HAS_CONTENT: [409, 'Bài này đã có nội dung nên không cần viết lại.',
    'This lesson already has content, so it does not need to be rewritten.'],
  RECOVERY_NOTHING_TO_DO: [409, 'Không còn phần nào cần chạy tiếp hoặc viết lại.',
    'There is nothing left to continue or rewrite.'],
  RECOVERY_LIMIT_REACHED: [409, 'Bài này đã được viết lại 3 lần. Bạn có thể tự soạn nội dung hoặc tạo bản thiết kế mới.',
    'This lesson has already been rewritten 3 times. You can write the content yourself or start a new design.'],
  RECOVERY_RUNTIME_CHANGED: [409, 'Cài đặt AI đã thay đổi sau khi tạo bản thiết kế này nên không thể chạy tiếp. Vui lòng tạo bản thiết kế mới.',
    'The AI settings changed after this design was created, so it cannot continue. Please start a new design.'],
  RECOVERY_OTHER_RUN_ACTIVE: [409, 'Bạn đang có một bản thiết kế khác của khoá học này đang chạy. Hãy chờ bản đó xong hoặc dừng nó trước.',
    'Another design of this course is still running. Wait for it to finish or stop it first.'],
  RECOVERY_IDEMPOTENCY_CONFLICT: [409, 'Thao tác này đã được gửi trước đó với nội dung khác. Vui lòng tải lại rồi thử lại.',
    'This action was already sent with different details. Please reload and try again.'],
  RUN_STOP_NOT_ACTIVE: [409, 'Bản thiết kế không còn đang chạy nên không cần dừng.',
    'The course design is no longer running, so there is nothing to stop.'],
  AI_CREDIT_INSUFFICIENT_FOR_RECOVERY: [429, 'Không đủ điểm AI để viết lại. Vui lòng liên hệ quản trị viên để mua thêm điểm.',
    'There are not enough AI points to rewrite. Please contact your administrator to buy more points.'],
  RECOVERY_UNAVAILABLE: [503, 'Chưa thể thực hiện lúc này. Vui lòng thử lại sau ít phút.',
    'This cannot be done right now. Please try again in a few minutes.'],
  RECOVERY_SOURCE_DOCUMENT_MISSING: [409, 'Tài liệu nguồn của bản thiết kế này không còn dùng được (đã bị xoá hoặc Kho tri thức của AI ID đã đổi) nên không thể viết lại. Bạn có thể tự soạn nội dung hoặc tạo bản thiết kế mới.',
    'The source documents of this design are no longer available (deleted, or the AI ID knowledge base changed), so it cannot be rewritten. You can write the content yourself or start a new design.'],
};

export interface OrchestrationV2RecoveryDiagnostic {
  event: 'workspace_recovery_completed' | 'workspace_recovery_failed';
  operation: OrchestrationV2RecoveryOperation;
  request_id: string;
  tenant_id: string | null;
  workspace_id: string | null;
  conversation_id: string | null;
  course_id_hash: string | null;
  node_id: string | null;
  operation_id: string | null;
  run_id: string | null;
  recovery_id: string | null;
  reopened_task_count: number | null;
  replayed: boolean | null;
  internal_failure_code: string | null;
  external_failure_code: ExternalCode | null;
  http_status: number;
  duration_ms: number;
}

const PARAMS = z.object({
  workspaceId: z.string().regex(UUID_PATTERN),
  conversationId: z.string().regex(UUID_PATTERN),
  courseId: z.string().min(1).max(255).refine(value => value.trim().length > 0
    && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)),
  nodeId: z.string().regex(UUID_PATTERN).optional(),
});
const QUERY = z.object({ ui_locale: z.enum(['vi', 'en']).optional() }).strict();
const STOP_BODY = z.object({ operation_id: z.string().regex(UUID_PATTERN) }).strict();
export const RECOVERY_BODY = z.object({
  operation_id: z.string().regex(UUID_PATTERN),
  expected_workspace_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export type OrchestrationV2AsyncMiddleware = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/** Route adapter: keeps Express's void handler signature and hands any rejection to next(). */
export function orchestrationV2RecoveryRoute(handler: OrchestrationV2AsyncMiddleware): RequestHandler {
  return (req, res, next) => { void handler(req, res, next).catch(next); };
}

export interface OrchestrationV2RecoveryHandlerDependencies {
  service: RecoveryService;
  report(record: OrchestrationV2RecoveryDiagnostic): void;
}

export interface OrchestrationV2RecoveryRequestContext {
  user: AuthUser & { tenantId: string };
  target: OrchestrationV2RecoveryTarget;
  nodeId: string | null;
  body: unknown;
}

type Operation = (context: OrchestrationV2RecoveryRequestContext) => Promise<{
  data: unknown;
  run_id?: string | null;
  recovery_id?: string | null;
  reopened_task_count?: number | null;
  replayed?: boolean | null;
}>;

/**
 * Log-only code of an unexpected failure: a database SQLSTATE, or the internal
 * code of a lower layer (accounting, worker repository, ...). Only codes of the
 * fixed shapes are kept, never a message; the client always gets RECOVERY_UNAVAILABLE.
 */
export function orchestrationV2RecoveryInternalCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== 'string') return 'RECOVERY_UNEXPECTED_ERROR';
  if (/^[0-9A-Z]{5}$/.test(code)) return `SQLSTATE_${code}`;
  return /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : 'RECOVERY_UNEXPECTED_ERROR';
}

/** Shared request pipeline: no-store, request id, actor + input checks, one error table, one log line. */
export function createOrchestrationV2RecoveryHandler(
  deps: Pick<OrchestrationV2RecoveryHandlerDependencies, 'report'>,
  operation: OrchestrationV2RecoveryOperation,
  run: Operation,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const started = performance.now();
    const requestId = randomUUID();
    const locale = requestLocale(req);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Request-ID', requestId);
    const params = PARAMS.safeParse(req.params);
    const body: unknown = req.body;
    const operationId = body && typeof body === 'object' && !Array.isArray(body)
      && typeof (body as { operation_id?: unknown }).operation_id === 'string'
      && UUID_PATTERN.test((body as { operation_id: string }).operation_id)
      ? (body as { operation_id: string }).operation_id : null;
    const outcome: { run_id: string | null; recovery_id: string | null; reopened_task_count: number | null;
      replayed: boolean | null } = { run_id: null, recovery_id: null, reopened_task_count: null, replayed: null };
    const user = req.user ? Object.freeze({ ...req.user }) : null;
    const report = (status: number, internal: string | null, external: ExternalCode | null) => {
      try {
        deps.report({ event: external ? 'workspace_recovery_failed' : 'workspace_recovery_completed', operation,
          request_id: requestId, tenant_id: typeof user?.tenantId === 'string' && UUID_PATTERN.test(user.tenantId)
            ? user.tenantId : null,
          workspace_id: params.success ? params.data.workspaceId : null,
          conversation_id: params.success ? params.data.conversationId : null,
          course_id_hash: params.success ? createHash('sha256').update(params.data.courseId).digest('hex') : null,
          node_id: params.success ? params.data.nodeId ?? null : null, operation_id: operationId, ...outcome,
          internal_failure_code: internal, external_failure_code: external, http_status: status,
          duration_ms: Math.max(0, Math.round(performance.now() - started)) });
      } catch { /* Logging never changes an accepted or refused request. */ }
    };
    const reject = (external: ExternalCode, internal: string = external) => {
      const [status, vi, en] = ORCHESTRATION_V2_RECOVERY_ERRORS[external];
      report(status, internal, external);
      res.status(status).json({ success: false, code: external, message: locale === 'en' ? en : vi, request_id: requestId });
    };
    if (!user) { reject('AUTH_REQUIRED'); return; }
    if (!isAiIdActor(user)) { reject('RECOVERY_FORBIDDEN'); return; }
    if (!params.success || !QUERY.safeParse(req.query).success
      || (operation === 'regenerate') !== (params.data.nodeId !== undefined)) {
      reject('RECOVERY_INPUT_INVALID'); return;
    }
    try {
      const result = await run({ user, nodeId: params.data.nodeId ?? null, body,
        target: { workspaceId: params.data.workspaceId, conversationId: params.data.conversationId,
          courseId: params.data.courseId } });
      Object.assign(outcome, { run_id: result.run_id ?? null, recovery_id: result.recovery_id ?? null,
        reopened_task_count: result.reopened_task_count ?? null, replayed: result.replayed ?? null });
      report(200, null, null);
      res.status(200).json({ success: true, data: result.data, request_id: requestId });
    } catch (error) {
      if (error instanceof OrchestrationV2RecoveryError) { reject(error.code); return; }
      reject('RECOVERY_UNAVAILABLE', orchestrationV2RecoveryInternalCode(error));
    }
  };
}

export function createOrchestrationV2RecoveryHandlers(deps: OrchestrationV2RecoveryHandlerDependencies) {
  return {
    describe: createOrchestrationV2RecoveryHandler(deps, 'describe', async ({ user, target, body }) => {
      if (body !== undefined && !(body && typeof body === 'object' && !Object.keys(body).length)) {
        throw new OrchestrationV2RecoveryError('RECOVERY_INPUT_INVALID');
      }
      const view = await deps.service.describe(user, target);
      return { data: view, run_id: view.run_id };
    }),
    stop: createOrchestrationV2RecoveryHandler(deps, 'stop', async ({ user, target, body }) => {
      const parsed = STOP_BODY.safeParse(body);
      if (!parsed.success) throw new OrchestrationV2RecoveryError('RECOVERY_INPUT_INVALID');
      const result = await deps.service.stop(user, target, parsed.data.operation_id);
      return { data: result, run_id: result.run_id, recovery_id: null, reopened_task_count: 0, replayed: result.replayed };
    }),
    resume: createOrchestrationV2RecoveryHandler(deps, 'resume', async ({ user, target, body }) => {
      const parsed = RECOVERY_BODY.safeParse(body);
      if (!parsed.success) throw new OrchestrationV2RecoveryError('RECOVERY_INPUT_INVALID');
      const result = await deps.service.recover(user, target, { action: 'resume' }, parsed.data);
      return { data: result, run_id: result.run_id, recovery_id: result.recovery_id,
        reopened_task_count: result.reopened_task_count, replayed: result.replayed };
    }),
    regenerate: createOrchestrationV2RecoveryHandler(deps, 'regenerate', async ({ user, target, nodeId, body }) => {
      const parsed = RECOVERY_BODY.safeParse(body);
      if (!parsed.success || !nodeId) throw new OrchestrationV2RecoveryError('RECOVERY_INPUT_INVALID');
      const result = await deps.service.recover(user, target, { action: 'regenerate', node_id: nodeId }, parsed.data);
      return { data: result, run_id: result.run_id, recovery_id: result.recovery_id,
        reopened_task_count: result.reopened_task_count, replayed: result.replayed };
    }),
  };
}
