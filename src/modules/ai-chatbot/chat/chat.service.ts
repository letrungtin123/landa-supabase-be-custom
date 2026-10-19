// ═══════════════════════════════════════════════════════════════
// Chat Service — Optimized for millions of users
// Features: cursor-based pagination, rate limiting, concurrency
// control, tenant isolation, CTE queries, retry with backoff
// ═══════════════════════════════════════════════════════════════

import { query, withDatabaseTransaction } from '../../../config/database.js';
import { cacheJson, getCacheVersion } from '../../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../../config/cache-keys.js';
import { invalidateTenantAiCaches } from '../../../config/cache-invalidation.js';
import { AppError } from '../../../middleware/error-handler.js';
import { CHAT_TARGETS, LESSON_AUTHOR_TARGET } from './chat.constants.js';
import type { ChatTarget } from './chat.constants.js';
import type {
  ChatMessage,
  KbAssignment,
  LessonAuthorSourceDocument,
  ChatStreamOptions,
  ChatStreamSideEvent,
} from './chat.types.js';
import {
  rateLimitMap,
  isValidUUID,
  getActiveKbAssignment,
  invalidateGeminiStoreNameCache,
  streamLocks,
  logLessonAuthorFlow,
  markRateLimit,
} from './chat-turn-runtime.service.js';
import {
  hydrateLessonAuthorProposalMessages,
  hydrateLessonAuthorBlueprintMessages,
} from '../ai-id/legacy/message-hydration.service.js';
import { sweepCourseOutlineCache } from './chat-course-context.service.js';
import type { FinalizeAiReservation } from './chat-turn.types.js';
import { admitChatTurn } from './chat-turn-admission.service.js';
import { resolveChatTurnContext } from './chat-turn-context.service.js';
import { reserveChatTurn } from './chat-turn-reserve.service.js';
import { persistChatTurnAnswer, persistChatTurnUserMessage } from './chat-turn-persist.service.js';
import { answerAdminReportTurn } from './chat-turn-report.service.js';
import { buildChatTurnPrompt } from './chat-turn-prompt.service.js';
import { streamChatTurnAnswer } from './chat-turn-stream.service.js';
import { createChatTurnState, failChatTurn, finalizeChatTurnReservation, settleChatTurn } from './chat-turn-settle.service.js';
import {
  answerLessonAuthorAction,
  answerLessonAuthorClarification,
  resolveLessonAuthorTurnIntent,
} from '../ai-id/legacy/chat-turn-intent.service.js';
import { answerLessonAuthorBlueprintTurn } from '../ai-id/legacy/chat-turn-blueprint.service.js';
import { answerLessonAuthorDraftTurn } from '../ai-id/legacy/chat-turn-draft.service.js';

// AI ID V1 / lesson-author legacy code lives in the ai-id/legacy/ folder, and the chat
// helpers it shares in ./chat.constants.ts, ./chat.types.ts, ./chat-turn-runtime.service.ts
// and ./chat-turn.logic.ts. Re-exported here so existing imports keep working.
export type { ChatTarget } from './chat.constants.js';
export type {
  ChatMessage,
  LessonAuthorSourceDocumentInput,
  LessonAuthorSourceDocument,
  KbAssignment,
  ChatStreamOptions,
  ChatStreamSideEvent,
} from './chat.types.js';
export {
  invalidateGeminiStoreNameCache,
  getActiveKbAssignment,
  getActiveKbAssignmentFresh,
} from './chat-turn-runtime.service.js';
export { applyLessonAuthorJob } from '../ai-id/legacy/job-apply.service.js';
export {
  withLessonAuthorConversationLock,
  assertDurableBlueprintActor,
  prepareDurableBlueprint,
  prepareWorkspaceContentRuntime,
} from '../ai-id/legacy/durable-blueprint.service.js';
export type {
  LessonAuthorOutlineMention,
  LessonAuthorBlueprintLesson,
  LessonAuthorBlueprintComponentPlan,
  LessonAuthorBlueprintMediaPlan,
  LessonAuthorBlueprintUnit,
  LessonAuthorBlueprintChapter,
  LessonAuthorBlueprintQualityReport,
  LessonAuthorBlueprint,
  LessonAuthorSourceFactAllocationV1,
  LessonAuthorSourceFactAllocationV2,
  LessonAuthorSourceFactAllocationV3,
  LessonAuthorSourceFactAllocation,
  LessonAuthorSourceEvidenceScopeAllocation,
  AppliedLessonAuthorJob,
} from '../ai-id/legacy/types.js';
export { normalizeLessonAuthorProposal } from '../ai-id/legacy/proposal-normalize.logic.js';
export { normalizeLessonAuthorBlueprint } from '../ai-id/legacy/blueprint-normalize.logic.js';
export { blueprintDraftArchitecture, lockProposalToBlueprintChapter } from '../ai-id/legacy/blueprint-store.service.js';
export { getChapterCheckpointStatus } from '../ai-id/legacy/chapter-checkpoint.service.js';

