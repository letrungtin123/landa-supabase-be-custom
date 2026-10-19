// ═══════════════════════════════════════════════════════════════
// AI ID apply: writes a reviewed AI ID proposal into a course outline, in one
// transaction under the course lock. Moved unchanged from
// course-authoring.service.ts, which still re-exports it.
// ═══════════════════════════════════════════════════════════════

import { getClient, withDatabaseTransaction } from '../../config/database.js';
import { createHash } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import {
  assertCourseComponentTypeAllowed,
  getTenantAllowedCourseComponentTypeSet,
} from '../tenants/tenant-course-components.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import {
  isLessonAuthorGeneratedContentOwned,
  isLessonAuthorMediaProtectedBlock,
  orderLessonAuthorComponents,
} from './lesson-author-components.logic.js';
import { assertLessonAuthorProposalComponentsValid } from '../ai-chatbot/ai-id/lesson-author-component-registry.logic.js';
import { normalizeDiagramData } from './diagram-data.logic.js';
import { applyGeneratedUnitComponents, ComponentApplyError, type StoredComponentRow } from './lesson-author-component-apply.logic.js';
import { formatChapterTitle, stripLessonAuthorSourceRangeSuffix } from '../ai-chatbot/ai-id/lesson-author-intent.logic.js';
import { UUID_PATTERN } from '../../utils/uuid.js';
import type {
  ApplyLessonAuthorProposalInput,
  ApplyLessonAuthorProposalResult,
  LessonAuthorComponentProposal,
  LessonAuthorComponentType,
  LessonAuthorOperationPlan,
  LessonAuthorProposal,
  LessonAuthorUnitProposal,
} from './course-authoring.types.js';

type DbClient = Awaited<ReturnType<typeof getClient>>;

async function getNextChildSortOrder(
  client: DbClient,
  courseId: string,
  parentId: string | null,
): Promise<number> {
  const result = parentId
    ? await client.query<{ next_order: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
         FROM course_blocks
         WHERE course_id = $1 AND parent_id = $2 AND deleted_at IS NULL`,
        [courseId, parentId],
      )
    : await client.query<{ next_order: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
         FROM course_blocks
         WHERE course_id = $1 AND parent_id IS NULL AND deleted_at IS NULL`,
        [courseId],
      );

  return result.rows[0]?.next_order ?? 0;
}

async function insertGeneratedBlock(
  client: DbClient,
  courseId: string,
  parentId: string | null,
  blockType: string,
  displayName: string,
  data: unknown,
  metadata: Record<string, unknown>,
): Promise<string> {
  const sortOrder = await getNextChildSortOrder(client, courseId, parentId);
  const result = await client.query<{ id: string }>(
    `INSERT INTO course_blocks (
       course_id, parent_id, block_type, display_name,
       data, metadata, sort_order, is_published, has_draft_changes
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, true)
     RETURNING id`,
    [
      courseId,
      parentId,
      blockType,
      displayName,
      JSON.stringify(data),
      metadata,
      sortOrder,
    ],
  );
  return result.rows[0].id;
}

