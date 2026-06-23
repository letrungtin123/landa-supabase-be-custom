// ═══════════════════════════════════════════════════════════════
// Chat Service — Optimized for millions of users
// Features: cursor-based pagination, rate limiting, concurrency
// control, tenant isolation, CTE queries, retry with backoff
// ═══════════════════════════════════════════════════════════════

import { createHash } from 'crypto';
import { query } from '../../config/database.js';
import {
  applyLessonAuthorProposalToCourse,
  type LessonAuthorChapterProposal,
  type LessonAuthorComponentProposal,
  type LessonAuthorLessonProposal,
  type LessonAuthorProposal,
  type LessonAuthorUnitProposal,
} from '../course-authoring/course-authoring.service.js';
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
const CHAT_TARGETS = ['admin', 'learner', 'lesson_author'] as const;
const LESSON_AUTHOR_TARGET = 'lesson_author' as const;
const MAX_PROPOSAL_CHAPTERS = 5;
const MAX_PROPOSAL_LESSONS = 30;
const MAX_PROPOSAL_UNITS = 80;
const MAX_PROPOSAL_COMPONENTS = 160;
const MAX_COMPONENTS_PER_UNIT = 4;
const MAX_UNIT_HTML_CHARS = 6000;
const MIN_UNIT_HTML_TEXT_CHARS = 180;

// ── UUID validation ──
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(s: string): boolean { return UUID_REGEX.test(s); }
export type ChatTarget = typeof CHAT_TARGETS[number];

export function isChatTarget(value: string): value is ChatTarget {
  return (CHAT_TARGETS as readonly string[]).includes(value);
}

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

// ═══════════════════════════════════════════════════════════════
// Course Context — Structure injection + Function Calling
// Optimized: single-query outline build, 5-min LRU cache,
// HTML strip, truncation, lazy content fetch via Gemini tool
// ═══════════════════════════════════════════════════════════════

interface CourseOutlineEntry {
  id: string;
  display_name: string;
  block_type: string;
  parent_id: string | null;
  sort_order: number;
}

interface CourseOutlineCache {
  outline: string;         // formatted text for system prompt
  courseName: string;
  lessonIds: Set<string>;  // valid sequential IDs for validation
  ts: number;
}

const courseOutlineCache = new Map<string, CourseOutlineCache>();
const COURSE_CACHE_TTL = 5 * 60_000; // 5 minutes
const MAX_LESSON_CONTENT_CHARS = 6000; // truncate lesson content

// Cleanup course cache every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of courseOutlineCache) {
    if (now - val.ts > COURSE_CACHE_TTL * 2) courseOutlineCache.delete(key);
  }
}, 10 * 60_000);

/** Strip HTML tags → plain text, collapse whitespace */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build course outline for system prompt injection.
 * Single indexed query → cached 5 minutes.
 * Only fetches structural blocks (course/chapter/sequential) — O(1) per message after cache.
 */
async function getCachedCourseOutline(courseId: string, includeDraft = false): Promise<CourseOutlineCache | null> {
  const cacheKey = `${courseId}:${includeDraft ? 'draft' : 'published'}`;
  const cached = courseOutlineCache.get(cacheKey);
  if (!includeDraft && cached && Date.now() - cached.ts < COURSE_CACHE_TTL) return cached;

  // Single query: only structural block types, indexed by course_id + sort_order
  const result = await query<CourseOutlineEntry>(
    `SELECT id, display_name, block_type, parent_id, sort_order
     FROM course_blocks
     WHERE course_id = $1
       AND block_type IN ('course', 'chapter', 'sequential')
       AND deleted_at IS NULL
       AND ($2::boolean = true OR is_published = true)
     ORDER BY sort_order ASC, created_at ASC`,
    [courseId, includeDraft],
  );

  if (!result.rowCount || result.rowCount === 0) return null;

  const rows = result.rows;
  const courseBlock = rows.find(r => r.block_type === 'course');
  const courseName = courseBlock?.display_name || 'Khóa học';

  // Build parent→children map
  const childrenOf = new Map<string, CourseOutlineEntry[]>();
  for (const r of rows) {
    if (!r.parent_id) continue;
    const arr = childrenOf.get(r.parent_id) || [];
    arr.push(r);
    childrenOf.set(r.parent_id, arr);
  }

  // Format outline
  const lessonIds = new Set<string>();
  let outline = `=== KHÓA HỌC: ${courseName} ===\n\n`;

  const chapters = rows.filter(r => r.block_type === 'chapter');
  chapters.forEach((ch, ci) => {
    outline += `Phần ${ci + 1}: ${ch.display_name}\n`;
    const sequentials = childrenOf.get(ch.id) || [];
    sequentials.forEach((seq, si) => {
      outline += `  - Bài ${ci + 1}.${si + 1}: ${seq.display_name} [lesson_id: ${seq.id}]\n`;
      lessonIds.add(seq.id);
    });
  });

  outline += '\n===';

  const entry: CourseOutlineCache = { outline, courseName, lessonIds, ts: Date.now() };
  if (!includeDraft) courseOutlineCache.set(cacheKey, entry);
  return entry;
}

/**
 * Fetch content of a specific lesson (sequential → verticals → leaf blocks).
 * Strips HTML, truncates to MAX_LESSON_CONTENT_CHARS.
 * Not cached — only called when Gemini requests via function calling.
 */
async function fetchLessonContent(courseId: string, lessonId: string, includeDraft = false): Promise<string> {
  // CTE: get all descendant blocks of this sequential
  const result = await query<{ display_name: string; block_type: string; data: any }>(
    `WITH RECURSIVE descendants AS (
       SELECT id,
              display_name,
              block_type,
              CASE WHEN $3::boolean THEN COALESCE(data, published_data) ELSE published_data END AS data,
              sort_order
       FROM course_blocks
       WHERE id = $1
         AND course_id = $2
         AND deleted_at IS NULL
         AND ($3::boolean = true OR is_published = true)
       UNION ALL
       SELECT cb.id,
              cb.display_name,
              cb.block_type,
              CASE WHEN $3::boolean THEN COALESCE(cb.data, cb.published_data) ELSE cb.published_data END AS data,
              cb.sort_order
       FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
         AND ($3::boolean = true OR cb.is_published = true)
     )
     SELECT display_name, block_type, data
     FROM descendants
     WHERE block_type NOT IN ('sequential', 'vertical')
     ORDER BY sort_order`,
    [lessonId, courseId, includeDraft],
  );

  if (!result.rowCount || result.rowCount === 0) {
    return 'Bài học này chưa có nội dung.';
  }

  let content = '';
  for (const row of result.rows) {
    const label = row.display_name || '';
    let text = '';

    if (row.block_type === 'html' && row.data) {
      // HTML block: data can be string or { data: string }
      const raw = typeof row.data === 'string' ? row.data
        : (row.data as any)?.data || (row.data as any)?.html || JSON.stringify(row.data);
      text = stripHtml(raw);
    } else if (row.block_type === 'video') {
      text = `[Video: ${label}]`;
    } else if (row.block_type === 'problem') {
      text = `[Bài tập: ${label}]`;
    } else {
      text = `[${row.block_type}: ${label}]`;
    }

    if (text) {
      if (label && !text.startsWith('[')) content += `\n### ${label}\n`;
      content += text + '\n';
    }

    // Early exit if already long enough
    if (content.length > MAX_LESSON_CONTENT_CHARS) break;
  }

  // Truncate
  if (content.length > MAX_LESSON_CONTENT_CHARS) {
    content = content.slice(0, MAX_LESSON_CONTENT_CHARS) + '\n... (nội dung đã được rút gọn)';
  }

  return content.trim() || 'Bài học này chưa có nội dung.';
}

/** Gemini function declarations for course context — two functions force reliable routing */
const COURSE_TOOLS = {
  functionDeclarations: [
    {
      name: 'get_lesson_content',
      description: 'Lấy nội dung chi tiết của một bài học cụ thể trong khóa học hiện tại. GỌI FUNCTION NÀY khi người dùng hỏi về nội dung, phần, bài, chủ đề trong khóa học.',
      parameters: {
        type: 'OBJECT' as const,
        properties: {
          lesson_id: {
            type: 'STRING' as const,
            description: 'ID của bài học (lesson_id trong cấu trúc khóa học)',
          },
        },
        required: ['lesson_id'],
      },
    },
    {
      name: 'respond_directly',
      description: 'Trả lời trực tiếp KHÔNG cần nội dung khóa học. Chỉ dùng khi câu hỏi HOÀN TOÀN không liên quan đến khóa học hiện tại.',
      parameters: {
        type: 'OBJECT' as const,
        properties: {},
      },
    },
  ],
};

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

interface LessonAuthorMessageJobRow {
  id: string;
  status: string;
  proposal: LessonAuthorProposal;
  error_reason: string | null;
  created_block_ids: string[] | null;
}

interface BotAssignment {
  id: string;
  tenant_id: string;
  target: ChatTarget;
  bot_id: string;
  bot_name: string;
  bot_avatar_url: string | null;
  bot_kb_id: string | null;
}

