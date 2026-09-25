import type { Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import {
  generationJobStatusView, type GenerationJobOwner, type GenerationJobRow,
} from './lesson-author-generation-job.logic.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHOR_ROLES = new Set(['staff', 'superuser', 'superadmin']);

interface GenerationStatusDependencies {
  enabled: () => boolean;
  canRead: (user: AuthUser) => Promise<boolean>;
  findOwned: (owner: GenerationJobOwner, jobId: string) => Promise<GenerationJobRow | null>;
  reportFailure: (record: {
    event: 'generation_status_read_failed';
    failure_stage: 'node_generation_status';
    internal_failure_code: 'GENERATION_STATUS_READ_FAILED';
    job_id: string;
    conversation_id: string;
  }) => void;
}

/** Read-only handler; neither polling nor a read failure may enqueue/retry AI work. */
export function createGenerationStatusHandler(deps: GenerationStatusDependencies) {
  return async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    const reject = (status: number, code: string, message: string) => {
      res.status(status).json({ success: false, code, message });
    };
    const user = req.user;
    if (!user) {
      reject(401, 'AUTH_REQUIRED', 'Chưa xác thực.');
      return;
    }
    // No superadmin cross-tenant/conversation-owner exception. Tenant selection
    // is resolved by existing tenantContext before reaching this handler.
    if (!user.tenantId || !AUTHOR_ROLES.has(user.role) || user.sessionMode === 'demo_iframe') {
      reject(403, 'GENERATION_STATUS_FORBIDDEN', 'Không có quyền xem tác vụ tạo khóa học.');
      return;
    }
    const { conversationId, jobId } = req.params;
    if (!UUID.test(conversationId ?? '') || !UUID.test(jobId ?? '')) {
      reject(400, 'GENERATION_IDENTIFIER_INVALID', 'ID tác vụ hoặc cuộc hội thoại không hợp lệ.');
      return;
    }
    if (!deps.enabled()) {
      reject(503, 'GENERATION_STATUS_DISABLED', 'Theo dõi tác vụ tạo khóa học chưa được bật.');
      return;
    }
    try {
      // Same courses permission implementation/cache semantics as existing APIs;
      // checked per read, with fresh ownership/assignment joins in the repository.
      if (!await deps.canRead(user)) {
        reject(403, 'GENERATION_STATUS_FORBIDDEN', 'Không có quyền xem tác vụ tạo khóa học.');
        return;
      }
      const job = await deps.findOwned({
        tenantId: user.tenantId, userId: user.id, conversationId,
      }, jobId);
      if (!job) {
        reject(404, 'GENERATION_JOB_NOT_FOUND', 'Không tìm thấy tác vụ tạo khóa học.');
        return;
      }
      res.status(200).json({ success: true, data: generationJobStatusView(job) });
    } catch {
      // No raw DB error, SQL parameters, credentials, source or prompt in logs/HTTP.
      deps.reportFailure({ event: 'generation_status_read_failed', failure_stage: 'node_generation_status',
        internal_failure_code: 'GENERATION_STATUS_READ_FAILED', job_id: jobId, conversation_id: conversationId });
      reject(503, 'GENERATION_STATUS_UNAVAILABLE', 'Chưa thể đọc trạng thái tác vụ. Vui lòng thử lại sau.');
    }
  };
}