function normalizeGeneratedTitle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findExistingChildBlock(
  client: DbClient,
  courseId: string,
  parentId: string,
  blockType: string,
  displayName: string,
): Promise<{ id: string; display_name: string; data: unknown; metadata: unknown } | null> {
  const normalized = normalizeGeneratedTitle(displayName);
  if (!normalized) return null;

  const result = await client.query<{ id: string; display_name: string; data: unknown; metadata: unknown }>(
    `SELECT id, display_name, data, metadata
     FROM course_blocks
     WHERE course_id = $1
       AND parent_id = $2
       AND block_type = $3
       AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
    [courseId, parentId, blockType],
  );

  const existing = result.rows.find(row => normalizeGeneratedTitle(row.display_name) === normalized);
  return existing ?? null;
}

async function markAncestorsDirtyWithClient(client: DbClient, blockId: string): Promise<void> {
  await client.query(
    `WITH RECURSIVE ancestors AS (
       SELECT parent_id
       FROM course_blocks
       WHERE id = $1 AND parent_id IS NOT NULL AND deleted_at IS NULL
       UNION ALL
       SELECT cb.parent_id
       FROM course_blocks cb
       JOIN ancestors a ON cb.id = a.parent_id
       WHERE cb.parent_id IS NOT NULL AND cb.deleted_at IS NULL
     )
     UPDATE course_blocks
     SET has_draft_changes = true, updated_at = now()
     WHERE id IN (SELECT parent_id FROM ancestors) AND deleted_at IS NULL`,
    [blockId],
  );
}

async function updateGeneratedBlockContent(
  client: DbClient,
  blockId: string,
  courseId: string,
  parentId: string,
  blockType: string,
  data: unknown,
  metadata: Record<string, unknown>,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `UPDATE course_blocks
     SET data = $5,
         metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
         has_draft_changes = true,
         updated_at = now()
     WHERE id = $1
       AND course_id = $2
       AND parent_id = $3
       AND block_type = $4
       AND deleted_at IS NULL
     RETURNING id`,
    [blockId, courseId, parentId, blockType, JSON.stringify(data), JSON.stringify(metadata)],
  );
  if (result.rowCount === 0) throw new Error('Existing generated block not found for update');
  await markAncestorsDirtyWithClient(client, blockId);
}

async function getOrCreateGeneratedBlock(
  client: DbClient,
  courseId: string,
  parentId: string,
  blockType: string,
  displayName: string,
  data: unknown,
  metadata: Record<string, unknown>,
  options: { updateExisting?: boolean; requireExisting?: boolean } = {},
): Promise<{ id: string; created: boolean; updated: boolean }> {
  const existing = await findExistingChildBlock(client, courseId, parentId, blockType, displayName);
  if (existing) {
    if (options.updateExisting) {
      const canUpdateGeneratedContent = isLessonAuthorGeneratedContentOwned(existing.metadata)
        && !isLessonAuthorMediaProtectedBlock(blockType, existing.data, existing.metadata);
      if (canUpdateGeneratedContent) {
        await updateGeneratedBlockContent(client, existing.id, courseId, parentId, blockType, data, metadata);
        return { id: existing.id, created: false, updated: true };
      }
    } else {
      return { id: existing.id, created: false, updated: false };
    }
  }

  if (options.requireExisting) {
    throw new AppError(`Không tìm thấy ${blockType} đã chọn trong outline. Vui lòng tạo lại đề xuất.`, 409);
  }

  const id = await insertGeneratedBlock(client, courseId, parentId, blockType, displayName, data, metadata);
  return { id, created: true, updated: false };
}

function clampTitle(value: string, fallback: string): string {
  const title = typeof value === 'string' ? value.trim() : '';
  return (title || fallback).slice(0, 250);
}

function clampStructuralTitle(value: string, fallback: string): string {
  let title = stripLessonAuthorSourceRangeSuffix(value);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = title.replace(
      /^(?:chương|chuong|chapter|phần|phan|part|mục|muc|section|module|sequential|bài học|bai hoc|bài|bai|lesson|unit|vertical)\s+\d+(?:\.\d+){0,2}(?:\s*[:.)-]\s*|\s+)/iu,
      '',
    ).trim();
    if (!next || next === title) break;
    title = next;
  }
  return clampTitle(title, fallback);
}

async function moveFaqComponentsToUnitEnd(client: DbClient, courseId: string, unitId: string): Promise<void> {
  // Move only FAQ rows. Non-FAQ blocks keep their sort_order and updated_at,
  // which is important for manual media and image components.
  await client.query(
    `WITH non_faq_max AS (
       SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order
       FROM course_blocks
       WHERE course_id = $1
         AND parent_id = $2
         AND deleted_at IS NULL
         AND block_type <> 'la_faq'
     ), ordered_faq AS (
       SELECT cb.id,
              non_faq_max.max_sort_order
                + ROW_NUMBER() OVER (
                    ORDER BY cb.sort_order ASC NULLS LAST, cb.created_at ASC, cb.id ASC
                  ) AS new_sort_order
       FROM course_blocks cb
       CROSS JOIN non_faq_max
       WHERE cb.course_id = $1
         AND cb.parent_id = $2
         AND cb.deleted_at IS NULL
         AND cb.block_type = 'la_faq'
     )
     UPDATE course_blocks cb
     SET sort_order = ordered_faq.new_sort_order::integer,
         updated_at = now()
     FROM ordered_faq
     WHERE cb.id = ordered_faq.id
       AND cb.course_id = $1
       AND cb.parent_id = $2
       AND cb.deleted_at IS NULL
       AND cb.sort_order IS DISTINCT FROM ordered_faq.new_sort_order::integer`,
    [courseId, unitId],
  );
}

function getLessonAuthorComponents(unit: LessonAuthorUnitProposal): LessonAuthorComponentProposal[] {
  if (Array.isArray(unit.components) && unit.components.length > 0) {
    return orderLessonAuthorComponents(unit.components);
  }
  if (typeof unit.html === 'string' && unit.html.trim()) {
    return [{
      type: 'html',
      title: unit.title,
      data: unit.html,
    }];
  }
  return [];
}

function buildGeneratedComponentBlock(
  component: LessonAuthorComponentProposal,
  unitTitle: string,
  baseMetadata: Record<string, unknown>,
  componentIndex: number,
): {
  blockType: LessonAuthorComponentType;
  displayName: string;
  data: unknown;
  metadata: Record<string, unknown>;
} {
  const displayName = clampTitle(component.title, `${unitTitle} component ${componentIndex + 1}`);
  const componentData = component.type === 'la_diagram'
    ? normalizeDiagramData(component.data)
    : component.data;
  return {
    blockType: component.type,
    displayName,
    data: componentData,
    metadata: {
      ...(component.metadata ?? {}),
      ...baseMetadata,
      ...(component.type === 'la_diagram' ? { diagram_data: componentData } : {}),
      ai_component_index: componentIndex,
      source: 'lesson_author_proposal',
    },
  };
}

function logLessonAuthorApply(stage: string, details: Record<string, unknown> = {}): void {
  console.log(`[LessonAuthorApply] ${stage}`, details);
}

export const LESSON_AUTHOR_OUTLINE_BUSY_CODE = 'LESSON_AUTHOR_OUTLINE_BUSY';

function normalizeLessonAuthorApplyError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof ComponentApplyError) {
    return new AppError('Chưa thể áp dụng đầy đủ các component. Không có thay đổi nào được lưu. Vui lòng kiểm tra lại đề xuất.', 409, error.code);
  }

  const databaseCode = (error as { code?: unknown })?.code;
  // A short lock timeout prevents the widget from waiting for the global
  // statement timeout when another course mutation owns the row lock.
  if (databaseCode === '55P03' || databaseCode === '57014') {
    return new AppError(
      'Khóa học đang được cập nhật ở nơi khác. Vui lòng thử lại sau.',
      409,
      LESSON_AUTHOR_OUTLINE_BUSY_CODE,
    );
  }

  return error;
}

function getProposalApplyMetrics(proposal: LessonAuthorProposal): Record<string, unknown> {
  let lessons = 0;
  let units = 0;
  let components = 0;
  const componentTypes = new Set<string>();

  proposal.chapters.forEach(chapter => {
    lessons += chapter.lessons.length;
    chapter.lessons.forEach(lesson => {
      units += lesson.units.length;
      lesson.units.forEach(unit => {
        const unitComponents = getLessonAuthorComponents(unit);
        components += unitComponents.length;
        unitComponents.forEach(component => componentTypes.add(component.type));
      });
    });
  });

  return {
    chapters: proposal.chapters.length,
    lessons,
    units,
    components,
    component_types: Array.from(componentTypes),
  };
}

function operationTargetType(blockType: string): LessonAuthorOperationPlan['target_type'] {
  if (blockType === 'course') return 'course';
  if (blockType === 'chapter') return 'chapter';
  if (blockType === 'sequential') return 'lesson';
  if (blockType === 'vertical') return 'unit';
  return 'component';
}

function operationTargetSnapshot(row: {
  id: string;
  parent_id: string | null;
  block_type: string;
  display_name: string;
  sort_order: number;
  data: unknown;
  metadata: unknown;
  updated_at: string | Date;
}): string {
  return createHash('sha256').update(JSON.stringify({
    id: row.id,
    parent_id: row.parent_id,
    block_type: row.block_type,
    display_name: row.display_name,
    sort_order: row.sort_order,
    data: row.data ?? null,
    metadata: row.metadata ?? null,
    updated_at: new Date(row.updated_at).toISOString(),
  })).digest('hex');
}

async function applyLessonAuthorOperationPlanWithClient(
  client: DbClient,
  input: ApplyLessonAuthorProposalInput,
  plan: LessonAuthorOperationPlan,
): Promise<ApplyLessonAuthorProposalResult> {
  if (!UUID_PATTERN.test(plan.target_block_id)) {
    throw new AppError('Target block không hợp lệ', 400);
  }

  const targetResult = await client.query<{
    id: string;
    course_id: string;
    parent_id: string | null;
    block_type: string;
    display_name: string;
    sort_order: number;
    data: unknown;
    metadata: unknown;
    updated_at: string | Date;
  }>(
    `SELECT cb.id::text AS id, cb.course_id, cb.parent_id::text AS parent_id,
            cb.block_type, cb.display_name, cb.sort_order, cb.data, cb.metadata, cb.updated_at
     FROM course_blocks cb
     JOIN courses c ON c.id = cb.course_id
     WHERE cb.id = $1
       AND cb.course_id = $2
       AND c.tenant_id = $3
       AND c.deleted_at IS NULL
       AND cb.deleted_at IS NULL
     FOR UPDATE OF cb`,
    [plan.target_block_id, input.courseId, input.tenantId],
  );
  const target = targetResult.rows[0];
  if (!target) throw new AppError('Node trong cây outline không còn tồn tại.', 409);

  const actualType = operationTargetType(target.block_type);
  if (plan.target_type && plan.target_type !== actualType) {
    throw new AppError('Node trong cây outline đã thay đổi loại. Vui lòng tạo lại đề xuất.', 409);
  }
  if (plan.target_snapshot && operationTargetSnapshot(target) !== plan.target_snapshot) {
    throw new AppError('Node trong cây outline đã thay đổi sau khi tạo đề xuất. Vui lòng tạo lại đề xuất.', 409);
  }

  if (plan.operation === 'rename') {
    const rawTitle = typeof plan.requested_title === 'string' ? plan.requested_title : '';
    const title = ['chapter', 'lesson', 'unit'].includes(actualType ?? '')
      ? clampStructuralTitle(rawTitle, '')
      : rawTitle.trim().slice(0, 250);
    if (!title) throw new AppError('Tên tiêu đề mới không hợp lệ.', 400);
    if (plan.title_strategy === 'prefix_chapter_number' && actualType === 'chapter') {
      const siblingRankResult = await client.query<{ sibling_index: number }>(
        `SELECT sibling_index
         FROM (
           SELECT cb.id::text AS id,
                  ROW_NUMBER() OVER (
                    PARTITION BY cb.parent_id, cb.block_type
                    ORDER BY cb.sort_order ASC, cb.id ASC
                  )::int AS sibling_index
           FROM course_blocks cb
           WHERE cb.course_id = $1
             AND cb.deleted_at IS NULL
         ) ranked
         WHERE ranked.id = $2`,
        [input.courseId, target.id],
      );
      const siblingIndex = siblingRankResult.rows[0]?.sibling_index;
      const expectedTitle = siblingIndex
        ? formatChapterTitle(target.display_name, String(siblingIndex))
        : null;
      if (!expectedTitle || title !== expectedTitle) {
        throw new AppError('Đề xuất định dạng tiêu đề đã cũ hoặc không khớp thứ tự Chương hiện tại. Vui lòng tạo lại đề xuất.', 409);
      }
    }
    const updated = await client.query<{ id: string }>(
      `UPDATE course_blocks
       SET display_name = $2,
           has_draft_changes = true,
           updated_at = now()
       WHERE id = $1 AND course_id = $3 AND deleted_at IS NULL
       RETURNING id`,
      [target.id, title, input.courseId],
    );
    if (updated.rowCount === 0) throw new AppError('Không thể đổi tiêu đề node trong outline.', 409);
    if (actualType === 'course' && target.parent_id === null) {
      await client.query(
        `UPDATE courses
         SET display_name = $2, updated_at = now()
         WHERE id = $1 AND tenant_id = $3 AND deleted_at IS NULL`,
        [input.courseId, title, input.tenantId],
      );
    }
    await markAncestorsDirtyWithClient(client, target.id);
    return { created_block_ids: [], updated_block_ids: [target.id] };
  }

  if (plan.operation === 'move') {
    throw new AppError('Thao tác di chuyển cần chỉ rõ vị trí đích trước khi áp dụng.', 400);
  }

  throw new AppError('Operation của đề xuất không được phép áp dụng.', 400);
}

async function applyLessonAuthorComponentContentWithClient(
  client: DbClient,
  input: ApplyLessonAuthorProposalInput,
  plan: LessonAuthorOperationPlan,
  proposal: LessonAuthorProposal,
  allowedComponentTypes: Set<CourseComponentType>,
  baseMetadata: Record<string, unknown>,
): Promise<ApplyLessonAuthorProposalResult | null> {
  if (plan.operation !== 'update_content' || plan.target_type !== 'component') return null;

  const targetResult = await client.query<{
    id: string;
    parent_id: string | null;
    block_type: string;
    display_name: string;
    sort_order: number;
    data: unknown;
    metadata: unknown;
    updated_at: string | Date;
  }>(
    `SELECT cb.id::text AS id, cb.parent_id::text AS parent_id, cb.block_type,
            cb.display_name, cb.sort_order, cb.data, cb.metadata, cb.updated_at
     FROM course_blocks cb
     JOIN courses c ON c.id = cb.course_id
     WHERE cb.id = $1
       AND cb.course_id = $2
       AND c.tenant_id = $3
       AND c.deleted_at IS NULL
       AND cb.deleted_at IS NULL
     FOR UPDATE OF cb`,
    [plan.target_block_id, input.courseId, input.tenantId],
  );
  const target = targetResult.rows[0];
  if (!target) throw new AppError('Component trong cây outline không còn tồn tại.', 409);
  if (operationTargetType(target.block_type) !== 'component') {
    throw new AppError('Target trong đề xuất không còn là component. Vui lòng tạo lại đề xuất.', 409);
  }
  if (plan.target_snapshot && operationTargetSnapshot(target) !== plan.target_snapshot) {
    throw new AppError('Component đã thay đổi sau khi tạo đề xuất. Vui lòng tạo lại đề xuất.', 409);
  }
  if (!target.parent_id) throw new AppError('Component không có Mục cha hợp lệ.', 409);
  if (isLessonAuthorMediaProtectedBlock(target.block_type, target.data, target.metadata)) {
    throw new AppError(
      'Lesson Author không sửa component chứa media, hình ảnh, video hoặc PDF. Hãy chỉnh component này trực tiếp trong trình soạn thảo.',
      409,
    );
  }

  const generatedComponents = getLessonAuthorComponents(
    proposal.chapters[0]?.lessons[0]?.units[0] ?? { title: target.display_name },
  );
  if (proposal.chapters.length !== 1
    || proposal.chapters[0]?.lessons.length !== 1
    || proposal.chapters[0]?.lessons[0]?.units.length !== 1
    || generatedComponents.length !== 1) {
    throw new AppError('Proposal sửa component phải chỉ chứa đúng một component được chọn.', 400);
  }
  const generatedComponent = generatedComponents[0];
  if (!generatedComponent) throw new AppError('Proposal không có nội dung component để áp dụng.', 400);
  if (generatedComponent.type !== target.block_type) {
    throw new AppError('Loại component trong proposal không khớp component đã chọn. Vui lòng tạo lại đề xuất.', 409);
  }
  const generated = buildGeneratedComponentBlock(
    { ...generatedComponent, title: target.display_name },
    target.display_name,
    baseMetadata,
    0,
  );
  assertCourseComponentTypeAllowed(allowedComponentTypes, generated.blockType);
  await updateGeneratedBlockContent(
    client,
    target.id,
    input.courseId,
    target.parent_id,
    target.block_type,
    generated.data,
    generated.metadata,
  );
  if (target.block_type === 'la_faq') await moveFaqComponentsToUnitEnd(client, input.courseId, target.parent_id);
  return { created_block_ids: [], updated_block_ids: [target.id] };
}

async function assertLessonAuthorOperationTargetFreshWithClient(
  client: DbClient,
  input: ApplyLessonAuthorProposalInput,
  plan: LessonAuthorOperationPlan,
): Promise<void> {
  if (!UUID_PATTERN.test(plan.target_block_id)) {
    throw new AppError('Target block không hợp lệ', 400);
  }
  const result = await client.query<{
    id: string;
    parent_id: string | null;
    block_type: string;
    display_name: string;
    sort_order: number;
    data: unknown;
    metadata: unknown;
    updated_at: string | Date;
  }>(
    `SELECT cb.id::text AS id, cb.parent_id::text AS parent_id, cb.block_type,
            cb.display_name, cb.sort_order, cb.data, cb.metadata, cb.updated_at
     FROM course_blocks cb
     JOIN courses c ON c.id = cb.course_id
     WHERE cb.id = $1
       AND cb.course_id = $2
       AND c.tenant_id = $3
       AND c.deleted_at IS NULL
       AND cb.deleted_at IS NULL
     FOR UPDATE OF cb`,
    [plan.target_block_id, input.courseId, input.tenantId],
  );
  const target = result.rows[0];
  if (!target) throw new AppError('Node trong cây outline không còn tồn tại.', 409);

  // A guarded new-chapter plan points at the course root as its parent. It
  // must never be accepted as an existing chapter update or as an arbitrary
  // parent supplied by a model-generated proposal.
  if (plan.target_resolution === 'new') {
    if (plan.operation !== 'create'
      || plan.target_type !== 'chapter'
      || target.block_type !== 'course'
      || target.parent_id !== null) {
      throw new AppError('Parent tạo Chương mới không hợp lệ. Vui lòng tạo lại đề xuất.', 409);
    }
    if (plan.target_snapshot && operationTargetSnapshot(target) !== plan.target_snapshot) {
      throw new AppError('Khóa học đã thay đổi sau khi tạo đề xuất. Vui lòng tạo lại đề xuất.', 409);
    }
    return;
  }

  if (plan.target_type === 'course') {
    throw new AppError('Không thể áp dụng nội dung trực tiếp cho toàn khóa học. Hãy chọn một node cụ thể.', 409);
  }
  const actualType = operationTargetType(target.block_type);
  if (actualType !== plan.target_type) {
    throw new AppError('Node trong đề xuất đã đổi loại. Vui lòng tạo lại đề xuất.', 409);
  }
  if (plan.target_snapshot && operationTargetSnapshot(target) !== plan.target_snapshot) {
    throw new AppError('Node trong cây outline đã thay đổi sau khi tạo đề xuất. Vui lòng tạo lại đề xuất.', 409);
  }
}

function lockLessonAuthorProposalToTarget(
  proposal: LessonAuthorProposal,
  plan: LessonAuthorOperationPlan,
): LessonAuthorProposal {
  if (plan.operation !== 'update_content' && plan.operation !== 'create') return proposal;
  if (!proposal.chapters.length) throw new AppError('Proposal không có nội dung để áp dụng.', 400);

  const isNewChapter = plan.target_resolution === 'new'
    && plan.operation === 'create'
    && plan.target_type === 'chapter';
  const pathParts = plan.target_path.split(' / ').map(part => part.trim()).filter(Boolean);
  const chapters = proposal.chapters.slice(0, 1).map((chapter) => {
    const chapterTitle = isNewChapter
      ? chapter.title
      : plan.target_type === 'chapter' || plan.target_type === 'course'
      ? plan.target_display_name
      : pathParts[0] || chapter.title;
    const lessons = chapter.lessons.slice(0, plan.target_type === 'chapter' || plan.target_type === 'course' ? chapter.lessons.length : 1).map((lesson) => {
      const lessonTitle = plan.target_type === 'lesson' ? plan.target_display_name : pathParts[1] || lesson.title;
      const units = lesson.units.slice(0, plan.target_type === 'lesson' || plan.target_type === 'chapter' || plan.target_type === 'course' ? lesson.units.length : 1).map((unit) => {
        const unitTitle = plan.target_type === 'unit' ? plan.target_display_name : pathParts[2] || unit.title;
        const components = plan.target_type === 'component'
          ? (unit.components ?? []).slice(0, 1).map(component => ({ ...component, title: plan.target_display_name }))
          : unit.components;
        return { ...unit, title: unitTitle, components };
      });
      return { ...lesson, title: lessonTitle, units };
    });
    return { ...chapter, title: chapterTitle, lessons };
  });
  return { ...proposal, chapters };
}

export async function applyLessonAuthorProposalToCourse(
  input: ApplyLessonAuthorProposalInput,
): Promise<ApplyLessonAuthorProposalResult> {
  const result = await withDatabaseTransaction(async (client) => {
    try {
    logLessonAuthorApply('start', {
      course_id: input.courseId,
      tenant_id: input.tenantId,
      job_id: input.jobId ?? null,
      kb_id: input.kbId ?? null,
      ...getProposalApplyMetrics(input.proposal),
    });
    await client.query("SET LOCAL lock_timeout = '3000ms'");
    logLessonAuthorApply('lock_timeout_configured', {
      course_id: input.courseId,
      job_id: input.jobId ?? null,
    });
    const advisoryLock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
      [`course:${input.tenantId}:${input.courseId}`],
    );
    if (!advisoryLock.rows[0]?.acquired) {
      throw new AppError(
        'Khóa học đang được cập nhật ở nơi khác. Vui lòng thử lại sau.',
        409,
        LESSON_AUTHOR_OUTLINE_BUSY_CODE,
      );
    }
    logLessonAuthorApply('transaction_locked', {
      course_id: input.courseId,
      tenant_id: input.tenantId,
      job_id: input.jobId ?? null,
    });

    logLessonAuthorApply('course_lock_start', {
      course_id: input.courseId,
      job_id: input.jobId ?? null,
    });
    const courseResult = await client.query<{ id: string; display_name: string }>(
      `SELECT id, display_name
       FROM courses
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [input.courseId, input.tenantId],
    );
    if (courseResult.rowCount === 0) throw new AppError('Course not found', 404);
    logLessonAuthorApply('course_locked', {
      course_id: input.courseId,
      job_id: input.jobId ?? null,
    });
    const allowedComponentTypes = await getTenantAllowedCourseComponentTypeSet(input.tenantId, client);
    logLessonAuthorApply('component_permissions_loaded', {
      course_id: input.courseId,
      job_id: input.jobId ?? null,
      allowed_component_types: allowedComponentTypes.size,
    });
    // Revalidate the persisted proposal inside the same transaction that will
    // mutate course_blocks. This preserves the proposal/Apply boundary even if
    // tenant component settings changed after review.
    assertLessonAuthorProposalComponentsValid(input.proposal, allowedComponentTypes);
    const baseMetadata = {
      generated_by: 'lesson_author_ai',
      job_id: input.jobId ?? null,
      kb_id: input.kbId ?? null,
      requested_by: input.requestedBy,
      generated_at: new Date().toISOString(),
    };
    const operationPlan = input.proposal.operation_plan;
    if (operationPlan
      && !['rename', 'move', 'create', 'update_content'].includes(operationPlan.operation)) {
      throw new AppError('Operation của đề xuất không được phép áp dụng.', 400);
    }
    if (operationPlan
      && (operationPlan.operation === 'create' || operationPlan.operation === 'update_content')) {
      await assertLessonAuthorOperationTargetFreshWithClient(client, input, operationPlan);
    }

    if (operationPlan
      && (operationPlan.operation === 'rename' || operationPlan.operation === 'move')) {
      const operationResult = await applyLessonAuthorOperationPlanWithClient(
        client,
        input,
        operationPlan,
      );
      logLessonAuthorApply('operation_applied', {
        course_id: input.courseId,
        job_id: input.jobId ?? null,
        operation: operationPlan.operation,
        target_block_id: operationPlan.target_block_id,
        updated_count: operationResult.updated_block_ids.length,
      });
      return operationResult;
    }

    if (operationPlan) {
      const componentResult = await applyLessonAuthorComponentContentWithClient(
        client,
        input,
        operationPlan,
        input.proposal,
        allowedComponentTypes,
        baseMetadata,
      );
      if (componentResult) return componentResult;
    }

    logLessonAuthorApply('root_lock_start', {
      course_id: input.courseId,
      job_id: input.jobId ?? null,
    });
    let rootResult = await client.query<{ id: string }>(
      `SELECT id
       FROM course_blocks
       WHERE course_id = $1
         AND parent_id IS NULL
         AND block_type = 'course'
         AND deleted_at IS NULL
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE`,
      [input.courseId],
    );

    let createdRoot = false;
    if (rootResult.rowCount === 0) {
      createdRoot = true;
      rootResult = await client.query<{ id: string }>(
        `INSERT INTO course_blocks (
           course_id, block_type, display_name, is_published, has_draft_changes
         )
         VALUES ($1, 'course', $2, true, true)
         RETURNING id`,
        [input.courseId, courseResult.rows[0].display_name],
      );
    }

    const rootId = rootResult.rows[0].id;
    logLessonAuthorApply('root_ready', {
      course_id: input.courseId,
      root_id: rootId,
      created_root: createdRoot,
    });
    const createdBlockIds: string[] = [];
    const updatedBlockIds: string[] = [];
    const proposalForApply = operationPlan
      ? lockLessonAuthorProposalToTarget(input.proposal, operationPlan)
      : input.proposal;
    const requireExistingChapter = Boolean(operationPlan) && operationPlan?.target_resolution !== 'new';
    const requireExistingLesson = operationPlan?.operation === 'update_content'
      || operationPlan?.target_type === 'lesson'
      || operationPlan?.target_type === 'unit'
      || operationPlan?.target_type === 'component';
    const requireExistingUnit = operationPlan?.operation === 'update_content'
      || operationPlan?.target_type === 'unit'
      || operationPlan?.target_type === 'component';

    for (const [chapterIndex, chapter] of proposalForApply.chapters.entries()) {
      const chapterTitle = clampStructuralTitle(chapter.title, `Generated chapter ${chapterIndex + 1}`);
      const chapterBlock = await getOrCreateGeneratedBlock(
        client,
        input.courseId,
        rootId,
        'chapter',
        chapterTitle,
        {},
        { ...baseMetadata, ai_index: chapterIndex },
        { requireExisting: requireExistingChapter },
      );
      if (chapterBlock.created) createdBlockIds.push(chapterBlock.id);
      logLessonAuthorApply('chapter_ready', {
        job_id: input.jobId ?? null,
        title: chapterTitle,
        id: chapterBlock.id,
        created: chapterBlock.created,
      });

      for (const [lessonIndex, lesson] of chapter.lessons.entries()) {
        const lessonTitle = clampStructuralTitle(lesson.title, `Generated lesson ${lessonIndex + 1}`);
        const sequentialBlock = await getOrCreateGeneratedBlock(
          client,
          input.courseId,
          chapterBlock.id,
          'sequential',
          lessonTitle,
          {},
          { ...baseMetadata, ai_index: lessonIndex },
          { requireExisting: requireExistingLesson },
        );
        if (sequentialBlock.created) createdBlockIds.push(sequentialBlock.id);
        logLessonAuthorApply('lesson_ready', {
          job_id: input.jobId ?? null,
          chapter_id: chapterBlock.id,
          title: lessonTitle,
          id: sequentialBlock.id,
          created: sequentialBlock.created,
        });

        for (const [unitIndex, unit] of lesson.units.entries()) {
          const unitTitle = clampStructuralTitle(unit.title, `Generated unit ${unitIndex + 1}`);
          const verticalBlock = await getOrCreateGeneratedBlock(
            client,
            input.courseId,
            sequentialBlock.id,
            'vertical',
            unitTitle,
            {},
            {
              ...baseMetadata,
              ai_index: unitIndex,
              ...(unit.source_fact_ids?.length ? { source_fact_ids: unit.source_fact_ids } : {}),
              ...(unit.component_plan?.length ? { component_plan: unit.component_plan } : {}),
            },
            { requireExisting: requireExistingUnit },
          );
          if (verticalBlock.created) createdBlockIds.push(verticalBlock.id);
          logLessonAuthorApply('unit_ready', {
            job_id: input.jobId ?? null,
            lesson_id: sequentialBlock.id,
            title: unitTitle,
            id: verticalBlock.id,
            created: verticalBlock.created,
          });

          const generatedComponents = getLessonAuthorComponents(unit).map((component, componentIndex) => {
            const generated = buildGeneratedComponentBlock(
              component,
              unitTitle,
              { ...baseMetadata, ai_index: unitIndex },
              componentIndex,
            );
            assertCourseComponentTypeAllowed(allowedComponentTypes, generated.blockType);
            return generated;
          });
          const componentResults = await applyGeneratedUnitComponents(generatedComponents, {
            list: async () => (await client.query<StoredComponentRow>(
              `SELECT cb.id, cb.block_type, cb.display_name, cb.data, cb.metadata
               FROM course_blocks cb JOIN courses c ON c.id = cb.course_id
               WHERE cb.course_id = $1 AND cb.parent_id = $2 AND c.tenant_id = $3
                 AND c.deleted_at IS NULL AND cb.deleted_at IS NULL
               ORDER BY cb.sort_order ASC, cb.created_at ASC, cb.id ASC
               FOR UPDATE OF cb`,
              [input.courseId, verticalBlock.id, input.tenantId],
            )).rows,
            insert: generated => insertGeneratedBlock(client, input.courseId, verticalBlock.id,
              generated.blockType, generated.displayName, generated.data, generated.metadata),
            update: (id, generated) => updateGeneratedBlockContent(client, id, input.courseId, verticalBlock.id,
              generated.blockType, generated.data, generated.metadata),
          });
          logLessonAuthorApply('component_parity_passed', {
            job_id: input.jobId ?? null, course_id: input.courseId, unit_id: verticalBlock.id,
            expected_component_count: generatedComponents.length,
            persisted_component_count: componentResults.length, identity_contract: 'component-apply-identity-1',
          });
          for (const [componentIndex, componentBlock] of componentResults.entries()) {
            const generatedComponent = generatedComponents[componentIndex];
            if (componentBlock.created) createdBlockIds.push(componentBlock.id);
            if (componentBlock.updated) updatedBlockIds.push(componentBlock.id);
            logLessonAuthorApply('component_ready', {
              job_id: input.jobId ?? null,
              unit_id: verticalBlock.id,
              type: generatedComponent.blockType,
              title: generatedComponent.displayName,
              id: componentBlock.id,
              created: componentBlock.created,
              updated: componentBlock.updated,
              component_plan_id: componentBlock.component_plan_id ?? null,
            });
          }
          await moveFaqComponentsToUnitEnd(client, input.courseId, verticalBlock.id);
        }
      }
    }

    await client.query(
      `UPDATE course_blocks
       SET has_draft_changes = true, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [rootId],
    );

    logLessonAuthorApply('transaction_prepared', {
      course_id: input.courseId,
      job_id: input.jobId ?? null,
      created_count: createdBlockIds.length,
      updated_count: updatedBlockIds.length,
    });
    return { created_block_ids: createdBlockIds, updated_block_ids: updatedBlockIds };
    } catch (error) {
      const normalizedError = normalizeLessonAuthorApplyError(error);
      logLessonAuthorApply('transaction_aborted', {
        course_id: input.courseId,
        job_id: input.jobId ?? null,
        ...(error instanceof ComponentApplyError ? { internal_failure_code: error.code, component_index: error.componentIndex ?? null,
          failure_stage: 'component_apply_identity_parity' } : {}),
        error: normalizedError instanceof Error ? normalizedError.message : String(normalizedError),
      });
      throw normalizedError;
    }
  });
  return result;
}
