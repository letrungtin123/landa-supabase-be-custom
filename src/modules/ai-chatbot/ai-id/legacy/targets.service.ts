// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { createHash } from 'crypto';
import { query } from '../../../../config/database.js';
import { AppError } from '../../../../middleware/error-handler.js';
import { type LessonAuthorOperationPlan } from '../../../course-authoring/course-authoring.service.js';
import {
  extractLessonAuthorTargetNumberPath,
  extractRequestedTitle,
  formatChapterTitle,
  isLessonAuthorNewChapterDraftRequest,
  stripLessonAuthorStructuralPrefix,
  stripLessonAuthorSourceRangeSuffix,
  type LessonAuthorIntentPlan,
} from '../../lesson-author-intent.logic.js';
import {
  normalizeLessonAuthorEditorContext,
  validateResolvedLessonAuthorEditorContext,
  type ResolvedLessonAuthorEditorEntity,
  type ValidatedLessonAuthorEditorContext,
} from '../../lesson-author-command.logic.js';
import { LESSON_AUTHOR_TARGET } from '../../chat.constants.js';
import type { ConversationContext } from '../../chat.types.js';
import { isValidUUID } from '../../chat-turn-runtime.service.js';
import type { LessonAuthorOutlineMention, MentionContextRow } from './types.js';
import { foldVietnameseText, stringifyBlockExcerpt, isSingleHtmlComponentRequest } from './context.service.js';

