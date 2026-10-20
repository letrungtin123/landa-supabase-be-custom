// ═══════════════════════════════════════════════════════════════
// AI ID apply, steps: logging and error mapping, the proposal metrics, the
// operation plan and component content applies, the target freshness check
// and the proposal-to-target lock. Moved unchanged from
// course-lesson-author-apply.service.ts, which runs them in one transaction.
// ═══════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { assertCourseComponentTypeAllowed } from '../tenants/tenant-course-components.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import { isLessonAuthorMediaProtectedBlock } from './lesson-author-components.logic.js';
import { ComponentApplyError } from './lesson-author-component-apply.logic.js';
import { formatChapterTitle } from '../ai-chatbot/ai-id/shared/lesson-author-intent.logic.js';
import { UUID_PATTERN } from '../../utils/uuid.js';
import type {
  ApplyLessonAuthorProposalInput,
  ApplyLessonAuthorProposalResult,
  LessonAuthorOperationPlan,
  LessonAuthorProposal,
} from './course-authoring.types.js';
import {
  type DbClient,
  markAncestorsDirtyWithClient,
  updateGeneratedBlockContent,
  clampStructuralTitle,
  moveFaqComponentsToUnitEnd,
  getLessonAuthorComponents,
  buildGeneratedComponentBlock,
} from './course-lesson-author-apply-blocks.js';

export function logLessonAuthorApply(stage: string, details: Record<string, unknown> = {}): void {
  console.log(`[LessonAuthorApply] ${stage}`, details);
}

export const LESSON_AUTHOR_OUTLINE_BUSY_CODE = 'LESSON_AUTHOR_OUTLINE_BUSY';

export function normalizeLessonAuthorApplyError(error: unknown): unknown {
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

export function getProposalApplyMetrics(proposal: LessonAuthorProposal): Record<string, unknown> {
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

export async function applyLessonAuthorOperationPlanWithClient(
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

export async function applyLessonAuthorComponentContentWithClient(
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

export async function assertLessonAuthorOperationTargetFreshWithClient(
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

export function lockLessonAuthorProposalToTarget(
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