export interface KbAssignment {
  id: string;
  tenant_id: string;
  target: typeof LESSON_AUTHOR_TARGET;
  kb_id: string;
  kb_name: string;
  kb_description: string | null;
  document_count: number;
  learned_count: number;
  learning_count: number;
  error_count: number;
  store_name: string | null;
  updated_at: string;
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

export async function getActiveBot(tenantId: string, target: ChatTarget): Promise<BotAssignment | null> {
  const result = await query<BotAssignment>(
    `SELECT tba.*, c.name AS bot_name, c.avatar_url AS bot_avatar_url, c.kb_id AS bot_kb_id
     FROM tenant_bot_assignments tba
     JOIN chatbots c ON c.id = tba.bot_id
     WHERE tba.tenant_id = $1 AND tba.target = $2`,
    [tenantId, target],
  );
  return result.rows[0] || null;
}

export async function assignBot(tenantId: string, target: ChatTarget, botId: string): Promise<void> {
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

export async function unassignBot(tenantId: string, target: ChatTarget): Promise<boolean> {
  const result = await query(
    `DELETE FROM tenant_bot_assignments WHERE tenant_id = $1 AND target = $2`,
    [tenantId, target],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getActiveKbAssignment(tenantId: string): Promise<KbAssignment | null> {
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

export async function getActivePersonaAssignment(tenantId: string): Promise<PersonaAssignment | null> {
  const result = await query<PersonaAssignment>(
    `SELECT tpa.id,
            tpa.tenant_id,
            tpa.target,
            tpa.bot_id,
            tpa.persona_id,
            COALESCE(bp.custom_name, spt.name) AS persona_name,
            spt.avatar_url AS persona_avatar_url,
            spt.fullbody_url AS persona_fullbody_url,
            tpa.updated_at
     FROM tenant_persona_assignments tpa
     JOIN chatbots c ON c.id = tpa.bot_id AND c.tenant_id = tpa.tenant_id
     JOIN bot_personas bp ON bp.id = tpa.persona_id AND bp.bot_id = tpa.bot_id
     JOIN system_prompt_templates spt ON spt.id = bp.template_id
     WHERE tpa.tenant_id = $1 AND tpa.target = $2`,
    [tenantId, LESSON_AUTHOR_TARGET],
  );
  return result.rows[0] || null;
}

export async function getLessonAuthorSettings(tenantId: string): Promise<LessonAuthorSettings> {
  const [activeBot, activeKb, activePersona] = await Promise.all([
    getActiveBot(tenantId, LESSON_AUTHOR_TARGET),
    getActiveKbAssignment(tenantId),
    getActivePersonaAssignment(tenantId),
  ]);
  return { active_bot: activeBot, active_kb: activeKb, active_persona: activePersona };
}

export async function assignLessonAuthorKb(tenantId: string, kbId: string): Promise<void> {
  if (!isValidUUID(kbId)) throw new Error('kb_id không hợp lệ');

  const kbCheck = await query<{ id: string }>(
    `SELECT id FROM knowledgebases WHERE id = $1 AND tenant_id = $2`,
    [kbId, tenantId],
  );
  if (!kbCheck.rowCount || kbCheck.rowCount === 0) {
    throw new Error('KB không tồn tại hoặc không thuộc tenant');
  }

  await query(
    `INSERT INTO tenant_kb_assignments (tenant_id, target, kb_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, target)
     DO UPDATE SET kb_id = $3, updated_at = now()`,
    [tenantId, LESSON_AUTHOR_TARGET, kbId],
  );

  storeNameCache.delete(kbId);
}

export async function unassignLessonAuthorKb(tenantId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM tenant_kb_assignments WHERE tenant_id = $1 AND target = $2`,
    [tenantId, LESSON_AUTHOR_TARGET],
  );
  return (result.rowCount ?? 0) > 0;
}

// ═══════════════════════════════════════════════════════════════
// Conversations — with tenant isolation
// ═══════════════════════════════════════════════════════════════

export async function assignLessonAuthorPersona(tenantId: string, botId: string, personaId: string): Promise<void> {
  if (!isValidUUID(botId)) throw new Error('bot_id không hợp lệ');
  if (!isValidUUID(personaId)) throw new Error('persona_id không hợp lệ');

  const personaCheck = await query<{ id: string }>(
    `SELECT bp.id
     FROM bot_personas bp
     JOIN chatbots c ON c.id = bp.bot_id
     WHERE bp.id = $1 AND bp.bot_id = $2 AND c.tenant_id = $3`,
    [personaId, botId, tenantId],
  );
  if (!personaCheck.rowCount || personaCheck.rowCount === 0) {
    throw new Error('Persona không tồn tại hoặc không thuộc bot/tenant');
  }

  await query(
    `INSERT INTO tenant_persona_assignments (tenant_id, target, bot_id, persona_id, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, target)
     DO UPDATE SET bot_id = $3, persona_id = $4, updated_at = now()`,
    [tenantId, LESSON_AUTHOR_TARGET, botId, personaId],
  );
}

export async function unassignLessonAuthorPersona(tenantId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM tenant_persona_assignments WHERE tenant_id = $1 AND target = $2`,
    [tenantId, LESSON_AUTHOR_TARGET],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listConversations(
  userId: string,
  botId: string,
  tenantId: string,
  target: ChatTarget = 'admin',
  courseId?: string,
): Promise<ChatConversation[]> {
  if (target === LESSON_AUTHOR_TARGET && !courseId) {
    throw new Error('courseId is required for lesson_author conversations');
  }
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
  personaId: string,
  target: ChatTarget = 'admin',
  courseId?: string,
): Promise<ChatConversation> {
  if (!isValidUUID(personaId)) throw new Error('persona_id không hợp lệ');

  if (target === LESSON_AUTHOR_TARGET && !courseId) {
    throw new Error('courseId is required for lesson_author conversations');
  }

  // Single CTE: count + validate persona in one round-trip
  const result = await query<ChatConversation & { conv_count: number; persona_valid: boolean }>(
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
     )
     SELECT counts.cnt AS conv_count, persona_check.valid AS persona_valid
     FROM counts, persona_check`,
    [userId, tenantId, botId, personaId, target, courseId ?? null],
  );

  const { conv_count, persona_valid } = result.rows[0];
  if (conv_count >= MAX_CONVERSATIONS_PER_USER) {
    throw new Error(`Tối đa ${MAX_CONVERSATIONS_PER_USER} cuộc hội thoại. Vui lòng xoá bớt.`);
  }
  if (!persona_valid) throw new Error('Nhân cách không hợp lệ cho bot này');

  const insertResult = await query<ChatConversation>(
    `INSERT INTO chat_conversations (tenant_id, bot_id, persona_id, user_id, target, course_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [tenantId, botId, personaId, userId, target, courseId ?? null, { created_from: target }],
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

async function hydrateLessonAuthorProposalMessages(
  messages: ChatMessage[],
  conversationId: string,
  tenantId: string,
): Promise<ChatMessage[]> {
  const jobIds = Array.from(new Set(messages
    .map((message) => {
      const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
      const jobId = (metadata as Record<string, unknown>).lesson_author_job_id;
      const kind = (metadata as Record<string, unknown>).kind;
      return kind === 'lesson_author_proposal' && typeof jobId === 'string' && isValidUUID(jobId) ? jobId : null;
    })
    .filter((jobId): jobId is string => Boolean(jobId))));

  if (jobIds.length === 0) return messages;

  const result = await query<LessonAuthorMessageJobRow>(
    `SELECT id::text, status, proposal, error_reason, created_block_ids
     FROM lesson_author_jobs
     WHERE conversation_id = $1
       AND tenant_id = $2
       AND id = ANY($3::uuid[])`,
    [conversationId, tenantId, jobIds],
  );
  const jobsById = new Map(result.rows.map(job => [job.id, job]));

  return messages.map((message) => {
    const metadata = message.metadata && typeof message.metadata === 'object'
      ? { ...message.metadata }
      : {};
    const jobId = metadata.lesson_author_job_id;
    if (typeof jobId !== 'string') return message;
    const job = jobsById.get(jobId);
    if (!job) return message;

    return {
      ...message,
      metadata: {
        ...metadata,
        lesson_author_job_status: job.status,
        lesson_author_proposal: job.proposal,
        lesson_author_error_reason: job.error_reason,
        lesson_author_created_block_ids: job.created_block_ids ?? [],
      },
    };
  });
}

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
  messages = await hydrateLessonAuthorProposalMessages(messages, conversationId, tenantId);

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
  botId: string;
  target: ChatTarget;
  courseId: string | null;
  botKbId: string | null;
  systemPrompt: string;
  messageCount: number;
}

async function loadConversationContext(conversationId: string, userId: string, tenantId: string): Promise<ConversationContext> {
  // Single query: load conversation + bot + persona + prompt + message count via CTE
  const result = await query<{
    id: string; tenant_id: string; bot_id: string; target: ChatTarget; course_id: string | null; bot_kb_id: string | null;
    custom_prompt: string | null; template_prompt: string;
    msg_count: number;
  }>(
    `WITH conv AS (
       SELECT cc.id, cc.tenant_id, cc.bot_id, cc.target, cc.course_id, c.kb_id AS bot_kb_id, cc.persona_id
       FROM chat_conversations cc
       JOIN chatbots c ON c.id = cc.bot_id
       WHERE cc.id = $1 AND cc.user_id = $2 AND cc.tenant_id = $3
     ), msg_cnt AS (
       SELECT COUNT(*)::int AS cnt FROM chat_messages WHERE conversation_id = $1
     )
     SELECT conv.id, conv.tenant_id, conv.bot_id, conv.target, conv.course_id, conv.bot_kb_id,
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
  let botKbId = row.bot_kb_id;
  if (row.target === LESSON_AUTHOR_TARGET) {
    if (!row.course_id) throw new Error('Lesson author conversation is missing course_id');
    const activeKb = await getActiveKbAssignment(tenantId);
    if (!activeKb) throw new Error('Chưa cấu hình KB active cho chuyên gia tạo bài học');
    botKbId = activeKb.kb_id;
  }

  return {
    conversationId: row.id,
    tenantId: row.tenant_id,
    botId: row.bot_id,
    target: row.target,
    courseId: row.course_id,
    botKbId,
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
    if (/file\s*search|filesearch|store/i.test(msg)) {
      return new Error('KB active chưa sẵn sàng hoặc File Search store không hợp lệ. Kiểm tra tài liệu đã học xong và thử lại.');
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

function logLessonAuthorFlow(stage: string, details: Record<string, unknown> = {}): void {
  console.log(`[LessonAuthorFlow] ${stage}`, details);
}

function logChatCourseFlow(stage: string, details: Record<string, unknown> = {}): void {
  console.log(`[ChatCourseFlow] ${stage}`, details);
}

export interface ChatStreamOptions {
  target?: ChatTarget;
  courseId?: string;
  mode?: 'chat' | 'draft_lesson' | 'auto';
  outlineMentions?: LessonAuthorOutlineMention[];
}

export interface LessonAuthorOutlineMention {
  block_id: string;
  block_type: string;
  display_name: string;
  path: string;
  unit_id?: string | null;
  ancestor_ids?: string[];
  ancestor_types?: string[];
}

export type ChatStreamSideEvent =
  | { type: 'proposal'; job_id: string; proposal: LessonAuthorProposal };

interface DraftCourseOutline {
  courseName: string;
  courseDescription: string;
  hasStructure: boolean;
  chapterCount: number;
  outline: string;
}

interface MentionContextRow {
  id: string;
  parent_id: string | null;
  root_id: string;
  block_type: string;
  display_name: string;
  sort_order: number;
  depth: number;
  data: unknown;
  metadata: unknown;
}

interface LessonAuthorJobRow {
  id: string;
  tenant_id: string;
  course_id: string;
  conversation_id: string | null;
  bot_id: string | null;
  kb_id: string | null;
  requested_by: string | null;
  prompt: string;
  proposal: LessonAuthorProposal;
  status: string;
}

export interface AppliedLessonAuthorJob {
  job_id: string;
  course_id: string;
  created_block_ids: string[];
  updated_block_ids: string[];
  created_count: number;
  updated_count: number;
}

async function getDraftCourseOutlineForPrompt(courseId: string, tenantId: string): Promise<DraftCourseOutline> {
  const courseResult = await query<{ id: string; display_name: string; description: string | null }>(
    `SELECT id, display_name, description
     FROM courses
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [courseId, tenantId],
  );
  if (!courseResult.rowCount || courseResult.rowCount === 0) {
    throw new Error('Course not found');
  }

  const blocksResult = await query<CourseOutlineEntry>(
    `SELECT id, display_name, block_type, parent_id, sort_order
     FROM course_blocks
     WHERE course_id = $1
       AND block_type IN ('course', 'chapter', 'sequential', 'vertical')
       AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
    [courseId],
  );

  const rows = blocksResult.rows;
  const childrenOf = new Map<string, CourseOutlineEntry[]>();
  for (const row of rows) {
    if (!row.parent_id) continue;
    const children = childrenOf.get(row.parent_id) ?? [];
    children.push(row);
    childrenOf.set(row.parent_id, children);
  }

  const courseBlock = rows.find(row => row.block_type === 'course');
  const courseName = courseBlock?.display_name || courseResult.rows[0].display_name;
  const courseDescription = (courseResult.rows[0].description || '').trim();
  let outline = `Course: ${courseName}\n`;
  outline += `Description: ${courseDescription || 'No description provided.'}\n`;

  const roots = courseBlock ? childrenOf.get(courseBlock.id) ?? [] : rows.filter(row => !row.parent_id);
  const chapters = roots.filter(row => row.block_type === 'chapter');
  chapters.forEach((chapter, chapterIndex) => {
    outline += `\n${chapterIndex + 1}. ${chapter.display_name}`;
    const lessons = (childrenOf.get(chapter.id) ?? []).filter(row => row.block_type === 'sequential');
    lessons.forEach((lesson, lessonIndex) => {
      outline += `\n  ${chapterIndex + 1}.${lessonIndex + 1}. ${lesson.display_name}`;
      const units = (childrenOf.get(lesson.id) ?? []).filter(row => row.block_type === 'vertical');
      units.forEach((unit, unitIndex) => {
        outline += `\n    ${chapterIndex + 1}.${lessonIndex + 1}.${unitIndex + 1}. ${unit.display_name}`;
      });
    });
  });

  if (chapters.length === 0) {
    outline += '\nCurrent structure: empty. Only the root course block exists.';
  }
  return { courseName, courseDescription, hasStructure: chapters.length > 0, chapterCount: chapters.length, outline };
}

function normalizeOutlineMentionInput(value: unknown): LessonAuthorOutlineMention | null {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const blockId = typeof record.block_id === 'string' ? record.block_id.trim() : '';
  if (!isValidUUID(blockId)) return null;
  const unitId = typeof record.unit_id === 'string' && isValidUUID(record.unit_id.trim())
    ? record.unit_id.trim()
    : null;
  const ancestorIds = Array.isArray(record.ancestor_ids)
    ? record.ancestor_ids.filter((id): id is string => typeof id === 'string' && isValidUUID(id.trim())).map(id => id.trim()).slice(0, 12)
    : [];
  const ancestorTypes = Array.isArray(record.ancestor_types)
    ? record.ancestor_types.filter((type): type is string => typeof type === 'string').map(type => type.slice(0, 50)).slice(0, 12)
    : [];
  return {
    block_id: blockId,
    block_type: typeof record.block_type === 'string' ? record.block_type.slice(0, 50) : '',
    display_name: typeof record.display_name === 'string' ? record.display_name.slice(0, 180) : '',
    path: typeof record.path === 'string' ? record.path.slice(0, 600) : '',
    unit_id: unitId,
    ancestor_ids: ancestorIds,
    ancestor_types: ancestorTypes,
  };
}

function foldVietnameseText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

function hasLessonAuthorDraftAction(userPrompt: string): boolean {
  const text = foldVietnameseText(userPrompt);
  return /(^|\b)(sua|chinh sua|cap nhat|bo sung|them|mo rong|viet lai|viet them|lam lai|lam di|tu lam|len plan|lap plan|de xuat|toi uu|cai thien|dai ti|dai hon|ngan gon|ro hon|draft|proposal|update|edit|improve|expand)(\b|$)/i.test(text);
}

function shouldCarryForwardLessonAuthorTarget(userPrompt: string): boolean {
  const text = foldVietnameseText(userPrompt);
  const hasLocalReference = /(^|\b)(phan nay|noi dung nay|cai nay|muc nay|bai nay|unit nay|component nay|chuong nay|doan nay|no nay|target nay)(\b|$)/i.test(text);
  return hasLocalReference || hasLessonAuthorDraftAction(userPrompt);
}

function isSingleHtmlComponentRequest(userPrompt: string): boolean {
  const text = foldVietnameseText(userPrompt);
  return /\bcomponent\b/i.test(text) && /\bhtml\b/i.test(text) && /(^|\b)(1|mot|them|tao|viet|bo sung)(\b|$)/i.test(text);
}

async function validateLessonAuthorOutlineMentions(
  ctx: ConversationContext,
  values: unknown[] = [],
): Promise<LessonAuthorOutlineMention[]> {
  if (ctx.target !== LESSON_AUTHOR_TARGET || !ctx.courseId || values.length === 0) return [];

  const byId = new Map<string, LessonAuthorOutlineMention>();
  for (const value of values.slice(0, 12)) {
    const mention = normalizeOutlineMentionInput(value);
    if (mention) byId.set(mention.block_id, mention);
  }
  const ids = [...byId.keys()];
  if (ids.length === 0) return [];

  const result = await query<{ id: string; block_type: string; display_name: string }>(
    `SELECT cb.id::text AS id, cb.block_type, cb.display_name
     FROM course_blocks cb
     JOIN courses c ON c.id = cb.course_id
     WHERE cb.course_id = $1
       AND c.tenant_id = $2
       AND cb.deleted_at IS NULL
       AND cb.id = ANY($3::uuid[])
     ORDER BY array_position($3::uuid[], cb.id)`,
    [ctx.courseId, ctx.tenantId, ids],
  );

  return result.rows.map((row) => {
    const mention = byId.get(row.id)!;
    return {
      block_id: row.id,
      block_type: row.block_type,
      display_name: row.display_name || mention.display_name,
      path: mention.path || row.display_name,
      unit_id: mention.unit_id,
      ancestor_ids: mention.ancestor_ids,
      ancestor_types: mention.ancestor_types,
    };
  });
}

async function getLatestConversationOutlineMentions(
  ctx: ConversationContext,
): Promise<LessonAuthorOutlineMention[]> {
  if (ctx.target !== LESSON_AUTHOR_TARGET || !ctx.courseId) return [];

  const result = await query<{ outline_mentions: unknown }>(
    `SELECT metadata -> 'outline_mentions' AS outline_mentions
     FROM chat_messages
     WHERE conversation_id = $1
       AND role = 'user'
       AND metadata ? 'outline_mentions'
     ORDER BY created_at DESC
     LIMIT 1`,
    [ctx.conversationId],
  );
  const rawMentions = result.rows[0]?.outline_mentions;
  return validateLessonAuthorOutlineMentions(
    ctx,
    Array.isArray(rawMentions) ? rawMentions : [],
  );
}

function formatOutlineMentionsForPrompt(mentions: LessonAuthorOutlineMention[]): string {
  return mentions
    .map((mention, index) => [
      `${index + 1}. ${mention.display_name}`,
      `   id: ${mention.block_id}`,
      `   type: ${mention.block_type}`,
      `   path: ${mention.path || mention.display_name}`,
    ].join('\n'))
    .join('\n');
}

function stringifyBlockExcerpt(data: unknown, metadata: unknown): string {
  const dataText = typeof data === 'string'
    ? data
    : data && typeof data === 'object'
      ? JSON.stringify(data)
      : '';
  const metadataText = metadata && typeof metadata === 'object' ? JSON.stringify(metadata) : '';
  const raw = dataText || metadataText;
  if (!raw) return '';
  return stripHtml(raw)
    .replace(/[{}[\]"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
}

async function getOutlineMentionContextRows(
  ctx: ConversationContext,
  mentions: LessonAuthorOutlineMention[],
): Promise<MentionContextRow[]> {
  if (!ctx.courseId || mentions.length === 0) return [];
  const ids = mentions.map(mention => mention.block_id).filter(isValidUUID);
  if (ids.length === 0) return [];

  const result = await query<MentionContextRow>(
    `WITH RECURSIVE selected(id, ord) AS (
       SELECT * FROM unnest($3::uuid[]) WITH ORDINALITY
     ), tree AS (
       SELECT cb.id::text,
              cb.parent_id::text,
              cb.id::text AS root_id,
              cb.block_type,
              cb.display_name,
              cb.sort_order,
              0 AS depth,
              COALESCE(cb.data, cb.published_data) AS data,
              COALESCE(cb.metadata, cb.published_metadata) AS metadata,
              selected.ord
       FROM course_blocks cb
       JOIN courses c ON c.id = cb.course_id
       JOIN selected ON selected.id = cb.id
       WHERE cb.course_id = $1
         AND c.tenant_id = $2
         AND cb.deleted_at IS NULL
       UNION ALL
       SELECT child.id::text,
              child.parent_id::text,
              tree.root_id,
              child.block_type,
              child.display_name,
              child.sort_order,
              tree.depth + 1 AS depth,
              COALESCE(child.data, child.published_data) AS data,
              COALESCE(child.metadata, child.published_metadata) AS metadata,
              tree.ord
       FROM course_blocks child
       JOIN tree ON tree.id = child.parent_id::text
       WHERE child.course_id = $1
         AND child.deleted_at IS NULL
         AND tree.depth < 5
     )
     SELECT id, parent_id, root_id, block_type, display_name, sort_order, depth, data, metadata
     FROM tree
     ORDER BY ord, depth, sort_order ASC`,
    [ctx.courseId, ctx.tenantId, ids],
  );

  return result.rows;
}

function formatMentionContextRowsForPrompt(rows: MentionContextRow[]): string {
  if (rows.length === 0) return '';

  const lines = ['Current @mention subtree/context from the database:'];
  let currentRoot = '';
  for (const row of rows.slice(0, 120)) {
    if (row.root_id !== currentRoot) {
      currentRoot = row.root_id;
      lines.push('');
    }
    const indent = '  '.repeat(Math.min(row.depth, 5));
    const excerpt = stringifyBlockExcerpt(row.data, row.metadata);
    lines.push(`${indent}- ${row.display_name || '(No title)'} [${row.block_type}] id=${row.id}${excerpt ? ` | excerpt: ${excerpt}` : ''}`);
  }
  if (rows.length > 120) {
    lines.push(`... ${rows.length - 120} more blocks omitted from this mention context.`);
  }

  return lines.join('\n');
}

function splitMentionPath(mention: LessonAuthorOutlineMention): string[] {
  const raw = mention.path || mention.display_name;
  return raw.split('/').map(part => part.trim()).filter(Boolean);
}

function firstVerticalTitleForMention(
  mention: LessonAuthorOutlineMention,
  contextRows: MentionContextRow[],
): string | null {
  if (mention.block_type === 'vertical') return mention.display_name || null;
  const directRows = contextRows.filter(row => row.root_id === mention.block_id);
  const vertical = directRows.find(row => row.block_type === 'vertical');
  return vertical?.display_name || null;
}

function buildTargetLockedProposalInstruction(
  userPrompt: string,
  mentions: LessonAuthorOutlineMention[],
  contextRows: MentionContextRow[],
): string {
  if (mentions.length === 0) return '';

  const lines = [
    'TARGET-LOCKED OUTPUT RULES:',
    '- The selected @mention target is authoritative. Ignore older targets from chat history and do not output unrelated course branches.',
    '- Return only the minimum chapter -> lesson -> unit chain needed for the selected target. Use exact existing titles from the selected path/subtree so apply reuses existing blocks.',
    '- Do not include any chapter, lesson, unit, or component whose title is outside the selected @mention path/subtree.',
    '- When adding new content to an existing unit, include only the new component(s) in unit.components. Do not copy existing components from the target context into the proposal.',
  ];

  if (isSingleHtmlComponentRequest(userPrompt)) {
    lines.push('- The admin asked for one HTML component. Output exactly one new component with type "html" and do not add quiz, FAQ, sortable, crossword, diagram, or extra units.');
  }

  mentions.slice(0, 5).forEach((mention, index) => {
    const pathParts = splitMentionPath(mention);
    const chapterTitle = mention.block_type === 'chapter' ? mention.display_name : pathParts[0] || '';
    const lessonTitle = mention.block_type === 'sequential' ? mention.display_name : pathParts[1] || '';
    const unitTitle = firstVerticalTitleForMention(mention, contextRows) || pathParts[2] || '';

    lines.push(`${index + 1}. Selected target: "${mention.display_name}" [${mention.block_type}] path="${mention.path || mention.display_name}" id=${mention.block_id}`);
    if (chapterTitle) lines.push(`   - Use chapter.title exactly: "${chapterTitle}".`);
    if (mention.block_type === 'chapter') {
      lines.push('   - Create or improve content only inside this selected chapter.');
      return;
    }
    if (lessonTitle) lines.push(`   - Use lesson.title exactly: "${lessonTitle}".`);
    if (mention.block_type === 'sequential') {
      if (unitTitle) {
        lines.push(`   - For adding a component, put it under existing unit.title exactly: "${unitTitle}".`);
      } else {
        lines.push('   - For adding a component, create exactly one relevant unit under this selected lesson because no existing unit was found in the target context.');
      }
      return;
    }
    if (unitTitle) lines.push(`   - Use unit.title exactly: "${unitTitle}".`);
    if (mention.block_type === 'vertical') {
      lines.push('   - Add or update components only inside this selected unit.');
      return;
    }
    if (pathParts.length >= 4) {
      lines.push(`   - The selected component is "${mention.display_name}". If adding a sibling component, keep it in the same unit. If editing, keep this exact component title.`);
    }
  });

  return lines.join('\n');
}

async function getOutlineMentionContextForPrompt(
  ctx: ConversationContext,
  mentions: LessonAuthorOutlineMention[],
): Promise<string> {
  const rows = await getOutlineMentionContextRows(ctx, mentions);
  return formatMentionContextRowsForPrompt(rows);
}

function buildCurrentTurnText(
  userPrompt: string,
  mentions: LessonAuthorOutlineMention[],
  mentionContext: string,
): string {
  if (mentions.length === 0) return userPrompt;
  return [
    'CURRENT USER TURN - HIGHEST PRIORITY',
    'The admin selected these @mention targets for THIS message. They override any older @mentions or older target references in the chat history.',
    formatOutlineMentionsForPrompt(mentions),
    mentionContext,
    'Answer or act ONLY for the current @mention target unless the admin explicitly asks to compare with older targets.',
    `Admin message:\n${userPrompt}`,
  ].filter(Boolean).join('\n\n');
}

function replaceLatestUserTurn(
  history: { role: string; parts: { text: string }[] }[],
  currentTurnText: string,
): { role: string; parts: { text: string }[] }[] {
  const next = history.map(item => ({ ...item, parts: item.parts.map(part => ({ ...part })) }));
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index].role === 'user') {
      next[index] = { role: 'user', parts: [{ text: currentTurnText }] };
      return next;
    }
  }
  return [...next, { role: 'user', parts: [{ text: currentTurnText }] }];
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('AI did not return valid JSON');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown, fallback: string, maxLength: number): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return (raw || fallback).slice(0, maxLength);
}

function sanitizeGeneratedHtml(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const withoutUnsafeTags = raw
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>[\s\S]*?<\/embed>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\s(href|src)\s*=\s*(['"])\s*javascript:[\s\S]*?\2/gi, '');

  const html = withoutUnsafeTags.trim();
  const plainText = stripHtml(html);
  if (plainText.length < MIN_UNIT_HTML_TEXT_CHARS) {
    throw new Error(`Unit content is too thin. Minimum ${MIN_UNIT_HTML_TEXT_CHARS} plain-text chars required.`);
  }
  return html.slice(0, MAX_UNIT_HTML_CHARS);
}

function escapeXml(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeComponentType(value: unknown): LessonAuthorComponentProposal['type'] | null {
  const type = readString(value, '', 40).toLowerCase();
  if (type === 'html') return 'html';
  if (type === 'problem' || type === 'quiz' || type === 'question') return 'problem';
  if (type === 'la_faq' || type === 'faq') return 'la_faq';
  if (type === 'la_sortable' || type === 'sortable' || type === 'ordering') return 'la_sortable';
  if (type === 'la_crossword' || type === 'crossword' || type === 'vocabulary') return 'la_crossword';
  if (type === 'la_diagram' || type === 'diagram' || type === 'flowchart' || type === 'mindmap') return 'la_diagram';
  return null;
}

function normalizeComponentTitle(value: unknown, fallback: string): string {
  return readString(value, fallback, 180);
}

function normalizeProblemChoices(rawChoices: unknown[], singleChoice: boolean): Array<{ text: string; correct: boolean }> {
  const choices = rawChoices
    .map((choiceValue, index) => {
      if (typeof choiceValue === 'string') {
        return { text: readString(choiceValue, '', 500), correct: index === 0 };
      }
      const choice = asRecord(choiceValue);
      const correctValue = choice.correct ?? choice.is_correct ?? choice.answer;
      return {
        text: readString(choice.text ?? choice.label ?? choice.value, '', 500),
        correct: correctValue === true || String(correctValue).toLowerCase() === 'true',
      };
    })
    .filter(choice => choice.text)
    .slice(0, 6);

  if (choices.length < 2) {
    throw new Error('Problem component requires at least 2 answer choices');
  }

  const firstCorrectIndex = choices.findIndex(choice => choice.correct);
  if (singleChoice) {
    const correctIndex = firstCorrectIndex >= 0 ? firstCorrectIndex : 0;
    return choices.map((choice, index) => ({ ...choice, correct: index === correctIndex }));
  }
  if (firstCorrectIndex < 0) choices[0].correct = true;
  return choices;
}

function buildChoiceProblemXml(
  problemType: string,
  question: string,
  choices: Array<{ text: string; correct: boolean }>,
  explanation: string,
): string {
  const solution = explanation
    ? `\n  <solution><div class="detailed-solution"><p>${escapeXml(explanation)}</p></div></solution>`
    : '';

  if (problemType === 'multiple_select') {
    const choicesXml = choices
      .map(choice => `      <choice correct="${choice.correct ? 'true' : 'false'}">${escapeXml(choice.text)}</choice>`)
      .join('\n');
    return [
      '<problem>',
      '  <choiceresponse>',
      `    <label>${escapeXml(question)}</label>`,
      '    <checkboxgroup>',
      choicesXml,
      '    </checkboxgroup>',
      `  </choiceresponse>${solution}`,
      '</problem>',
    ].join('\n');
  }

  const choicesXml = choices
    .map(choice => `      <choice correct="${choice.correct ? 'true' : 'false'}">${escapeXml(choice.text)}</choice>`)
    .join('\n');
  return [
    '<problem>',
    '  <multiplechoiceresponse>',
    `    <label>${escapeXml(question)}</label>`,
    '    <choicegroup type="MultipleChoice">',
    choicesXml,
    '    </choicegroup>',
    `  </multiplechoiceresponse>${solution}`,
    '</problem>',
  ].join('\n');
}

function normalizeProblemComponent(component: Record<string, unknown>, fallbackTitle: string): LessonAuthorComponentProposal {
  const problemType = readString(component.problem_type ?? component.subtype, 'multiple_choice', 40).toLowerCase();
  const supportedType = problemType === 'multiple_select' ? 'multiple_select' : 'multiple_choice';
  const question = readString(component.question ?? component.prompt ?? component.label, '', 1000);
  if (!question) throw new Error('Problem component requires a question');

  const rawChoices = Array.isArray(component.choices) ? component.choices : [];
  const choices = normalizeProblemChoices(rawChoices, supportedType !== 'multiple_select');
  const explanation = readString(component.explanation ?? component.solution, '', 1500);

  return {
    type: 'problem',
    title: normalizeComponentTitle(component.title, fallbackTitle),
    data: buildChoiceProblemXml(supportedType, question, choices, explanation),
    metadata: { weight: 1 },
  };
}

function normalizeFaqComponent(component: Record<string, unknown>, fallbackTitle: string): LessonAuthorComponentProposal {
  const rawItems = Array.isArray(component.items) ? component.items : [];
  const items = rawItems
    .map((itemValue, index) => {
      const item = asRecord(itemValue);
      return {
        id: index + 1,
        question: readString(item.question ?? item.q, '', 500),
        answer: readString(item.answer ?? item.a ?? item.content, '', 2000),
      };
    })
    .filter(item => item.question && item.answer)
    .slice(0, 8);

  if (items.length < 2) throw new Error('FAQ component requires at least 2 Q&A items');

  const faqData = { items };
  return {
    type: 'la_faq',
    title: normalizeComponentTitle(component.title, fallbackTitle),
    data: { faq_data: JSON.stringify(faqData) },
    metadata: { faq_data: faqData },
  };
}

function normalizeSortableComponent(component: Record<string, unknown>, fallbackTitle: string): LessonAuthorComponentProposal {
  const rawItems = Array.isArray(component.items) ? component.items : [];
  const items = rawItems
    .map((itemValue, index) => {
      const item = asRecord(itemValue);
      const text = typeof itemValue === 'string'
        ? readString(itemValue, '', 500)
        : readString(item.text ?? item.label ?? item.title, '', 500);
      return { id: index + 1, text };
    })
    .filter(item => item.text)
    .slice(0, 10);

  if (items.length < 3) throw new Error('Sortable component requires at least 3 ordered items');

  const questionText = readString(
    component.question_text ?? component.question ?? component.prompt,
    'Sap xep cac muc theo dung thu tu.',
    500,
  );
  const sortableData = { items };
  return {
    type: 'la_sortable',
    title: normalizeComponentTitle(component.title, fallbackTitle),
    data: { question_text: questionText, sortable_data: JSON.stringify(sortableData) },
    metadata: { question_text: questionText, sortable_data: sortableData },
  };
}

function normalizeCrosswordAnswer(value: unknown): string {
  return readString(value, '', 80)
    .replace(/đ/gi, 'D')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 24);
}

function normalizeCrosswordComponent(component: Record<string, unknown>, fallbackTitle: string): LessonAuthorComponentProposal {
  const rawWords = Array.isArray(component.words) ? component.words : [];
  const words = rawWords
    .map((wordValue, index) => {
      const word = asRecord(wordValue);
      const answer = normalizeCrosswordAnswer(word.answer ?? word.term ?? word.text);
      return {
        id: index + 1,
        answer,
        clue: readString(word.clue ?? word.definition ?? word.hint, '', 500),
        hint: readString(word.hint, '', 500),
        row: index,
        col: 0,
        direction: 'across',
      };
    })
    .filter(word => word.answer.length >= 2 && word.clue)
    .slice(0, 10);

  if (words.length < 3) throw new Error('Crossword component requires at least 3 valid words');

  const crosswordData = { words, keyword_coordinates: [] };
  return {
    type: 'la_crossword',
    title: normalizeComponentTitle(component.title, fallbackTitle),
    data: { crossword_data: JSON.stringify(crosswordData) },
    metadata: { crossword_data: crosswordData },
  };
}

function normalizeDiagramShape(value: unknown): 'rectangle' | 'rounded' | 'ellipse' {
  const shape = readString(value, 'rounded', 40).toLowerCase();
  if (shape === 'rectangle' || shape === 'rounded' || shape === 'ellipse') return shape;
  if (shape === 'circle' || shape === 'oval') return 'ellipse';
  return 'rounded';
}

function normalizeDiagramNodeColor(index: number): string {
  const palette = ['#DBEAFE', '#DCFCE7', '#FEF3C7', '#FCE7F3', '#EDE9FE', '#CCFBF1'];
  return palette[index % palette.length];
}

function resolveDiagramNodeRef(value: unknown, nodes: Array<{ id: string; label: string }>): string | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const zeroBased = nodes[value];
    const oneBased = nodes[value - 1];
    return zeroBased?.id ?? oneBased?.id ?? null;
  }

  const raw = readString(value, '', 180);
  if (!raw) return null;
  const direct = nodes.find(node => node.id === raw);
  if (direct) return direct.id;

  const normalized = raw.trim().toLowerCase();
  return nodes.find(node => node.label.trim().toLowerCase() === normalized)?.id ?? null;
}

function normalizeDiagramComponent(component: Record<string, unknown>, fallbackTitle: string): LessonAuthorComponentProposal {
  const rawNodes = Array.isArray(component.nodes) ? component.nodes : [];
  const nodeRefs: Array<{ id: string; label: string }> = [];
  const nodes = rawNodes
    .map((nodeValue, index) => {
      const node = asRecord(nodeValue);
      const label = typeof nodeValue === 'string'
        ? readString(nodeValue, '', 120)
        : readString(node.label ?? node.title ?? node.name, '', 120);
      if (!label) return null;

      const id = `node_${index + 1}`;
      nodeRefs.push({ id, label });
      return {
        id,
        type: 'customShape',
        position: {
          x: 80 + (index % 4) * 220,
          y: 80 + Math.floor(index / 4) * 140,
        },
        data: {
          label,
          shape: normalizeDiagramShape(node.shape),
          bgColor: readString(node.bgColor ?? node.bg_color, normalizeDiagramNodeColor(index), 24),
          textColor: readString(node.textColor ?? node.text_color, '#0F172A', 24),
          tooltip: readString(node.tooltip ?? node.description, '', 500),
          target_diagram_id: '',
        },
      };
    })
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .slice(0, 12);

  if (nodes.length < 2) throw new Error('Diagram component requires at least 2 nodes');

  const availableNodeRefs = nodes.map(node => ({ id: node.id, label: node.data.label }));
  const rawEdges = Array.isArray(component.edges) ? component.edges : [];
  const explicitEdges = rawEdges
    .map((edgeValue, index) => {
      const edge = asRecord(edgeValue);
      const source = resolveDiagramNodeRef(edge.source ?? edge.from, availableNodeRefs);
      const target = resolveDiagramNodeRef(edge.target ?? edge.to, availableNodeRefs);
      if (!source || !target || source === target) return null;
      return {
        id: `edge_${index + 1}`,
        source,
        target,
        sourceHandle: 'right',
        targetHandle: 'left',
        type: 'deletable',
        label: readString(edge.label, '', 120) || undefined,
      };
    })
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
    .slice(0, 16);

  const edges = explicitEdges.length > 0
    ? explicitEdges
    : nodes.slice(1).map((node, index) => ({
      id: `edge_${index + 1}`,
      source: nodes[index].id,
      target: node.id,
      sourceHandle: 'right',
      targetHandle: 'left',
      type: 'deletable',
    }));

  const diagramId = 'root';
  const diagramData = {
    diagrams: [{
      id: diagramId,
      name: readString(component.name ?? component.title, 'Main Diagram', 120),
      nodes,
      edges,
    }],
    start_diagram_id: diagramId,
  };

  return {
    type: 'la_diagram',
    title: normalizeComponentTitle(component.title, fallbackTitle),
    data: { diagram_data: JSON.stringify(diagramData) },
    metadata: { diagram_data: diagramData },
  };
}

function normalizeLessonAuthorComponent(componentValue: unknown, fallbackTitle: string): LessonAuthorComponentProposal {
  const component = asRecord(componentValue);
  const type = normalizeComponentType(component.type);
  if (!type) throw new Error(`Unsupported component type: ${readString(component.type, 'unknown', 40)}`);

  if (type === 'html') {
    return {
      type: 'html',
      title: normalizeComponentTitle(component.title, fallbackTitle),
      data: sanitizeGeneratedHtml(component.html ?? component.data ?? component.content),
    };
  }
  if (type === 'problem') return normalizeProblemComponent(component, fallbackTitle);
  if (type === 'la_faq') return normalizeFaqComponent(component, fallbackTitle);
  if (type === 'la_sortable') return normalizeSortableComponent(component, fallbackTitle);
  if (type === 'la_crossword') return normalizeCrosswordComponent(component, fallbackTitle);
  return normalizeDiagramComponent(component, fallbackTitle);
}

function normalizeLessonAuthorUnitComponents(unit: Record<string, unknown>, unitTitle: string): LessonAuthorComponentProposal[] {
  const rawComponents = Array.isArray(unit.components)
    ? unit.components
    : Array.isArray(unit.blocks)
      ? unit.blocks
      : [];

  const components = rawComponents
    .slice(0, MAX_COMPONENTS_PER_UNIT)
    .map((componentValue, componentIndex) => normalizeLessonAuthorComponent(
      componentValue,
      `${unitTitle} component ${componentIndex + 1}`,
    ));

  if (components.length > 0) return components;

  if (unit.html || unit.content) {
    return [{
      type: 'html',
      title: unitTitle,
      data: sanitizeGeneratedHtml(unit.html ?? unit.content),
    }];
  }

  throw new Error(`Unit "${unitTitle}" must contain at least one valid component`);
}

function normalizeLessonAuthorProposal(rawValue: unknown): LessonAuthorProposal {
  const raw = asRecord(rawValue);
  const rawChapters = Array.isArray(raw.chapters) ? raw.chapters : [];
  if (rawChapters.length === 0) throw new Error('AI proposal must contain at least one chapter');
  if (rawChapters.length > MAX_PROPOSAL_CHAPTERS) {
    throw new Error(`AI proposal exceeds ${MAX_PROPOSAL_CHAPTERS} chapters`);
  }

  let lessonCount = 0;
  let unitCount = 0;
  let componentCount = 0;

  const chapters: LessonAuthorChapterProposal[] = rawChapters.map((chapterValue, chapterIndex) => {
    const chapter = asRecord(chapterValue);
    const rawLessons = Array.isArray(chapter.lessons) ? chapter.lessons : [];
    if (rawLessons.length === 0) throw new Error(`Chapter ${chapterIndex + 1} must contain lessons`);

    const lessons: LessonAuthorLessonProposal[] = rawLessons.map((lessonValue, lessonIndex) => {
      lessonCount += 1;
      if (lessonCount > MAX_PROPOSAL_LESSONS) {
        throw new Error(`AI proposal exceeds ${MAX_PROPOSAL_LESSONS} lessons`);
      }

      const lesson = asRecord(lessonValue);
      const rawUnits = Array.isArray(lesson.units) ? lesson.units : [];
      if (rawUnits.length === 0) throw new Error(`Lesson ${lessonIndex + 1} must contain units`);

      const units: LessonAuthorUnitProposal[] = rawUnits.map((unitValue, unitIndex) => {
        unitCount += 1;
        if (unitCount > MAX_PROPOSAL_UNITS) {
          throw new Error(`AI proposal exceeds ${MAX_PROPOSAL_UNITS} units`);
        }

        const unit = asRecord(unitValue);
        const unitTitle = readString(unit.title, `Unit ${unitIndex + 1}`, 180);
        const components = normalizeLessonAuthorUnitComponents(unit, unitTitle);
        componentCount += components.length;
        if (componentCount > MAX_PROPOSAL_COMPONENTS) {
          throw new Error(`AI proposal exceeds ${MAX_PROPOSAL_COMPONENTS} components`);
        }

        return {
          title: unitTitle,
          components,
        };
      });

      return {
        title: readString(lesson.title, `Lesson ${lessonIndex + 1}`, 180),
        units,
      };
    });

    return {
      title: readString(chapter.title, `Chapter ${chapterIndex + 1}`, 180),
      lessons,
    };
  });

  return {
    summary: readString(raw.summary, 'Generated lesson plan', 1000),
    chapters,
  };
}

function sanitizeInternalErrorReason(err: any): string {
  const msg = err?.message || err?.toString?.() || 'Unknown lesson author error';
  return String(msg)
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .slice(0, 2000);
}

function formatLessonAuthorFailurePreview(err: any, jobId?: string): string {
  const safeError = sanitizeGeminiError(err).message;
  return [
    'Mình chưa tạo được proposal bài học cho yêu cầu này.',
    jobId ? `Failed job ID: ${jobId}` : '',
    `Lý do: ${safeError}`,
    'Chưa có block nào được tạo vào outline. Hãy thử lại với yêu cầu cụ thể hơn về chủ đề chương/bài/unit, hoặc kiểm tra KB/File Search nếu lỗi tiếp tục lặp lại.',
  ].filter(Boolean).join('\n\n');
}

function formatProposalPreview(proposal: LessonAuthorProposal, jobId: string): string {
  const pendingSummary = proposal.summary
    .replace(/^đã tạo/i, 'Đề xuất tạo')
    .replace(/^da tao/i, 'Đề xuất tạo')
    .replace(/^đã cập nhật/i, 'Đề xuất cập nhật')
    .replace(/^da cap nhat/i, 'Đề xuất cập nhật');
  let text = [
    'Mình đã chuẩn bị bản đề xuất. Chưa có block nào được ghi vào outline trước khi admin bấm Áp dụng.',
    `Tóm tắt đề xuất: ${pendingSummary}`,
    `Mã đề xuất: ${jobId}`,
    '',
  ].join('\n\n');
  proposal.chapters.forEach((chapter, chapterIndex) => {
    text += `${chapterIndex + 1}. ${chapter.title}\n`;
    chapter.lessons.forEach((lesson, lessonIndex) => {
      const componentTypes = new Set(
        lesson.units.flatMap(unit => (unit.components ?? []).map(component => component.type)),
      );
      const typeText = componentTypes.size > 0 ? `; ${Array.from(componentTypes).join(', ')}` : '';
      text += `   ${chapterIndex + 1}.${lessonIndex + 1}. ${lesson.title} (${lesson.units.length} unit${typeText})\n`;
      lesson.units.forEach(unit => {
        const unitTypes = (unit.components ?? []).map(component => component.type).join(', ') || 'html';
        text += `      - ${unit.title}: ${unitTypes}\n`;
      });
    });
  });
  text += '\nKiểm tra bản đề xuất để xác nhận, sau đó bấm Áp dụng. Chỉ sau khi bấm Áp dụng, backend mới ghi thay đổi vào outline và refresh cây bài học.';
  return text;
}

function getLessonAuthorProposalMetrics(proposal: LessonAuthorProposal): Record<string, unknown> {
  let lessonCount = 0;
  let unitCount = 0;
  let componentCount = 0;
  const componentTypes = new Set<string>();

  proposal.chapters.forEach(chapter => {
    lessonCount += chapter.lessons.length;
    chapter.lessons.forEach(lesson => {
      unitCount += lesson.units.length;
      lesson.units.forEach(unit => {
        const components = unit.components ?? [];
        componentCount += components.length;
        components.forEach(component => componentTypes.add(component.type));
      });
    });
  });

  return {
    chapters: proposal.chapters.length,
    lessons: lessonCount,
    units: unitCount,
    components: componentCount,
    component_types: Array.from(componentTypes),
  };
}

type LessonAuthorIntent = 'chat' | 'draft_lesson';

function getLessonAuthorIntentByHeuristic(userPrompt: string): LessonAuthorIntent | null {
  const text = userPrompt.toLowerCase();
  const hasDraftVerb = /(tao|tạo|soan|soạn|len plan|lên plan|len outline|lên outline|xay|xây|them|thêm|bo sung|bổ sung|de xuat|đề xuất|chinh sua|chỉnh sửa|sua|sửa|cap nhat|cập nhật|toi uu|tối ưu|cai thien|cải thiện|da dang|đa dạng|generate|create|build|draft|proposal|update|edit|improve|diversify)/i.test(text);
  const hasCourseObject = /(bai hoc|bài học|lesson|unit|chapter|chuong|chương|outline|cau truc|cấu trúc|course|khoa hoc|khóa học|noi dung|nội dung)/i.test(text);
  const hasChatIntent = /(la gi|là gì|giai thich|giải thích|hoi|hỏi|tom tat|tóm tắt|da co gi|đã có gì|hien tai|hiện tại|kiem tra|kiểm tra|review|phan tich|phân tích|doc|đọc|cho biet|cho biết)/i.test(text);

  if (hasChatIntent && !hasDraftVerb) return 'chat';
  if (!hasDraftVerb) return 'chat';
  if (hasDraftVerb && hasCourseObject) return 'draft_lesson';
  return null;
}

async function classifyLessonAuthorIntent(ctx: ConversationContext, userPrompt: string): Promise<LessonAuthorIntent> {
  const heuristic = getLessonAuthorIntentByHeuristic(userPrompt);
  if (heuristic) {
    logLessonAuthorFlow('intent_heuristic_resolved', {
      conversation_id: ctx.conversationId,
      course_id: ctx.courseId,
      intent: heuristic,
      prompt_chars: userPrompt.length,
    });
    return heuristic;
  }

  try {
    logLessonAuthorFlow('intent_ai_classifier_start', {
      conversation_id: ctx.conversationId,
      course_id: ctx.courseId,
      prompt_chars: userPrompt.length,
    });
    const aiClient = await getGeminiClient(ctx.tenantId);
    const course = ctx.courseId
      ? await getDraftCourseOutlineForPrompt(ctx.courseId, ctx.tenantId).catch(() => null)
      : null;

    const response = await aiClient.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{
        role: 'user',
        parts: [{
          text: [
            `Admin message:\n${userPrompt}`,
            course ? `Current course:\n${course.outline}` : 'Current course: unavailable',
            'Classify the admin intent.',
            'Return exactly one token:',
            '- draft_lesson: admin clearly asks to create, add, update, generate, or draft course outline/lessons/units.',
            '- chat: admin is asking, discussing, checking, explaining, reviewing, or giving natural-language context without a clear request to create/update structure.',
          ].join('\n\n'),
        }],
      }],
      config: {
        systemInstruction: 'You are a strict intent classifier for a lesson authoring chatbot. Prefer chat unless the admin clearly asks to create or modify course structure.',
      },
    });

    const intent = (response.text ?? '').toLowerCase().includes('draft_lesson') ? 'draft_lesson' : 'chat';
    logLessonAuthorFlow('intent_ai_classifier_done', {
      conversation_id: ctx.conversationId,
      course_id: ctx.courseId,
      intent,
      raw_response: (response.text ?? '').slice(0, 80),
    });
    return intent;
  } catch (err) {
    logLessonAuthorFlow('intent_ai_classifier_failed', {
      conversation_id: ctx.conversationId,
      course_id: ctx.courseId,
      error: (err as Error).message,
    });
    return 'chat';
  }
}

async function generateLessonAuthorProposal(
  ctx: ConversationContext,
  userPrompt: string,
  kbId: string,
  outlineMentions: LessonAuthorOutlineMention[] = [],
  mentionContext = '',
  targetScopeInstruction = '',
): Promise<LessonAuthorProposal> {
  logLessonAuthorFlow('proposal_generate_start', {
    conversation_id: ctx.conversationId,
    course_id: ctx.courseId,
    bot_id: ctx.botId,
    kb_id: kbId,
    prompt_chars: userPrompt.length,
    outline_mentions: outlineMentions.length,
    target_scope_chars: targetScopeInstruction.length,
  });

  const storeName = await getCachedStoreName(kbId);
  logLessonAuthorFlow('proposal_store_resolved', {
    conversation_id: ctx.conversationId,
    kb_id: kbId,
    has_store: Boolean(storeName),
    store_name: storeName ?? null,
  });
  if (!storeName) {
    throw new Error('KB active chưa có Gemini File Search store. Hãy upload tài liệu và chờ KB học xong trước.');
  }
  if (!ctx.courseId) throw new Error('courseId is required for lesson author');

  const course = await getDraftCourseOutlineForPrompt(ctx.courseId, ctx.tenantId);
  logLessonAuthorFlow('proposal_draft_outline_loaded', {
    conversation_id: ctx.conversationId,
    course_id: ctx.courseId,
    has_structure: course.hasStructure,
    chapter_count: course.chapterCount,
    outline_chars: course.outline.length,
  });
  const aiClient = await getGeminiClient(ctx.tenantId);
  const basePrompt = [
    `Admin request:\n${userPrompt}`,
    `Current course context:\n${course.outline}`,
    `Current chapter count: ${course.chapterCount}.`,
    course.hasStructure
      ? 'The course already has structure. Propose ONLY missing or clearly requested new chapters/lessons/units. Do not repeat existing chapter, lesson, or unit titles from the current outline.'
      : 'The course has no chapters yet. Build an initial structure from the course name, course description, admin request, and active KB.',
    outlineMentions.length > 0
      ? `Admin selected exact outline targets with @mentions:\n${formatOutlineMentionsForPrompt(outlineMentions)}\n${mentionContext}\nUse these IDs and the database subtree/context as the authoritative target scope. If the admin asks to edit, expand, add components, or improve content, produce proposal content ONLY for the selected target path unless the admin explicitly asks for a broader course change. Preserve the selected target title when returning the matching chapter/lesson/unit so the apply step updates that area instead of creating duplicates.`
      : 'Admin did not select an exact @mention target. Infer the target from the request and current course outline. If the request is ambiguous, answer with a clarification instead of generating unrelated structure.',
    targetScopeInstruction,
    'If the admin asks for a specific next chapter number, create only that new chapter and place it after the existing chapters. Example: if the course already has 3 chapters and the admin asks for chapter 4, return exactly one new chapter for chapter 4.',
    'Return JSON only with this schema:',
    '{"summary":"string","chapters":[{"title":"string","lessons":[{"title":"string","units":[{"title":"string","components":[{"type":"html","title":"string","html":"safe html string"},{"type":"problem","title":"string","problem_type":"multiple_choice|multiple_select","question":"string","choices":[{"text":"string","correct":true}],"explanation":"string"},{"type":"la_faq","title":"string","items":[{"question":"string","answer":"string"}]},{"type":"la_sortable","title":"string","question_text":"string","items":["first","second","third"]},{"type":"la_crossword","title":"string","words":[{"answer":"TERM","clue":"string","hint":"string"}]},{"type":"la_diagram","title":"string","name":"string","nodes":[{"label":"string","shape":"rectangle|rounded|ellipse","tooltip":"string"}],"edges":[{"source":0,"target":1,"label":"string"}]}]}]}]}]}',
    `Limits: max ${MAX_PROPOSAL_CHAPTERS} chapters, ${MAX_PROPOSAL_LESSONS} lessons total, ${MAX_PROPOSAL_UNITS} units total, ${MAX_COMPONENTS_PER_UNIT} components per unit.`,
    'Use the active KB as the source of truth. Do not invent facts that are not supported by the KB.',
    'The summary must describe a pending proposal only. Do not say content was created, applied, inserted, or updated in the database/outline before admin approval.',
    'Each unit must contain 1-3 components. Usually start with one html component for explanation, then add one interactive component when it improves learning.',
    'Choose component types by pedagogy: html for explanation, problem for checks, la_sortable for ordered processes, la_faq for definitions/misconceptions, la_crossword only for vocabulary terms, la_diagram for concept maps, workflows, hierarchies, relationships, or cause-effect structures. Do not force every type.',
    'For la_diagram, output simple nodes and edges only. Use 2-12 nodes. Edge source/target may be zero-based node indexes or exact node labels.',
    'Do not output video, pdf, image, or unsupported component types.',
    'Each html component must be real lesson content, not an empty shell: include a short objective, explanation, and key points. Prefer 500-1200 Vietnamese words when the KB supports it.',
    'Problem choices must include at least 2 options and at least 1 correct answer. FAQ needs at least 2 items. Sortable needs at least 3 ordered items. Crossword needs at least 3 short terms.',
    'HTML must be clean and suitable for an LMS html block. Use h3, p, ul, ol, strong, em only. Do not include script/style/iframe/object/embed tags.',
  ].join('\n\n');

  let lastValidationError: any = null;
  let lastResponseText = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = attempt === 0
      ? basePrompt
      : [
        basePrompt,
        `Previous JSON failed validation: ${sanitizeInternalErrorReason(lastValidationError)}`,
        `Previous response excerpt:\n${lastResponseText.slice(0, 1200)}`,
        'Regenerate the FULL JSON object now. Do not explain. Make every unit.components array valid, useful, and substantial enough to pass validation.',
      ].join('\n\n');

    logLessonAuthorFlow('proposal_gemini_attempt_start', {
      conversation_id: ctx.conversationId,
      attempt: attempt + 1,
      prompt_chars: prompt.length,
    });
    const response = await aiClient.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        systemInstruction: `${ctx.systemPrompt}\n\nYou are a lesson authoring expert for the current admin dashboard course. Produce practical course structure, not conversational prose.`,
        tools: [{ fileSearch: { fileSearchStoreNames: [storeName] } }],
      } as any,
    });

    lastResponseText = response.text ?? '';
    logLessonAuthorFlow('proposal_gemini_attempt_response', {
      conversation_id: ctx.conversationId,
      attempt: attempt + 1,
      response_chars: lastResponseText.length,
    });
    try {
      const proposal = normalizeLessonAuthorProposal(extractJsonObject(lastResponseText));
      logLessonAuthorFlow('proposal_validation_ok', {
        conversation_id: ctx.conversationId,
        attempt: attempt + 1,
        ...getLessonAuthorProposalMetrics(proposal),
      });
      return proposal;
    } catch (err) {
      lastValidationError = err;
      logLessonAuthorFlow('proposal_validation_failed', {
        conversation_id: ctx.conversationId,
        attempt: attempt + 1,
        error: sanitizeInternalErrorReason(err),
      });
      if (attempt === 1) throw err;
    }
  }

  throw lastValidationError || new Error('AI proposal validation failed');
}

function createLessonAuthorRequestHash(
  ctx: ConversationContext,
  kbId: string | null,
  prompt: string,
): string {
  return createHash('sha256')
    .update([ctx.tenantId, ctx.courseId, ctx.botId, kbId ?? '', prompt.trim()].join('|'))
    .digest('hex');
}

async function createLessonAuthorJob(
  ctx: ConversationContext,
  userId: string,
  prompt: string,
  kbId: string,
  proposal: LessonAuthorProposal,
): Promise<string> {
  if (!ctx.courseId) throw new Error('courseId is required for lesson author');
  const requestHash = createLessonAuthorRequestHash(ctx, kbId, prompt);

  const result = await query<{ id: string }>(
    `INSERT INTO lesson_author_jobs (
       tenant_id, course_id, conversation_id, bot_id, kb_id,
       requested_by, request_hash, prompt, proposal, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'proposed')
     RETURNING id`,
    [ctx.tenantId, ctx.courseId, ctx.conversationId, ctx.botId, kbId, userId, requestHash, prompt, proposal],
  );
  logLessonAuthorFlow('proposal_job_created', {
    conversation_id: ctx.conversationId,
    course_id: ctx.courseId,
    job_id: result.rows[0].id,
    request_hash: requestHash,
    ...getLessonAuthorProposalMetrics(proposal),
  });
  return result.rows[0].id;
}

async function createFailedLessonAuthorJob(
  ctx: ConversationContext,
  userId: string,
  prompt: string,
  kbId: string | null,
  errorReason: string,
): Promise<string> {
  if (!ctx.courseId) throw new Error('courseId is required for lesson author');
  const requestHash = createLessonAuthorRequestHash(ctx, kbId, prompt);

  const result = await query<{ id: string }>(
    `INSERT INTO lesson_author_jobs (
       tenant_id, course_id, conversation_id, bot_id, kb_id,
       requested_by, request_hash, prompt, proposal, status, error_reason
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, 'failed', $9)
     RETURNING id`,
    [ctx.tenantId, ctx.courseId, ctx.conversationId, ctx.botId, kbId, userId, requestHash, prompt, errorReason],
  );
  logLessonAuthorFlow('proposal_failed_job_created', {
    conversation_id: ctx.conversationId,
    course_id: ctx.courseId,
    job_id: result.rows[0].id,
    request_hash: requestHash,
    error: errorReason,
  });
  return result.rows[0].id;
}

export async function applyLessonAuthorJob(
  jobId: string,
  userId: string,
  tenantId: string,
): Promise<AppliedLessonAuthorJob> {
  if (!isValidUUID(jobId)) throw new Error('job_id không hợp lệ');
  logLessonAuthorFlow('apply_job_claim_start', { job_id: jobId, tenant_id: tenantId, user_id: userId });

  const claim = await query<LessonAuthorJobRow>(
    `UPDATE lesson_author_jobs
     SET status = 'applying', updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'proposed'
     RETURNING *`,
    [jobId, tenantId],
  );

  if (!claim.rowCount || claim.rowCount === 0) {
    const existing = await query<{ status: string }>(
      `SELECT status FROM lesson_author_jobs WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId],
    );
    const status = existing.rows[0]?.status;
    logLessonAuthorFlow('apply_job_claim_failed', { job_id: jobId, tenant_id: tenantId, status: status ?? null });
    throw new Error(status ? `Job is not applicable in status: ${status}` : 'Job not found');
  }

  const job = claim.rows[0];
  logLessonAuthorFlow('apply_job_claimed', {
    job_id: job.id,
    tenant_id: tenantId,
    course_id: job.course_id,
    conversation_id: job.conversation_id,
    kb_id: job.kb_id,
    ...getLessonAuthorProposalMetrics(job.proposal),
  });
  try {
    const applied = await applyLessonAuthorProposalToCourse({
      courseId: job.course_id,
      tenantId,
      requestedBy: userId,
      proposal: job.proposal,
      jobId: job.id,
      kbId: job.kb_id,
    });
    logLessonAuthorFlow('apply_course_blocks_done', {
      job_id: job.id,
      course_id: job.course_id,
      created_count: applied.created_block_ids.length,
      created_block_ids: applied.created_block_ids,
      updated_count: applied.updated_block_ids.length,
      updated_block_ids: applied.updated_block_ids,
    });

    await query(
      `UPDATE lesson_author_jobs
       SET status = 'succeeded',
           created_block_ids = $2::uuid[],
           updated_at = now()
       WHERE id = $1 AND tenant_id = $3`,
      [job.id, applied.created_block_ids, tenantId],
    );

    return {
      job_id: job.id,
      course_id: job.course_id,
      created_block_ids: applied.created_block_ids,
      updated_block_ids: applied.updated_block_ids,
      created_count: applied.created_block_ids.length,
      updated_count: applied.updated_block_ids.length,
    };
  } catch (err: any) {
    logLessonAuthorFlow('apply_job_failed', {
      job_id: job.id,
      course_id: job.course_id,
      error: err?.message || 'Apply failed',
    });
    await query(
      `UPDATE lesson_author_jobs
       SET status = 'failed',
           error_reason = $2,
           updated_at = now()
       WHERE id = $1 AND tenant_id = $3`,
      [job.id, err?.message || 'Apply failed', tenantId],
    );
    throw err;
  }
}

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
  options: ChatStreamOptions,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onSideEvent?: (event: ChatStreamSideEvent) => void,
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
    logLessonAuthorFlow('stream_context_loaded', {
      conversation_id: conversationId,
      tenant_id: tenantId,
      user_id: userId,
      target: ctx.target,
      bot_id: ctx.botId,
      course_id: ctx.courseId,
      has_bot_kb: Boolean(ctx.botKbId),
      requested_mode: options.mode ?? 'auto',
      message_chars: trimmed.length,
      message_count_before: ctx.messageCount,
    });
    if (options.target && options.target !== ctx.target) {
      throw new Error('Conversation target mismatch');
    }
    if (options.courseId && ctx.courseId && options.courseId !== ctx.courseId) {
      throw new Error('Conversation course mismatch');
    }
    const courseId = options.courseId ?? ctx.courseId ?? undefined;
    const requestedOutlineMentions = await validateLessonAuthorOutlineMentions(ctx, options.outlineMentions ?? []);
    const carriedOutlineMentions = requestedOutlineMentions.length === 0 && shouldCarryForwardLessonAuthorTarget(trimmed)
      ? await getLatestConversationOutlineMentions(ctx)
      : [];
    const outlineMentions = requestedOutlineMentions.length > 0 ? requestedOutlineMentions : carriedOutlineMentions;
    const outlineMentionSource = requestedOutlineMentions.length > 0
      ? 'current'
      : outlineMentions.length > 0
        ? 'carried_forward'
        : 'none';
    const mentionContextRows = await getOutlineMentionContextRows(ctx, outlineMentions);
    const mentionContext = formatMentionContextRowsForPrompt(mentionContextRows);
    const targetScopeInstruction = buildTargetLockedProposalInstruction(trimmed, outlineMentions, mentionContextRows);
    logLessonAuthorFlow('stream_outline_mentions_validated', {
      conversation_id: conversationId,
      target: ctx.target,
      requested_count: options.outlineMentions?.length ?? 0,
      valid_count: outlineMentions.length,
      mention_ids: outlineMentions.map(mention => mention.block_id),
      mention_source: outlineMentionSource,
      mention_context_chars: mentionContext.length,
      target_scope_chars: targetScopeInstruction.length,
    });

    // 2. Mark rate limit AFTER validation passes
    markRateLimit(userId);

    // 3. Save user message + update timestamp (2 queries, could batch but INSERT RETURNING is needed)
    await query(
      `INSERT INTO chat_messages (conversation_id, role, content, metadata)
       VALUES ($1, 'user', $2, $3)`,
      [
        conversationId,
        trimmed,
        outlineMentions.length > 0 ? { outline_mentions: outlineMentions, outline_mentions_source: outlineMentionSource } : {},
      ],
    );
    await query(
      `UPDATE chat_conversations SET updated_at = now() WHERE id = $1`,
      [conversationId],
    );
    logLessonAuthorFlow('stream_user_message_saved', {
      conversation_id: conversationId,
      target: ctx.target,
      course_id: courseId ?? null,
    });

    const targetedDraftAction = ctx.target === LESSON_AUTHOR_TARGET
      && outlineMentions.length > 0
      && hasLessonAuthorDraftAction(trimmed);
    const lessonAuthorIntent: LessonAuthorIntent =
      ctx.target === LESSON_AUTHOR_TARGET
        ? (options.mode === 'draft_lesson' || options.mode === 'chat'
          ? options.mode
          : targetedDraftAction
            ? 'draft_lesson'
            : await classifyLessonAuthorIntent(ctx, trimmed))
        : 'chat';
    logLessonAuthorFlow('stream_intent_resolved', {
      conversation_id: conversationId,
      target: ctx.target,
      intent: lessonAuthorIntent,
      requested_mode: options.mode ?? 'auto',
      targeted_draft_action: targetedDraftAction,
    });

    if (ctx.target === LESSON_AUTHOR_TARGET && lessonAuthorIntent === 'draft_lesson') {
      let proposal: LessonAuthorProposal | null = null;
      let jobId: string | null = null;
      let assistantText = '';

      logLessonAuthorFlow('draft_branch_enter', {
        conversation_id: conversationId,
        course_id: ctx.courseId,
        kb_id: ctx.botKbId,
      });
      try {
        if (!ctx.botKbId) throw new Error('Chưa cấu hình KB active cho chuyên gia tạo bài học');
        proposal = await generateLessonAuthorProposal(ctx, trimmed, ctx.botKbId, outlineMentions, mentionContext, targetScopeInstruction);
        jobId = await createLessonAuthorJob(ctx, userId, trimmed, ctx.botKbId, proposal);
        assistantText = formatProposalPreview(proposal, jobId);
        logLessonAuthorFlow('draft_branch_proposal_ready', {
          conversation_id: conversationId,
          job_id: jobId,
          assistant_chars: assistantText.length,
          ...getLessonAuthorProposalMetrics(proposal),
        });
      } catch (err: any) {
        const errorReason = sanitizeInternalErrorReason(err);
        jobId = await createFailedLessonAuthorJob(ctx, userId, trimmed, ctx.botKbId ?? null, errorReason);
        assistantText = formatLessonAuthorFailurePreview(err, jobId);
        logLessonAuthorFlow('draft_branch_proposal_failed', {
          conversation_id: conversationId,
          job_id: jobId,
          error: errorReason,
        });
      }

      onChunk(assistantText);
      if (proposal && jobId) {
        onSideEvent?.({ type: 'proposal', job_id: jobId, proposal });
        logLessonAuthorFlow('draft_branch_side_event_sent', {
          conversation_id: conversationId,
          job_id: jobId,
        });
      }

      await query(
        `INSERT INTO chat_messages (conversation_id, role, content, metadata)
         VALUES ($1, 'assistant', $2, $3)`,
        [
          conversationId,
          assistantText,
          {
            lesson_author_job_id: jobId,
            kind: proposal ? 'lesson_author_proposal' : 'lesson_author_generation_failed',
          },
        ],
      );
      logLessonAuthorFlow('draft_branch_assistant_message_saved', {
        conversation_id: conversationId,
        job_id: jobId,
        success: Boolean(proposal),
      });

      if (ctx.messageCount === 0) {
        const title = trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '');
        await query(
          `UPDATE chat_conversations SET title = $1 WHERE id = $2`,
          [title, conversationId],
        );
      }

      logLessonAuthorFlow('draft_branch_done', {
        conversation_id: conversationId,
        job_id: jobId,
        success: Boolean(proposal),
      });
      onDone();
      return;
    }

    // 4. Load history (includes the just-saved user message)
    const currentTurnText = buildCurrentTurnText(trimmed, outlineMentions, mentionContext);
    const history = replaceLatestUserTurn(await loadHistory(conversationId), currentTurnText);
    logLessonAuthorFlow('chat_branch_enter', {
      conversation_id: conversationId,
      target: ctx.target,
      course_id: courseId ?? null,
      history_messages: history.length,
      current_mentions: outlineMentions.length,
      mention_context_chars: mentionContext.length,
    });

    // 5. Build Gemini config with correct fileSearch tool format
    const aiClient = await getGeminiClient(ctx.tenantId);

    // Build fileSearch tools — separate from function calling (Gemini doesn't allow combining)
    const fileSearchTools: any[] = [];
    if (ctx.botKbId) {
      const storeName = await getCachedStoreName(ctx.botKbId);
      logLessonAuthorFlow('chat_branch_store_resolved', {
        conversation_id: conversationId,
        target: ctx.target,
        kb_id: ctx.botKbId,
        has_store: Boolean(storeName),
        store_name: storeName ?? null,
      });
      if (storeName) {
        fileSearchTools.push({
          fileSearch: {
            fileSearchStoreNames: [storeName],
          },
        });
      }
    }

    // 5b. Course context — inject outline + function calling tool
    let enrichedPrompt = ctx.systemPrompt;
    let hasCourseContext = false;
    if (courseId && typeof courseId === 'string' && courseId.length > 0) {
      try {
        const includeDraftCourseContext = ctx.target === LESSON_AUTHOR_TARGET;
        const courseOutline = await getCachedCourseOutline(courseId, includeDraftCourseContext);
        logChatCourseFlow('course_outline_loaded', {
          conversation_id: conversationId,
          target: ctx.target,
          course_id: courseId,
          include_draft: includeDraftCourseContext,
          has_outline: Boolean(courseOutline),
          lesson_count: courseOutline?.lessonIds.size || 0,
          outline_chars: courseOutline?.outline.length || 0,
        });
        if (courseOutline) {
          hasCourseContext = true;
          enrichedPrompt += `\n\n${courseOutline.outline}\n\nQUAN TRỌNG: Người dùng HIỆN TẠI đang xem khóa học "${courseOutline.courseName}". Khi người dùng hỏi về "phần", "bài", hoặc nội dung học, hãy LUÔN dùng tool get_lesson_content để lấy nội dung chi tiết bài học TRƯỚC KHI trả lời. Bỏ qua mọi ngữ cảnh khóa học khác trong lịch sử hội thoại — chỉ dùng khóa học hiện tại ở trên. Nếu câu hỏi không liên quan đến khóa học, trả lời bình thường.`;
        }
      } catch (err) {
        logChatCourseFlow('course_outline_error', {
          conversation_id: conversationId,
          course_id: courseId,
          error: (err as Error).message,
        });
      }
    }
    if (ctx.target === LESSON_AUTHOR_TARGET && outlineMentions.length > 0) {
      enrichedPrompt += `\n\nADMIN SELECTED OUTLINE TARGETS FOR THE CURRENT TURN:\n${formatOutlineMentionsForPrompt(outlineMentions)}\n${mentionContext}\nThese current @mentions override older @mentions and older answers in the chat history. If the current target conflicts with prior conversation context, follow the current target. If the admin is only chatting or asking a question, answer naturally using this current target scope. If the admin asks to create or edit lesson content, do not modify unrelated outline nodes.`;
    }

    // 6. Stream Gemini response with retry on 503
    //    Gemini constraint: fileSearch + functionDeclarations CANNOT be in the same request.
    //    Strategy when course context is active:
    //      Step 1: non-streaming call with ONLY functionDeclarations → check if function call
    //      Step 2a: if function call → fetch lesson content → streaming call with function result (no tools)
    //      Step 2b: if no function call → streaming call with fileSearch tools (KB fallback)
    //    Without course context: direct streaming with fileSearch (original flow).
    let fullResponse = '';
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const suggestedDelay = parseRetryDelay(lastError);
          const delay = suggestedDelay || (GEMINI_RETRY_DELAY_MS * attempt);
          logChatCourseFlow('retry_wait', {
            conversation_id: conversationId,
            attempt,
            max_retries: GEMINI_MAX_RETRIES,
            wait_seconds: Math.round(delay / 1000),
            last_error: lastError?.message ?? null,
          });
          await sleep(delay);
        }

        if (hasCourseContext) {
          logChatCourseFlow('function_router_start', {
            conversation_id: conversationId,
            target: ctx.target,
            course_id: courseId ?? null,
            attempt,
          });
          // ── Two-step flow: forced function calling (mode=ANY) ──
          // Gemini MUST choose: get_lesson_content OR respond_directly
          const firstResponse = await aiClient.models.generateContent({
            model: GEMINI_MODEL,
            contents: history,
            config: {
              systemInstruction: enrichedPrompt,
              tools: [COURSE_TOOLS] as any,
              toolConfig: { functionCallingConfig: { mode: 'ANY' as any } },
            },
          });

          const fnCall = firstResponse.functionCalls?.[0];
          logChatCourseFlow('function_router_chosen', {
            conversation_id: conversationId,
            function_name: fnCall?.name || 'none',
            args: fnCall?.args || {},
          });

          if (fnCall?.name === 'get_lesson_content' && fnCall.args?.lesson_id) {
            // Gemini identified a course-related question → fetch lesson content
            const lessonContent = await fetchLessonContent(
              courseId!,
              fnCall.args.lesson_id as string,
              ctx.target === LESSON_AUTHOR_TARGET,
            );
            logChatCourseFlow('lesson_content_fetched', {
              conversation_id: conversationId,
              course_id: courseId ?? null,
              lesson_id: fnCall.args.lesson_id,
              include_draft: ctx.target === LESSON_AUTHOR_TARGET,
              content_chars: lessonContent.length,
            });

            // Step 2: streaming with function result (no tools needed)
            const secondResponse = await aiClient.models.generateContentStream({
              model: GEMINI_MODEL,
              contents: [
                ...history,
                { role: 'model', parts: [{ functionCall: fnCall }] },
                { role: 'user', parts: [{ functionResponse: { name: 'get_lesson_content', response: { content: lessonContent } } }] },
              ],
              config: { systemInstruction: enrichedPrompt },
            });

            for await (const chunk of secondResponse) {
              const text = chunk.text ?? '';
              if (text) { fullResponse += text; onChunk(text); }
            }
          } else {
            // respond_directly OR no function call → not about course content
            // Stream with fileSearch KB (if available)
            logChatCourseFlow('stream_fallback_with_filesearch', {
              conversation_id: conversationId,
              file_search_enabled: fileSearchTools.length > 0,
            });
            const fallbackConfig: any = {
              systemInstruction: enrichedPrompt,
              ...(fileSearchTools.length > 0 ? { tools: fileSearchTools } : {}),
            };
            const fallbackResponse = await aiClient.models.generateContentStream({
              model: GEMINI_MODEL,
              contents: history,
              config: fallbackConfig,
            });

            for await (const chunk of fallbackResponse) {
              const text = chunk.text ?? '';
              if (text) { fullResponse += text; onChunk(text); }
            }
          }
        } else {
          // ── Original flow: direct streaming with fileSearch (no course context) ──
          logChatCourseFlow('direct_stream_start', {
            conversation_id: conversationId,
            file_search_enabled: fileSearchTools.length > 0,
            has_course_context: hasCourseContext,
          });
          const config: any = {
            systemInstruction: enrichedPrompt,
            ...(fileSearchTools.length > 0 ? { tools: fileSearchTools } : {}),
          };
          const response = await aiClient.models.generateContentStream({
            model: GEMINI_MODEL,
            contents: history,
            config,
          });

          for await (const chunk of response) {
            const text = chunk.text ?? '';
            if (text) { fullResponse += text; onChunk(text); }
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
      logLessonAuthorFlow('chat_branch_assistant_message_saved', {
        conversation_id: conversationId,
        target: ctx.target,
        response_chars: fullResponse.length,
      });
    } else {
      logLessonAuthorFlow('chat_branch_empty_response', {
        conversation_id: conversationId,
        target: ctx.target,
      });
    }

    // 8. Auto-title on first message pair ONLY (using pre-loaded msg_count from CTE)
    if (ctx.messageCount === 0) {
      const title = trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '');
      await query(
        `UPDATE chat_conversations SET title = $1 WHERE id = $2`,
        [title, conversationId],
      );
    }

    logLessonAuthorFlow('stream_done', {
      conversation_id: conversationId,
      target: ctx.target,
      response_chars: fullResponse.length,
    });
    onDone();
  } catch (err: any) {
    logLessonAuthorFlow('stream_error', {
      conversation_id: conversationId,
      error: err?.message || 'Unknown stream error',
    });
    onError(sanitizeGeminiError(err));
  } finally {
    logLessonAuthorFlow('stream_lock_released', { conversation_id: conversationId });
    streamLocks.delete(conversationId);
  }
}