export async function getOutlineMentionContextRows(
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

interface LessonAuthorTargetRow {
  id: string;
  parent_id: string | null;
  block_type: string;
  display_name: string;
  sort_order: number;
  updated_at: string | Date;
  data: unknown;
  metadata: unknown;
}

interface CanonicalLessonAuthorTarget extends LessonAuthorTargetRow {
  target_type: NonNullable<LessonAuthorOperationPlan['target_type']>;
  path: string;
  number_path: string | null;
  ancestor_ids: string[];
}

interface LessonAuthorTargetChainRow extends LessonAuthorTargetRow {
  depth: number;
  sibling_index: number;
}

function lessonAuthorTargetType(blockType: string): NonNullable<LessonAuthorOperationPlan['target_type']> | null {
  if (blockType === 'course') return 'course';
  if (blockType === 'chapter') return 'chapter';
  if (blockType === 'sequential') return 'lesson';
  if (blockType === 'vertical') return 'unit';
  return 'component';
}

export function canonicalTargetSnapshot(target: LessonAuthorTargetRow): string {
  return createHash('sha256').update(JSON.stringify({
    id: target.id,
    parent_id: target.parent_id,
    block_type: target.block_type,
    display_name: target.display_name,
    sort_order: target.sort_order,
    data: target.data ?? null,
    metadata: target.metadata ?? null,
    updated_at: new Date(target.updated_at).toISOString(),
  })).digest('hex');
}

function buildCanonicalTargetRows(rows: LessonAuthorTargetRow[]): CanonicalLessonAuthorTarget[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  const children = new Map<string | null, LessonAuthorTargetRow[]>();
  for (const row of rows) {
    const list = children.get(row.parent_id) ?? [];
    list.push(row);
    children.set(row.parent_id, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  }

  const roots = (children.get(null) ?? []).filter(row => row.block_type === 'course');
  const startRows = roots.length > 0 ? roots : children.get(null) ?? [];
  const result: CanonicalLessonAuthorTarget[] = [];
  const visited = new Set<string>();

  const walk = (
    row: LessonAuthorTargetRow,
    ancestorPath: string[],
    numberPath: number[],
    ancestorIds: string[],
  ): void => {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    const type = lessonAuthorTargetType(row.block_type);
    if (!type) return;
    const nextPath = row.block_type === 'course' ? [] : [...ancestorPath, row.display_name || '(Không có tiêu đề)'];
    const nextNumbers = row.block_type === 'course' ? [] : numberPath;
    result.push({
      ...row,
      target_type: type,
      path: nextPath.join(' / '),
      number_path: nextNumbers.length > 0 ? nextNumbers.join('.') : null,
      ancestor_ids: ancestorIds,
    });

    const childRows = children.get(row.id) ?? [];
    const typeCounters = new Map<string, number>();
    for (const child of childRows) {
      const childType = child.block_type;
      const childIndex = (typeCounters.get(childType) ?? 0) + 1;
      typeCounters.set(childType, childIndex);
      const childNumbers = childType === 'chapter'
        ? [childIndex]
        : childType === 'sequential'
          ? [...nextNumbers.slice(0, 1), childIndex]
          : childType === 'vertical'
            ? [...nextNumbers.slice(0, 2), childIndex]
            : nextNumbers;
      walk(child, nextPath, childNumbers, [...ancestorIds, row.id]);
    }
  };

  for (const root of startRows) walk(root, [], [], []);
  for (const row of rows) {
    if (!visited.has(row.id)) walk(row, [], [], []);
  }
  return result.filter(target => byId.has(target.id));
}

async function loadLessonAuthorTargetById(
  ctx: ConversationContext,
  blockId: string,
): Promise<CanonicalLessonAuthorTarget | null> {
  if (!ctx.courseId || !isValidUUID(blockId)) return null;
  const result = await query<LessonAuthorTargetChainRow>(
    `WITH RECURSIVE chain AS (
       SELECT cb.id::text AS id, cb.parent_id::text AS parent_id, cb.block_type,
              cb.display_name, cb.sort_order, cb.updated_at, cb.data, cb.metadata,
              0 AS depth
       FROM course_blocks cb
       JOIN courses c ON c.id = cb.course_id
       WHERE cb.id = $1
         AND cb.course_id = $2
         AND c.tenant_id = $3
         AND c.deleted_at IS NULL
         AND cb.deleted_at IS NULL
       UNION ALL
       SELECT parent.id::text, parent.parent_id::text, parent.block_type,
              parent.display_name, parent.sort_order, parent.updated_at,
              parent.data, parent.metadata, chain.depth + 1
       FROM course_blocks parent
       JOIN chain ON parent.id::text = chain.parent_id
       WHERE parent.course_id = $2
         AND parent.deleted_at IS NULL
         AND chain.depth < 8
     )
     , ranked AS (
       SELECT cb.id::text AS id,
              ROW_NUMBER() OVER (
                PARTITION BY cb.parent_id, cb.block_type
                ORDER BY cb.sort_order ASC, cb.id ASC
              )::int AS sibling_index
       FROM course_blocks cb
       WHERE cb.course_id = $2
         AND cb.deleted_at IS NULL
     )
     SELECT chain.id, chain.parent_id, chain.block_type, chain.display_name,
            chain.sort_order, chain.updated_at, chain.data, chain.metadata,
            chain.depth, ranked.sibling_index
     FROM chain
     JOIN ranked ON ranked.id = chain.id
     ORDER BY chain.depth DESC` ,
    [blockId, ctx.courseId, ctx.tenantId],
  );
  const target = buildCanonicalTargetRows(result.rows).find(row => row.id === blockId);
  if (!target) return null;

  // The chain query intentionally avoids loading the whole course tree. Use
  // the database-ranked sibling positions to preserve the real outline path
  // (for example, a selected sixth chapter must remain Chapter 6).
  const numberPath = result.rows
    .filter(row => row.block_type !== 'course'
      && ['chapter', 'sequential', 'vertical'].includes(row.block_type))
    .sort((a, b) => b.depth - a.depth)
    .map(row => String(row.sibling_index))
    .join('.');

  return {
    ...target,
    number_path: numberPath || target.number_path,
  };
}

interface ValidatedLessonAuthorEditorContextState {
  context: ValidatedLessonAuthorEditorContext;
  targets: Map<string, CanonicalLessonAuthorTarget>;
}

function toResolvedLessonAuthorEditorEntity(
  target: CanonicalLessonAuthorTarget,
): ResolvedLessonAuthorEditorEntity {
  return {
    id: target.id,
    type: target.target_type,
    parent_id: target.parent_id,
    ancestor_ids: target.ancestor_ids,
  };
}

export async function validateLessonAuthorEditorContext(
  ctx: ConversationContext,
  value: unknown,
): Promise<ValidatedLessonAuthorEditorContextState | null> {
  if (ctx.target !== LESSON_AUTHOR_TARGET || value === undefined || value === null) return null;
  if (!ctx.courseId) throw new AppError('editor_context chỉ hợp lệ trong khóa học đang mở.', 400);

  const normalized = normalizeLessonAuthorEditorContext(value);
  if (!normalized) return null;
  const ids = [
    normalized.selected_entity?.id,
    normalized.current_chapter_id,
    normalized.current_lesson_id,
    normalized.current_unit_id,
    normalized.current_component_id,
  ].filter((id): id is string => Boolean(id));
  const uniqueIds = [...new Set(ids)];
  const loaded = await Promise.all(uniqueIds.map(async (id) => [id, await loadLessonAuthorTargetById(ctx, id)] as const));
  const targets = new Map<string, CanonicalLessonAuthorTarget>();
  for (const [id, target] of loaded) {
    if (!target) throw new AppError('editor_context chứa target không thuộc tenant hoặc khóa học hiện tại.', 400);
    targets.set(id, target);
  }

  const resolvedEntities = new Map<string, ResolvedLessonAuthorEditorEntity>();
  for (const target of targets.values()) {
    resolvedEntities.set(target.id, toResolvedLessonAuthorEditorEntity(target));
  }
  const context = validateResolvedLessonAuthorEditorContext(normalized, ctx.courseId, resolvedEntities);
  return { context, targets };
}

export function toLessonAuthorEditorContextMention(
  target: CanonicalLessonAuthorTarget,
): LessonAuthorOutlineMention {
  return {
    block_id: target.id,
    block_type: target.block_type,
    display_name: target.display_name,
    path: target.path || target.display_name,
    unit_id: target.target_type === 'unit' ? target.id : null,
    ancestor_ids: target.ancestor_ids,
    ancestor_types: [],
  };
}

async function loadLessonAuthorTargetCandidates(
  ctx: ConversationContext,
  targetType: LessonAuthorOperationPlan['target_type'],
): Promise<CanonicalLessonAuthorTarget[]> {
  if (!ctx.courseId) return [];
  // Structural resolution must stay bounded even when a course contains a
  // very large number of learning components. Component targets are resolved
  // separately because they are normally selected by @mention/ID.
  const blockTypeFilter = targetType === 'component'
    ? `block_type NOT IN ('course', 'chapter', 'sequential', 'vertical')`
    : `block_type IN ('course', 'chapter', 'sequential', 'vertical')`;
  const result = await query<LessonAuthorTargetRow>(
    `SELECT id::text AS id, parent_id::text AS parent_id, block_type,
            display_name, sort_order, updated_at,
            NULL::jsonb AS data, NULL::jsonb AS metadata
     FROM course_blocks
     WHERE course_id = $1
       AND deleted_at IS NULL
       AND ${blockTypeFilter}
       AND EXISTS (SELECT 1 FROM courses c WHERE c.id = $1 AND c.tenant_id = $2::uuid AND c.deleted_at IS NULL)
     ORDER BY sort_order ASC, id ASC
     LIMIT 10000`,
    [ctx.courseId, ctx.tenantId],
  );
  return buildCanonicalTargetRows(result.rows);
}

async function loadLessonAuthorCourseTarget(
  ctx: ConversationContext,
): Promise<CanonicalLessonAuthorTarget | null> {
  if (!ctx.courseId) return null;
  const result = await query<LessonAuthorTargetRow>(
    `SELECT cb.id::text AS id, cb.parent_id::text AS parent_id, cb.block_type,
            cb.display_name, cb.sort_order, cb.updated_at,
            cb.data, cb.metadata
     FROM course_blocks cb
     JOIN courses c ON c.id = cb.course_id
     WHERE cb.course_id = $1
       AND cb.parent_id IS NULL
       AND cb.block_type = 'course'
       AND c.tenant_id = $2
       AND c.deleted_at IS NULL
       AND cb.deleted_at IS NULL
     ORDER BY cb.created_at ASC, cb.id ASC
     LIMIT 1`,
    [ctx.courseId, ctx.tenantId],
  );
  return buildCanonicalTargetRows(result.rows)[0] ?? null;
}

function findNumericTarget(
  text: string,
  targetType: LessonAuthorOperationPlan['target_type'],
  candidates: CanonicalLessonAuthorTarget[],
): CanonicalLessonAuthorTarget | null {
  const numberPath = extractLessonAuthorTargetNumberPath(text, targetType);
  if (!numberPath || !targetType) return null;
  const found = candidates.find(candidate => candidate.target_type === targetType && candidate.number_path === numberPath);
  if (found) return found;
  return null;
}

function findNamedTargets(
  text: string,
  targetType: LessonAuthorOperationPlan['target_type'],
  candidates: CanonicalLessonAuthorTarget[],
): CanonicalLessonAuthorTarget[] {
  const quoted = [...text.matchAll(/["“']([^"”']{2,180})["”']/g)]
    .map(match => foldVietnameseText(match[1]));
  const haystack = foldVietnameseText(text);
  return candidates
    .filter(candidate => !targetType || candidate.target_type === targetType)
    .filter(candidate => {
      const title = foldVietnameseText(candidate.display_name);
      return quoted.includes(title) || (title.length >= 4 && haystack.includes(title));
    })
    .sort((a, b) => b.display_name.length - a.display_name.length);
}

export async function resolveLessonAuthorOperationPlan(
  ctx: ConversationContext,
  plan: LessonAuthorIntentPlan,
  userPrompt: string,
  mentions: LessonAuthorOutlineMention[],
): Promise<LessonAuthorOperationPlan | LessonAuthorIntentPlan> {
  if (plan.operation === 'answer' || plan.operation === 'course_blueprint' || plan.operation === 'clarify') return plan;
  if (plan.operation === 'move') {
    return {
      ...plan,
      operation: 'clarify',
      ambiguity_reasons: ['Thao tác di chuyển cần chỉ rõ node đích; chưa tạo proposal để tránh đổi sai cấu trúc.'],
    };
  }

  let target: CanonicalLessonAuthorTarget | null = null;
  let candidates: CanonicalLessonAuthorTarget[] = [];
  if (mentions[0]?.block_id) {
    target = await loadLessonAuthorTargetById(ctx, mentions[0].block_id);
  } else if (plan.target_type === 'course') {
    target = await loadLessonAuthorCourseTarget(ctx);
  } else {
    candidates = await loadLessonAuthorTargetCandidates(ctx, plan.target_type);
    target = findNumericTarget(foldVietnameseText(userPrompt), plan.target_type, candidates);
    if (!target) {
      const named = findNamedTargets(userPrompt, plan.target_type, candidates);
      if (named.length === 1) target = named[0];
      else if (named.length > 1) {
        return {
          ...plan,
          operation: 'clarify',
          ambiguity_reasons: ['Có nhiều node trong outline trùng tên; cần chọn đúng một node.'],
        };
      }
    }
    if (target) {
      // Candidate lookup intentionally reads only structural columns. Reload
      // the selected row with its full payload once for a precise snapshot.
      target = await loadLessonAuthorTargetById(ctx, target.id);
    }
  }

  // A new conversation cannot carry an existing target for "Soạn Chương N".
  // Resolve that request against the course root only when it is clearly a
  // draft/create command, the requested chapter is the next ordinal, and no
  // existing chapter matched. Edit/rename/delete requests remain clarify-only.
  const canCreateNewChapter = !mentions[0]?.block_id
    && plan.target_type === 'chapter'
    && (plan.operation === 'create'
      || (plan.operation === 'update_content' && isLessonAuthorNewChapterDraftRequest(userPrompt)))
    && !target;
  if (canCreateNewChapter) {
    const courseTarget = await loadLessonAuthorCourseTarget(ctx);
    const chapterNumbers = candidates
      .filter(candidate => candidate.target_type === 'chapter' && /^\d+$/.test(candidate.number_path ?? ''))
      .map(candidate => Number(candidate.number_path))
      .filter(Number.isInteger)
      .filter(number => number > 0);
    const nextChapterNumber = (chapterNumbers.length > 0 ? Math.max(...chapterNumbers) : 0) + 1;
    const requestedNumberPath = extractLessonAuthorTargetNumberPath(userPrompt, 'chapter');
    const requestedChapterNumber = requestedNumberPath ? Number(requestedNumberPath) : nextChapterNumber;

    if (!courseTarget) {
      return {
        ...plan,
        operation: 'clarify',
        ambiguity_reasons: ['Không tìm thấy node gốc của khóa học để tạo Chương mới.'],
      };
    }
    if (!Number.isInteger(requestedChapterNumber) || requestedChapterNumber < 1) {
      return {
        ...plan,
        operation: 'clarify',
        ambiguity_reasons: ['Số Chương mới không hợp lệ.'],
      };
    }
    if (requestedChapterNumber !== nextChapterNumber) {
      return {
        ...plan,
        operation: 'clarify',
        ambiguity_reasons: [
          `Chỉ có thể tạo Chương tiếp theo là Chương ${nextChapterNumber}; Chương ${requestedChapterNumber} chưa thể tạo vì cấu trúc hiện tại chưa có đủ Chương trước đó.`,
        ],
      };
    }

    return {
      ...plan,
      operation: 'create',
      target_resolution: 'new',
      target_block_id: courseTarget.id,
      target_path: courseTarget.path || courseTarget.display_name,
      target_number_path: String(nextChapterNumber),
      target_display_name: `Chương ${nextChapterNumber}`,
      target_updated_at: new Date(courseTarget.updated_at).toISOString(),
      target_snapshot: canonicalTargetSnapshot(courseTarget),
      ambiguity_reasons: [],
      signals: [...plan.signals, 'virtual_new_chapter'],
    };
  }

  if (!target || (plan.target_type && plan.target_type !== target.target_type)) {
    return {
      ...plan,
      operation: 'clarify',
      ambiguity_reasons: ['Không xác định được đúng node trong cây outline cho yêu cầu này.'],
    };
  }

  if (plan.operation === 'create' && target.target_type === 'component') {
    return {
      ...plan,
      operation: 'clarify',
      ambiguity_reasons: ['Không thể thêm node con vào một component. Hãy chọn Chương, Mục hoặc Bài học để thêm học liệu; nếu muốn sửa component này, hãy nói rõ sửa nội dung.'],
    };
  }
  if (plan.operation === 'create' && target.target_type === 'course') {
    return {
      ...plan,
      operation: 'clarify',
      ambiguity_reasons: ['Không thể thêm nội dung trực tiếp vào toàn khóa học. Hãy chọn Chương, Mục hoặc Bài học cụ thể; nếu muốn thiết kế toàn khóa học, hãy yêu cầu Bản thiết kế khóa học.'],
    };
  }
  if (plan.operation === 'update_content' && target.target_type === 'course') {
    return {
      ...plan,
      operation: 'clarify',
      ambiguity_reasons: ['Yêu cầu cập nhật toàn bộ khóa học cần được chia rõ theo Chương, Mục hoặc Bài học để tránh ghi đè ngoài phạm vi.'],
    };
  }
  if (plan.operation === 'delete' && target.target_type === 'course') {
    return {
      ...plan,
      operation: 'clarify',
      requires_confirmation: false,
      ambiguity_reasons: ['Không hỗ trợ xóa toàn bộ khóa học từ Chuyên gia bài học. Hãy thực hiện thao tác này tại màn hình quản trị khóa học.'],
    };
  }

  const explicitRequestedTitle = plan.operation === 'rename'
    ? (plan.requested_title ?? extractRequestedTitle(userPrompt))
    : plan.requested_title ?? null;
  const requestedTitle = explicitRequestedTitle
    ? stripLessonAuthorStructuralPrefix(stripLessonAuthorSourceRangeSuffix(explicitRequestedTitle))
    : plan.operation === 'rename' && plan.title_strategy === 'prefix_chapter_number' && target.target_type === 'chapter'
      ? formatChapterTitle(target.display_name, target.number_path ?? '')
      : null;
  if (plan.operation === 'rename' && !requestedTitle) {
    return {
      ...plan,
      operation: 'clarify',
      ambiguity_reasons: ['Chưa có tên tiêu đề mới cần áp dụng.'],
    };
  }

  return {
    ...plan,
    target_block_id: target.id,
    target_path: target.path || target.display_name,
    target_number_path: target.number_path,
    target_display_name: target.display_name,
    target_updated_at: new Date(target.updated_at).toISOString(),
    target_snapshot: canonicalTargetSnapshot(target),
    target_type: target.target_type,
    target_resolution: 'existing',
    requested_title: requestedTitle,
  };
}

export function formatLessonAuthorIntentClarification(
  plan: LessonAuthorIntentPlan,
  locale: 'vi' | 'en',
): string {
  const rawReason = plan.ambiguity_reasons[0] || '';
  const reason = locale === 'en'
    ? rawReason
      .replace('Chưa có tên tiêu đề mới cần áp dụng.', 'No new title was provided.')
      .replace('Chưa xác định được phạm vi Chương/Mục/Bài học cần chỉnh sửa.', 'The Chapter, Section, or Lesson scope is not specific enough.')
      .replace('Yêu cầu chứa nhiều thao tác thay đổi. Hãy gửi từng thao tác riêng để tránh áp dụng sai phạm vi.', 'This request contains multiple changes. Send each change separately to avoid applying the wrong scope.')
      .replace(/Chỉ có thể tạo Chương tiếp theo là Chương (\d+); Chương (\d+) chưa thể tạo vì cấu trúc hiện tại chưa có đủ Chương trước đó\./, 'Only the next chapter, Chapter $1, can be created now; Chapter $2 cannot be created until the preceding chapters exist.')
      .replace('Không xác định được đúng node trong cây outline cho yêu cầu này.', 'I could not identify one exact node in the outline.')
    : rawReason;
  if (locale === 'en') {
    if (plan.fields.includes('title')) return `I can rename the selected outline item, but I need the new title. ${reason || 'Please provide the new title.'}`;
    if (plan.target_type === 'course') return `This request applies to the whole course. ${reason || 'Select one Chapter, Section, or Lesson to update, or ask me to create detailed course content so I can prepare a Course blueprint.'}`;
    return `I could not identify one exact outline item for this change. ${reason || 'Please select one Chapter, Section, Lesson, or component and try again.'}`;
  }
  if (plan.fields.includes('title')) return `Mình có thể đổi tiêu đề node đã chọn, nhưng cần tên mới. ${reason || 'Hãy nhập tên tiêu đề mới.'}`;
  if (plan.target_type === 'course') return `Yêu cầu này đang áp dụng cho toàn khóa học. ${reason || 'Hãy chọn một Chương, Mục hoặc Bài học để cập nhật, hoặc yêu cầu tạo nội dung chi tiết cho khóa học để mình lập Bản thiết kế khóa học.'}`;
  return `Mình chưa xác định được đúng một node trong cây outline để thực hiện yêu cầu. ${reason || 'Hãy chọn một Chương, Mục, Bài học hoặc component rồi thử lại.'}`;
}

export function buildLessonAuthorOperationInstruction(plan: LessonAuthorIntentPlan): string {
  const targetLabel = plan.target_type === 'chapter'
    ? 'Chương/Chapter'
    : plan.target_type === 'lesson'
      ? 'Mục/Section'
      : plan.target_type === 'unit'
        ? 'Bài học/Lesson'
        : plan.target_type || 'outline node';
  if (plan.operation === 'update_content' && plan.target_block_id) {
    return [
      'SERVER-RESOLVED OPERATION: UPDATE_CONTENT.',
      `User-facing target level: ${targetLabel}.`,
      'Exact target: ' + plan.target_type + ' "' + plan.target_display_name + '" at "' + plan.target_path + '" (id=' + plan.target_block_id + ').',
      'Update only the selected target scope. Do not create a new chapter, lesson, or unit and do not rename any structural title.',
      'Preserve the exact existing Chương/Mục/Bài học titles from the target path. Return only the smallest chapter -> section -> lesson chain needed to carry the requested content update.',
      plan.target_type === 'component'
        ? 'The selected component is authoritative. Return exactly one component of the same type; the server will update that component by ID.'
        : 'Keep all unrelated outline branches out of the proposal. Existing components not explicitly requested must not be copied or replaced.',
    ].join('\n');
  }
  if (plan.operation === 'create' && plan.target_block_id) {
    if (plan.target_resolution === 'new' && plan.target_type === 'chapter') {
      return [
        'SERVER-RESOLVED OPERATION: CREATE_NEW_CHAPTER.',
        'The requested chapter does not exist yet. The exact parent target is the course root: ' + plan.target_path + ' (id=' + plan.target_block_id + ').',
        `Create exactly one new top-level Chapter ${plan.target_number_path ?? 'next'} under that course root.`,
        'Use the active KB and the current course context to generate the chapter title and its learning content. Do not rename or overwrite existing chapters, and do not create any chapter before the requested ordinal.',
        'Return only one chapter with its smallest complete section -> lesson -> component chain. Keep FAQ components last in each lesson and do not copy unrelated existing branches.',
      ].join('\n');
    }
    return [
      'SERVER-RESOLVED OPERATION: CREATE_CONTENT.',
      `User-facing parent level: ${targetLabel}.`,
      'Exact parent target: ' + plan.target_type + ' "' + plan.target_display_name + '" at "' + plan.target_path + '" (id=' + plan.target_block_id + ').',
      'Add only the requested learning content under this target. Do not create a new top-level chapter and do not rename existing structural titles.',
      'Preserve exact existing Chương/Mục/Bài học titles in the selected path and return only the smallest required chain.',
      'Do not copy unrelated existing components into the proposal; FAQ components must remain last in each unit.',
    ].join('\n');
  }
  return '';
}

export function formatMentionContextRowsForPrompt(rows: MentionContextRow[]): string {
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

export function buildTargetLockedProposalInstruction(
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