// ── Constants ──
const MAX_CONVERSATIONS_PER_USER = 10;
const MESSAGES_PAGE_SIZE = 50;            // Cursor-based pagination

export function isChatTarget(value: string): value is ChatTarget {
  return (CHAT_TARGETS as readonly string[]).includes(value);
}

// Cleanup every 5 minutes to prevent memory leak (startChatCacheSweepers)
function sweepRateLimitMap(): void {
  const now = Date.now();
  for (const [key, ts] of rateLimitMap) {
    if (now - ts > 60_000) rateLimitMap.delete(key);
  }
}

let chatCacheSweepers: NodeJS.Timeout[] | null = null;
/** Started once per process by the process startup (every role) or a worker entry point, never at import. */
export function startChatCacheSweepers(): NodeJS.Timeout[] {
  chatCacheSweepers ??= [setInterval(sweepRateLimitMap, 5 * 60_000), setInterval(sweepCourseOutlineCache, 10 * 60_000)];
  return chatCacheSweepers;
}

// ── Types ──
export interface ChatConversation {
  id: string;
  tenant_id: string;
  bot_id: string;
  persona_id: string;
  user_id: string;
  target: ChatTarget;
  course_id: string | null;
  metadata: Record<string, unknown>;
  title: string;
  created_at: string;
  updated_at: string;
  persona_name?: string;
  persona_avatar_url?: string | null;
  last_message?: string | null;
  last_message_at?: string | null;
  message_count?: number;
}

export interface PaginatedMessages {
  messages: ChatMessage[];
  has_more: boolean;
  next_cursor: string | null; // created_at of the oldest message returned
}

interface BotAssignment {
  id: string;
  tenant_id: string;
  target: ChatTarget;
  bot_id: string;
  bot_name: string;
  bot_avatar_url: string | null;
  bot_kb_id: string | null;
  bot_kb_name: string | null;
  ai_active_engine: 'gemini_file_search' | 'self_built_rag';
}

export interface PersonaAssignment {
  id: string;
  tenant_id: string;
  target: typeof LESSON_AUTHOR_TARGET;
  bot_id: string;
  persona_id: string;
  persona_name: string;
  persona_avatar_url: string | null;
  persona_fullbody_url: string | null;
  updated_at: string;
}

export interface LessonAuthorSettings {
  active_bot: BotAssignment | null;
  active_kb: KbAssignment | null;
  active_persona: PersonaAssignment | null;
}

export interface ListLessonAuthorSourceDocumentsOptions {
  search?: string;
  limit?: number;
}

// ═══════════════════════════════════════════════════════════════
// Bot Assignments
// ═══════════════════════════════════════════════════════════════

export async function getAssignments(tenantId: string): Promise<BotAssignment[]> {
  const version = await getCacheVersion(...cacheVersions.tenantAi(tenantId));
  return cacheJson(
    cacheKeys.aiTenantResource(tenantId, 'assignments', version),
    CACHE_TTL.aiConfig,
    () => getAssignmentsFromDb(tenantId),
  );
}

