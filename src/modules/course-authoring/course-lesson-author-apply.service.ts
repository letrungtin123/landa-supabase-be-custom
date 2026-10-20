// ═══════════════════════════════════════════════════════════════
// AI ID apply: writes a reviewed AI ID proposal into a course outline, in one
// transaction under the course lock. Moved unchanged from
// course-authoring.service.ts, which still re-exports it.
// ═══════════════════════════════════════════════════════════════

import { withDatabaseTransaction } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import {
  assertCourseComponentTypeAllowed,
  getTenantAllowedCourseComponentTypeSet,
} from '../tenants/tenant-course-components.service.js';
import { assertLessonAuthorProposalComponentsValid } from '../ai-chatbot/ai-id/content/lesson-author-component-registry.logic.js';
import { applyGeneratedUnitComponents, ComponentApplyError, type StoredComponentRow } from './lesson-author-component-apply.logic.js';
import type { ApplyLessonAuthorProposalInput, ApplyLessonAuthorProposalResult } from './course-authoring.types.js';
import {
  insertGeneratedBlock,
  updateGeneratedBlockContent,
  getOrCreateGeneratedBlock,
  clampStructuralTitle,
  moveFaqComponentsToUnitEnd,
  getLessonAuthorComponents,
  buildGeneratedComponentBlock,
} from './course-lesson-author-apply-blocks.js';
import {
  logLessonAuthorApply,
  LESSON_AUTHOR_OUTLINE_BUSY_CODE,
  normalizeLessonAuthorApplyError,
  getProposalApplyMetrics,
  applyLessonAuthorOperationPlanWithClient,
  applyLessonAuthorComponentContentWithClient,
  assertLessonAuthorOperationTargetFreshWithClient,
  lockLessonAuthorProposalToTarget,
} from './course-lesson-author-apply-steps.js';
// The steps of the apply live in course-lesson-author-apply-steps.ts; this name stays importable from here.
export { LESSON_AUTHOR_OUTLINE_BUSY_CODE } from './course-lesson-author-apply-steps.js';

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
