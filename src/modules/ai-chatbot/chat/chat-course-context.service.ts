// The course a chat turn runs in: its outline for the system prompt (cached
// 5 minutes per process, swept by startChatCacheSweepers in chat.service.ts)
// and one lesson's content for the get_lesson_content tool. Moved from
// chat.service.ts (move only).

import { query } from '../../../config/database.js';
import type { CourseOutlineEntry } from './chat.types.js';
import { stripHtml } from './chat-turn.logic.js';

// ═══════════════════════════════════════════════════════════════
// Course Context — Structure injection + Function Calling
// Optimized: single-query outline build, 5-min LRU cache,
// HTML strip, truncation, lazy content fetch via Gemini tool
// ═══════════════════════════════════════════════════════════════

export interface CourseOutlineCache {
  outline: string;         // formatted text for system prompt
  courseName: string;
  lessonIds: Set<string>;  // valid sequential IDs for validation
  ts: number;
}

const courseOutlineCache = new Map<string, CourseOutlineCache>();
const COURSE_CACHE_TTL = 5 * 60_000; // 5 minutes
const MAX_LESSON_CONTENT_CHARS = 6000; // truncate lesson content

// Cleanup course cache every 10 minutes (startChatCacheSweepers)
export function sweepCourseOutlineCache(): void {
  const now = Date.now();
  for (const [key, val] of courseOutlineCache) {
    if (now - val.ts > COURSE_CACHE_TTL * 2) courseOutlineCache.delete(key);
  }
}

/**
 * Build course outline for system prompt injection.
 * Single indexed query → cached 5 minutes.
 * Only fetches structural blocks (course/chapter/sequential) — O(1) per message after cache.
 */
export async function getCachedCourseOutline(courseId: string, tenantId: string, includeDraft = false): Promise<CourseOutlineCache | null> {
  const cacheKey = `${tenantId}:${courseId}:${includeDraft ? 'draft' : 'published'}`;
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
       AND EXISTS (SELECT 1 FROM courses c WHERE c.id = $1 AND c.tenant_id = $3::uuid AND c.deleted_at IS NULL)
     ORDER BY sort_order ASC, created_at ASC`,
    [courseId, includeDraft, tenantId],
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
export async function fetchLessonContent(courseId: string, lessonId: string, tenantId: string, includeDraft = false): Promise<string> {
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
         AND EXISTS (SELECT 1 FROM courses c WHERE c.id = $2 AND c.tenant_id = $4::uuid AND c.deleted_at IS NULL)
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
    [lessonId, courseId, includeDraft, tenantId],
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
    } else if (row.block_type === 'la_image_choice_quiz') {
      text = `[Câu hỏi đáp án hình ảnh: ${label}]`;
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
export const COURSE_TOOLS = {
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