async function getAssignmentsFromDb(tenantId: string): Promise<BotAssignment[]> {
  const result = await query<BotAssignment>(
    `SELECT tba.*, c.name AS bot_name, c.avatar_url AS bot_avatar_url, c.kb_id AS bot_kb_id, kb.name AS bot_kb_name,
            COALESCE(tas.active_engine, 'gemini_file_search') AS ai_active_engine
     FROM tenant_bot_assignments tba
     JOIN chatbots c ON c.id = tba.bot_id AND c.tenant_id = tba.tenant_id
     LEFT JOIN knowledgebases kb ON kb.id = c.kb_id AND kb.tenant_id = c.tenant_id
     LEFT JOIN tenant_ai_settings tas ON tas.tenant_id = tba.tenant_id
     WHERE tba.tenant_id = $1
     ORDER BY tba.target ASC`,
    [tenantId],
  );
  return result.rows;
}

export async function getActiveBot(tenantId: string, target: ChatTarget): Promise<BotAssignment | null> {
  const version = await getCacheVersion(...cacheVersions.tenantAi(tenantId));
  return cacheJson(
    cacheKeys.aiTenantResource(tenantId, 'active-bot', version, { target }),
    CACHE_TTL.aiConfig,
    () => getActiveBotFromDb(tenantId, target),
  );
}

async function getActiveBotFromDb(tenantId: string, target: ChatTarget): Promise<BotAssignment | null> {
  const result = await query<BotAssignment>(
    `SELECT tba.*, c.name AS bot_name, c.avatar_url AS bot_avatar_url, c.kb_id AS bot_kb_id, kb.name AS bot_kb_name,
            COALESCE(tas.active_engine, 'gemini_file_search') AS ai_active_engine
     FROM tenant_bot_assignments tba
     JOIN chatbots c ON c.id = tba.bot_id AND c.tenant_id = tba.tenant_id
     LEFT JOIN knowledgebases kb ON kb.id = c.kb_id AND kb.tenant_id = c.tenant_id
     LEFT JOIN tenant_ai_settings tas ON tas.tenant_id = tba.tenant_id
     WHERE tba.tenant_id = $1 AND tba.target = $2`,
    [tenantId, target],
  );
  return result.rows[0] || null;
}

export async function assignBot(tenantId: string, target: ChatTarget, botId: string): Promise<void> {
  if (!isValidUUID(botId)) throw new AppError('bot_id không hợp lệ', 400);

  const botCheck = await query<{ id: string }>(
    `SELECT id FROM chatbots WHERE id = $1 AND tenant_id = $2`,
    [botId, tenantId],
  );
  if (!botCheck.rowCount || botCheck.rowCount === 0) {
    throw new AppError('Bot không tồn tại, không thuộc tenant, hoặc đã bị tắt', 404);
  }

  await query(
    `INSERT INTO tenant_bot_assignments (tenant_id, target, bot_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, target) DO UPDATE SET bot_id = $3, created_at = now()`,
    [tenantId, target, botId],
  );

  if (target === LESSON_AUTHOR_TARGET) {
    await resolveLessonAuthorPersonaForBot(tenantId, botId);
  }
  await invalidateTenantAiCaches(tenantId);
}

export async function unassignBot(tenantId: string, target: ChatTarget): Promise<boolean> {
  const result = await query(
    `DELETE FROM tenant_bot_assignments WHERE tenant_id = $1 AND target = $2`,
    [tenantId, target],
  );
  if ((result.rowCount ?? 0) > 0) await invalidateTenantAiCaches(tenantId);
  return (result.rowCount ?? 0) > 0;
}

