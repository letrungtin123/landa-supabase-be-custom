// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { lessonAuthorSourceInfoSummary as getSourceInfoSummary } from '../shared/lesson-author-source-snapshot.logic.js';
import { query } from '../../../../config/database.js';
import { AppError } from '../../../../middleware/error-handler.js';
import { type RagWorkflowDiagnostics } from '../../ai-platform/ai-rag-client.service.js';
import { withoutAuthorOnlyMetadata } from '../../../course-authoring/course-author-notes.logic.js';
import { LESSON_AUTHOR_TARGET } from '../../chat/chat.constants.js';
import type {
  ChatStreamSideEvent,
  CourseOutlineEntry,
  ConversationContext,
  LessonAuthorSourceDocument,
  LessonAuthorSourceDocumentInput,
} from '../../chat/chat.types.js';
import { isValidUUID } from '../../chat/chat-turn-runtime.service.js';
import { stripHtml } from '../../chat/chat-turn.logic.js';
import { MAX_SOURCE_DOCUMENTS, MAX_SOURCE_DOCUMENT_EXCERPT_CHARS } from './constants.js';
import type { LessonAuthorBlueprint, DraftCourseOutline, LessonAuthorOutlineMention } from './types.js';

/**
 * The current RAG contract is request/response JSON, not an internal event
 * stream. Replay safe graph milestones when the response arrives; the caller
 * still emits its immediate retrieval milestone before awaiting Python.
 */
export function emitRagWorkflowProgress(
  onSideEvent: ((event: ChatStreamSideEvent) => void) | undefined,
  workflow: RagWorkflowDiagnostics | undefined,
): void {
  for (const event of workflow?.progress ?? []) {
    const code = event.code.trim();
    if (!code) continue;
    onSideEvent?.({ type: 'progress', stage: code, detail: event.message });
  }
}

export function withAuthoritativeCourseTitle(
  blueprint: LessonAuthorBlueprint,
  courseName: string,
): LessonAuthorBlueprint {
  const authoritativeTitle = courseName.trim();
  return authoritativeTitle ? { ...blueprint, title: authoritativeTitle } : blueprint;
}

