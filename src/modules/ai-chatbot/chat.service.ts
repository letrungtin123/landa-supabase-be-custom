// ═══════════════════════════════════════════════════════════════
// Chat Service — Optimized for millions of users
// Features: cursor-based pagination, rate limiting, concurrency
// control, tenant isolation, CTE queries, retry with backoff
// ═══════════════════════════════════════════════════════════════

import { createHash } from 'crypto';
import { query } from '../../config/database.js';
import { env } from '../../config/env.js';
import { cacheJson, getCacheVersion } from '../../config/cache.js';
import { CACHE_TTL, cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { invalidateTenantAiCaches } from '../../config/cache-invalidation.js';
import { getRedisClient } from '../../config/redis.js';
import {
  applyLessonAuthorProposalToCourse,
  type LessonAuthorChapterProposal,
  type LessonAuthorComponentProposal,
  type LessonAuthorComponentType,
  type LessonAuthorLessonProposal,
  type LessonAuthorProposal,
  type LessonAuthorUnitProposal,
} from '../course-authoring/course-authoring.service.js';
import { getGeminiClient } from './gemini.service.js';
import { runStoredInputFilter } from './input-filter/input-filter.service.js';
import { INPUT_FILTER_CONFIG_KEY } from './input-filter/input-filter.schema.js';
import type { FilterResult } from './input-filter/core/index.js';

// ── Constants ──
const MAX_CONVERSATIONS_PER_USER = 10;
const HISTORY_CONTEXT_LIMIT = 20;         // Last N messages sent to Gemini
const MAX_USER_MESSAGE_LENGTH = 5000;
const GEMINI_MODEL = env.GEMINI_CHAT_MODEL;
const MESSAGES_PAGE_SIZE = 50;            // Cursor-based pagination
const RATE_LIMIT_MS = 3_000;              // 1 message per 3 seconds per user
const GEMINI_MAX_RETRIES = 3;
const GEMINI_RETRY_DELAY_MS = 5_000;       // base delay, actual may be longer for 429
const CHAT_TARGETS = ['admin', 'learner', 'lesson_author'] as const;
const LESSON_AUTHOR_TARGET = 'lesson_author' as const;
const MAX_PROPOSAL_CHAPTERS = 1;
const MAX_PROPOSAL_LESSONS = 30;
const MAX_PROPOSAL_UNITS = 80;
const MAX_PROPOSAL_COMPONENTS = 160;
const MAX_COMPONENTS_PER_UNIT = 4;
const MAX_UNIT_HTML_CHARS = 6000;
const MIN_UNIT_HTML_TEXT_CHARS = 180;
const MAX_SOURCE_DOCUMENTS = 5;
const MAX_SOURCE_DOCUMENT_EXCERPT_CHARS = 2400;

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

export function invalidateGeminiStoreNameCache(kbId?: string): void {
  if (kbId) {
    storeNameCache.delete(kbId);
    return;
  }
  storeNameCache.clear();
}

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

export interface LessonAuthorSourceDocumentInput {
  document_id?: string;
  id?: string;
  kb_id?: string;
  name?: string;
}

export interface LessonAuthorSourceDocument {
  document_id: string;
  kb_id: string;
  name: string;
  type: string;
  status: string;
  source_info: Record<string, unknown> | null;
  gemini_path: string;
  content_excerpt: string | null;
}

interface LessonAuthorMessageJobRow {
  id: string;
  status: string;
  proposal: LessonAuthorProposal;
  error_reason: string | null;
  created_block_ids: string[] | null;
  source_documents: LessonAuthorSourceDocument[] | null;
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
  const version = await getCacheVersion(...cacheVersions.tenantAi(tenantId));
  return cacheJson(
    cacheKeys.aiTenantResource(tenantId, 'assignments', version),
    CACHE_TTL.aiConfig,
    () => getAssignmentsFromDb(tenantId),
  );
}

async function getAssignmentsFromDb(tenantId: string): Promise<BotAssignment[]> {
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
  const version = await getCacheVersion(...cacheVersions.tenantAi(tenantId));
  return cacheJson(
    cacheKeys.aiTenantResource(tenantId, 'active-bot', version, { target }),
    CACHE_TTL.aiConfig,
    () => getActiveBotFromDb(tenantId, target),
  );
}

async function getActiveBotFromDb(tenantId: string, target: ChatTarget): Promise<BotAssignment | null> {
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

export async function getActiveKbAssignment(tenantId: string): Promise<KbAssignment | null> {
  const version = await getCacheVersion(...cacheVersions.tenantAi(tenantId));
  return cacheJson(
    cacheKeys.aiTenantResource(tenantId, 'lesson-author-kb', version),
    CACHE_TTL.aiConfig,
    () => getActiveKbAssignmentFromDb(tenantId),
  );
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

async function resolveLessonAuthorPersonaForBot(
  tenantId: string,
  botId: string,
  opts: { strict?: boolean } = {},
): Promise<PersonaAssignment | null> {
  if (!isValidUUID(botId)) throw new Error('bot_id không hợp lệ');

  const result = await query<PersonaAssignment>(
    `WITH bot_check AS (
       SELECT id
       FROM chatbots
       WHERE id = $2 AND tenant_id = $1
     ), active_template AS (
       SELECT id, name, avatar_url, fullbody_url, sort_order
       FROM system_prompt_templates
       WHERE is_lesson_author = true
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
    throw new Error('Bot không tồn tại hoặc không thuộc tenant');
  }
  if (!check.rows[0]?.has_template) {
    throw new Error('Chưa cấu hình nhân cách chuyên gia bài học trong Prompt hệ thống');
  }
  return null;
}

export async function getActivePersonaAssignment(tenantId: string): Promise<PersonaAssignment | null> {
  const version = await getCacheVersion(...cacheVersions.tenantAi(tenantId));
  return cacheJson(
    cacheKeys.aiTenantResource(tenantId, 'lesson-author-persona', version),
    CACHE_TTL.aiConfig,
    () => getActivePersonaAssignmentFromDb(tenantId),
  );
}

async function getActivePersonaAssignmentFromDb(tenantId: string): Promise<PersonaAssignment | null> {
  const activeBot = await getActiveBot(tenantId, LESSON_AUTHOR_TARGET);
  if (!activeBot) return null;
  return resolveLessonAuthorPersonaForBot(tenantId, activeBot.bot_id);
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
  personaId: string | null,
  target: ChatTarget = 'admin',
  courseId?: string,
): Promise<ChatConversation> {
  if (target === LESSON_AUTHOR_TARGET && !courseId) {
    throw new Error('courseId is required for lesson_author conversations');
  }

  if (target === LESSON_AUTHOR_TARGET) {
    const activePersona = await resolveLessonAuthorPersonaForBot(tenantId, botId, { strict: true });
    personaId = activePersona?.persona_id ?? null;
  }

  if (!personaId || !isValidUUID(personaId)) throw new Error('persona_id không hợp lệ');

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
    `SELECT id::text, status, proposal, error_reason, created_block_ids, source_documents
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
        lesson_author_proposal: toLessonAuthorDisplayProposal(job.proposal),
        lesson_author_error_reason: job.error_reason,
        lesson_author_created_block_ids: job.created_block_ids ?? [],
        lesson_author_source_documents: job.source_documents ?? [],
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
  inputFilterConfig: unknown;
}

function getInputFilterConfigFromBotConfig(botConfig: unknown): unknown {
  if (typeof botConfig !== 'object' || botConfig === null || Array.isArray(botConfig)) return null;
  return (botConfig as Record<string, unknown>)[INPUT_FILTER_CONFIG_KEY] ?? null;
}

async function loadConversationContext(conversationId: string, userId: string, tenantId: string): Promise<ConversationContext> {
  // Single query: load conversation + bot + persona + prompt + message count via CTE
  const result = await query<{
    id: string; tenant_id: string; bot_id: string; target: ChatTarget; course_id: string | null; bot_kb_id: string | null;
    custom_prompt: string | null; template_prompt: string; bot_config: unknown;
    msg_count: number;
  }>(
    `WITH conv AS (
       SELECT cc.id, cc.tenant_id, cc.bot_id, cc.target, cc.course_id, c.kb_id AS bot_kb_id, c.config AS bot_config, cc.persona_id
       FROM chat_conversations cc
       JOIN chatbots c ON c.id = cc.bot_id
       WHERE cc.id = $1 AND cc.user_id = $2 AND cc.tenant_id = $3
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
    systemPrompt: row.target === LESSON_AUTHOR_TARGET ? row.template_prompt : (row.custom_prompt ?? row.template_prompt),
    messageCount: row.msg_count,
    inputFilterConfig: getInputFilterConfigFromBotConfig(row.bot_config),
  };
}

async function saveInputFilterRejectedTurn(
  ctx: ConversationContext,
  userContent: string,
  replyMessage: string,
  result: FilterResult,
): Promise<void> {
  await query(
    `INSERT INTO chat_messages (conversation_id, role, content, metadata)
     VALUES ($1, 'user', $2, $3)`,
    [
      ctx.conversationId,
      userContent,
      {
        input_filter_blocked: true,
        input_filter_code: result.code,
      },
    ],
  );

  await query(
    `INSERT INTO chat_messages (conversation_id, role, content, metadata)
     VALUES ($1, 'assistant', $2, $3)`,
    [
      ctx.conversationId,
      replyMessage,
      {
        kind: 'input_filter_rejection',
        input_filter_code: result.code,
        input_filter_detail: result.detail ?? null,
      },
    ],
  );

  const title = userContent.slice(0, 50) + (userContent.length > 50 ? '...' : '');
  await query(
    `UPDATE chat_conversations
     SET updated_at = now(),
         title = CASE WHEN $3::boolean THEN $2 ELSE title END
     WHERE id = $1 AND tenant_id = $4`,
    [ctx.conversationId, title, ctx.messageCount === 0, ctx.tenantId],
  );
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
function redactGeminiApiKeys(value: string): string {
  return value.replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{8,})\b/g, '[redacted]');
}

function sanitizeGeminiError(err: any): Error {
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
  if (msg !== rawMsg) return new Error(msg);
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
  sourceDocuments?: LessonAuthorSourceDocumentInput[];
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
  created_at: string;
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
  return /(^|\b)(sua|chinh sua|cap nhat|bo sung|them|add|insert|create|generate|build|tao|soan|viet|mo rong|viet lai|viet them|lam lai|lam di|lam luon|tu lam|len plan|lap plan|de xuat|toi uu|cai thien|dai ti|dai hon|ngan gon|ro hon|draft|proposal|update|edit|improve|expand)(\b|$)/i.test(text);
}

function shouldCarryForwardLessonAuthorTarget(userPrompt: string): boolean {
  const text = foldVietnameseText(userPrompt);
  const hasLocalReference = /(^|\b)(phan nay|noi dung nay|cai nay|muc nay|bai nay|unit nay|component nay|diagram nay|so do nay|chuong nay|doan nay|no nay|target nay)(\b|$)/i.test(text);
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

function shouldCarryForwardLessonAuthorSourceDocuments(userPrompt: string): boolean {
  const text = foldVietnameseText(userPrompt);
  return /(^|\b)(file nay|file do|file da co san|file vua chon|file tren|pdf nay|pdf do|tai lieu nay|tai lieu do|tai lieu da co san|tai lieu tren|dua tren file|dua vao file|dua tren tai lieu|dua vao tai lieu|noi dung file|noi dung tai lieu)(\b|$)/i.test(text);
}

async function getLatestConversationSourceDocuments(
  ctx: ConversationContext,
): Promise<LessonAuthorSourceDocument[]> {
  if (ctx.target !== LESSON_AUTHOR_TARGET || !ctx.botKbId) return [];

  const result = await query<{ source_documents: unknown }>(
    `SELECT metadata -> 'source_documents' AS source_documents
     FROM chat_messages
     WHERE conversation_id = $1
       AND role = 'user'
       AND metadata ? 'source_documents'
     ORDER BY created_at DESC
     LIMIT 1`,
    [ctx.conversationId],
  );
  const rawDocuments = result.rows[0]?.source_documents;
  return validateLessonAuthorSourceDocuments(
    ctx,
    ctx.botKbId,
    Array.isArray(rawDocuments) ? rawDocuments : [],
  );
}

function normalizeSourceDocumentIds(inputs: LessonAuthorSourceDocumentInput[] = []): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const raw = typeof input?.document_id === 'string'
      ? input.document_id
      : typeof input?.id === 'string'
        ? input.id
        : '';
    const id = raw.trim();
    if (!isValidUUID(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_SOURCE_DOCUMENTS) break;
  }
  return ids;
}

function getSourceInfoSummary(sourceInfo: Record<string, unknown> | null): string {
  if (!sourceInfo) return '';
  const parts: string[] = [];
  const extension = typeof sourceInfo.extension === 'string' ? sourceInfo.extension : '';
  const mimeType = typeof sourceInfo.mime_type === 'string' ? sourceInfo.mime_type : '';
  const size = typeof sourceInfo.size === 'number' ? sourceInfo.size : null;
  if (extension) parts.push(`extension=${extension}`);
  if (mimeType) parts.push(`mime_type=${mimeType}`);
  if (size && Number.isFinite(size)) parts.push(`size=${size}`);
  return parts.join(', ');
}

function toSourceDocumentMetadata(doc: LessonAuthorSourceDocument): Omit<LessonAuthorSourceDocument, 'content_excerpt' | 'gemini_path'> {
  return {
    document_id: doc.document_id,
    kb_id: doc.kb_id,
    name: doc.name,
    type: doc.type,
    status: doc.status,
    source_info: doc.source_info,
  };
}

async function validateLessonAuthorSourceDocuments(
  ctx: ConversationContext,
  kbId: string | null,
  inputs: LessonAuthorSourceDocumentInput[] = [],
): Promise<LessonAuthorSourceDocument[]> {
  const ids = normalizeSourceDocumentIds(inputs);
  if (ids.length === 0) return [];
  if (ctx.target !== LESSON_AUTHOR_TARGET) {
    throw new Error('Chỉ có Chuyên gia bài học mới được chọn file nguồn.');
  }
  if (!kbId) {
    throw new Error('Chưa cấu hình KB active cho chuyên gia tạo bài học.');
  }

  const result = await query<{
    document_id: string;
    kb_id: string;
    name: string;
    type: string;
    status: string;
    source_info: Record<string, unknown> | null;
    content: string | null;
    gemini_path: string | null;
  }>(
    `SELECT d.id::text AS document_id,
            d.kb_id::text AS kb_id,
            d.name,
            d.type,
            d.status,
            d.source_info,
            d.content,
            m.gemini_path
     FROM kb_documents d
     LEFT JOIN kb_doc_gemini_mapping m ON m.document_id = d.id
     WHERE d.tenant_id = $1
       AND d.kb_id = $2
       AND d.type = 'file'
       AND d.id = ANY($3::uuid[])
     ORDER BY array_position($3::uuid[], d.id)`,
    [ctx.tenantId, kbId, ids],
  );

  const foundIds = new Set(result.rows.map(row => row.document_id));
  const missingIds = ids.filter(id => !foundIds.has(id));
  if (missingIds.length > 0) {
    throw new Error('Một số file nguồn không tồn tại, không thuộc KB active, hoặc không thuộc tenant hiện tại.');
  }

  return result.rows.map((row) => {
    if (row.status !== 'learned') {
      throw new Error(`File "${row.name}" chưa học xong. Vui lòng chờ trạng thái Đã học rồi thử lại.`);
    }
    if (!row.gemini_path) {
      throw new Error(`File "${row.name}" chưa có mapping Gemini File Search. Vui lòng retry tài liệu này trong KB.`);
    }
    const contentText = row.content ? stripHtml(row.content).replace(/\s+/g, ' ').trim() : '';
    return {
      document_id: row.document_id,
      kb_id: row.kb_id,
      name: row.name,
      type: row.type,
      status: row.status,
      source_info: row.source_info,
      gemini_path: row.gemini_path,
      content_excerpt: contentText ? contentText.slice(0, MAX_SOURCE_DOCUMENT_EXCERPT_CHARS) : null,
    };
  });
}

function formatSourceDocumentsForPrompt(docs: LessonAuthorSourceDocument[]): string {
  if (docs.length === 0) return '';
  const lines = [
    'ADMIN SELECTED KB SOURCE FILES FOR THE CURRENT TURN:',
    'These selected files are the primary evidence for this request. Older selected files in chat history are stale unless selected again in the current turn.',
    'When using Gemini File Search, narrow retrieval to these exact file names/display names and do not rely on other KB files unless the selected files are insufficient.',
    'If the selected files do not contain enough information to create or edit the requested lesson content, say what is missing instead of inventing facts.',
  ];

  docs.forEach((doc, index) => {
    const sourceInfo = getSourceInfoSummary(doc.source_info);
    lines.push(`${index + 1}. ${doc.name}`);
    lines.push(`   document_id: ${doc.document_id}`);
    lines.push(`   kb_id: ${doc.kb_id}`);
    lines.push(`   gemini_path: ${doc.gemini_path}`);
    if (sourceInfo) lines.push(`   source_info: ${sourceInfo}`);
    if (doc.content_excerpt) lines.push(`   local_excerpt: ${doc.content_excerpt}`);
  });

  return lines.join('\n');
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
    '- Hard scope limit: output at most one top-level section/chapter. If multiple @mentions point to multiple sections, use only the first selected section and ignore the rest for this proposal.',
    '- Return only the minimum chapter -> lesson -> unit chain needed for the selected target. Use exact existing titles from the selected path/subtree so apply reuses existing blocks.',
    '- Do not include any chapter, lesson, unit, or component whose title is outside the selected @mention path/subtree.',
    '- When adding new content to an existing unit, include only the new component(s) in unit.components. Do not copy existing components from the target context into the proposal.',
  ];

  if (isSingleHtmlComponentRequest(userPrompt)) {
    lines.push('- The admin asked for one HTML component. Output exactly one new component with type "html" and do not add quiz, FAQ, sortable, crossword, diagram, or extra units.');
  }

  mentions.slice(0, 1).forEach((mention, index) => {
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
  sourceDocuments: LessonAuthorSourceDocument[] = [],
): string {
  const sourceDocumentContext = formatSourceDocumentsForPrompt(sourceDocuments);
  if (mentions.length === 0 && !sourceDocumentContext) return userPrompt;
  return [
    'CURRENT USER TURN - HIGHEST PRIORITY',
    mentions.length > 0
      ? 'The admin selected these @mention targets for THIS message. They override any older @mentions or older target references in the chat history.'
      : '',
    mentions.length > 0 ? formatOutlineMentionsForPrompt(mentions) : '',
    mentions.length > 0 ? mentionContext : '',
    sourceDocumentContext,
    mentions.length > 0
      ? 'Answer or act ONLY for the current @mention target unless the admin explicitly asks to compare with older targets.'
      : '',
    sourceDocuments.length > 0
      ? 'Use the selected KB source files above as the primary evidence for this turn. They override older selected files in the chat history.'
      : '',
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

function readScalarString(value: unknown, fallback: string, maxLength: number): string {
  let raw = '';
  if (typeof value === 'string') raw = value.trim();
  else if (typeof value === 'number' && Number.isFinite(value)) raw = String(value);
  else if (typeof value === 'boolean') raw = String(value);
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

type NormalizedProblemSubtype = 'multiple_choice' | 'multiple_select' | 'dropdown' | 'numerical' | 'short_text';

function normalizeProblemSubtype(value: unknown): NormalizedProblemSubtype {
  const type = readScalarString(value, 'multiple_choice', 60)
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (['multiple_select', 'multi_select', 'checkbox', 'checkboxes', 'choiceresponse'].includes(type)) {
    return 'multiple_select';
  }
  if (['dropdown', 'option', 'select', 'option_response', 'optionresponse'].includes(type)) {
    return 'dropdown';
  }
  if (['numerical', 'numeric', 'number', 'numerical_response', 'numericalresponse'].includes(type)) {
    return 'numerical';
  }
  if (['short_text', 'short_answer', 'text', 'string', 'string_response', 'stringresponse', 'free_text'].includes(type)) {
    return 'short_text';
  }
  return 'multiple_choice';
}

function normalizeComparableText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeScalarList(value: unknown, maxLength: number): string[] {
  const rawValues = Array.isArray(value) ? value : [value];
  const values = rawValues
    .map(item => {
      const itemRecord = asRecord(item);
      return readScalarString(
        itemRecord.answer ?? itemRecord.text ?? itemRecord.label ?? itemRecord.value ?? item,
        '',
        maxLength,
      );
    })
    .filter(Boolean);
  return Array.from(new Set(values));
}

function getProblemAnswers(component: Record<string, unknown>, maxLength = 500): string[] {
  const answerSources = [
    component.answers,
    component.correct_answers,
    component.correctAnswers,
    component.answer,
    component.correct_answer,
    component.correctAnswer,
    component.expected_answer,
    component.expectedAnswer,
    component.value,
  ];

  for (const source of answerSources) {
    const answers = normalizeScalarList(source, maxLength);
    if (answers.length > 0) return answers;
  }
  return [];
}

function normalizeProblemChoices(
  rawChoices: unknown[],
  singleChoice: boolean,
  answers: string[] = [],
): Array<{ text: string; correct: boolean }> {
  const answerSet = new Set(answers.map(normalizeComparableText));
  const choices = rawChoices
    .map((choiceValue, index) => {
      if (typeof choiceValue === 'string' || typeof choiceValue === 'number') {
        const text = readScalarString(choiceValue, '', 500);
        return {
          text,
          correct: answerSet.size > 0 ? answerSet.has(normalizeComparableText(text)) : index === 0,
        };
      }
      const choice = asRecord(choiceValue);
      const correctValue = choice.correct ?? choice.is_correct ?? choice.answer;
      const text = readScalarString(choice.text ?? choice.label ?? choice.value ?? choice.answer, '', 500);
      return {
        text,
        correct: correctValue === true
          || String(correctValue).toLowerCase() === 'true'
          || (answerSet.size > 0 && answerSet.has(normalizeComparableText(text))),
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

function buildProblemSolutionXml(explanation: string): string {
  return explanation
    ? `\n  <solution><div class="detailed-solution"><p>${escapeXml(explanation)}</p></div></solution>`
    : '';
}

function buildChoiceProblemXml(
  problemType: 'multiple_choice' | 'multiple_select',
  question: string,
  choices: Array<{ text: string; correct: boolean }>,
  explanation: string,
): string {
  const solution = buildProblemSolutionXml(explanation);

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

function normalizeDropdownChoices(component: Record<string, unknown>): Array<{ text: string; correct: boolean }> {
  const rawOptions = Array.isArray(component.options)
    ? component.options
    : Array.isArray(component.choices)
      ? component.choices
      : [];
  const answers = getProblemAnswers(component);
  const answerSet = new Set(answers.map(normalizeComparableText));
  const choices = rawOptions
    .map((optionValue, index) => {
      if (typeof optionValue === 'string' || typeof optionValue === 'number') {
        const text = readScalarString(optionValue, '', 500);
        return {
          text,
          correct: answerSet.size > 0 ? answerSet.has(normalizeComparableText(text)) : index === 0,
        };
      }

      const option = asRecord(optionValue);
      const text = readScalarString(option.text ?? option.label ?? option.value ?? option.answer, '', 500);
      const correctValue = option.correct ?? option.is_correct;
      return {
        text,
        correct: correctValue === true
          || String(correctValue).toLowerCase() === 'true'
          || (answerSet.size > 0 && answerSet.has(normalizeComparableText(text))),
      };
    })
    .filter(choice => choice.text)
    .slice(0, 8);

  if (answerSet.size > 0 && choices.every(choice => !choice.correct)) {
    const answer = answers[0];
    const existingIndex = choices.findIndex(choice => normalizeComparableText(choice.text) === normalizeComparableText(answer));
    if (existingIndex >= 0) choices[existingIndex].correct = true;
    else choices.unshift({ text: answer, correct: true });
  }

  if (choices.length < 2) {
    throw new Error('Dropdown problem component requires at least 2 options');
  }

  const correctIndex = choices.findIndex(choice => choice.correct);
  const safeCorrectIndex = correctIndex >= 0 ? correctIndex : 0;
  return choices.map((choice, index) => ({ ...choice, correct: index === safeCorrectIndex }));
}

function buildDropdownProblemXml(
  question: string,
  choices: Array<{ text: string; correct: boolean }>,
  explanation: string,
): string {
  const optionsXml = choices
    .map(choice => `      <option correct="${choice.correct ? 'true' : 'false'}">${escapeXml(choice.text)}</option>`)
    .join('\n');
  return [
    '<problem>',
    '  <optionresponse>',
    `    <label>${escapeXml(question)}</label>`,
    '    <optioninput>',
    optionsXml,
    '    </optioninput>',
    `  </optionresponse>${buildProblemSolutionXml(explanation)}`,
    '</problem>',
  ].join('\n');
}

function buildNumericalProblemXml(question: string, answers: string[], tolerance: string, explanation: string): string {
  const primaryAnswer = answers[0];
  const additionalAnswers = answers
    .slice(1, 5)
    .map(answer => `    <additional_answer answer="${escapeXml(answer)}" />`)
    .join('\n');
  const toleranceXml = tolerance
    ? `    <responseparam type="tolerance" default="${escapeXml(tolerance)}" />\n`
    : '';

  return [
    '<problem>',
    `  <numericalresponse answer="${escapeXml(primaryAnswer)}">`,
    `    <label>${escapeXml(question)}</label>`,
    additionalAnswers,
    `${toleranceXml}    <formulaequationinput />`,
    `  </numericalresponse>${buildProblemSolutionXml(explanation)}`,
    '</problem>',
  ].filter(line => line !== '').join('\n');
}

function buildStringProblemXml(question: string, answers: string[], caseSensitive: boolean, explanation: string): string {
  const primaryAnswer = answers[0];
  const additionalAnswers = answers
    .slice(1, 5)
    .map(answer => `    <additional_answer answer="${escapeXml(answer)}" />`)
    .join('\n');

  return [
    '<problem>',
    `  <stringresponse answer="${escapeXml(primaryAnswer)}" type="${caseSensitive ? 'cs' : 'ci'}">`,
    `    <label>${escapeXml(question)}</label>`,
    additionalAnswers,
    '    <textline size="30" />',
    `  </stringresponse>${buildProblemSolutionXml(explanation)}`,
    '</problem>',
  ].filter(line => line !== '').join('\n');
}

function normalizeProblemComponent(component: Record<string, unknown>, fallbackTitle: string): LessonAuthorComponentProposal {
  const problemType = normalizeProblemSubtype(component.problem_type ?? component.subtype ?? component.response_type);
  const question = readString(component.question ?? component.prompt ?? component.label, '', 1000);
  if (!question) throw new Error('Problem component requires a question');

  const explanation = readString(component.explanation ?? component.solution, '', 1500);
  let data: string;

  if (problemType === 'numerical') {
    const answers = getProblemAnswers(component, 120);
    if (answers.length === 0) throw new Error('Numerical problem component requires an answer');
    const tolerance = readScalarString(component.tolerance ?? component.error_margin ?? component.margin, '0', 40);
    data = buildNumericalProblemXml(question, answers, tolerance, explanation);
  } else if (problemType === 'short_text') {
    const answers = getProblemAnswers(component);
    if (answers.length === 0) throw new Error('String problem component requires an answer');
    const caseSensitive = component.case_sensitive === true
      || String(component.case_sensitive ?? component.caseSensitive ?? '').toLowerCase() === 'true';
    data = buildStringProblemXml(question, answers, caseSensitive, explanation);
  } else if (problemType === 'dropdown') {
    data = buildDropdownProblemXml(question, normalizeDropdownChoices(component), explanation);
  } else {
    const rawChoices = Array.isArray(component.choices) ? component.choices : [];
    const choices = normalizeProblemChoices(rawChoices, problemType !== 'multiple_select', getProblemAnswers(component));
    data = buildChoiceProblemXml(problemType, question, choices, explanation);
  }

  return {
    type: 'problem',
    title: normalizeComponentTitle(component.title, fallbackTitle),
    data,
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

const DIAGRAM_NODE_STYLES = [
  { bgColor: '#EEF2FF', textColor: '#3730A3', icon: '🎯' },
  { bgColor: '#E0F2FE', textColor: '#075985', icon: '💡' },
  { bgColor: '#DCFCE7', textColor: '#166534', icon: '✅' },
  { bgColor: '#FEF3C7', textColor: '#92400E', icon: '⚙️' },
  { bgColor: '#FCE7F3', textColor: '#9D174D', icon: '📊' },
  { bgColor: '#EDE9FE', textColor: '#5B21B6', icon: '🧩' },
  { bgColor: '#CCFBF1', textColor: '#115E59', icon: '🔍' },
  { bgColor: '#FFE4E6', textColor: '#9F1239', icon: '🚀' },
];

function normalizeDiagramNodeColor(index: number): string {
  return DIAGRAM_NODE_STYLES[index % DIAGRAM_NODE_STYLES.length].bgColor;
}

function normalizeDiagramTextColor(index: number): string {
  return DIAGRAM_NODE_STYLES[index % DIAGRAM_NODE_STYLES.length].textColor;
}

function labelAlreadyHasIcon(label: string): boolean {
  const firstChar = Array.from(label.trim())[0] ?? '';
  const codePoint = firstChar.codePointAt(0) ?? 0;
  return codePoint >= 0x2190 && codePoint <= 0x1FAFF;
}

function chooseDiagramNodeIcon(label: string, index: number): string {
  const folded = foldVietnameseText(label);
  if (/(^|\b)(muc tieu|goal|objective|outcome|ket qua)(\b|$)/i.test(folded)) return '🎯';
  if (/(^|\b)(khai niem|concept|dinh nghia|definition|y tuong|idea|ly thuyet)(\b|$)/i.test(folded)) return '💡';
  if (/(^|\b)(quy trinh|process|flow|workflow|buoc|step|giai doan|stage)(\b|$)/i.test(folded)) return '⚙️';
  if (/(^|\b)(du lieu|data|chi so|metric|kpi|bao cao|report|so lieu)(\b|$)/i.test(folded)) return '📊';
  if (/(^|\b)(nguoi hoc|learner|khach hang|customer|user|team|nhom|doi ngu)(\b|$)/i.test(folded)) return '👥';
  if (/(^|\b)(rui ro|risk|loi|error|van de|problem|thach thuc|challenge)(\b|$)/i.test(folded)) return '⚠️';
  if (/(^|\b)(giai phap|solution|ket luan|conclusion|thanh cong|success|hoan thanh)(\b|$)/i.test(folded)) return '✅';
  if (/(^|\b)(cong cu|tool|he thong|system|api|nen tang|platform|ky thuat)(\b|$)/i.test(folded)) return '🛠️';
  return DIAGRAM_NODE_STYLES[index % DIAGRAM_NODE_STYLES.length].icon;
}

function formatDiagramNodeLabel(label: string, index: number): string {
  const cleanLabel = label.replace(/\s+/g, ' ').trim();
  if (!cleanLabel || labelAlreadyHasIcon(cleanLabel)) return cleanLabel.slice(0, 120);
  return `${chooseDiagramNodeIcon(cleanLabel, index)} ${cleanLabel}`.slice(0, 140);
}

function getDiagramEdgeHandles(
  sourcePosition: { x: number; y: number },
  targetPosition: { x: number; y: number },
): { sourceHandle: 'top' | 'right' | 'bottom' | 'left'; targetHandle: 'top' | 'right' | 'bottom' | 'left' } {
  const dx = targetPosition.x - sourcePosition.x;
  const dy = targetPosition.y - sourcePosition.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'right', targetHandle: 'left' }
      : { sourceHandle: 'left', targetHandle: 'right' };
  }
  return dy >= 0
    ? { sourceHandle: 'bottom', targetHandle: 'top' }
    : { sourceHandle: 'top', targetHandle: 'bottom' };
}

function layoutDiagramNodes<T extends { id: string; position: { x: number; y: number } }>(
  nodes: T[],
  edges: Array<{ source: string; target: string }>,
): T[] {
  if (nodes.length === 0) return nodes;

  const xSpacing = 260;
  const ySpacing = 150;
  const left = 80;
  const top = 70;

  if (edges.length > 0) {
    const incoming = new Map(nodes.map(node => [node.id, 0]));
    const outgoing = new Map<string, string[]>();
    for (const edge of edges) {
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    }

    const roots = nodes.filter(node => (incoming.get(node.id) ?? 0) === 0);
    const queue = roots.length > 0 ? roots.map(node => node.id) : [nodes[0].id];
    const levelById = new Map<string, number>();
    queue.forEach(id => levelById.set(id, 0));

    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      const nextLevel = (levelById.get(id) ?? 0) + 1;
      for (const target of outgoing.get(id) ?? []) {
        if ((levelById.get(target) ?? Number.POSITIVE_INFINITY) > nextLevel) {
          levelById.set(target, nextLevel);
          queue.push(target);
        }
      }
    }

    nodes.forEach((node, index) => {
      if (!levelById.has(node.id)) levelById.set(node.id, Math.floor(index / 3));
    });

    const rows = new Map<number, T[]>();
    nodes.forEach((node) => {
      const level = levelById.get(node.id) ?? 0;
      rows.set(level, [...(rows.get(level) ?? []), node]);
    });
    const widestRow = Math.max(...Array.from(rows.values()).map(row => row.length));
    const canvasWidth = Math.max(1, widestRow - 1) * xSpacing;

    for (const [level, row] of rows.entries()) {
      const rowWidth = Math.max(1, row.length - 1) * xSpacing;
      const rowOffset = (canvasWidth - rowWidth) / 2;
      row.forEach((node, index) => {
        node.position = {
          x: left + rowOffset + index * xSpacing,
          y: top + level * ySpacing,
        };
      });
    }
    return nodes;
  }

  const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(nodes.length))));
  nodes.forEach((node, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const rowCount = Math.min(cols, nodes.length - row * cols);
    const rowOffset = ((cols - rowCount) * xSpacing) / 2;
    node.position = {
      x: left + rowOffset + col * xSpacing,
      y: top + row * ySpacing,
    };
  });
  return nodes;
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
      const bgColor = readString(node.bgColor ?? node.bg_color, normalizeDiagramNodeColor(index), 24);
      return {
        id,
        type: 'customShape',
        position: { x: 80, y: 70 },
        data: {
          label: formatDiagramNodeLabel(label, index),
          shape: normalizeDiagramShape(node.shape ?? (index === 0 ? 'ellipse' : 'rounded')),
          bgColor,
          textColor: readString(node.textColor ?? node.text_color, normalizeDiagramTextColor(index), 24),
          tooltip: readString(node.tooltip ?? node.description ?? node.summary, label, 500),
          target_diagram_id: '',
        },
      };
    })
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .slice(0, 12);

  if (nodes.length < 2) throw new Error('Diagram component requires at least 2 nodes');

  const availableNodeRefs = nodeRefs;
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
        sourceHandle: 'right' as const,
        targetHandle: 'left' as const,
        type: 'deletable',
        label: readString(edge.label, '', 120) || undefined,
        style: { stroke: '#64748B', strokeWidth: 2 },
        markerEnd: { type: 'arrowclosed', color: '#64748B' },
      };
    })
    .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
    .slice(0, 16);

  const initialEdges = explicitEdges.length > 0
    ? explicitEdges
    : nodes.slice(1).map((node, index) => ({
      id: `edge_${index + 1}`,
      source: nodes[index].id,
      target: node.id,
      sourceHandle: 'right' as const,
      targetHandle: 'left' as const,
      type: 'deletable',
      style: { stroke: '#64748B', strokeWidth: 2 },
      markerEnd: { type: 'arrowclosed', color: '#64748B' },
    }));
  const positionedNodes = layoutDiagramNodes(nodes, initialEdges);
  const nodeById = new Map(positionedNodes.map(node => [node.id, node]));
  const edges = initialEdges.map(edge => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const handles = source && target
      ? getDiagramEdgeHandles(source.position, target.position)
      : { sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle };
    return { ...edge, ...handles };
  });

  const diagramId = 'root';
  const diagramData = {
    diagrams: [{
      id: diagramId,
      name: readString(component.name ?? component.title, 'Main Diagram', 120),
      nodes: positionedNodes,
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

// ── Convert system prompt's `changes`-based format to `chapters`-based format ──
// System prompt (34fe8e8a) returns: {changes: [{action, block_type, display_name, content:{...nested...}}]}
// Backend normalize expects: {chapters: [{title, lessons:[{title, units:[{title, components:[...]}]}]}]}
function convertChangesToChapters(changes: unknown[]): unknown[] {
  const chapters: unknown[] = [];

  for (const changeValue of changes) {
    const change = asRecord(changeValue);
    const blockType = readString(change.block_type, '', 50);
    const displayName = readString(change.display_name ?? change.title, '', 180);
    const content = asRecord(change.content);

    if (blockType === 'chapter') {
      // Chapter-level change → extract nested lessons from content
      const rawLessons = Array.isArray(content.lessons) ? content.lessons : [];
      const lessons = rawLessons.map((lessonValue: unknown) => {
        const lesson = asRecord(lessonValue);
        const lessonName = readString(lesson.display_name ?? lesson.title, '', 180);
        const lessonContent = asRecord(lesson.content ?? lesson);
        const rawUnits = Array.isArray(lessonContent.units) ? lessonContent.units : [];
        const units = rawUnits.map((unitValue: unknown) => {
          const unit = asRecord(unitValue);
          const unitName = readString(unit.display_name ?? unit.title, '', 180);
          const unitContent = asRecord(unit.content ?? unit);
          // Components can be in unit.content.components, unit.components, or unit.content directly
          const rawComponents = Array.isArray(unitContent.components)
            ? unitContent.components
            : Array.isArray(unit.components)
              ? unit.components
              : [];
          return {
            title: unitName,
            components: rawComponents.map((compValue: unknown) => {
              const comp = asRecord(compValue);
              const compContent = asRecord(comp.content ?? comp);
              return {
                type: readString(comp.type ?? comp.block_type, 'html', 40),
                title: readString(comp.display_name ?? comp.title, '', 180),
                // Spread content fields (html, items, words, nodes, edges, etc.)
                ...compContent,
              };
            }),
          };
        });
        return { title: lessonName, units };
      });
      chapters.push({ title: displayName, lessons });
    }
  }

  return chapters;
}

function normalizeLessonAuthorProposal(rawValue: unknown): LessonAuthorProposal {
  const raw = asRecord(rawValue);

  // ── Convert system prompt's `changes` format to `chapters` format ──
  // System prompt (34fe8e8a) teaches Gemini to return: {changes: [{action, block_type, display_name, content:{lessons:[...]}}]}
  // But this function expects: {chapters: [{title, lessons:[{title, units:[{title, components:[...]}]}]}]}
  let rawChapters = Array.isArray(raw.chapters) ? raw.chapters : [];
  if (rawChapters.length === 0 && Array.isArray(raw.changes)) {
    rawChapters = convertChangesToChapters(raw.changes);
  }

  if (rawChapters.length === 0) throw new Error('AI proposal must contain at least one chapter');
  if (rawChapters.length > MAX_PROPOSAL_CHAPTERS) {
    throw new Error(`AI proposal vượt quá giới hạn ${MAX_PROPOSAL_CHAPTERS} section/chapter. Chỉ được tạo nội dung đầy đủ trong một section cho mỗi lần approve.`);
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

function getRequestedComponentTypes(userPrompt: string): LessonAuthorComponentType[] {
  const folded = foldVietnameseText(userPrompt);
  const types: LessonAuthorComponentType[] = [];
  const add = (type: LessonAuthorComponentType) => {
    if (!types.includes(type)) types.push(type);
  };

  const asksSortable = /(^|\b)(sortable|sap xep|ordering|sequence|thu tu)(\b|$)/i.test(folded);
  if (/(^|\b)(diagram|flowchart|mindmap|so do|bieu do)(\b|$)/i.test(folded)) add('la_diagram');
  if (/(^|\b)(faq|hoi dap|cau hoi thuong gap)(\b|$)/i.test(folded)) add('la_faq');
  if (/(^|\b)(crossword|do vui o chu|tu dien|vocabulary)(\b|$)/i.test(folded)
    || (/(^|\b)o chu(\b|$)/i.test(folded) && !asksSortable)) add('la_crossword');
  if (asksSortable) add('la_sortable');
  if (/(^|\b)(quiz|problem|cau hoi|kiem tra|multiple choice|trac nghiem|dropdown|optionresponse|numerical|numericalresponse|dien so|stringresponse|short answer|short_text|dien van ban)(\b|$)/i.test(folded)) add('problem');
  if (/(^|\b)(html|text|van ban|ly thuyet|noi dung doc)(\b|$)/i.test(folded)) add('html');
  return types;
}

function isAdditiveComponentOnlyRequest(userPrompt: string, outlineMentions: LessonAuthorOutlineMention[]): boolean {
  if (outlineMentions.length === 0) return false;
  const folded = foldVietnameseText(userPrompt);
  const hasAddVerb = /(^|\b)(tao|them|add|insert|create|generate|build|bo sung|viet|soan)(\b|$)/i.test(folded);
  const hasReplaceVerb = /(^|\b)(xoa|remove|delete|thay the|replace|sua|chinh sua|cap nhat|update|edit|viet lai|lam lai)(\b|$)/i.test(folded);
  const hasComponentScope = /(^|\b)(component|block|unit nay|phan nay|muc nay|diagram|so do|bieu do|faq|crossword|sortable|quiz|problem|dropdown|optionresponse|numerical|numericalresponse|dien so|stringresponse|short answer|short_text|dien van ban|html)(\b|$)/i.test(folded);
  return hasAddVerb && !hasReplaceVerb && hasComponentScope && getRequestedComponentTypes(userPrompt).length > 0;
}

function requestedComponentLimit(userPrompt: string): number | null {
  const folded = foldVietnameseText(userPrompt);
  return /(^|\b)(1|mot|one|single)(\b|$)/i.test(folded) ? 1 : null;
}

function componentTypeLabel(type: string): string {
  if (type === 'html') return 'Nội dung lý thuyết';
  if (type === 'problem') return 'Câu hỏi kiểm tra';
  if (type === 'la_faq') return 'Hỏi đáp';
  if (type === 'la_sortable') return 'sắp xếp ô chữ';
  if (type === 'la_crossword') return 'Đố vui ô chữ';
  if (type === 'la_diagram') return 'Sơ đồ trực quan';
  return type;
}

function formatComponentTypeLabels(types: Iterable<string>): string {
  const labels = Array.from(types)
    .map(type => componentTypeLabel(type))
    .filter(Boolean);
  return Array.from(new Set(labels)).join(', ');
}

function humanizeLessonAuthorPlanText(value: string): string {
  return value
    .replace(/\bla_diagram\b/g, componentTypeLabel('la_diagram'))
    .replace(/\bla_faq\b/g, componentTypeLabel('la_faq'))
    .replace(/\bla_sortable\b/g, componentTypeLabel('la_sortable'))
    .replace(/\bla_crossword\b/g, componentTypeLabel('la_crossword'))
    .replace(/\bproblem\b/g, componentTypeLabel('problem'))
    .replace(/\bhtml\b/g, componentTypeLabel('html'));
}

function toLessonAuthorDisplayProposal(proposal: LessonAuthorProposal): LessonAuthorProposal {
  return {
    ...proposal,
    summary: humanizeLessonAuthorPlanText(proposal.summary),
  };
}

function constrainAdditiveComponentProposal(
  proposal: LessonAuthorProposal,
  userPrompt: string,
  outlineMentions: LessonAuthorOutlineMention[],
): LessonAuthorProposal {
  if (!isAdditiveComponentOnlyRequest(userPrompt, outlineMentions)) return proposal;

  const requestedTypes = new Set(getRequestedComponentTypes(userPrompt));
  let remaining = requestedComponentLimit(userPrompt) ?? Number.POSITIVE_INFINITY;
  let keptCount = 0;

  const chapters: LessonAuthorChapterProposal[] = proposal.chapters
    .map((chapter): LessonAuthorChapterProposal => ({
      ...chapter,
      lessons: chapter.lessons
        .map((lesson): LessonAuthorLessonProposal => ({
          ...lesson,
          units: lesson.units
            .map((unit): LessonAuthorUnitProposal => {
              const components = (unit.components ?? []).filter(component => {
                if (!requestedTypes.has(component.type) || remaining <= 0) return false;
                remaining -= 1;
                keptCount += 1;
                return true;
              });
              return { ...unit, components };
            })
            .filter(unit => (unit.components ?? []).length > 0),
        }))
        .filter(lesson => lesson.units.length > 0),
    }))
    .filter(chapter => chapter.lessons.length > 0);

  if (keptCount === 0 || chapters.length === 0) {
    throw new Error(`AI proposal did not include requested component type: ${Array.from(requestedTypes).map(componentTypeLabel).join(', ')}`);
  }

  const labels = Array.from(requestedTypes).map(componentTypeLabel).join(', ');
  const target = outlineMentions[0]?.display_name || 'target đã chọn';
  return {
    summary: `Đề xuất thêm ${keptCount} component ${labels} vào "${target}". Không thay thế, xoá, hoặc ghi đè component hiện có.`,
    chapters,
  };
}

function sanitizeInternalErrorReason(err: any): string {
  const msg = err?.message || err?.toString?.() || 'Unknown lesson author error';
  return redactGeminiApiKeys(String(msg)).slice(0, 2000);
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

const MAX_PLAN_PREVIEW_CHARS = 14000;
const MAX_DETAILED_PLAN_UNITS = 18;

function clipPreviewText(value: unknown, maxLength: number): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function previewPlainText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return clipPreviewText(stripHtml(decodeXmlEntities(value)), maxLength);
}

function parseJsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getComponentPayload(component: LessonAuthorComponentProposal, key: string): unknown {
  const metadata = asRecord(component.metadata);
  if (key in metadata) return parseJsonish(metadata[key]);

  const dataRecord = asRecord(component.data);
  if (key in dataRecord) return parseJsonish(dataRecord[key]);
  return null;
}

function xmlTagText(xml: string, tagName: string): string {
  const match = xml.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? previewPlainText(match[1], 500) : '';
}

function xmlAttribute(xml: string, tagName: string, attrName: string): string {
  const match = xml.match(new RegExp(`<${tagName}\\b[^>]*\\s${attrName}="([^"]*)"`, 'i'));
  return match ? decodeXmlEntities(match[1]).trim() : '';
}

function formatCorrectOptionsFromXml(xml: string, tagName: 'choice' | 'option'): string {
  const matches = [...xml.matchAll(new RegExp(`<${tagName}\\b[^>]*correct="(true|false)"[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi'))];
  if (matches.length === 0) return '';

  const preview = matches.slice(0, 5).map((match, index) => {
    const text = previewPlainText(match[2], 90);
    const correct = match[1].toLowerCase() === 'true' ? 'đúng' : 'sai';
    return `${index + 1}. ${text} (${correct})`;
  });
  if (matches.length > preview.length) preview.push(`... và ${matches.length - preview.length} lựa chọn khác`);
  return preview.join('; ');
}

function problemTypeLabelFromXml(xml: string): string {
  if (/<multiplechoiceresponse\b/i.test(xml)) return 'Trắc nghiệm 1 đáp án';
  if (/<choiceresponse\b/i.test(xml)) return 'Trắc nghiệm nhiều đáp án';
  if (/<optionresponse\b/i.test(xml)) return 'Danh sách thả xuống';
  if (/<numericalresponse\b/i.test(xml)) return 'Điền số';
  if (/<stringresponse\b/i.test(xml)) return 'Điền văn bản';
  return 'Câu hỏi kiểm tra';
}

function formatProblemComponentDetails(component: LessonAuthorComponentProposal): string[] {
  const xml = typeof component.data === 'string' ? component.data : '';
  if (!xml) return ['Cấu hình câu hỏi đã được tạo trong component.'];

  const lines = [`Dạng: ${problemTypeLabelFromXml(xml)}`];
  const question = xmlTagText(xml, 'label');
  if (question) lines.push(`Câu hỏi: ${clipPreviewText(question, 220)}`);

  if (/<multiplechoiceresponse\b|<choiceresponse\b/i.test(xml)) {
    const choices = formatCorrectOptionsFromXml(xml, 'choice');
    if (choices) lines.push(`Lựa chọn: ${choices}`);
  } else if (/<optionresponse\b/i.test(xml)) {
    const options = formatCorrectOptionsFromXml(xml, 'option');
    const correctAttr = xmlAttribute(xml, 'optioninput', 'correct');
    if (options) lines.push(`Tuỳ chọn: ${options}`);
    else if (correctAttr) lines.push(`Đáp án đúng: ${correctAttr}`);
  } else if (/<numericalresponse\b/i.test(xml)) {
    const answer = xmlAttribute(xml, 'numericalresponse', 'answer');
    const tolerance = xmlAttribute(xml, 'responseparam', 'default');
    if (answer) lines.push(`Đáp án: ${answer}${tolerance ? `, sai số: ${tolerance}` : ''}`);
  } else if (/<stringresponse\b/i.test(xml)) {
    const answer = xmlAttribute(xml, 'stringresponse', 'answer');
    const mode = xmlAttribute(xml, 'stringresponse', 'type') === 'cs' ? 'phân biệt hoa/thường' : 'không phân biệt hoa/thường';
    if (answer) lines.push(`Đáp án: ${answer} (${mode})`);
  }

  const solution = xmlTagText(xml, 'solution');
  if (solution) lines.push(`Giải thích: ${clipPreviewText(solution, 220)}`);
  return lines;
}

function formatFaqComponentDetails(component: LessonAuthorComponentProposal): string[] {
  const faqData = asRecord(getComponentPayload(component, 'faq_data'));
  const items = Array.isArray(faqData.items) ? faqData.items.map(asRecord) : [];
  if (items.length === 0) return ['Danh sách hỏi đáp đã được tạo.'];

  const questions = items.slice(0, 3).map((item, index) => {
    const question = readString(item.question, `Câu hỏi ${index + 1}`, 180);
    const answer = previewPlainText(readString(item.answer, '', 500), 140);
    return `${index + 1}. ${question}${answer ? ` -> ${answer}` : ''}`;
  });
  if (items.length > questions.length) questions.push(`... và ${items.length - questions.length} câu hỏi khác`);
  return [`Nội dung FAQ: ${questions.join(' | ')}`];
}

function formatSortableComponentDetails(component: LessonAuthorComponentProposal): string[] {
  const data = asRecord(component.data);
  const sortableData = asRecord(getComponentPayload(component, 'sortable_data'));
  const items = Array.isArray(sortableData.items) ? sortableData.items.map(asRecord) : [];
  const question = readString(asRecord(component.metadata).question_text ?? data.question_text, '', 300);
  const orderedItems = items
    .map((item, index) => `${index + 1}. ${readString(item.text ?? item.label ?? item.title, '', 120)}`)
    .filter(item => !item.endsWith('. '))
    .slice(0, 6);

  const lines: string[] = [];
  if (question) lines.push(`Yêu cầu: ${question}`);
  if (orderedItems.length > 0) lines.push(`Thứ tự đúng: ${orderedItems.join(' -> ')}${items.length > orderedItems.length ? ` -> ... (${items.length} mục)` : ''}`);
  return lines.length > 0 ? lines : ['Bài sắp xếp đã có danh sách đáp án đúng.'];
}

function formatCrosswordComponentDetails(component: LessonAuthorComponentProposal): string[] {
  const crosswordData = asRecord(getComponentPayload(component, 'crossword_data'));
  const words = Array.isArray(crosswordData.words) ? crosswordData.words.map(asRecord) : [];
  if (words.length === 0) return ['Đố vui ô chữ đã có bộ từ khoá và gợi ý.'];

  const preview = words.slice(0, 5).map((word, index) => {
    const answer = readString(word.answer, `Từ ${index + 1}`, 80);
    const clue = readString(word.clue ?? word.hint, '', 140);
    return `${answer}${clue ? ` (${clue})` : ''}`;
  });
  if (words.length > preview.length) preview.push(`... và ${words.length - preview.length} từ khác`);
  return [`Từ khoá: ${preview.join('; ')}`];
}

function formatDiagramComponentDetails(component: LessonAuthorComponentProposal): string[] {
  const diagramData = asRecord(getComponentPayload(component, 'diagram_data'));
  const diagrams = Array.isArray(diagramData.diagrams) ? diagramData.diagrams.map(asRecord) : [];
  const diagram = diagrams[0] ?? {};
  const nodes = Array.isArray(diagram.nodes) ? diagram.nodes.map(asRecord) : [];
  const edges = Array.isArray(diagram.edges) ? diagram.edges.map(asRecord) : [];
  const nodeLabels = nodes
    .map(node => readString(asRecord(node.data).label ?? node.label, '', 120))
    .filter(Boolean)
    .slice(0, 8);

  const lines: string[] = [];
  if (nodeLabels.length > 0) lines.push(`Nút chính: ${nodeLabels.join(', ')}${nodes.length > nodeLabels.length ? `, ... (${nodes.length} nút)` : ''}`);
  lines.push(`Liên kết: ${edges.length} cạnh quan hệ`);
  return lines;
}

function formatHtmlComponentDetails(component: LessonAuthorComponentProposal): string[] {
  const dataRecord = asRecord(component.data);
  const html = typeof component.data === 'string'
    ? component.data
    : readString(dataRecord.html ?? dataRecord.content, '', MAX_UNIT_HTML_CHARS);
  const preview = previewPlainText(html, 320);
  return preview ? [`Nội dung chính: ${preview}`] : ['Nội dung lý thuyết đã được soạn trong component.'];
}

function formatComponentDetails(component: LessonAuthorComponentProposal): string[] {
  switch (component.type) {
    case 'html':
      return formatHtmlComponentDetails(component);
    case 'problem':
      return formatProblemComponentDetails(component);
    case 'la_faq':
      return formatFaqComponentDetails(component);
    case 'la_sortable':
      return formatSortableComponentDetails(component);
    case 'la_crossword':
      return formatCrosswordComponentDetails(component);
    case 'la_diagram':
      return formatDiagramComponentDetails(component);
    default:
      return [];
  }
}

function getProposalMetrics(proposal: LessonAuthorProposal): { lessons: number; units: number; components: number } {
  let lessons = 0;
  let units = 0;
  let components = 0;
  for (const chapter of proposal.chapters) {
    lessons += chapter.lessons.length;
    for (const lesson of chapter.lessons) {
      units += lesson.units.length;
      for (const unit of lesson.units) components += (unit.components ?? []).length;
    }
  }
  return { lessons, units, components };
}

function formatProposalPreview(proposal: LessonAuthorProposal, jobId: string): string {
  const pendingSummary = humanizeLessonAuthorPlanText(proposal.summary)
    .replace(/^đã tạo/i, 'Đề xuất tạo')
    .replace(/^da tao/i, 'Đề xuất tạo')
    .replace(/^đã cập nhật/i, 'Đề xuất cập nhật')
    .replace(/^da cap nhat/i, 'Đề xuất cập nhật');
  const metrics = getProposalMetrics(proposal);
  const lines: string[] = [
    'Mình đã chuẩn bị bản đề xuất chi tiết. Chưa có block nào được ghi vào outline trước khi admin bấm Áp dụng.',
    '',
    `Tóm tắt: ${pendingSummary}`,
    `Phạm vi: ${proposal.chapters.length} chương, ${metrics.lessons} bài, ${metrics.units} unit, ${metrics.components} component.`,
    `Mã đề xuất: ${jobId}`,
    '',
    'Chi tiết plan:',
  ];
  let detailedUnitCount = 0;
  let clipped = false;
  let currentChars = lines.join('\n').length;

  const pushLine = (line = ''): boolean => {
    if (clipped) return false;
    const nextLength = currentChars + line.length + 1;
    if (nextLength > MAX_PLAN_PREVIEW_CHARS) {
      clipped = true;
      return false;
    }
    lines.push(line);
    currentChars = nextLength;
    return true;
  };

  proposal.chapters.forEach((chapter, chapterIndex) => {
    pushLine('');
    pushLine(`${chapterIndex + 1}. Chương: ${chapter.title}`);
    chapter.lessons.forEach((lesson, lessonIndex) => {
      const componentTypes = new Set(
        lesson.units.flatMap(unit => (unit.components ?? []).map(component => component.type)),
      );
      const typeText = formatComponentTypeLabels(componentTypes) || componentTypeLabel('html');
      pushLine(`   ${chapterIndex + 1}.${lessonIndex + 1}. Bài: ${lesson.title}`);
      pushLine(`      Mục tiêu nội dung: ${lesson.units.length} unit; loại nội dung: ${typeText}.`);
      lesson.units.forEach((unit, unitIndex) => {
        const components = unit.components ?? [];
        const unitTypes = formatComponentTypeLabels(components.map(component => component.type)) || componentTypeLabel('html');
        const shouldShowDetails = detailedUnitCount < MAX_DETAILED_PLAN_UNITS;
        pushLine(`      ${chapterIndex + 1}.${lessonIndex + 1}.${unitIndex + 1}. Unit: ${unit.title}`);
        pushLine(`         Components: ${unitTypes}.`);

        if (!shouldShowDetails) {
          pushLine('         Chi tiết component đã được rút gọn trong preview để tránh quá dài.');
          return;
        }

        detailedUnitCount += 1;
        components.forEach((component, componentIndex) => {
          pushLine(`         - ${componentIndex + 1}. ${component.title || componentTypeLabel(component.type)} (${componentTypeLabel(component.type)})`);
          for (const detail of formatComponentDetails(component)) {
            pushLine(`           + ${detail}`);
          }
        });
      });
    });
  });

  if (clipped || metrics.units > MAX_DETAILED_PLAN_UNITS) {
    lines.push('');
    lines.push(`Preview đã rút gọn chi tiết sau ${Math.min(detailedUnitCount, MAX_DETAILED_PLAN_UNITS)} unit đầu để widget không quá nặng. Proposal đầy đủ vẫn được lưu trong job và sẽ được áp dụng đầy đủ nếu admin bấm Áp dụng.`);
  }

  lines.push('');
  lines.push('Kiểm tra bản đề xuất để xác nhận, sau đó bấm Áp dụng. Chỉ sau khi bấm Áp dụng, backend mới ghi thay đổi vào outline và refresh cây bài học.');
  return lines.join('\n');
}

function looksLikeLessonAuthorProposalJsonResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const hasJsonFence = /```json/i.test(trimmed);
  const hasProposalShape = /"chapters"\s*:/.test(trimmed) || /"changes"\s*:/.test(trimmed);
  const hasCourseTreeShape = /"lessons"\s*:/.test(trimmed) || /"units"\s*:/.test(trimmed) || /"components"\s*:/.test(trimmed);
  const mentionsProposal = /proposal|de xuat|đề xuất/i.test(foldVietnameseText(trimmed));
  return (hasJsonFence && (hasProposalShape || hasCourseTreeShape || mentionsProposal))
    || (hasProposalShape && hasCourseTreeShape);
}

async function convertLessonAuthorChatJsonToProposalMessage(
  ctx: ConversationContext,
  userId: string,
  prompt: string,
  rawResponse: string,
  sourceDocuments: LessonAuthorSourceDocument[],
): Promise<{
  content: string;
  metadata: Record<string, unknown>;
  proposal?: LessonAuthorProposal;
  jobId: string;
} | null> {
  if (ctx.target !== LESSON_AUTHOR_TARGET || !looksLikeLessonAuthorProposalJsonResponse(rawResponse)) return null;

  try {
    if (!ctx.botKbId) throw new Error('Chưa cấu hình KB active cho chuyên gia tạo bài học');
    const proposal = normalizeLessonAuthorProposal(extractJsonObject(rawResponse));
    const jobId = await createLessonAuthorJob(ctx, userId, prompt, ctx.botKbId, proposal, sourceDocuments);
    logLessonAuthorFlow('chat_json_intercepted_as_proposal', {
      conversation_id: ctx.conversationId,
      job_id: jobId,
      response_chars: rawResponse.length,
      ...getLessonAuthorProposalMetrics(proposal),
    });
    return {
      content: formatProposalPreview(proposal, jobId),
      metadata: {
        kind: 'lesson_author_proposal',
        lesson_author_job_id: jobId,
        ...(sourceDocuments.length > 0 ? { source_documents: sourceDocuments.map(toSourceDocumentMetadata) } : {}),
      },
      proposal: toLessonAuthorDisplayProposal(proposal),
      jobId,
    };
  } catch (err) {
    const errorReason = sanitizeInternalErrorReason(err);
    const jobId = await createFailedLessonAuthorJob(ctx, userId, prompt, ctx.botKbId ?? null, errorReason, sourceDocuments);
    logLessonAuthorFlow('chat_json_intercept_failed', {
      conversation_id: ctx.conversationId,
      job_id: jobId,
      response_chars: rawResponse.length,
      error: errorReason,
    });
    return {
      content: formatLessonAuthorFailurePreview(err, jobId),
      metadata: {
        kind: 'lesson_author_generation_failed',
        lesson_author_job_id: jobId,
        ...(sourceDocuments.length > 0 ? { source_documents: sourceDocuments.map(toSourceDocumentMetadata) } : {}),
      },
      jobId,
    };
  }
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

// ── Scoring-based intent classifier ──
// Mỗi signal có weight. Tổng > 0 → draft_lesson, ≤ 0 → chat
// KHÔNG gọi Gemini — zero extra API call

interface IntentSignal {
  name: string;
  weight: number;
  matched: boolean;
}

interface IntentClassificationResult {
  intent: LessonAuthorIntent;
  signals: IntentSignal[];
  score: number;
}

function classifyLessonAuthorIntentV2(
  userPrompt: string,
  outlineMentions: LessonAuthorOutlineMention[],
  mode: 'chat' | 'draft_lesson' | 'auto',
): IntentClassificationResult {
  // FE forced mode → trả ngay
  if (mode === 'draft_lesson') return { intent: 'draft_lesson', signals: [], score: 100 };
  if (mode === 'chat') return { intent: 'chat', signals: [], score: -100 };

  const folded = foldVietnameseText(userPrompt);
  const signals: IntentSignal[] = [];

  // ══ POSITIVE signals → draft ══

  // +3: Strong create/write verb
  const strongDraft = /(^|\b)(tao|soan|viet|thiet ke|xay dung|chia|generate|create|build|design|draft|de xuat|len plan|lap plan)(\b|$)/i.test(folded);
  signals.push({ name: 'strong_draft_verb', weight: 3, matched: strongDraft });

  // +2: Moderate edit verb
  const moderateDraft = /(^|\b)(sua|chinh sua|cap nhat|bo sung|them|goi y|phan chia|add|insert|update|edit|improve|toi uu|cai thien|viet lai|lam lai|mo rong|dai ti|dai hon|ngan gon)(\b|$)/i.test(folded);
  signals.push({ name: 'moderate_draft_verb', weight: 2, matched: moderateDraft });

  // +2: Course structure object
  const courseObj = /(^|\b)(bai hoc|noi dung bai hoc|lesson|unit|module|chapter|chuong|outline|cau truc|ly thuyet|bai tap|danh gia|muc tieu hoc tap|component|block|sequential|vertical)(\b|$)/i.test(folded);
  signals.push({ name: 'course_object', weight: 2, matched: courseObj });

  // +2: Component type keyword (specific types only, NOT generic words like "lý thuyết")
  const compType = /(^|\b)(quiz|problem|cau hoi trac nghiem|trac nghiem|diagram|so do|faq|hoi dap|crossword|o chu|sortable|sap xep|html|text|video|infographic|audio|media)(\b|$)/i.test(folded);
  signals.push({ name: 'component_type', weight: 2, matched: compType });

  // +3: Instructional design / course planning language
  const instructionalDesign = /(^|\b)(instructional design|phuong phap instructional design|thiet ke hoc tap|thiet ke noi dung|cau truc bai hoc|learning objective|muc tieu hoc tap|module hoc|hoc lieu)(\b|$)/i.test(folded);
  signals.push({ name: 'instructional_design', weight: 3, matched: instructionalDesign });

  // +3: @mention present → rất mạnh
  signals.push({ name: 'has_outline_mention', weight: 3, matched: outlineMentions.length > 0 });

  // +1: Imperative (lam di, ok, cứ thế...)
  const imperative = /(^|\b)(lam di|lam luon|cu the|tao di|them di|sua di|bat dau|go ahead|do it|proceed)(\b|$)/i.test(folded);
  signals.push({ name: 'imperative_tone', weight: 1, matched: imperative });

  // ══ NEGATIVE signals → chat ══

  // -3: Question/explain intent
  const chatIntent = /(^|\b)(la gi|giai thich|tom tat|hoi|cho biet|phan tich|doc|so sanh|tai sao|vi sao|nhu the nao|the nao|review|explain|summarize|what is|how|why)(\b|$)/i.test(folded);
  signals.push({ name: 'strong_chat_intent', weight: -3, matched: chatIntent });

  // -3: Question form (? or question starters) — rất mạnh, câu hỏi gần như chắc chắn là chat
  const question = /\?$|^(ban co the|lieu|hay|co nen|nen|co phai|theo ban|ban thay|ban nghi)/i.test(folded);
  signals.push({ name: 'question_form', weight: -3, matched: question });

  // -3: Evaluation/assessment questions ("đã ok chưa", "đủ chưa", "đánh giá")
  const evalQuestion = /(^|\b)(da ok|da du|day du|da on|ok chua|du chua|on chua|danh gia|nhan xet|tot chua|duoc chua|hop ly|da xong)(\b|$)/i.test(folded);
  signals.push({ name: 'evaluation_question', weight: -3, matched: evalQuestion });

  // -2: Read/check verbs
  const readVerb = /(^|\b)(kiem tra|xem|da co gi|hien tai|dang co|list|show|check|status)(\b|$)/i.test(folded);
  signals.push({ name: 'read_verb', weight: -2, matched: readVerb });

  // -2: Short ambiguous message (< 15 chars, no draft verbs) — likely conversational
  const isShortAmbiguous = userPrompt.trim().length < 15 && !strongDraft && !moderateDraft;
  signals.push({ name: 'short_ambiguous', weight: -2, matched: isShortAmbiguous });

  // -99: DELETE INTENT → HARD BLOCK, luôn vào chat
  const deleteIntent = /(^|\b)(xoa|delete|remove|bo di|go bo|huy|cancel|loai bo)(\b|$)/i.test(folded);
  signals.push({ name: 'delete_intent', weight: -99, matched: deleteIntent });

  const score = signals.filter(s => s.matched).reduce((sum, s) => sum + s.weight, 0);

  return {
    intent: score > 0 ? 'draft_lesson' : 'chat',
    signals,
    score,
  };
}


async function generateLessonAuthorProposal(
  ctx: ConversationContext,
  userPrompt: string,
  kbId: string,
  outlineMentions: LessonAuthorOutlineMention[] = [],
  mentionContext = '',
  targetScopeInstruction = '',
  sourceDocuments: LessonAuthorSourceDocument[] = [],
): Promise<LessonAuthorProposal> {
  const sourceDocumentContext = formatSourceDocumentsForPrompt(sourceDocuments);
  logLessonAuthorFlow('proposal_generate_start', {
    conversation_id: ctx.conversationId,
    course_id: ctx.courseId,
    bot_id: ctx.botId,
    kb_id: kbId,
    prompt_chars: userPrompt.length,
    outline_mentions: outlineMentions.length,
    source_documents: sourceDocuments.length,
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
  const scopedOutlineMentions = outlineMentions.slice(0, 1);
  const basePrompt = [
    `Admin request:\n${userPrompt}`,
    sourceDocumentContext,
    `Current course context:\n${course.outline}`,
    `Current chapter count: ${course.chapterCount}.`,
    'HARD SCOPE LIMIT: One proposal may contain content for exactly ONE top-level section/chapter only. Never generate full detailed content for the entire course, all sections, or multiple chapters in one proposal. If the admin asks for the whole course, choose only the selected/explicit/next/first suitable section and state in summary that other sections must be handled in separate requests.',
    course.hasStructure
      ? 'The course already has structure. Propose ONLY missing or clearly requested new lessons/units inside one section/chapter. Do not repeat existing chapter, lesson, or unit titles from the current outline.'
      : 'The course has no chapters yet. Build only the first initial section/chapter from the course name, course description, admin request, and active KB.',
    scopedOutlineMentions.length > 0
      ? `Admin selected exact outline target with @mention:\n${formatOutlineMentionsForPrompt(scopedOutlineMentions)}\n${mentionContext}\nUse this ID and the database subtree/context as the authoritative target scope. If the admin asks to edit, expand, add components, or improve content, produce proposal content ONLY for the selected target path unless the admin explicitly asks for a broader change within the same section. Preserve the selected target title when returning the matching chapter/lesson/unit so the apply step updates that area instead of creating duplicates.`
      : 'Admin did not select an exact @mention target. Infer the target from the request and current course outline. If the request is ambiguous, answer with a clarification instead of generating unrelated structure.',
    targetScopeInstruction,
    'If the admin asks for a specific next chapter number, create only that new chapter and place it after the existing chapters. Example: if the course already has 3 chapters and the admin asks for chapter 4, return exactly one new chapter for chapter 4.',
    'Return JSON only with this schema:',
    '{"summary":"string","chapters":[{"title":"string","lessons":[{"title":"string","units":[{"title":"string","components":[{"type":"html","title":"string","html":"safe html string"},{"type":"problem","title":"string","problem_type":"multiple_choice|multiple_select|dropdown|numerical|short_text","question":"string","choices":[{"text":"string","correct":true}],"options":["string"],"answer":"string|number","tolerance":"5%","explanation":"string"},{"type":"la_faq","title":"string","items":[{"question":"string","answer":"string"}]},{"type":"la_sortable","title":"string","question_text":"string","items":["first","second","third"]},{"type":"la_crossword","title":"string","words":[{"answer":"TERM","clue":"string","hint":"string"}]},{"type":"la_diagram","title":"string","name":"string","nodes":[{"label":"string","shape":"rectangle|rounded|ellipse","tooltip":"string"}],"edges":[{"source":0,"target":1,"label":"string"}]}]}]}]}]}',
    `Limits: exactly 1 top-level section/chapter max, ${MAX_PROPOSAL_LESSONS} lessons total inside that section, ${MAX_PROPOSAL_UNITS} units total inside that section, ${MAX_COMPONENTS_PER_UNIT} components per unit.`,
    'Use the active KB as the source of truth. Do not invent facts that are not supported by the KB.',
    'The summary must describe a pending proposal only. Do not say content was created, applied, inserted, or updated in the database/outline before admin approval.',
    'Each unit must contain 1-3 components. Usually start with one html component for explanation, then add one interactive component when it improves learning.',
    'Choose component types by pedagogy: html for explanation, problem for checks, la_sortable for ordered processes, la_faq for definitions/misconceptions, la_crossword only for vocabulary terms, la_diagram for concept maps, workflows, hierarchies, relationships, or cause-effect structures. Do not force every type.',
    'For la_diagram, output 4-8 meaningful nodes with short labels, useful tooltip/description text, and clear edges with relationship labels when helpful. Edge source/target may be zero-based node indexes or exact node labels. Do not include icons in labels; backend will add consistent label icons automatically.',
    'Do not output video, pdf, image, or unsupported component types.',
    'Each html component must be real lesson content, not an empty shell: include a short objective, explanation, and key points. Prefer 500-1200 Vietnamese words when the KB supports it.',
    'Problem components may use exactly one of 5 problem_type values: multiple_choice, multiple_select, dropdown, numerical, short_text. For multiple_choice/multiple_select provide choices with correct flags. For dropdown provide options and answer, or choices with one correct flag. For numerical provide answer and optional tolerance such as "5%" or "0.01". For short_text provide answer and optional answers for accepted alternatives.',
    'Problem choices/dropdown options must include at least 2 options and at least 1 correct answer. FAQ needs at least 2 items. Sortable needs at least 3 ordered items. Crossword needs at least 3 short terms.',
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

    // ── DEBUG: log raw LLM response for troubleshooting ──
    logLessonAuthorFlow('proposal_gemini_raw_response_debug', {
      conversation_id: ctx.conversationId,
      attempt: attempt + 1,
      response_first_2000: lastResponseText.slice(0, 2000),
      response_last_500: lastResponseText.slice(-500),
    });

    try {
      const extractedJson = extractJsonObject(lastResponseText);
      const extractedRecord = asRecord(extractedJson);

      // ── DEBUG: log parsed JSON structure ──
      logLessonAuthorFlow('proposal_parsed_json_debug', {
        conversation_id: ctx.conversationId,
        attempt: attempt + 1,
        parsed_type: typeof extractedJson,
        is_array: Array.isArray(extractedJson),
        top_keys: Object.keys(extractedRecord).slice(0, 20),
        has_chapters: 'chapters' in extractedRecord,
        chapters_type: typeof extractedRecord.chapters,
        chapters_is_array: Array.isArray(extractedRecord.chapters),
        chapters_length: Array.isArray(extractedRecord.chapters) ? extractedRecord.chapters.length : -1,
      });

      const proposal = constrainAdditiveComponentProposal(
        normalizeLessonAuthorProposal(extractedJson),
        userPrompt,
        scopedOutlineMentions,
      );
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

// ── Staged proposal generation for large scopes ──

const STAGED_THRESHOLD_UNITS = 3;         // If > 3 units → use staged
const MAX_UNITS_PER_CONTENT_BATCH = 3;    // Batch 3 units/call to balance API calls vs quality

async function generateProposalSkeleton(
  ctx: ConversationContext,
  userPrompt: string,
  kbId: string,
  course: { courseName: string; courseDescription: string; hasStructure: boolean; chapterCount: number; outline: string },
  outlineMentions: LessonAuthorOutlineMention[],
  mentionContext: string,
  targetScopeInstruction: string,
  sourceDocuments: LessonAuthorSourceDocument[],
): Promise<LessonAuthorProposal> {
  const aiClient = await getGeminiClient(ctx.tenantId);
  const storeName = await getCachedStoreName(kbId);
  if (!storeName) throw new Error('KB active chưa có Gemini File Search store.');

  const scopedOutlineMentions = outlineMentions.slice(0, 1);
  const skeletonPrompt = [
    `Admin request:\n${userPrompt}`,
    formatSourceDocumentsForPrompt(sourceDocuments),
    `Current course:\n${course.outline}`,
    `Current chapter count: ${course.chapterCount}.`,
    'HARD SCOPE LIMIT: Return a skeleton for exactly ONE top-level section/chapter only. Never plan full course content or multiple sections in one proposal. If the admin asked for the whole course, pick only the selected/explicit/next/first suitable section and mention the one-section limit in summary.',
    course.hasStructure
      ? 'The course already has structure. Propose ONLY missing or clearly requested lessons/units inside one section/chapter.'
      : 'The course has no chapters yet. Build only the first initial section/chapter.',
    scopedOutlineMentions.length > 0
      ? `Admin selected outline target:\n${formatOutlineMentionsForPrompt(scopedOutlineMentions)}\n${mentionContext}`
      : '',
    targetScopeInstruction,
    'STAGE 1 — SKELETON ONLY.',
    'Return JSON with chapter, lesson, unit titles and component TYPES only.',
    'Do NOT generate actual html content, quiz questions, FAQ items, or diagram data yet.',
    'For each component, set: type, title. Leave html/data/items/words/nodes/edges empty or omitted.',
    '{"summary":"string","chapters":[{"title":"string","lessons":[{"title":"string","units":[{"title":"string","components":[{"type":"html|problem|la_faq|la_sortable|la_crossword|la_diagram","title":"string"}]}]}]}]}',
    `Limits: exactly 1 top-level section/chapter max, ${MAX_PROPOSAL_LESSONS} lessons inside that section, ${MAX_PROPOSAL_UNITS} units inside that section, ${MAX_COMPONENTS_PER_UNIT} components/unit.`,
    'Use KB as source of truth. Design structure following Instructional Design principles.',
    'Do not output video, pdf, image, or unsupported component types.',
  ].filter(Boolean).join('\n\n');

  logLessonAuthorFlow('staged_skeleton_start', {
    conversation_id: ctx.conversationId,
    course_id: ctx.courseId,
    prompt_chars: skeletonPrompt.length,
  });

  const response = await aiClient.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: skeletonPrompt }] }],
    config: {
      systemInstruction: `${ctx.systemPrompt}\n\nYou are creating a structural outline ONLY. No content yet.`,
      tools: [{ fileSearch: { fileSearchStoreNames: [storeName] } }],
    } as any,
  });

  const rawText = response.text ?? '';
  logLessonAuthorFlow('staged_skeleton_response', {
    conversation_id: ctx.conversationId,
    response_chars: rawText.length,
  });

  return extractJsonObject(rawText) as LessonAuthorProposal;
}

interface UnitBatchItem {
  chapterTitle: string;
  lessonTitle: string;
  unitTitle: string;
  componentTypes: string[];
}

async function generateUnitContentBatch(
  ctx: ConversationContext,
  kbId: string,
  batch: UnitBatchItem[],
  courseName: string,
  sourceDocuments: LessonAuthorSourceDocument[],
): Promise<LessonAuthorUnitProposal[]> {
  const aiClient = await getGeminiClient(ctx.tenantId);
  const storeName = await getCachedStoreName(kbId);
  if (!storeName) throw new Error('KB store not found');

  const unitDescriptions = batch.map((item, i) =>
    `${i + 1}. Chapter: "${item.chapterTitle}" > Lesson: "${item.lessonTitle}" > Unit: "${item.unitTitle}" → components: [${item.componentTypes.join(', ')}]`,
  ).join('\n');

  const contentPrompt = [
    'STAGE 2 — GENERATE FULL CONTENT for these units:',
    unitDescriptions,
    formatSourceDocumentsForPrompt(sourceDocuments),
    `Course: ${courseName}`,
    'For each unit, generate COMPLETE component content:',
    '- html: real lesson content, 500-1200 Vietnamese words, with h3/p/ul/ol/strong/em. Include learning objective, explanation, key points, examples.',
    '- problem: choose one problem_type from "multiple_choice", "multiple_select", "dropdown", "numerical", "short_text". For multiple_choice/multiple_select provide choices with correct flags. For dropdown provide options and answer, or choices with one correct flag. For numerical provide answer and optional tolerance. For short_text provide answer and optional accepted answers.',
    '- la_faq: provide items array with 2+ Q&A items.',
    '- la_sortable: provide question_text and items array with 3+ ordered items.',
    '- la_crossword: provide words array with 3+ terms, each having answer, clue, hint.',
    '- la_diagram: provide 4-8 meaningful nodes with short labels, tooltip/description, and clear edges with relationship labels when useful. Do not include icons in labels; backend will add label icons.',
    'Return JSON array of units: [{"title":"exact unit title","components":[{"type":"html","title":"string","html":"full html content"}, ...]}]',
    'Use KB as source of truth. Do not invent facts not supported by KB.',
    'HTML must be clean. Use h3, p, ul, ol, strong, em only. No script/style/iframe.',
    'Each html component must be real lesson content with objective, explanation, key points — not empty shells.',
  ].filter(Boolean).join('\n\n');

  logLessonAuthorFlow('staged_content_batch_start', {
    conversation_id: ctx.conversationId,
    batch_size: batch.length,
    unit_titles: batch.map(b => b.unitTitle),
    prompt_chars: contentPrompt.length,
  });

  const response = await aiClient.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: 'user', parts: [{ text: contentPrompt }] }],
    config: {
      systemInstruction: `${ctx.systemPrompt}\n\nYou are generating detailed lesson content for specific units. Follow Instructional Design best practices. Return JSON array only.`,
      tools: [{ fileSearch: { fileSearchStoreNames: [storeName] } }],
    } as any,
  });

  const rawText = response.text ?? '';
  logLessonAuthorFlow('staged_content_batch_response', {
    conversation_id: ctx.conversationId,
    batch_size: batch.length,
    response_chars: rawText.length,
  });

  const parsed = extractJsonObject(rawText);
  return Array.isArray(parsed) ? parsed as LessonAuthorUnitProposal[] : [parsed as LessonAuthorUnitProposal];
}

async function generateLessonAuthorProposalV2(
  ctx: ConversationContext,
  userPrompt: string,
  kbId: string,
  outlineMentions: LessonAuthorOutlineMention[],
  mentionContext: string,
  targetScopeInstruction: string,
  sourceDocuments: LessonAuthorSourceDocument[],
  onProgress?: (stage: string, detail: string) => void,
): Promise<LessonAuthorProposal> {
  if (!ctx.courseId) throw new Error('courseId is required for lesson author');
  const course = await getDraftCourseOutlineForPrompt(ctx.courseId, ctx.tenantId);

  // Decide between single-shot and staged generation
  // Staged: only when @mention targets chapter-level blocks (large scope, many units expected)
  // Single-shot: no @mention (let Gemini decide scope), or @mention on lesson/unit (small scope)
  const isLargeScope = outlineMentions.length > 0
    && outlineMentions.some(m => m.block_type === 'chapter');

  if (!isLargeScope) {
    logLessonAuthorFlow('proposal_mode', { mode: 'single_shot', conversation_id: ctx.conversationId, reason: outlineMentions.length === 0 ? 'no_mention' : 'small_scope' });
    onProgress?.('generating', 'Đang tạo nội dung...');
    return generateLessonAuthorProposal(ctx, userPrompt, kbId, outlineMentions, mentionContext, targetScopeInstruction, sourceDocuments);
  }

  // Stage 1: Generate skeleton
  logLessonAuthorFlow('proposal_mode', { mode: 'staged', conversation_id: ctx.conversationId });
  onProgress?.('skeleton', 'Đang lên cấu trúc bài học...');

  let skeleton: LessonAuthorProposal | null = null;
  try {
    skeleton = await generateProposalSkeleton(
      ctx, userPrompt, kbId, course,
      outlineMentions, mentionContext, targetScopeInstruction, sourceDocuments,
    );
  } catch (err) {
    logLessonAuthorFlow('staged_skeleton_failed', {
      conversation_id: ctx.conversationId,
      error: (err as Error).message,
    });
  }

  // Parse skeleton to collect all units
  const allUnits: UnitBatchItem[] = [];
  if (skeleton) {
    const rawSkeleton = asRecord(skeleton);
    const allRawChaptersForSkeleton = Array.isArray(rawSkeleton.chapters) ? rawSkeleton.chapters : [];
    const rawChaptersForSkeleton = allRawChaptersForSkeleton.slice(0, MAX_PROPOSAL_CHAPTERS);
    if (allRawChaptersForSkeleton.length > MAX_PROPOSAL_CHAPTERS) {
      (skeleton as any).chapters = rawChaptersForSkeleton;
      logLessonAuthorFlow('staged_skeleton_scope_truncated', {
        conversation_id: ctx.conversationId,
        original_chapters: allRawChaptersForSkeleton.length,
        kept_chapters: rawChaptersForSkeleton.length,
      });
    }

    logLessonAuthorFlow('staged_skeleton_parsed', {
      conversation_id: ctx.conversationId,
      skeleton_type: typeof skeleton,
      skeleton_keys: Object.keys(rawSkeleton),
      chapters_count: rawChaptersForSkeleton.length,
      raw_chapters_type: typeof rawSkeleton.chapters,
      is_array: Array.isArray(rawSkeleton.chapters),
    });

    for (const chapterValue of rawChaptersForSkeleton) {
      const chapter = asRecord(chapterValue);
      const chapterTitle = readString(chapter.title, '', 180);
      const rawLessons = Array.isArray(chapter.lessons) ? chapter.lessons : [];
      for (const lessonValue of rawLessons) {
        const lesson = asRecord(lessonValue);
        const lessonTitle = readString(lesson.title, '', 180);
        const rawUnits = Array.isArray(lesson.units) ? lesson.units : [];
        for (const unitValue of rawUnits) {
          const unit = asRecord(unitValue);
          const unitTitle = readString(unit.title, '', 180);
          const rawComponents = Array.isArray(unit.components) ? unit.components : [];
          const componentTypes = rawComponents
            .map(c => readString(asRecord(c).type, 'html', 40))
            .filter(Boolean);
          allUnits.push({
            chapterTitle,
            lessonTitle,
            unitTitle,
            componentTypes: componentTypes.length > 0 ? componentTypes : ['html'],
          });
        }
      }
    }
  }

  logLessonAuthorFlow('staged_skeleton_done', {
    conversation_id: ctx.conversationId,
    total_units: allUnits.length,
    skeleton_available: skeleton !== null,
  });

  // If skeleton failed to parse or has too few units, fallback to single-shot
  if (allUnits.length <= STAGED_THRESHOLD_UNITS) {
    logLessonAuthorFlow('staged_fallback_single_shot', {
      conversation_id: ctx.conversationId,
      total_units: allUnits.length,
      reason: allUnits.length === 0 ? 'skeleton_parse_empty' : 'below_threshold',
    });
    onProgress?.('generating', 'Đang tạo nội dung...');
    return generateLessonAuthorProposal(ctx, userPrompt, kbId, outlineMentions, mentionContext, targetScopeInstruction, sourceDocuments);
  }

  // Stage 2: Generate content per batch
  const contentMap = new Map<string, LessonAuthorUnitProposal>();
  const batches: UnitBatchItem[][] = [];
  for (let i = 0; i < allUnits.length; i += MAX_UNITS_PER_CONTENT_BATCH) {
    batches.push(allUnits.slice(i, i + MAX_UNITS_PER_CONTENT_BATCH));
  }

  for (const [batchIndex, batch] of batches.entries()) {
    const progress = `${batchIndex + 1}/${batches.length}`;
    const unitNames = batch.map(b => b.unitTitle).join(', ');
    onProgress?.('content', `Đang soạn nội dung (${progress}): ${unitNames}`);

    try {
      const generated = await generateUnitContentBatch(
        ctx, kbId, batch, course.courseName, sourceDocuments,
      );

      for (let i = 0; i < batch.length && i < generated.length; i++) {
        const unitKey = `${batch[i].chapterTitle}|${batch[i].lessonTitle}|${batch[i].unitTitle}`;
        contentMap.set(unitKey, generated[i]);
      }

      logLessonAuthorFlow('staged_content_batch_done', {
        conversation_id: ctx.conversationId,
        batch: batchIndex + 1,
        total_batches: batches.length,
        generated_units: generated.length,
      });
    } catch (err) {
      logLessonAuthorFlow('staged_content_batch_failed', {
        conversation_id: ctx.conversationId,
        batch: batchIndex + 1,
        error: (err as Error).message,
      });
      // Continue with remaining batches — partial success is better than full failure
    }
  }

  // Assemble: merge content into skeleton
  onProgress?.('validating', 'Đang kiểm tra proposal...');

  const assembled: LessonAuthorProposal = {
    summary: readString((skeleton as any).summary, 'Generated lesson plan', 1000),
    chapters: (Array.isArray((skeleton as any)?.chapters) ? (skeleton as any).chapters : []).map((chapterValue: unknown) => {
      const chapter = asRecord(chapterValue);
      const chapterTitle = readString(chapter.title, '', 180);
      const rawLessons = Array.isArray(chapter.lessons) ? chapter.lessons : [];
      return {
        title: chapterTitle,
        lessons: rawLessons.map(lessonValue => {
          const lesson = asRecord(lessonValue);
          const lessonTitle = readString(lesson.title, '', 180);
          const rawUnits = Array.isArray(lesson.units) ? lesson.units : [];
          return {
            title: lessonTitle,
            units: rawUnits.map(unitValue => {
              const unit = asRecord(unitValue);
              const unitTitle = readString(unit.title, '', 180);
              const unitKey = `${chapterTitle}|${lessonTitle}|${unitTitle}`;
              const contentUnit = contentMap.get(unitKey);
              if (contentUnit) {
                return {
                  title: unitTitle,
                  components: Array.isArray(contentUnit.components) ? contentUnit.components as any : undefined,
                  html: contentUnit.html,
                } as LessonAuthorUnitProposal;
              }
              // Fallback: skeleton unit without generated content
              return { title: unitTitle, components: unit.components as any, html: (unit as any).html } as LessonAuthorUnitProposal;
            }),
          };
        }),
      };
    }),
  };

  // Normalize + validate
  return constrainAdditiveComponentProposal(
    normalizeLessonAuthorProposal(assembled),
    userPrompt,
    outlineMentions.slice(0, 1),
  );
}

function createLessonAuthorRequestHash(
  ctx: ConversationContext,
  kbId: string | null,
  prompt: string,
  sourceDocuments: LessonAuthorSourceDocument[] = [],
): string {
  const sourceKey = sourceDocuments.map(doc => doc.document_id).sort().join(',');
  return createHash('sha256')
    .update([ctx.tenantId, ctx.courseId, ctx.botId, kbId ?? '', sourceKey, prompt.trim()].join('|'))
    .digest('hex');
}

async function createLessonAuthorJob(
  ctx: ConversationContext,
  userId: string,
  prompt: string,
  kbId: string,
  proposal: LessonAuthorProposal,
  sourceDocuments: LessonAuthorSourceDocument[] = [],
): Promise<string> {
  if (!ctx.courseId) throw new Error('courseId is required for lesson author');
  const requestHash = createLessonAuthorRequestHash(ctx, kbId, prompt, sourceDocuments);
  const sourceDocumentMetadata = sourceDocuments.map(toSourceDocumentMetadata);

  const result = await query<{ id: string }>(
    `INSERT INTO lesson_author_jobs (
       tenant_id, course_id, conversation_id, bot_id, kb_id,
       requested_by, request_hash, prompt, proposal, status, source_documents
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'proposed', $10::jsonb)
     RETURNING id`,
    [
      ctx.tenantId,
      ctx.courseId,
      ctx.conversationId,
      ctx.botId,
      kbId,
      userId,
      requestHash,
      prompt,
      proposal,
      JSON.stringify(sourceDocumentMetadata),
    ],
  );
  logLessonAuthorFlow('proposal_job_created', {
    conversation_id: ctx.conversationId,
    course_id: ctx.courseId,
    job_id: result.rows[0].id,
    request_hash: requestHash,
    source_documents: sourceDocuments.length,
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
  sourceDocuments: LessonAuthorSourceDocument[] = [],
): Promise<string> {
  if (!ctx.courseId) throw new Error('courseId is required for lesson author');
  const requestHash = createLessonAuthorRequestHash(ctx, kbId, prompt, sourceDocuments);
  const sourceDocumentMetadata = sourceDocuments.map(toSourceDocumentMetadata);

  const result = await query<{ id: string }>(
    `INSERT INTO lesson_author_jobs (
       tenant_id, course_id, conversation_id, bot_id, kb_id,
       requested_by, request_hash, prompt, proposal, status, error_reason, source_documents
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb, 'failed', $9, $10::jsonb)
     RETURNING id`,
    [
      ctx.tenantId,
      ctx.courseId,
      ctx.conversationId,
      ctx.botId,
      kbId,
      userId,
      requestHash,
      prompt,
      errorReason,
      JSON.stringify(sourceDocumentMetadata),
    ],
  );
  logLessonAuthorFlow('proposal_failed_job_created', {
    conversation_id: ctx.conversationId,
    course_id: ctx.courseId,
    job_id: result.rows[0].id,
    request_hash: requestHash,
    source_documents: sourceDocuments.length,
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
    // ── Staleness check ──
    const STALENESS_THRESHOLD_MS = 30 * 60_000; // 30 minutes
    const jobAge = Date.now() - new Date(job.created_at).getTime();
    if (jobAge > STALENESS_THRESHOLD_MS) {
      const courseChanged = await query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM course_blocks
         WHERE course_id = $1 AND deleted_at IS NULL
           AND updated_at > $2`,
        [job.course_id, job.created_at],
      );
      if (courseChanged.rows[0]?.cnt > 0) {
        await query(
          `UPDATE lesson_author_jobs SET status = 'proposed', updated_at = now() WHERE id = $1`,
          [job.id],
        );
        logLessonAuthorFlow('apply_staleness_rejected', {
          job_id: job.id,
          course_id: job.course_id,
          age_minutes: Math.round(jobAge / 60_000),
        });
        throw new Error(
          `Proposal đã tạo ${Math.round(jobAge / 60_000)} phút trước và outline đã thay đổi. Tạo proposal mới để tránh conflict.`
        );
      }
    }

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
           updated_block_ids = $3::uuid[],
           updated_at = now()
       WHERE id = $1 AND tenant_id = $4`,
      [job.id, applied.created_block_ids, applied.updated_block_ids, tenantId],
    );

    const approvalText = [
      'Đã approve plan thành công và áp dụng vào outline.',
      `Đã tạo ${applied.created_block_ids.length} block, cập nhật ${applied.updated_block_ids.length} block.`,
      `Mã đề xuất: ${job.id}`,
    ].join('\n\n');
    try {
      await query(
        `INSERT INTO chat_messages (conversation_id, role, content, metadata)
         VALUES ($1, 'assistant', $2, $3)`,
        [
          job.conversation_id,
          approvalText,
          {
            kind: 'lesson_author_plan_approved',
            lesson_author_job_id: job.id,
            created_block_ids: applied.created_block_ids,
            updated_block_ids: applied.updated_block_ids,
            created_count: applied.created_block_ids.length,
            updated_count: applied.updated_block_ids.length,
          },
        ],
      );
      await query(
        `UPDATE chat_conversations SET updated_at = now() WHERE id = $1 AND tenant_id = $2`,
        [job.conversation_id, tenantId],
      );
      logLessonAuthorFlow('apply_approval_message_saved', {
        job_id: job.id,
        conversation_id: job.conversation_id,
        created_count: applied.created_block_ids.length,
        updated_count: applied.updated_block_ids.length,
      });
    } catch (messageErr) {
      logLessonAuthorFlow('apply_approval_message_failed', {
        job_id: job.id,
        conversation_id: job.conversation_id,
        error: messageErr instanceof Error ? messageErr.message : String(messageErr),
      });
    }

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

    try {
      const filterOutcome = await runStoredInputFilter({
        message: trimmed,
        sessionId: conversationId,
        tenantId: ctx.tenantId,
        botId: ctx.botId,
        rawConfig: ctx.inputFilterConfig,
        redisClient: getRedisClient(),
      });

      if (filterOutcome.blocked && filterOutcome.replyMessage) {
        markRateLimit(userId);
        await saveInputFilterRejectedTurn(ctx, trimmed, filterOutcome.replyMessage, filterOutcome.result);
        logLessonAuthorFlow('input_filter_rejected', {
          conversation_id: conversationId,
          tenant_id: ctx.tenantId,
          bot_id: ctx.botId,
          target: ctx.target,
          code: filterOutcome.result.code,
          processing_time_ms: filterOutcome.result.processingTimeMs ?? null,
        });
        onChunk(filterOutcome.replyMessage);
        onDone();
        return;
      }
    } catch (err) {
      console.error('[InputFilter] Invalid config or runtime error; continuing chat flow', {
        conversation_id: conversationId,
        tenant_id: ctx.tenantId,
        bot_id: ctx.botId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const requestedOutlineMentions = await validateLessonAuthorOutlineMentions(ctx, options.outlineMentions ?? []);
    // Pre-classify intent to decide carry-forward (delete intent should never carry forward)
    const preClassify = ctx.target === LESSON_AUTHOR_TARGET
      ? classifyLessonAuthorIntentV2(trimmed, requestedOutlineMentions, (options.mode as 'chat' | 'draft_lesson' | 'auto') ?? 'auto')
      : null;
    const isDeleteRequest = preClassify?.signals.some(s => s.name === 'delete_intent' && s.matched) ?? false;
    const carriedOutlineMentions = !isDeleteRequest
      && requestedOutlineMentions.length === 0
      && shouldCarryForwardLessonAuthorTarget(trimmed)
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
    const requestedSourceDocuments = await validateLessonAuthorSourceDocuments(ctx, ctx.botKbId, options.sourceDocuments ?? []);
    const carriedSourceDocuments = requestedSourceDocuments.length === 0 && shouldCarryForwardLessonAuthorSourceDocuments(trimmed)
      ? await getLatestConversationSourceDocuments(ctx)
      : [];
    const sourceDocuments = requestedSourceDocuments.length > 0 ? requestedSourceDocuments : carriedSourceDocuments;
    const sourceDocumentSource = requestedSourceDocuments.length > 0
      ? 'current'
      : sourceDocuments.length > 0
        ? 'carried_forward'
        : 'none';
    const sourceDocumentContext = formatSourceDocumentsForPrompt(sourceDocuments);
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
    logLessonAuthorFlow('stream_source_documents_validated', {
      conversation_id: conversationId,
      target: ctx.target,
      requested_count: options.sourceDocuments?.length ?? 0,
      valid_count: sourceDocuments.length,
      source: sourceDocumentSource,
      document_ids: sourceDocuments.map(doc => doc.document_id),
      source_context_chars: sourceDocumentContext.length,
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
        {
          ...(outlineMentions.length > 0 ? { outline_mentions: outlineMentions, outline_mentions_source: outlineMentionSource } : {}),
          ...(sourceDocuments.length > 0 ? { source_documents: sourceDocuments.map(toSourceDocumentMetadata), source_documents_source: sourceDocumentSource } : {}),
        },
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
        source_documents: sourceDocuments.length,
      });

    // ── Intent classification via deterministic scoring (zero Gemini calls) ──
    const { intent: lessonAuthorIntent, signals: intentSignals, score: intentScore } = ctx.target === LESSON_AUTHOR_TARGET
      ? classifyLessonAuthorIntentV2(trimmed, outlineMentions, (options.mode as 'chat' | 'draft_lesson' | 'auto') ?? 'auto')
      : { intent: 'chat' as LessonAuthorIntent, signals: [] as IntentSignal[], score: -100 };
    logLessonAuthorFlow('intent_scored', {
      conversation_id: conversationId,
      target: ctx.target,
      intent: lessonAuthorIntent,
      score: intentScore,
      matched: intentSignals.filter(s => s.matched).map(s => `${s.name}(${s.weight > 0 ? '+' : ''}${s.weight})`),
      requested_mode: options.mode ?? 'auto',
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
        // Delete guard: NEVER allow draft_lesson when delete intent detected
        if (isDeleteRequest) {
          throw new Error('Thao tác xóa không được hỗ trợ qua Chuyên gia bài học. Vui lòng xóa trực tiếp trong outline/editor.');
        }
        if (!ctx.botKbId) throw new Error('Chưa cấu hình KB active cho chuyên gia tạo bài học');
        proposal = await generateLessonAuthorProposalV2(
          ctx, trimmed, ctx.botKbId, outlineMentions, mentionContext, targetScopeInstruction, sourceDocuments,
          (stage, detail) => {
            onSideEvent?.({ type: 'progress', stage, detail } as any);
          },
        );
        jobId = await createLessonAuthorJob(ctx, userId, trimmed, ctx.botKbId, proposal, sourceDocuments);
        assistantText = formatProposalPreview(proposal, jobId);
        logLessonAuthorFlow('draft_branch_proposal_ready', {
          conversation_id: conversationId,
          job_id: jobId,
          assistant_chars: assistantText.length,
          ...getLessonAuthorProposalMetrics(proposal),
        });
      } catch (err: any) {
        const errorReason = sanitizeInternalErrorReason(err);
        jobId = await createFailedLessonAuthorJob(ctx, userId, trimmed, ctx.botKbId ?? null, errorReason, sourceDocuments);
        assistantText = formatLessonAuthorFailurePreview(err, jobId);
        logLessonAuthorFlow('draft_branch_proposal_failed', {
          conversation_id: conversationId,
          job_id: jobId,
          error: errorReason,
        });
      }

      onChunk(assistantText);
      if (proposal && jobId) {
        onSideEvent?.({ type: 'proposal', job_id: jobId, proposal: toLessonAuthorDisplayProposal(proposal) });
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
            ...(sourceDocuments.length > 0 ? { source_documents: sourceDocuments.map(toSourceDocumentMetadata) } : {}),
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
    const currentTurnText = buildCurrentTurnText(trimmed, outlineMentions, mentionContext, sourceDocuments);
    const history = replaceLatestUserTurn(await loadHistory(conversationId), currentTurnText);
    logLessonAuthorFlow('chat_branch_enter', {
      conversation_id: conversationId,
      target: ctx.target,
      course_id: courseId ?? null,
      history_messages: history.length,
      current_mentions: outlineMentions.length,
      mention_context_chars: mentionContext.length,
      source_documents: sourceDocuments.length,
      source_context_chars: sourceDocumentContext.length,
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
    if (ctx.target === LESSON_AUTHOR_TARGET) {
      enrichedPrompt += [
        '',
        '',
        'LESSON AUTHOR DASHBOARD RULES:',
        '- You are inside the admin course outline widget. You cannot send work to an external team, designer, or separate tool.',
        '- Never claim that content has been added, created, updated, integrated, sent to a design team, or queued outside this system unless the backend approval flow has actually applied it.',
        '- If the admin asks to create, add, edit, update, or improve course content, answer in terms of the pending proposal / admin approval workflow. Do not invent a manual handoff process.',
      ].join('\n');
      if (sourceDocumentContext) {
        enrichedPrompt += `\n\n${sourceDocumentContext}\n\nThe selected source files above are for the CURRENT TURN only and override older file selections in chat history.`;
      }
    }
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
    const shouldBufferLessonAuthorChat = ctx.target === LESSON_AUTHOR_TARGET;
    const appendChatChunk = (text: string) => {
      if (!text) return;
      fullResponse += text;
      if (!shouldBufferLessonAuthorChat) onChunk(text);
    };

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
              appendChatChunk(text);
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
              appendChatChunk(text);
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
            appendChatChunk(text);
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

    let assistantContent = fullResponse;
    let assistantMetadata: Record<string, unknown> = {};
    if (shouldBufferLessonAuthorChat) {
      const converted = await convertLessonAuthorChatJsonToProposalMessage(
        ctx,
        userId,
        trimmed,
        fullResponse,
        sourceDocuments,
      );
      if (converted) {
        assistantContent = converted.content;
        assistantMetadata = converted.metadata;
        if (converted.proposal) {
          onSideEvent?.({ type: 'proposal', job_id: converted.jobId, proposal: converted.proposal });
        }
      }
      if (assistantContent.trim()) onChunk(assistantContent);
    }

    // 7. Save assistant message (only if we got content)
    if (assistantContent.trim()) {
      await query(
        `INSERT INTO chat_messages (conversation_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3)`,
        [conversationId, assistantContent, assistantMetadata],
      );
      logLessonAuthorFlow('chat_branch_assistant_message_saved', {
        conversation_id: conversationId,
        target: ctx.target,
        response_chars: assistantContent.length,
        raw_response_chars: fullResponse.length,
        metadata_kind: assistantMetadata.kind ?? null,
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
      error: redactGeminiApiKeys(err?.message || 'Unknown stream error'),
    });
    onError(sanitizeGeminiError(err));
  } finally {
    logLessonAuthorFlow('stream_lock_released', { conversation_id: conversationId });
    streamLocks.delete(conversationId);
  }
}