async function resolveLessonAuthorPersonaForBot(
  tenantId: string,
  botId: string,
  opts: { strict?: boolean } = {},
): Promise<PersonaAssignment | null> {
  if (!isValidUUID(botId)) throw new AppError('bot_id không hợp lệ', 400);

  const result = await query<PersonaAssignment>(
    `WITH bot_check AS (
       SELECT id
       FROM chatbots
       WHERE id = $2 AND tenant_id = $1
     ), active_template AS (
       SELECT id, name, avatar_url, fullbody_url, sort_order
       FROM system_prompt_templates
       WHERE is_lesson_author = true
       ORDER BY is_active DESC, updated_at DESC, sort_order ASC, id ASC
       LIMIT 1
     ), inserted_persona AS (
       INSERT INTO bot_personas (bot_id, template_id, sort_order)
       SELECT bot_check.id, active_template.id, active_template.sort_order
       FROM bot_check
       CROSS JOIN active_template
       ON CONFLICT (bot_id, template_id)
       DO NOTHING
       RETURNING id, bot_id, template_id, updated_at
     ), resolved_persona AS (
       SELECT id, bot_id, template_id, updated_at
       FROM inserted_persona
       UNION ALL
       SELECT bp.id, bp.bot_id, bp.template_id, bp.updated_at
       FROM bot_personas bp
       JOIN bot_check ON bot_check.id = bp.bot_id
       JOIN active_template ON active_template.id = bp.template_id
       WHERE NOT EXISTS (SELECT 1 FROM inserted_persona)
     )
     SELECT resolved_persona.id,
            $1::uuid AS tenant_id,
            $3::varchar AS target,
            resolved_persona.bot_id,
            resolved_persona.id AS persona_id,
            active_template.name AS persona_name,
            active_template.avatar_url AS persona_avatar_url,
            active_template.fullbody_url AS persona_fullbody_url,
            resolved_persona.updated_at
     FROM resolved_persona
     JOIN active_template ON active_template.id = resolved_persona.template_id`,
    [tenantId, botId, LESSON_AUTHOR_TARGET],
  );

  if (result.rows[0]) return result.rows[0];
  if (!opts.strict) return null;

  const check = await query<{ has_bot: boolean; has_template: boolean }>(
    `SELECT
       EXISTS(SELECT 1 FROM chatbots WHERE id = $2 AND tenant_id = $1) AS has_bot,
       EXISTS(SELECT 1 FROM system_prompt_templates WHERE is_lesson_author = true) AS has_template`,
    [tenantId, botId],
  );

  if (!check.rows[0]?.has_bot) {
    throw new AppError('Bot không tồn tại hoặc không thuộc tenant', 404);
  }
  if (!check.rows[0]?.has_template) {
    throw new AppError('Chưa cấu hình nhân cách chuyên gia bài học trong Prompt hệ thống', 409);
  }
  return null;
}

export async function getLessonAuthorSettings(tenantId: string): Promise<LessonAuthorSettings> {
  const version = await getCacheVersion(...cacheVersions.tenantAi(tenantId));
  return cacheJson(
    cacheKeys.aiTenantResource(tenantId, 'lesson-author-settings', version),
    CACHE_TTL.aiConfig,
    () => getLessonAuthorSettingsFromDb(tenantId),
  );
}

async function getLessonAuthorSettingsFromDb(tenantId: string): Promise<LessonAuthorSettings> {
  const [activeBot, activeKb] = await Promise.all([
    getActiveBot(tenantId, LESSON_AUTHOR_TARGET),
    getActiveKbAssignment(tenantId),
  ]);
  const activePersona = activeBot
    ? await resolveLessonAuthorPersonaForBot(tenantId, activeBot.bot_id)
    : null;
  return { active_bot: activeBot, active_kb: activeKb, active_persona: activePersona };
}

export async function listLessonAuthorSourceDocuments(
  tenantId: string,
  options: ListLessonAuthorSourceDocumentsOptions = {},
): Promise<LessonAuthorSourceDocument[]> {
  const [activeBot, activeKb] = await Promise.all([
    getActiveBot(tenantId, LESSON_AUTHOR_TARGET),
    getActiveKbAssignment(tenantId),
  ]);
  if (!activeBot || !activeKb) return [];

  const search = options.search?.trim() || '';
  const requestedLimit = Number.isFinite(options.limit || NaN) ? Number(options.limit) : 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 50);
  const result = await query<LessonAuthorSourceDocument>(
    `SELECT d.id::text AS document_id,
            d.kb_id::text AS kb_id,
            d.name,
            d.type,
            d.status,
            d.source_info,
            NULL::text AS gemini_path,
            NULL::text AS content_excerpt
     FROM kb_documents d
     WHERE d.tenant_id = $1
       AND d.kb_id = $2
       AND d.type = 'file'
       AND d.status IN ('learning', 'learned')
       AND ($3 = '' OR d.name ILIKE '%' || $3 || '%')
     ORDER BY d.updated_at DESC, d.created_at DESC
     LIMIT $4`,
    [tenantId, activeKb.kb_id, search, limit],
  );
  return result.rows;
}

