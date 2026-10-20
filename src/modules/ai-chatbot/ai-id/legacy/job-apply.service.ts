// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { query } from '../../../../config/database.js';
import { AppError } from '../../../../middleware/error-handler.js';
import {
  applyLessonAuthorProposalToCourse,
  LESSON_AUTHOR_OUTLINE_BUSY_CODE,
} from '../../../course-authoring/course-authoring.service.js';
import { formatLessonAuthorApprovalMessage } from '../v1/lesson-author-message.logic.js';
import { requestBlockDeletion } from '../../../course-deletion/course-deletion.service.js';
import { isValidUUID, logLessonAuthorFlow } from '../../chat/chat-turn-runtime.service.js';
import { getLessonAuthorJobLocale } from './job-store.service.js';
import { getBlueprintChapterIndexForJob } from './message-hydration.service.js';
import type { AppliedLessonAuthorJob, LessonAuthorJobRow } from './types.js';
import {
  getLessonAuthorProposalMetrics,
  readStoredLessonAuthorOperationPlan,
  assertLessonAuthorActionPlanFresh,
} from './preview.logic.js';

const LESSON_AUTHOR_APPLY_IN_PROGRESS_CODE = 'LESSON_AUTHOR_APPLY_IN_PROGRESS';

function isRetryableLessonAuthorApplyError(error: unknown): boolean {
  return error instanceof AppError && error.code === LESSON_AUTHOR_OUTLINE_BUSY_CODE;
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
    const existing = await query<Pick<LessonAuthorJobRow, 'status' | 'course_id' | 'conversation_id' | 'blueprint_id' | 'created_at' | 'created_block_ids' | 'updated_block_ids'>>(
      `SELECT status, course_id, conversation_id, blueprint_id, created_at, created_block_ids, updated_block_ids
       FROM lesson_author_jobs
       WHERE id = $1 AND tenant_id = $2`,
      [jobId, tenantId],
    );
    const existingJob = existing.rows[0];
    const status = existingJob?.status;
    logLessonAuthorFlow('apply_job_claim_failed', { job_id: jobId, tenant_id: tenantId, status: status ?? null });
    if (status === 'succeeded' && existingJob) {
      const createdBlockIds = existingJob.created_block_ids ?? [];
      const updatedBlockIds = existingJob.updated_block_ids ?? [];
      // Optional field of a replayed result: null when it cannot be read.
      const blueprintChapterIndex = await getBlueprintChapterIndexForJob(existingJob).catch(() => null);
      return {
        job_id: jobId,
        course_id: existingJob.course_id,
        created_block_ids: createdBlockIds,
        updated_block_ids: updatedBlockIds,
        created_count: createdBlockIds.length,
        updated_count: updatedBlockIds.length,
        already_applied: true,
        blueprint_id: existingJob.blueprint_id ?? null,
        blueprint_chapter_index: blueprintChapterIndex,
      };
    }
    if (status === 'applying') {
      throw new AppError(
        'Đề xuất đang được áp dụng. Vui lòng chờ trong giây lát.',
        409,
        LESSON_AUTHOR_APPLY_IN_PROGRESS_CODE,
      );
    }
    if (status) {
      throw new AppError('Đề xuất này chưa sẵn sàng để áp dụng. Vui lòng tạo lại đề xuất.', 409);
    }
    throw new AppError('Không tìm thấy đề xuất cần áp dụng.', 404);
  }

  const job = claim.rows[0];
  const blueprintChapterIndex = await getBlueprintChapterIndexForJob(job).catch((error: unknown) => {
    logLessonAuthorFlow('apply_blueprint_chapter_context_unavailable', {
      job_id: job.id,
      blueprint_id: job.blueprint_id ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  logLessonAuthorFlow('apply_job_claimed', {
    job_id: job.id,
    tenant_id: tenantId,
    course_id: job.course_id,
    conversation_id: job.conversation_id,
    kb_id: job.kb_id,
    ...getLessonAuthorProposalMetrics(job.proposal),
  });
  try {
    // A detailed proposal created from a Blueprint must not be applied after
    // its source snapshot was invalidated by a KB document change.
    if (job.blueprint_id) {
      const blueprint = await query<{ status: string; error_reason: string | null }>(
        `SELECT status, error_reason
         FROM lesson_author_blueprints
         WHERE id = $1
           AND tenant_id = $2
           AND course_id = $3
           AND kb_id IS NOT DISTINCT FROM $4
         LIMIT 1`,
        [job.blueprint_id, tenantId, job.course_id, job.kb_id],
      );
      const sourceChangeReason = blueprint.rows[0]?.error_reason
        || 'Tài liệu nguồn hoặc Kho tri thức của Bản thiết kế đã thay đổi.';
      if (!blueprint.rowCount || blueprint.rows[0]?.status !== 'proposed') {
        logLessonAuthorFlow('apply_blueprint_provenance_rejected', {
          job_id: job.id,
          blueprint_id: job.blueprint_id,
          tenant_id: tenantId,
          blueprint_status: blueprint.rows[0]?.status ?? null,
        });
        throw new AppError(`${sourceChangeReason} Vui lòng tạo lại Bản thiết kế khóa học trước khi áp dụng.`, 409);
      }
    }

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
        throw new AppError(
          `Proposal đã tạo ${Math.round(jobAge / 60_000)} phút trước và outline đã thay đổi. Tạo proposal mới để tránh conflict.`,
          409,
        );
      }
    }

    const storedOperationPlanValue = job.proposal?.operation_plan;
    const operationPlan = readStoredLessonAuthorOperationPlan(storedOperationPlanValue);
    if (storedOperationPlanValue !== undefined && storedOperationPlanValue !== null && !operationPlan) {
      throw new AppError('Đề xuất thao tác không hợp lệ hoặc đã bị thay đổi. Vui lòng tạo lại đề xuất.', 409);
    }
    let applied: { created_block_ids: string[]; updated_block_ids: string[] };
    if (operationPlan?.operation === 'delete') {
      const existingDeletion = await query<{ id: string; status: string }>(
        `SELECT id::text AS id, status
         FROM course_deletion_jobs
         WHERE tenant_id = $1
           AND course_id = $2
           AND root_block_id = $3
           AND target_type = 'block'
           AND status IN ('queued', 'running', 'succeeded', 'failed')
         ORDER BY created_at DESC
         LIMIT 1`,
        [tenantId, job.course_id, operationPlan.target_block_id],
      );
      if (!existingDeletion.rows[0]) {
        await assertLessonAuthorActionPlanFresh(operationPlan, job.course_id, tenantId);
        await requestBlockDeletion(operationPlan.target_block_id, tenantId, userId);
      }
      applied = {
        created_block_ids: [],
        updated_block_ids: [operationPlan.target_block_id],
      };
      logLessonAuthorFlow('delete_operation_queued', {
        job_id: job.id,
        course_id: job.course_id,
        target_block_id: operationPlan.target_block_id,
        existing_deletion_job_id: existingDeletion.rows[0]?.id ?? null,
      });
    } else {
      applied = await applyLessonAuthorProposalToCourse({
        courseId: job.course_id,
        tenantId,
        requestedBy: userId,
        proposal: job.proposal,
        jobId: job.id,
        kbId: job.kb_id,
      });
    }
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

    const approvalLocale = await getLessonAuthorJobLocale(job, tenantId).catch((error: unknown) => {
      logLessonAuthorFlow('apply_approval_locale_unavailable', {
        job_id: job.id,
        conversation_id: job.conversation_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'vi' as const;
    });
    const approvalText = formatLessonAuthorApprovalMessage(
      operationPlan?.operation,
      applied.created_block_ids.length,
      applied.updated_block_ids.length,
      approvalLocale,
    );
    await query(
      `INSERT INTO chat_messages (conversation_id, role, content, metadata)
       VALUES ($1, 'assistant', $2, $3)`,
      [
        job.conversation_id,
        approvalText,
        {
          kind: 'lesson_author_plan_approved',
          lesson_author_job_id: job.id,
          locale: approvalLocale,
          ...(job.blueprint_id ? { lesson_author_blueprint_id: job.blueprint_id } : {}),
          ...(blueprintChapterIndex !== null ? { lesson_author_blueprint_chapter_index: blueprintChapterIndex } : {}),
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

    return {
      job_id: job.id,
      course_id: job.course_id,
      created_block_ids: applied.created_block_ids,
      updated_block_ids: applied.updated_block_ids,
      created_count: applied.created_block_ids.length,
      updated_count: applied.updated_block_ids.length,
      blueprint_id: job.blueprint_id ?? null,
      blueprint_chapter_index: blueprintChapterIndex,
    };
  } catch (err: unknown) {
    const retryable = isRetryableLessonAuthorApplyError(err);
    const errorMessage = err instanceof Error ? err.message : 'Apply failed';
    logLessonAuthorFlow('apply_job_failed', {
      job_id: job.id,
      course_id: job.course_id,
      retryable,
      error: errorMessage,
    });
    await query(
      `UPDATE lesson_author_jobs
       SET status = 'proposed', updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'applying'`,
      [job.id, tenantId],
    ).catch((resetError) => {
      console.error('[LessonAuthorFlow] Failed to reset applying job after error', {
        job_id: job.id,
        error: resetError instanceof Error ? resetError.message : String(resetError),
      });
    });
    // The claim is made in a separate short transaction from course mutation.
    // Return the job to `proposed` after a failed apply so a transient error
    // does not leave the approval button permanently stuck.
    throw err;
  }
}
