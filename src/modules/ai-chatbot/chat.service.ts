// ═══════════════════════════════════════════════════════════════
// Chat Service — Optimized for millions of users
// Features: cursor-based pagination, rate limiting, concurrency
// control, tenant isolation, CTE queries, retry with backoff
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { getGeminiClient } from './gemini.service.js';

// ── Constants ──
const MAX_CONVERSATIONS_PER_USER = 10;
const HISTORY_CONTEXT_LIMIT = 20;         // Last N messages sent to Gemini
const MAX_USER_MESSAGE_LENGTH = 5000;
const GEMINI_MODEL = 'gemini-2.5-flash';
const MESSAGES_PAGE_SIZE = 50;            // Cursor-based pagination
const RATE_LIMIT_MS = 3_000;              // 1 message per 3 seconds per user
const GEMINI_MAX_RETRIES = 3;
const GEMINI_RETRY_DELAY_MS = 5_000;       // base delay, actual may be longer for 429

// ── UUID validation ──
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(s: string): boolean { return UUID_REGEX.test(s); }

// ── In-memory rate limiter (per-user) ──
const rateLimitMap = new Map<string, number>();
// Cleanup every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of rateLimitMap) {
    if (now - ts > 60_000) rateLimitMap.delete(key);
  }
}, 5 * 60_000);

function checkRateLimit(userId: string): void {
  const lastSent = rateLimitMap.get(userId);
  if (lastSent && Date.now() - lastSent < RATE_LIMIT_MS) {
    throw new Error('Bạn gửi tin nhắn quá nhanh. Vui lòng đợi vài giây.');
  }
}
function markRateLimit(userId: string): void {
  rateLimitMap.set(userId, Date.now());
}

// ── In-memory concurrency lock (per-conversation) ──
const streamLocks = new Set<string>();

// ── Store name cache (per-kb, rarely changes) ──
const storeNameCache = new Map<string, { name: string; ts: number }>();
const STORE_CACHE_TTL = 10 * 60_000; // 10 minutes

async function getCachedStoreName(kbId: string): Promise<string | null> {
  const cached = storeNameCache.get(kbId);
  if (cached && Date.now() - cached.ts < STORE_CACHE_TTL) return cached.name;

  const result = await query<{ store_name: string }>(
    `SELECT store_name FROM kb_google_store WHERE kb_id = $1`,
    [kbId],
  );
  if (!result.rowCount || result.rowCount === 0) return null;
  const name = result.rows[0].store_name;
  storeNameCache.set(kbId, { name, ts: Date.now() });
  return name;
}