export async function assignLessonAuthorKb(tenantId: string, kbId: string): Promise<void> {
  if (!isValidUUID(kbId)) throw new AppError('kb_id không hợp lệ', 400);

  const kbCheck = await query<{ id: string }>(
    `SELECT id FROM knowledgebases WHERE id = $1 AND tenant_id = $2`,
    [kbId, tenantId],
  );
  if (!kbCheck.rowCount || kbCheck.rowCount === 0) {
    throw new AppError('KB không tồn tại hoặc không thuộc tenant', 404);
  }

  await query(
    `INSERT INTO tenant_kb_assignments (tenant_id, target, kb_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, target)
     DO UPDATE SET kb_id = $3, updated_at = now()`,
    [tenantId, LESSON_AUTHOR_TARGET, kbId],
  );

  invalidateGeminiStoreNameCache(kbId);
  await invalidateTenantAiCaches(tenantId);
}

export async function unassignLessonAuthorKb(tenantId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM tenant_kb_assignments WHERE tenant_id = $1 AND target = $2`,
    [tenantId, LESSON_AUTHOR_TARGET],
  );
  if ((result.rowCount ?? 0) > 0) await invalidateTenantAiCaches(tenantId);
  return (result.rowCount ?? 0) > 0;
}

// ═══════════════════════════════════════════════════════════════
// Conversations — with tenant isolation
// ═══════════════════════════════════════════════════════════════

export async function listConversations(
  userId: string,
  botId: string,
  tenantId: string,
  target: ChatTarget = 'admin',
  courseId?: string,
): Promise<ChatConversation[]> {
  if (target === LESSON_AUTHOR_TARGET && !courseId) {
    throw new AppError('courseId is required for lesson_author conversations', 400);
  }
  const result = await query<ChatConversation>(
    `SELECT cc.*,
            COALESCE(bp.custom_name, spt.name) AS persona_name,
            spt.avatar_url AS persona_avatar_url,
            lm.content AS last_message,
            lm.created_at AS last_message_at
     FROM chat_conversations cc
     JOIN tenant_bot_assignments tba
       ON tba.tenant_id = cc.tenant_id
      AND tba.target = cc.target
      AND tba.bot_id = cc.bot_id
     JOIN chatbots c ON c.id = cc.bot_id AND c.tenant_id = cc.tenant_id
     JOIN bot_personas bp ON bp.id = cc.persona_id
     JOIN system_prompt_templates spt ON spt.id = bp.template_id
     LEFT JOIN LATERAL (
       SELECT content, created_at FROM chat_messages
       WHERE conversation_id = cc.id
       ORDER BY created_at DESC LIMIT 1
     ) lm ON true
     WHERE cc.user_id = $1
       AND cc.bot_id = $2
       AND cc.tenant_id = $3
       AND cc.target = $4
       AND (($5::text IS NULL AND cc.course_id IS NULL) OR cc.course_id = $5)
     ORDER BY cc.updated_at DESC`,
    [userId, botId, tenantId, target, courseId ?? null],
  );
  return result.rows;
}

export async function createConversation(
  userId: string,
  tenantId: string,
  botId: string,
  personaId: string | null,
  target: ChatTarget = 'admin',
  courseId?: string,
): Promise<ChatConversation> {
  if (target === LESSON_AUTHOR_TARGET && !courseId) {
    throw new AppError('courseId is required for lesson_author conversations', 400);
  }

  if (target === LESSON_AUTHOR_TARGET) {
    const activePersona = await resolveLessonAuthorPersonaForBot(tenantId, botId, { strict: true });
    personaId = activePersona?.persona_id ?? null;
  }

  if (!personaId || !isValidUUID(personaId)) throw new AppError('persona_id không hợp lệ', 400);

  return withDatabaseTransaction(async () => {
    // Serializes the per-user/course cap across every backend instance. The
    // transaction lock is short and never surrounds provider or network work.
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 20261002))`, [
      `chat-conversation-create:${tenantId}:${userId}:${target}:${courseId ?? ''}`,
    ]);

    // Count + authority checks remain in the same transaction as INSERT.
    const result = await query<ChatConversation & { conv_count: number; persona_valid: boolean; assignment_valid: boolean }>(
      `WITH counts AS (
       SELECT COUNT(*)::int AS cnt
       FROM chat_conversations
       WHERE user_id = $1
         AND bot_id = $3
         AND tenant_id = $2
         AND target = $5
         AND (($6::text IS NULL AND course_id IS NULL) OR course_id = $6)
     ), persona_check AS (
       SELECT EXISTS(SELECT 1 FROM bot_personas WHERE id = $4 AND bot_id = $3) AS valid
     ), assignment_check AS (
       SELECT EXISTS(
         SELECT 1
         FROM tenant_bot_assignments tba
         JOIN chatbots c ON c.id = tba.bot_id AND c.tenant_id = tba.tenant_id
         WHERE tba.tenant_id = $2
           AND tba.target = $5
           AND tba.bot_id = $3
       ) AS valid
     )
     SELECT counts.cnt AS conv_count,
            persona_check.valid AS persona_valid,
            assignment_check.valid AS assignment_valid
      FROM counts, persona_check, assignment_check`,
      [userId, tenantId, botId, personaId, target, courseId ?? null],
    );

    const { conv_count, persona_valid, assignment_valid } = result.rows[0];
    if (!assignment_valid) throw new AppError('Chưa có bot nào được triển khai cho khu vực này', 409);
    if (conv_count >= MAX_CONVERSATIONS_PER_USER) {
      throw new AppError(`Tối đa ${MAX_CONVERSATIONS_PER_USER} cuộc hội thoại. Vui lòng xoá bớt.`, 409);
    }
    if (!persona_valid) throw new AppError('Nhân cách không hợp lệ cho bot này', 400);

    const insertResult = await query<ChatConversation>(
      `INSERT INTO chat_conversations (tenant_id, bot_id, persona_id, user_id, target, course_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [tenantId, botId, personaId, userId, target, courseId ?? null, { created_from: target }],
    );
    return insertResult.rows[0];
  });
}

export async function deleteConversation(
  conversationId: string,
  userId: string,
  tenantId: string,
  expectedTarget?: ChatTarget,
): Promise<boolean> {
  if (!isValidUUID(conversationId)) throw new AppError('ID không hợp lệ', 400);
  if (expectedTarget === LESSON_AUTHOR_TARGET) {
    throw new AppError('Phiên AI Instructional Design phải được xóa từ danh sách bản thảo.', 409);
  }

  const result = await query(
    `DELETE FROM chat_conversations
     USING tenant_bot_assignments tba, chatbots c
     WHERE chat_conversations.id = $1
       AND chat_conversations.user_id = $2
       AND chat_conversations.tenant_id = $3
       AND tba.tenant_id = chat_conversations.tenant_id
       AND tba.target = chat_conversations.target
       AND tba.bot_id = chat_conversations.bot_id
       AND c.id = chat_conversations.bot_id
       AND c.tenant_id = chat_conversations.tenant_id
       AND chat_conversations.target <> 'lesson_author'
       AND ($4::text IS NULL OR chat_conversations.target = $4)`,
    [conversationId, userId, tenantId, expectedTarget ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

// ═══════════════════════════════════════════════════════════════
// Messages — Cursor-based pagination (load newest first)
// ═══════════════════════════════════════════════════════════════

export async function getConversationMessages(
  conversationId: string,
  userId: string,
  tenantId: string,
  cursor?: string,
  expectedTarget?: ChatTarget,
): Promise<PaginatedMessages> {
  if (!isValidUUID(conversationId)) throw new AppError('ID không hợp lệ', 400);

  // Validate ownership + tenant in one query
  const convCheck = await query<{ id: string }>(
    `SELECT cc.id FROM chat_conversations cc
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
  if (!convCheck.rowCount || convCheck.rowCount === 0) {
    throw new AppError('Cuộc hội thoại không tồn tại', 404);
  }

  // Cursor-based: load N+1 messages BEFORE cursor (newest first), then reverse
  const limit = MESSAGES_PAGE_SIZE + 1; // +1 to check has_more

  let messages: ChatMessage[];
  if (cursor) {
    const result = await query<ChatMessage>(
      `SELECT * FROM chat_messages
       WHERE conversation_id = $1 AND created_at < $2
       ORDER BY created_at DESC LIMIT $3`,
      [conversationId, cursor, limit],
    );
    messages = result.rows;
  } else {
    // First page: load newest messages
    const result = await query<ChatMessage>(
      `SELECT * FROM chat_messages
       WHERE conversation_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [conversationId, limit],
    );
    messages = result.rows;
  }

  const hasMore = messages.length > MESSAGES_PAGE_SIZE;
  if (hasMore) messages.pop(); // remove the extra one

  // Reverse to chronological order for FE
  messages.reverse();
  messages = await hydrateLessonAuthorProposalMessages(messages, conversationId, tenantId);
  messages = await hydrateLessonAuthorBlueprintMessages(messages, conversationId, tenantId);

  return {
    messages,
    has_more: hasMore,
    next_cursor: hasMore ? messages[0]?.created_at || null : null,
  };
}

// ═══════════════════════════════════════════════════════════════
// Send Message + Gemini Stream (SSE)
// Optimized: CTE context loading, rate limit, concurrency lock,
// retry on 503, store name caching
// ═══════════════════════════════════════════════════════════════

/**
 * Core chat function — optimized for production scale.
 *
 * Optimizations:
 * 1. Rate limiting (1 msg / 3s / user)
 * 2. Concurrency lock (1 stream / conversation)
 * 3. CTE for context loading (1 query instead of 3)
 * 4. Store name caching (avoids DB hit per message)
 * 5. Auto-retry on Gemini 503 (up to 2 retries)
 * 6. Tenant isolation on all queries
 * 7. Content sanitization
 * 8. Auto-title only on first message pair
 *
 * The turn runs as named stages (chat-turn.types.ts): validate, resolve context,
 * reserve, build prompt, stream provider, persist, settle. The AI Report entry and
 * the AI ID V1 answers (ai-id/legacy/chat-turn-*.ts) answer instead of the chat stages.
 */
export async function sendMessageStream(
  conversationId: string,
  userId: string,
  tenantId: string,
  userContent: string,
  options: ChatStreamOptions,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onSideEvent?: (event: ChatStreamSideEvent) => void,
): Promise<void> {
  const admitted = await admitChatTurn(conversationId, userId, userContent, options, onError);
  if (!admitted) return;
  const { trimmed, distributedStreamLock } = admitted;

  const state = createChatTurnState();
  const finalizeAiReservation: FinalizeAiReservation = (usage, source, metadata = {}) =>
    finalizeChatTurnReservation(state, usage, source, metadata);

  try {
    const turn = await resolveChatTurnContext(
      { conversationId, userId, tenantId, trimmed, options, onChunk, onDone, onSideEvent, finalizeAiReservation },
      state,
    );
    if (!turn) return;
    const { ctx } = turn;
    const budget = await reserveChatTurn(turn, state);

    // 2. Mark rate limit AFTER validation passes
    markRateLimit(userId);

    await persistChatTurnUserMessage(turn);

    if (await answerAdminReportTurn(turn)) return;

    // ── AI ID V1 / lesson-author answers (ai-id/legacy/chat-turn-*.ts) ──
    const intent = await resolveLessonAuthorTurnIntent(turn, budget);
    const { lessonAuthorIntent } = intent;
    if (await answerLessonAuthorClarification(turn, budget, intent)) return;
    if (await answerLessonAuthorAction(turn, budget, intent)) return;
    if (ctx.target === LESSON_AUTHOR_TARGET && lessonAuthorIntent === 'course_blueprint') {
      await answerLessonAuthorBlueprintTurn(turn, budget);
      return;
    }
    if (ctx.target === LESSON_AUTHOR_TARGET && lessonAuthorIntent === 'draft_lesson') {
      await answerLessonAuthorDraftTurn(turn, budget, intent);
      return;
    }

    // 4-8. Chat answer: prompt, provider stream, persist, settle.
    const prompt = await buildChatTurnPrompt(turn, budget);
    const answer = await streamChatTurnAnswer(turn, budget, prompt, state);
    const assistantContent = await persistChatTurnAnswer(turn, budget, intent, answer);
    await settleChatTurn(turn, budget, prompt, answer, assistantContent);
  } catch (err) {
    await failChatTurn(state, conversationId, err, onError);
  } finally {
    await distributedStreamLock.release();
    logLessonAuthorFlow('stream_lock_released', { correlation_id: state.lessonAuthorCorrelationId, conversation_id: conversationId });
    streamLocks.delete(conversationId);
  }
}