export async function getDraftCourseOutlineForPrompt(courseId: string, tenantId: string): Promise<DraftCourseOutline> {
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

export function foldVietnameseText(value: string): string {
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

export function shouldCarryForwardLessonAuthorTarget(userPrompt: string): boolean {
  const text = foldVietnameseText(userPrompt);
  const hasLocalReference = /(^|\b)(phan nay|noi dung nay|cai nay|muc nay|bai nay|unit nay|component nay|diagram nay|so do nay|chuong nay|doan nay|no nay|target nay)(\b|$)/i.test(text);
  return hasLocalReference || hasLessonAuthorDraftAction(userPrompt);
}

export function isSingleHtmlComponentRequest(userPrompt: string): boolean {
  const text = foldVietnameseText(userPrompt);
  return /\bcomponent\b/i.test(text) && /\bhtml\b/i.test(text) && /(^|\b)(1|mot|them|tao|viet|bo sung)(\b|$)/i.test(text);
}

export async function validateLessonAuthorOutlineMentions(
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

export async function getLatestConversationOutlineMentions(
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

export function shouldCarryForwardLessonAuthorSourceDocuments(userPrompt: string): boolean {
  const text = foldVietnameseText(userPrompt);
  return /(^|\b)(file nay|file do|file da co san|file vua chon|file tren|pdf nay|pdf do|tai lieu nay|tai lieu do|tai lieu da co san|tai lieu tren|dua tren file|dua vao file|dua tren tai lieu|dua vao tai lieu|noi dung file|noi dung tai lieu)(\b|$)/i.test(text);
}

export async function getLatestConversationSourceDocuments(
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

export function toSourceDocumentMetadata(doc: LessonAuthorSourceDocument): Omit<LessonAuthorSourceDocument, 'content_excerpt' | 'gemini_path'> {
  return {
    document_id: doc.document_id,
    kb_id: doc.kb_id,
    name: doc.name,
    type: doc.type,
    status: doc.status,
    updated_at: doc.updated_at,
    source_info: doc.source_info,
  };
}

export function normalizeDocumentUpdatedAt(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

export async function validateLessonAuthorSourceDocuments(
  ctx: ConversationContext,
  kbId: string | null,
  inputs: LessonAuthorSourceDocumentInput[] = [],
  options: { requireGeminiMapping?: boolean } = {},
): Promise<LessonAuthorSourceDocument[]> {
  const ids = normalizeSourceDocumentIds(inputs);
  if (ids.length === 0) return [];
  if (ctx.target !== LESSON_AUTHOR_TARGET) {
    throw new AppError('Chỉ có Chuyên gia bài học mới được chọn file nguồn.', 400);
  }
  if (!kbId) {
    throw new AppError('Chưa cấu hình KB active cho chuyên gia tạo bài học.', 409);
  }

  const result = await query<{
    document_id: string;
    kb_id: string;
    name: string;
    type: string;
    status: string;
    updated_at: Date | string;
    source_info: Record<string, unknown> | null;
    content: string | null;
    gemini_path: string | null;
  }>(
    `SELECT d.id::text AS document_id,
            d.kb_id::text AS kb_id,
            d.name,
            d.type,
            d.status,
            d.updated_at,
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
    throw new AppError('Một số file nguồn không tồn tại, không thuộc KB active, hoặc không thuộc tenant hiện tại.', 400);
  }

  return result.rows.map((row) => {
    if (row.status !== 'learned') {
      throw new AppError(`File "${row.name}" chưa học xong. Vui lòng chờ trạng thái Đã học rồi thử lại.`, 409);
    }
    if (options.requireGeminiMapping !== false && !row.gemini_path) {
      throw new AppError(`File "${row.name}" chưa có mapping Gemini File Search. Vui lòng retry tài liệu này trong KB.`, 409);
    }
    const contentText = row.content ? stripHtml(row.content).replace(/\s+/g, ' ').trim() : '';
    return {
      document_id: row.document_id,
      kb_id: row.kb_id,
      name: row.name,
      type: row.type,
      status: row.status,
      updated_at: normalizeDocumentUpdatedAt(row.updated_at),
      source_info: row.source_info,
      gemini_path: row.gemini_path,
      content_excerpt: contentText ? contentText.slice(0, MAX_SOURCE_DOCUMENT_EXCERPT_CHARS) : null,
    };
  });
}

export function formatSourceDocumentsForPrompt(docs: LessonAuthorSourceDocument[]): string {
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
    if (doc.gemini_path) lines.push(`   gemini_path: ${doc.gemini_path}`);
    if (sourceInfo) lines.push(`   source_info: ${sourceInfo}`);
    if (doc.content_excerpt) lines.push(`   local_excerpt: ${doc.content_excerpt}`);
  });

  return lines.join('\n');
}

export function formatOutlineMentionsForPrompt(mentions: LessonAuthorOutlineMention[]): string {
  return mentions
    .map((mention, index) => [
      `${index + 1}. ${mention.display_name}`,
      `   id: ${mention.block_id}`,
      `   type: ${mention.block_type}`,
      `   path: ${mention.path || mention.display_name}`,
    ].join('\n'))
    .join('\n');
}

export function stringifyBlockExcerpt(data: unknown, metadata: unknown): string {
  const dataText = typeof data === 'string'
    ? data
    : data && typeof data === 'object'
      ? JSON.stringify(data)
      : '';
  // AI ID author notes/storyboard are author-only design metadata; they are
  // never pasted into a chat prompt excerpt (the reply streams to the user).
  const promptMetadata = withoutAuthorOnlyMetadata(metadata);
  const metadataText = promptMetadata && typeof promptMetadata === 'object' ? JSON.stringify(promptMetadata) : '';
  const raw = dataText || metadataText;
  if (!raw) return '';
  return stripHtml(raw)
    .replace(/[{}[\]"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
}

export function buildCurrentTurnText(
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

export function toRagSourceDocuments(docs: LessonAuthorSourceDocument[]) {
  return docs.map(doc => ({
    document_id: doc.document_id,
    kb_id: doc.kb_id,
    name: doc.name,
    type: doc.type,
    status: doc.status,
  }));
}
