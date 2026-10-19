// Chat turn runtime shared by chat.service.ts and the AI ID legacy code (ai-id/legacy/):
// per-process rate limit and stream locks, Gemini File Search store names,
// active KB lookups, conversation context and provider error text. The timer
// that sweeps rateLimitMap stays in chat.service.ts.
import { query } from '../../../config/database.js';
import { cacheJson, getCacheVersion } from '../../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../../config/cache-keys.js';
import { clusterBus } from '../../../config/cluster-bus.js';
import { chatStreamLocks, type DistributedStreamLock } from './chat-stream-lock.js';
import { AppError } from '../../../middleware/error-handler.js';
import {
  getOptionalGeminiApiKeyFingerprint,
  isGeminiPermissionDeniedError,
  markKbGeminiStoreRemoteProblem,
} from '../ai-platform/gemini.service.js';
import { INPUT_FILTER_CONFIG_KEY } from '../ai-platform/input-filter/input-filter.schema.js';
import { UUID_PATTERN } from '../../../utils/uuid.js';
import { RATE_LIMIT_MS, LESSON_AUTHOR_TARGET } from './chat.constants.js';
import type { ChatTarget } from './chat.constants.js';
import type { KbAssignment, ConversationContext } from './chat.types.js';

// ── UUID validation ──
export function isValidUUID(s: string): boolean { return UUID_PATTERN.test(s); }

// ── In-memory rate limiter (per-user) ──
export const rateLimitMap = new Map<string, number>();

export function checkRateLimit(userId: string): void {
  const lastSent = rateLimitMap.get(userId);
  if (lastSent && Date.now() - lastSent < RATE_LIMIT_MS) {
    throw new AppError('Bạn gửi tin nhắn quá nhanh. Vui lòng đợi vài giây.', 429);
  }
}
export function markRateLimit(userId: string): void {
  rateLimitMap.set(userId, Date.now());
}

// ── In-memory concurrency lock (per-conversation) ──
export const streamLocks = new Set<string>();

/**
 * Prevents duplicate provider calls when the same conversation lands on more
 * than one backend process (chat-stream-lock.ts: plain Redis commands under
 * the backend key prefix, renewed while held). Redis is an optimization: the
 * local lock remains the safe fallback when Redis is unavailable.
 */
export function acquireDistributedStreamLock(conversationId: string, requireDistributedFence = false): Promise<DistributedStreamLock | null> {
  return chatStreamLocks.acquire(conversationId, requireDistributedFence);
}

// ── Store name cache (per-kb, rarely changes) ──
const storeNameCache = new Map<string, { name: string; ts: number }>();
const STORE_CACHE_TTL = 10 * 60_000; // 10 minutes
const ACTIVE_KB_RESTORE_STATES = new Set(['queued', 'restoring', 'uploading']);
const RESTORE_REQUIRED_STORE_STATUSES = new Set(['key_changed', 'permission_denied', 'not_found']);

// KB restores and engine transitions run in the background process: their
// invalidations reach the API processes through the cluster bus.
const STORE_NAME_EVENT = 'kb.store-name';

function forgetGeminiStoreNames(kbId?: string): void {
  if (kbId) {
    for (const key of storeNameCache.keys()) {
      if (key.startsWith(`${kbId}:`)) storeNameCache.delete(key);
    }
    return;
  }
  storeNameCache.clear();
}

clusterBus.on(STORE_NAME_EVENT, (payload) => {
  forgetGeminiStoreNames(typeof payload.kb_id === 'string' ? payload.kb_id : undefined);
});
clusterBus.onReset(() => storeNameCache.clear());

export function invalidateGeminiStoreNameCache(kbId?: string): void {
  forgetGeminiStoreNames(kbId);
  void clusterBus.publish(STORE_NAME_EVENT, kbId ? { kb_id: kbId } : {});
}

