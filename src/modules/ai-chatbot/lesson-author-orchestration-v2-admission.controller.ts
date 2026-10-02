import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import type {
  OrchestrationV2AdmissionReceipt,
  OrchestrationV2AdmissionTarget,
} from './lesson-author-orchestration-v2-admission.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Dependencies = {
  enabled(): boolean;
  admit(user: AuthUser, target: OrchestrationV2AdmissionTarget): Promise<OrchestrationV2AdmissionReceipt>;
  report(event: Record<string, unknown>): void;
};

function safeReport(report: Dependencies['report'], event: Record<string, unknown>): void {
  try { report(event); } catch { /* Telemetry is not admission authority. */ }
}

function safeCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(code)
    ? code : 'ORCHESTRATION_V2_ADMISSION_UNAVAILABLE';
}

/** Default-off HTTP boundary. The browser supplies no model, budget, source or authority data. */
export function createOrchestrationV2AdmissionHandler(deps: Dependencies) {
  return async (req: Request, res: Response): Promise<void> => {
    const started = performance.now();
    const requestId = randomUUID();
    const locale = req.query.ui_locale === 'en' ? 'en' : 'vi';
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Request-ID', requestId);
    const fail = (status: number, externalCode: string, internalCode = externalCode) => {
      safeReport(deps.report, { event: 'orchestration_v2_admission_failed', request_id: requestId,
        workspace_id: UUID.test(req.params.workspaceId ?? '') ? req.params.workspaceId : null,
        run_id: null, internal_failure_code: internalCode, external_failure_code: externalCode,
        http_status: status, duration_ms: Math.round(performance.now() - started) });
      res.status(status).json({ success: false, code: externalCode, request_id: requestId,
        message: locale === 'en'
          ? 'The course generation request could not be confirmed. Refresh the workspace before trying again.'
          : 'Chưa thể xác nhận yêu cầu tạo khóa học. Hãy tải lại bản thảo trước khi thử lại.' });
    };

    const user = req.user;
    const { courseId, conversationId, workspaceId } = req.params;
    const queryKeys = Object.keys(req.query);
    const body = req.body as unknown;
    if (!user) { fail(401, 'AUTH_REQUIRED'); return; }
    if (user.sessionMode !== 'normal' || !user.tenantId || !UUID.test(user.id) || !UUID.test(user.tenantId)
      || !['staff', 'superuser', 'superadmin'].includes(user.role)) {
      fail(403, 'ORCHESTRATION_V2_ADMISSION_FORBIDDEN'); return;
    }
    if (!deps.enabled()) { fail(503, 'ORCHESTRATION_V2_ADMISSION_DISABLED'); return; }
    if (typeof courseId !== 'string' || !courseId.trim() || courseId.length > 255 || /[\x00-\x1f\x7f]/.test(courseId)
      || !UUID.test(conversationId ?? '') || !UUID.test(workspaceId ?? '')
      || queryKeys.some(key => key !== 'ui_locale')
      || (req.query.ui_locale !== undefined && !['en', 'vi'].includes(req.query.ui_locale as string))
      || (body !== undefined && body !== null
        && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body as Record<string, unknown>).length > 0))) {
      fail(400, 'ORCHESTRATION_V2_ADMISSION_INPUT_INVALID'); return;
    }

    const target: OrchestrationV2AdmissionTarget = {
      workspaceId, tenantId: user.tenantId, courseId, conversationId, userId: user.id,
    };
    try {
      const receipt = await deps.admit(user, target);
      if (!receipt || typeof receipt.created !== 'boolean' || !UUID.test(receipt.run_id)) {
        fail(503, 'ORCHESTRATION_V2_ADMISSION_UNAVAILABLE', 'ORCHESTRATION_V2_ADMISSION_READBACK_INVALID');
        return;
      }
      const status = receipt.created ? 202 : 200;
      safeReport(deps.report, { event: 'orchestration_v2_admission_completed', request_id: requestId,
        workspace_id: workspaceId, run_id: receipt.run_id, replayed: !receipt.created,
        http_status: status, duration_ms: Math.round(performance.now() - started) });
      res.status(status).json({ success: true, data: {
        workspace_id: workspaceId, run_id: receipt.run_id, status: 'planning', replayed: !receipt.created,
      } });
    } catch (error) {
      const internal = safeCode(error);
      const forbidden = internal === 'ORCHESTRATION_V2_ADMISSION_FORBIDDEN';
      const conflict = ['ORCHESTRATION_V2_ADMISSION_STATE_INVALID', 'ORCHESTRATION_V2_ADMISSION_SOURCE_CHANGED',
        'ORCHESTRATION_V2_ADMISSION_CONFLICT'].includes(internal);
      fail(forbidden ? 403 : conflict ? 409 : 503,
        forbidden ? 'ORCHESTRATION_V2_ADMISSION_FORBIDDEN'
          : conflict ? internal : 'ORCHESTRATION_V2_ADMISSION_UNAVAILABLE', internal);
    }
  };
}
