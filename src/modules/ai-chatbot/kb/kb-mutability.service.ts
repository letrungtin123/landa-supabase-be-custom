// ═══════════════════════════════════════════════════════════════
// Knowledge base mutability: a document change is refused while the
// knowledge base is missing, restoring, queued for deletion, inside an AI
// engine transition, or needs a restore for the tenant's current key. SQL
// lives in kb.repository.ts; moved from kb.service.ts.
// ═══════════════════════════════════════════════════════════════

import { query } from '../../../config/database.js';
import { AppError } from '../../../middleware/error-handler.js';
import { hasQueuedKnowledgebaseDeletion } from './kb-operation.service.js';
import { getOptionalGeminiApiKeyFingerprint } from '../ai-platform/gemini.service.js';
import { createKbRepository } from './kb.repository.js';
import { getRestoreReasonFromStore, isRestoreActiveState } from './kb-restore.logic.js';

const kbRepository = createKbRepository({ query });

export async function assertNoActiveAiEngineTransition(
  tenantId: string,
  actionLabel = 'thay doi tai lieu',
): Promise<void> {
  if (await kbRepository.selectActiveAiEngineTransition(tenantId)) {
    throw new AppError(
      `Hệ thống AI đang chuyển dữ liệu, tạm thời không thể ${actionLabel}.`,
      409,
      'AI_ENGINE_TRANSITION_ACTIVE',
    );
  }
}

export async function assertKnowledgebaseMutable(
  kbId: string,
  tenantId: string,
  actionLabel = 'thay doi tai lieu',
): Promise<void> {
  const currentFingerprint = await getOptionalGeminiApiKeyFingerprint(tenantId);
  const row = await kbRepository.selectKbForMutation(kbId, tenantId);
  if (!row) throw new AppError('Knowledge Base khong ton tai', 404);
  if (isRestoreActiveState(row.restore_state)) {
    throw new AppError(`Kho tri thuc dang khoi phuc, tam thoi khong the ${actionLabel}.`, 409);
  }
  if (await hasQueuedKnowledgebaseDeletion(kbId, tenantId)) {
    throw new AppError(`Kho tri thuc dang duoc xoa, tam thoi khong the ${actionLabel}.`, 409);
  }
  await assertNoActiveAiEngineTransition(tenantId, actionLabel);
  const reason = getRestoreReasonFromStore(
    row.remote_status
      ? {
          api_key_fingerprint: row.api_key_fingerprint,
          remote_status: row.remote_status,
          remote_error_reason: row.remote_error_reason,
        }
      : null,
    currentFingerprint,
  );
  if (reason) {
    throw new AppError(`Kho tri thuc can khoi phuc truoc khi ${actionLabel}. Ly do: ${reason}`, 409);
  }
}