export async function getCachedStoreName(kbId: string, tenantId: string): Promise<string | null> {
  const currentFingerprint = await getOptionalGeminiApiKeyFingerprint(tenantId);
  const cacheKey = `${kbId}:${currentFingerprint ?? 'no-key'}`;
  const cached = storeNameCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < clusterBus.cacheTtlMs(STORE_CACHE_TTL)) return cached.name;

  const result = await query<{
    restore_state: string | null;
    store_name: string | null;
    api_key_fingerprint: string | null;
    remote_status: string | null;
    remote_error_reason: string | null;
  }>(
    `SELECT kb.restore_state,
            kgs.store_name,
            kgs.api_key_fingerprint,
            kgs.remote_status,
            kgs.remote_error_reason
     FROM knowledgebases kb
     LEFT JOIN kb_google_store kgs ON kgs.kb_id = kb.id
     WHERE kb.id = $1 AND kb.tenant_id = $2
     LIMIT 1`,
    [kbId, tenantId],
  );
  if (!result.rowCount || result.rowCount === 0) return null;

  const row = result.rows[0];
  if (ACTIVE_KB_RESTORE_STATES.has(row.restore_state || '')) {
    throw new AppError('Kho tri thuc dang khoi phuc. Vui long cho hoan tat roi chat lai.', 409);
  }
  if (!row.store_name) return null;
  if (RESTORE_REQUIRED_STORE_STATUSES.has(row.remote_status || '')) {
    // The stored remote reason is provider text; the chat answer stays plain.
    throw new AppError('Kho tri thuc can khoi phuc lai truoc khi chat.', 409);
  }
  if (row.remote_status && row.remote_status !== 'active') return null;
  if (row.api_key_fingerprint && currentFingerprint && row.api_key_fingerprint !== currentFingerprint) {
    await markKbGeminiStoreRemoteProblem(
      kbId,
      'key_changed',
      'KEY_CHANGED',
      'Gemini API key changed; restore this KB to rebuild File Search store for the current key.',
    );
    invalidateGeminiStoreNameCache(kbId);
    throw new AppError('Kho tri thuc can khoi phuc lai truoc khi chat vi Google/Gemini key da thay doi.', 409);
  }

  storeNameCache.set(cacheKey, { name: row.store_name, ts: Date.now() });
  return row.store_name;
}

export async function getActiveKbAssignment(tenantId: string): Promise<KbAssignment | null> {
  const version = await getCacheVersion(...cacheVersions.tenantAi(tenantId));
  return cacheJson(
    cacheKeys.aiTenantResource(tenantId, 'lesson-author-kb', version),
    CACHE_TTL.aiConfig,
    () => getActiveKbAssignmentFromDb(tenantId),
  );
}

/**
 * Mutation paths must bind to the currently assigned lesson-author KB, not a
 * short-lived configuration cache. Read-only widget setup continues to use
 * the cached accessor above.
 */
export async function getActiveKbAssignmentFresh(tenantId: string): Promise<KbAssignment | null> {
  return getActiveKbAssignmentFromDb(tenantId);
}

async function getActiveKbAssignmentFromDb(tenantId: string): Promise<KbAssignment | null> {
  const result = await query<KbAssignment>(
    `SELECT tka.id,
            tka.tenant_id,
            tka.target,
            tka.kb_id,
            kb.name AS kb_name,
            kb.description AS kb_description,
            COALESCE(doc_stats.document_count, 0)::int AS document_count,
            COALESCE(doc_stats.learned_count, 0)::int AS learned_count,
            COALESCE(doc_stats.learning_count, 0)::int AS learning_count,
            COALESCE(doc_stats.error_count, 0)::int AS error_count,
            kgs.store_name,
            tka.updated_at
     FROM tenant_kb_assignments tka
     JOIN knowledgebases kb ON kb.id = tka.kb_id
     LEFT JOIN kb_google_store kgs ON kgs.kb_id = kb.id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS document_count,
              COUNT(*) FILTER (WHERE status = 'learned') AS learned_count,
              COUNT(*) FILTER (WHERE status IN ('learning', 'pending')) AS learning_count,
              COUNT(*) FILTER (WHERE status = 'error') AS error_count
       FROM kb_documents
       WHERE kb_id = kb.id
     ) doc_stats ON true
     WHERE tka.tenant_id = $1 AND tka.target = $2`,
    [tenantId, LESSON_AUTHOR_TARGET],
  );
  return result.rows[0] || null;
}