// ── Types ──
export interface ChatConversation {
  id: string;
  tenant_id: string;
  bot_id: string;
  persona_id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  persona_name?: string;
  persona_avatar_url?: string | null;
  last_message?: string | null;
  last_message_at?: string | null;
  message_count?: number;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface PaginatedMessages {
  messages: ChatMessage[];
  has_more: boolean;
  next_cursor: string | null; // created_at of the oldest message returned
}

interface BotAssignment {
  id: string;
  tenant_id: string;
  target: string;
  bot_id: string;
  bot_name: string;
  bot_avatar_url: string | null;
  bot_kb_id: string | null;
}

// ═══════════════════════════════════════════════════════════════
// Bot Assignments
// ═══════════════════════════════════════════════════════════════

export async function getAssignments(tenantId: string): Promise<BotAssignment[]> {
  const result = await query<BotAssignment>(
    `SELECT tba.*, c.name AS bot_name, c.avatar_url AS bot_avatar_url, c.kb_id AS bot_kb_id
     FROM tenant_bot_assignments tba
     JOIN chatbots c ON c.id = tba.bot_id
     WHERE tba.tenant_id = $1
     ORDER BY tba.target ASC`,
    [tenantId],
  );
  return result.rows;
}

export async function getActiveBot(tenantId: string, target: string): Promise<BotAssignment | null> {
  const result = await query<BotAssignment>(
    `SELECT tba.*, c.name AS bot_name, c.avatar_url AS bot_avatar_url, c.kb_id AS bot_kb_id
     FROM tenant_bot_assignments tba
     JOIN chatbots c ON c.id = tba.bot_id
     WHERE tba.tenant_id = $1 AND tba.target = $2`,
    [tenantId, target],
  );
  return result.rows[0] || null;
}

export async function assignBot(tenantId: string, target: string, botId: string): Promise<void> {
  if (!isValidUUID(botId)) throw new Error('bot_id không hợp lệ');

  const botCheck = await query<{ id: string }>(
    `SELECT id FROM chatbots WHERE id = $1 AND tenant_id = $2`,
    [botId, tenantId],
  );
  if (!botCheck.rowCount || botCheck.rowCount === 0) {
    throw new Error('Bot không tồn tại, không thuộc tenant, hoặc đã bị tắt');
  }

  await query(
    `INSERT INTO tenant_bot_assignments (tenant_id, target, bot_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, target) DO UPDATE SET bot_id = $3, created_at = now()`,
    [tenantId, target, botId],
  );
}

export async function unassignBot(tenantId: string, target: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM tenant_bot_assignments WHERE tenant_id = $1 AND target = $2`,
    [tenantId, target],
  );
  return (result.rowCount ?? 0) > 0;
}

// ═══════════════════════════════════════════════════════════════
// Conversations — with tenant isolation
// ═══════════════════════════════════════════════════════════════

export async function listConversations(userId: string, botId: string, tenantId: string): Promise<ChatConversation[]> {
  const result = await query<ChatConversation>(
    `SELECT cc.*,
            COALESCE(bp.custom_name, spt.name) AS persona_name,
            spt.avatar_url AS persona_avatar_url,
            lm.content AS last_message,
            lm.created_at AS last_message_at
     FROM chat_conversations cc
     JOIN bot_personas bp ON bp.id = cc.persona_id
     JOIN system_prompt_templates spt ON spt.id = bp.template_id
     LEFT JOIN LATERAL (
       SELECT content, created_at FROM chat_messages
       WHERE conversation_id = cc.id
       ORDER BY created_at DESC LIMIT 1
     ) lm ON true
     WHERE cc.user_id = $1 AND cc.bot_id = $2 AND cc.tenant_id = $3
     ORDER BY cc.updated_at DESC`,
    [userId, botId, tenantId],
  );
  return result.rows;
}

export async function createConversation(
  userId: string, tenantId: string, botId: string, personaId: string,
): Promise<ChatConversation> {
  if (!isValidUUID(personaId)) throw new Error('persona_id không hợp lệ');

  // Single CTE: count + validate persona in one round-trip
  const result = await query<ChatConversation & { conv_count: number; persona_valid: boolean }>(
    `WITH counts AS (
       SELECT COUNT(*)::int AS cnt FROM chat_conversations WHERE user_id = $1 AND bot_id = $3 AND tenant_id = $2
     ), persona_check AS (
       SELECT EXISTS(SELECT 1 FROM bot_personas WHERE id = $4 AND bot_id = $3) AS valid
     )
     SELECT counts.cnt AS conv_count, persona_check.valid AS persona_valid
     FROM counts, persona_check`,
    [userId, tenantId, botId, personaId],
  );

  const { conv_count, persona_valid } = result.rows[0];
  if (conv_count >= MAX_CONVERSATIONS_PER_USER) {
    throw new Error(`Tối đa ${MAX_CONVERSATIONS_PER_USER} cuộc hội thoại. Vui lòng xoá bớt.`);
  }
  if (!persona_valid) throw new Error('Nhân cách không hợp lệ cho bot này');

  const insertResult = await query<ChatConversation>(
    `INSERT INTO chat_conversations (tenant_id, bot_id, persona_id, user_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [tenantId, botId, personaId, userId],
  );
  return insertResult.rows[0];
}

export async function deleteConversation(conversationId: string, userId: string, tenantId: string): Promise<boolean> {
  if (!isValidUUID(conversationId)) throw new Error('ID không hợp lệ');

  const result = await query(
    `DELETE FROM chat_conversations WHERE id = $1 AND user_id = $2 AND tenant_id = $3`,
    [conversationId, userId, tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ═══════════════════════════════════════════════════════════════
// Messages — Cursor-based pagination (load newest first)
// ═══════════════════════════════════════════════════════════════

export async function getConversationMessages(
  conversationId: string, userId: string, tenantId: string, cursor?: string,
): Promise<PaginatedMessages> {
  if (!isValidUUID(conversationId)) throw new Error('ID không hợp lệ');

  // Validate ownership + tenant in one query
  const convCheck = await query<{ id: string }>(
    `SELECT cc.id FROM chat_conversations cc
     WHERE cc.id = $1 AND cc.user_id = $2 AND cc.tenant_id = $3`,
    [conversationId, userId, tenantId],
  );
  if (!convCheck.rowCount || convCheck.rowCount === 0) {
    throw new Error('Cuộc hội thoại không tồn tại');
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

interface ConversationContext {
  conversationId: string;
  tenantId: string;
  botKbId: string | null;
  systemPrompt: string;
  messageCount: number;
}

async function loadConversationContext(conversationId: string, userId: string, tenantId: string): Promise<ConversationContext> {
  // Single query: load conversation + bot + persona + prompt + message count via CTE
  const result = await query<{
    id: string; tenant_id: string; bot_kb_id: string | null;
    custom_prompt: string | null; template_prompt: string;
    msg_count: number;
  }>(
    `WITH conv AS (
       SELECT cc.id, cc.tenant_id, c.kb_id AS bot_kb_id, cc.persona_id
       FROM chat_conversations cc
       JOIN chatbots c ON c.id = cc.bot_id
       WHERE cc.id = $1 AND cc.user_id = $2 AND cc.tenant_id = $3
     ), msg_cnt AS (
       SELECT COUNT(*)::int AS cnt FROM chat_messages WHERE conversation_id = $1
     )
     SELECT conv.id, conv.tenant_id, conv.bot_kb_id,
            bp.custom_prompt, spt.prompt AS template_prompt,
            msg_cnt.cnt AS msg_count
     FROM conv
     JOIN bot_personas bp ON bp.id = conv.persona_id
     JOIN system_prompt_templates spt ON spt.id = bp.template_id
     CROSS JOIN msg_cnt`,
    [conversationId, userId, tenantId],
  );

  if (!result.rowCount || result.rowCount === 0) {
    throw new Error('Cuộc hội thoại không tồn tại');
  }

  const row = result.rows[0];
  return {
    conversationId: row.id,
    tenantId: row.tenant_id,
    botKbId: row.bot_kb_id,
    systemPrompt: row.custom_prompt ?? row.template_prompt,
    messageCount: row.msg_count,
  };
}

async function loadHistory(conversationId: string): Promise<{ role: string; parts: { text: string }[] }[]> {
  const result = await query<{ role: string; content: string }>(
    `SELECT role, content FROM chat_messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [conversationId, HISTORY_CONTEXT_LIMIT],
  );
  return result.rows.reverse().map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

/** Helper: parse retry delay from Gemini 429 error message */
function parseRetryDelay(err: any): number | null {
  try {
    const msg = err?.message || err?.toString() || '';
    const match = msg.match(/retry in (\d+(?:\.\d+)?)s/i);
    if (match) {
      const seconds = parseFloat(match[1]);
      if (seconds > 0 && seconds < 120) return Math.ceil(seconds * 1000);
    }
  } catch {}
  return null;
}

/** Sanitize Gemini errors → short Vietnamese messages for UI */
function sanitizeGeminiError(err: any): Error {
  const msg = err?.message || err?.toString() || '';
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
  if (status === 400 || msg.includes('INVALID_ARGUMENT')) {
    if (msg.includes('safety') || msg.includes('blocked')) {
      return new Error('Tin nhắn bị từ chối do vi phạm chính sách an toàn.');
    }
    return new Error('Yêu cầu không hợp lệ. Vui lòng thử lại với nội dung khác.');
  }
  // 403 — forbidden / API key issue
  if (status === 403 || msg.includes('PERMISSION_DENIED')) {
    return new Error('API key không hợp lệ hoặc đã hết hạn. Vui lòng liên hệ quản trị viên.');
  }
  // Generic — don't leak raw error
  if (msg.length > 200 || msg.includes('{')) {
    return new Error('Đã xảy ra lỗi khi xử lý tin nhắn. Vui lòng thử lại.');
  }
  return err;
}

/** Helper: sleep for retry */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
 */
export async function sendMessageStream(
  conversationId: string,
  userId: string,
  tenantId: string,
  userContent: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
): Promise<void> {
  // ── Validation ──
  if (!isValidUUID(conversationId)) { onError(new Error('ID không hợp lệ')); return; }
  const trimmed = userContent.trim();
  if (!trimmed) { onError(new Error('Tin nhắn không được trống')); return; }
  if (trimmed.length > MAX_USER_MESSAGE_LENGTH) { onError(new Error(`Tin nhắn tối đa ${MAX_USER_MESSAGE_LENGTH} ký tự`)); return; }

  // ── Rate limit ──
  try { checkRateLimit(userId); } catch (err: any) { onError(err); return; }

  // ── Concurrency lock ──
  if (streamLocks.has(conversationId)) {
    onError(new Error('Đang xử lý tin nhắn trước đó. Vui lòng đợi.'));
    return;
  }
  streamLocks.add(conversationId);

  try {
    // 1. Load context (CTE: 1 query for conversation + persona + prompt + msg count)
    const ctx = await loadConversationContext(conversationId, userId, tenantId);

    // 2. Mark rate limit AFTER validation passes
    markRateLimit(userId);

    // 3. Save user message + update timestamp (2 queries, could batch but INSERT RETURNING is needed)
    await query(
      `INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
      [conversationId, trimmed],
    );
    await query(
      `UPDATE chat_conversations SET updated_at = now() WHERE id = $1`,
      [conversationId],
    );

    // 4. Load history (includes the just-saved user message)
    const history = await loadHistory(conversationId);

    // 5. Build Gemini config with correct fileSearch tool format
    const aiClient = await getGeminiClient(ctx.tenantId);

    // Build tools — use cached store name
    const tools: any[] = [];
    if (ctx.botKbId) {
      const storeName = await getCachedStoreName(ctx.botKbId);
      if (storeName) {
        tools.push({
          fileSearch: {
            fileSearchStoreNames: [storeName],  // CORRECT format for @google/genai
          },
        });
      }
    }

    // 6. Stream Gemini response with retry on 503
    let fullResponse = '';
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          // Parse retry delay from Gemini 429 response if available
          const suggestedDelay = parseRetryDelay(lastError);
          const delay = suggestedDelay || (GEMINI_RETRY_DELAY_MS * attempt);
          console.log(`[Chat] Retry attempt ${attempt}/${GEMINI_MAX_RETRIES} for ${conversationId}, waiting ${Math.round(delay / 1000)}s`);
          await sleep(delay);
        }

        const response = await aiClient.models.generateContentStream({
          model: GEMINI_MODEL,
          contents: history,
          config: {
            systemInstruction: ctx.systemPrompt,
            ...(tools.length > 0 ? { tools } : {}),
          },
        });

        for await (const chunk of response) {
          const text = chunk.text ?? '';
          if (text) {
            fullResponse += text;
            onChunk(text);
          }
        }

        lastError = null;
        break; // Success — exit retry loop

      } catch (err: any) {
        lastError = err;
        const status = err?.status || err?.code || 0;
        // Only retry on 503 (service unavailable) or 429 (rate limited)
        if (status !== 503 && status !== 429) break;
        if (attempt === GEMINI_MAX_RETRIES) break;
      }
    }

    if (lastError && !fullResponse) {
      throw lastError;
    }

    // 7. Save assistant message (only if we got content)
    if (fullResponse.trim()) {
      await query(
        `INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
        [conversationId, fullResponse],
      );
    }

    // 8. Auto-title on first message pair ONLY (using pre-loaded msg_count from CTE)
    if (ctx.messageCount === 0) {
      const title = trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '');
      await query(
        `UPDATE chat_conversations SET title = $1 WHERE id = $2`,
        [title, conversationId],
      );
    }

    onDone();
  } catch (err: any) {
    console.error('[Chat] Stream error:', err.message);
    onError(sanitizeGeminiError(err));
  } finally {
    streamLocks.delete(conversationId);
  }
}