function getInputFilterConfigFromBotConfig(botConfig: unknown): unknown {
  if (typeof botConfig !== 'object' || botConfig === null || Array.isArray(botConfig)) return null;
  return (botConfig as Record<string, unknown>)[INPUT_FILTER_CONFIG_KEY] ?? null;
}

/** The one answer for a conversation the caller cannot use: missing, another user's, another tenant's or another target's. */
function conversationNotFound(): AppError {
  return new AppError('Cuộc hội thoại không tồn tại', 404);
}

/**
 * The conversation is the caller's: same tenant and user, the expected target
 * when given, and its bot still deployed (the conversation conditions of
 * loadConversationContext). Checked before the conversation locks, so another
 * user's conversation is answered exactly like a missing one, never with
 * "already processing".
 */
export async function assertChatConversationOwner(
  conversationId: string,
  userId: string,
  tenantId: string,
  expectedTarget?: ChatTarget,
): Promise<void> {
  const result = await query<{ id: string }>(
    `SELECT cc.id
     FROM chat_conversations cc
     JOIN tenant_bot_assignments tba
       ON tba.tenant_id = cc.tenant_id
      AND tba.target = cc.target
      AND tba.bot_id = cc.bot_id
     JOIN chatbots c ON c.id = cc.bot_id AND c.tenant_id = cc.tenant_id
     WHERE cc.id = $1
       AND cc.user_id = $2
       AND cc.tenant_id = $3
       AND ($4::text IS NULL OR cc.target = $4)`,
    [conversationId, userId, tenantId, expectedTarget ?? null],
  );
  if (!result.rowCount) throw conversationNotFound();
}

export async function loadConversationContext(
  conversationId: string,
  userId: string,
  tenantId: string,
  expectedTarget?: ChatTarget,
): Promise<ConversationContext> {
  // Single query: load conversation + bot + persona + prompt + message count via CTE
  const result = await query<{
    id: string; tenant_id: string; bot_id: string; target: ChatTarget; course_id: string | null; bot_kb_id: string | null;
    custom_prompt: string | null; template_prompt: string; bot_config: unknown;
    msg_count: number;
  }>(
    `WITH conv AS (
       SELECT cc.id, cc.tenant_id, cc.bot_id, cc.target, cc.course_id, c.kb_id AS bot_kb_id, c.config AS bot_config, cc.persona_id
       FROM chat_conversations cc
       JOIN tenant_bot_assignments tba
         ON tba.tenant_id = cc.tenant_id
        AND tba.target = cc.target
        AND tba.bot_id = cc.bot_id
       JOIN chatbots c ON c.id = cc.bot_id AND c.tenant_id = cc.tenant_id
       WHERE cc.id = $1
         AND cc.user_id = $2
         AND cc.tenant_id = $3
         AND ($4::text IS NULL OR cc.target = $4)
     ), msg_cnt AS (
       SELECT COUNT(*)::int AS cnt FROM chat_messages WHERE conversation_id = $1
     )
     SELECT conv.id, conv.tenant_id, conv.bot_id, conv.target, conv.course_id, conv.bot_kb_id, conv.bot_config,
            bp.custom_prompt, spt.prompt AS template_prompt,
            msg_cnt.cnt AS msg_count
     FROM conv
     JOIN bot_personas bp ON bp.id = conv.persona_id
     JOIN system_prompt_templates spt ON spt.id = bp.template_id
     CROSS JOIN msg_cnt`,
    [conversationId, userId, tenantId, expectedTarget ?? null],
  );

  if (!result.rowCount || result.rowCount === 0) {
    throw conversationNotFound();
  }

  const row = result.rows[0];
  let botKbId = row.bot_kb_id;
  if (row.target === LESSON_AUTHOR_TARGET) {
    if (!row.course_id) throw new Error('Lesson author conversation is missing course_id');
    const activeKb = await getActiveKbAssignment(tenantId);
    if (!activeKb) throw new AppError('Chưa cấu hình KB active cho chuyên gia tạo bài học', 409);
    botKbId = activeKb.kb_id;
  }

  return {
    conversationId: row.id,
    tenantId: row.tenant_id,
    botId: row.bot_id,
    target: row.target,
    courseId: row.course_id,
    botKbId,
    systemPrompt: row.target === LESSON_AUTHOR_TARGET ? row.template_prompt : (row.custom_prompt ?? row.template_prompt),
    messageCount: row.msg_count,
    inputFilterConfig: getInputFilterConfigFromBotConfig(row.bot_config),
  };
}

/** Sanitize Gemini errors → short Vietnamese messages for UI */
export function redactGeminiApiKeys(value: string): string {
  return value.replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{8,})\b/g, '[redacted]');
}

export function sanitizeGeminiError(err: any): Error {
  if (err instanceof AppError) return err;

  const rawMsg = err?.message || err?.toString() || '';
  const msg = redactGeminiApiKeys(rawMsg);
  const status = err?.status || err?.code || 0;

  // 429 — quota exceeded
  if (status === 429 || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota')) {
    return new Error('Hệ thống AI đang quá tải. Vui lòng thử lại sau ít phút.');
  }
  // 503 — service unavailable
  if (status === 503 || msg.includes('UNAVAILABLE')) {
    return new Error('Dịch vụ AI tạm thời không khả dụng. Vui lòng thử lại sau.');
  }
  // 400 — bad request (prompt blocked, safety, etc.)
  if (isGeminiPermissionDeniedError(err)) {
    return new Error('Kho tri thuc can khoi phuc lai voi Google/Gemini key hien tai truoc khi chat.');
  }
  if (status === 400 || msg.includes('INVALID_ARGUMENT')) {
    if (msg.includes('safety') || msg.includes('blocked')) {
      return new Error('Tin nhắn bị từ chối do vi phạm chính sách an toàn.');
    }
    if (/file\s*search|filesearch|store/i.test(msg)) {
      return new Error('KB active chưa sẵn sàng hoặc File Search store không hợp lệ. Kiểm tra tài liệu đã học xong và thử lại.');
    }
    return new Error('Yêu cầu không hợp lệ. Vui lòng thử lại với nội dung khác.');
  }
  // 403 — forbidden / API key issue
  if (status === 403 || msg.includes('PERMISSION_DENIED')) {
    return new Error('API key không hợp lệ hoặc đã hết hạn. Vui lòng liên hệ quản trị viên.');
  }
  // Anything else was not written for the user (database, storage, network,
  // provider or internal validation text): the detail goes to the server log,
  // the user gets one plain message.
  console.warn('[AI Chatbot] Unexpected error shown as a generic message:', msg.slice(0, 500));
  return new Error('Đã xảy ra lỗi khi xử lý tin nhắn. Vui lòng thử lại.');
}

export function logLessonAuthorFlow(stage: string, details: Record<string, unknown> = {}): void {
  console.log(`[LessonAuthorFlow] ${stage}`, details);
}

// Moved from chat.service.ts (used by the chat turn prompt and stream stages).
export function logChatCourseFlow(stage: string, details: Record<string, unknown> = {}): void {
  console.log(`[ChatCourseFlow] ${stage}`, details);
}
