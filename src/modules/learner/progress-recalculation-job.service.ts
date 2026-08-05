import { query } from '../../config/database.js';
import { env } from '../../config/env.js';
import { QUEUES, publish } from '../../config/rabbitmq/index.js';

interface ProgressRecalculationJob {
  id: string;
  tenant_id: string;
  course_id: string;
  last_enrollment_id: string | null;
  processed_count: number;
}

interface ProgressRecalculationRequest {
  tenantId: string;
  courseId: string;
  reason: string;
  assignmentId?: string | null;
}


const errorToMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const isMissingJobTableError = (error: unknown): boolean => {
  const maybeError = error as { code?: string; message?: string };
  return maybeError?.code === '42P01' || Boolean(maybeError?.message?.includes('course_progress_recalculation_jobs'));
};

export async function wakeCourseProgressRecalculationJob(jobId: string): Promise<void> {
  await publish(QUEUES.COURSE_PROGRESS_RECALC, { jobId });
}

async function enqueueCourseProgressRecalculation(
  request: ProgressRecalculationRequest,
): Promise<string | null> {
  try {
    const result = await query<{ id: string }>(
      `
        INSERT INTO course_progress_recalculation_jobs (
          tenant_id,
          course_id,
          reason,
          assignment_id,
          status,
          requested_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, 'queued', now(), now())
        ON CONFLICT (tenant_id, course_id) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          reason = EXCLUDED.reason,
          assignment_id = EXCLUDED.assignment_id,
          requested_at = now(),
          updated_at = now(),
          status = CASE
            WHEN course_progress_recalculation_jobs.status = 'running' THEN 'running'
            ELSE 'queued'
          END,
          rerun_requested = CASE
            WHEN course_progress_recalculation_jobs.status = 'running' THEN true
            ELSE false
          END,
          last_enrollment_id = CASE
            WHEN course_progress_recalculation_jobs.status = 'running' THEN course_progress_recalculation_jobs.last_enrollment_id
            ELSE NULL
          END,
          processed_count = CASE
            WHEN course_progress_recalculation_jobs.status = 'running' THEN course_progress_recalculation_jobs.processed_count
            ELSE 0
          END,
          last_error = NULL,
          finished_at = NULL
        RETURNING id
      `,
      [request.tenantId, request.courseId, request.reason, request.assignmentId ?? null],
    );

    return result.rows[0]?.id ?? null;
  } catch (error) {
    if (isMissingJobTableError(error)) {
      console.warn('[course-progress-recalculation] Job table is missing; falling back to inline recalculation');
      return null;
    }

    console.error('[course-progress-recalculation] Failed to enqueue job', error);
    return null;
  }
}

export async function scheduleCourseProgressRecalculation(
  request: ProgressRecalculationRequest,
): Promise<void> {
  const jobId = await enqueueCourseProgressRecalculation(request);

  if (!jobId) {
    console.warn('[course-progress-recalculation] Job was not scheduled; run the manual SQL before relying on async recalculation');
    return;
  }

  try {
    await wakeCourseProgressRecalculationJob(jobId);
  } catch (error) {
    console.error('[course-progress-recalculation] Failed to publish job wake-up; poller will retry queued jobs', error);
  }
}

async function claimCourseProgressRecalculationJob(jobId: string): Promise<ProgressRecalculationJob | null> {
  try {
    const result = await query<ProgressRecalculationJob>(
      `
        UPDATE course_progress_recalculation_jobs
        SET
          status = 'running',
          attempts = attempts + 1,
          started_at = COALESCE(started_at, now()),
          updated_at = now(),
          last_error = NULL
        WHERE id = $1
          AND status = 'queued'
        RETURNING id, tenant_id, course_id, last_enrollment_id, processed_count
      `,
      [jobId],
    );

    return result.rows[0] ?? null;
  } catch (error) {
    if (isMissingJobTableError(error)) {
      console.warn('[course-progress-recalculation] Job table is missing; ignoring queued message');
      return null;
    }
    throw error;
  }
}

async function recalculateCourseProgressBatch(
  job: ProgressRecalculationJob,
  batchSize: number,
): Promise<{ processed: number; lastEnrollmentId: string | null }> {
  const result = await query<{ processed: number; last_enrollment_id: string | null }>(
    `
      WITH RECURSIVE target_enrollments AS (
        SELECT e.id
        FROM enrollments e
        WHERE e.tenant_id = $2
          AND e.course_id = $1
          AND e.is_active = true
          AND ($3::uuid IS NULL OR e.id > $3::uuid)
        ORDER BY e.id
        LIMIT $4
      ),
      active_tree AS (
        SELECT b.id, b.parent_id, b.block_type
        FROM course_blocks b
        JOIN courses c ON c.id = b.course_id
        WHERE b.course_id = $1
          AND c.tenant_id = $2
          AND b.parent_id IS NULL
          AND b.is_published = true
          AND b.deleted_at IS NULL
          AND c.deleted_at IS NULL
        UNION ALL
        SELECT child.id, child.parent_id, child.block_type
        FROM course_blocks child
        JOIN active_tree parent ON parent.id = child.parent_id
        WHERE child.course_id = $1
          AND child.is_published = true
          AND child.deleted_at IS NULL
      ),
      leaf_blocks AS (
        SELECT id
        FROM active_tree
        WHERE block_type NOT IN ('course', 'chapter', 'sequential', 'vertical')
      ),
      totals AS (
        SELECT
          (
            SELECT COUNT(*)::int
            FROM leaf_blocks
          ) +
          (
            SELECT COUNT(*)::int
            FROM course_assignments ca
            WHERE ca.tenant_id = $2
              AND ca.course_id = $1
              AND ca.deleted_at IS NULL
          ) AS total_items
      ),
      completed_blocks AS (
        SELECT bc.enrollment_id, COUNT(DISTINCT bc.block_id)::int AS completed
        FROM block_completions bc
        JOIN target_enrollments te ON te.id = bc.enrollment_id
        JOIN leaf_blocks lb ON lb.id = bc.block_id
        GROUP BY bc.enrollment_id
      ),
      completed_assignments AS (
        SELECT s.enrollment_id, COUNT(DISTINCT s.assignment_id)::int AS completed
        FROM assignment_submissions s
        JOIN target_enrollments te ON te.id = s.enrollment_id
        JOIN course_assignments ca
          ON ca.id = s.assignment_id
         AND ca.tenant_id = $2
         AND ca.course_id = $1
         AND ca.deleted_at IS NULL
        WHERE s.status IN ('submitted', 'feedback_given')
        GROUP BY s.enrollment_id
      ),
      calculated_progress AS (
        SELECT
          te.id AS enrollment_id,
          CASE
            WHEN totals.total_items > 0 THEN
              ROUND(
                (
                  (
                    (
                      COALESCE(completed_blocks.completed, 0) +
                      COALESCE(completed_assignments.completed, 0)
                    )::numeric / totals.total_items::numeric
                  ) * 100
                ),
                2
              )
            ELSE 0
          END AS progress,
          CASE
            WHEN totals.total_items > 0 THEN
              (
                COALESCE(completed_blocks.completed, 0) +
                COALESCE(completed_assignments.completed, 0)
              ) >= totals.total_items
            ELSE false
          END AS is_completed
        FROM target_enrollments te
        CROSS JOIN totals
        LEFT JOIN completed_blocks ON completed_blocks.enrollment_id = te.id
        LEFT JOIN completed_assignments ON completed_assignments.enrollment_id = te.id
      ),
      upserted_progress AS (
        INSERT INTO course_progress (
          enrollment_id,
          progress,
          is_completed,
          completed_at,
          last_activity_at,
          updated_at
        )
        SELECT
          enrollment_id,
          progress,
          is_completed,
          CASE WHEN is_completed THEN now() ELSE NULL END,
          now(),
          now()
        FROM calculated_progress
        ON CONFLICT (enrollment_id) DO UPDATE SET
          progress = EXCLUDED.progress,
          is_completed = EXCLUDED.is_completed,
          completed_at = CASE
            WHEN EXCLUDED.is_completed THEN COALESCE(course_progress.completed_at, now())
            ELSE NULL
          END,
          last_activity_at = now(),
          updated_at = now()
        RETURNING enrollment_id
      )
      SELECT
        COUNT(*)::int AS processed,
        MAX(id)::text AS last_enrollment_id
      FROM target_enrollments
    `,
    [job.course_id, job.tenant_id, job.last_enrollment_id, batchSize],
  );

  const row = result.rows[0];
  return {
    processed: Number(row?.processed ?? 0),
    lastEnrollmentId: row?.last_enrollment_id ?? null,
  };
}

async function updateCourseProgressRecalculationCursor(
  jobId: string,
  processed: number,
  lastEnrollmentId: string,
): Promise<void> {
  await query(
    `
      UPDATE course_progress_recalculation_jobs
      SET
        last_enrollment_id = $2,
        processed_count = processed_count + $3,
        updated_at = now()
      WHERE id = $1
    `,
    [jobId, lastEnrollmentId, processed],
  );
}

async function pauseCourseProgressRecalculationJob(jobId: string): Promise<void> {
  await query(
    `
      UPDATE course_progress_recalculation_jobs
      SET status = 'queued', updated_at = now()
      WHERE id = $1
        AND status = 'running'
    `,
    [jobId],
  );
}

async function finishCourseProgressRecalculationJob(jobId: string): Promise<boolean> {
  const result = await query<{ status: string }>(
    `
      UPDATE course_progress_recalculation_jobs
      SET
        status = CASE WHEN rerun_requested THEN 'queued' ELSE 'succeeded' END,
        last_enrollment_id = CASE WHEN rerun_requested THEN NULL ELSE last_enrollment_id END,
        processed_count = CASE WHEN rerun_requested THEN 0 ELSE processed_count END,
        rerun_requested = false,
        finished_at = CASE WHEN rerun_requested THEN NULL ELSE now() END,
        updated_at = now()
      WHERE id = $1
        AND status = 'running'
      RETURNING status
    `,
    [jobId],
  );

  return result.rows[0]?.status === 'queued';
}

export async function markCourseProgressRecalculationJobRetryable(
  jobId: string,
  error: unknown,
): Promise<void> {
  await query(
    `
      UPDATE course_progress_recalculation_jobs
      SET
        status = 'queued',
        last_error = $2,
        updated_at = now()
      WHERE id = $1
        AND status <> 'succeeded'
    `,
    [jobId, errorToMessage(error).slice(0, 2000)],
  );
}

export async function markCourseProgressRecalculationJobFailed(
  jobId: string,
  error: unknown,
): Promise<void> {
  await query(
    `
      UPDATE course_progress_recalculation_jobs
      SET
        status = 'failed',
        last_error = $2,
        finished_at = now(),
        updated_at = now()
      WHERE id = $1
        AND status <> 'succeeded'
    `,
    [jobId, errorToMessage(error).slice(0, 2000)],
  );
}

export async function runCourseProgressRecalculationJob(jobId: string): Promise<void> {
  const job = await claimCourseProgressRecalculationJob(jobId);
  if (!job) return;

  const batchSize = env.COURSE_PROGRESS_RECALC_BATCH_SIZE;

  for (let batch = 0; batch < env.COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK; batch += 1) {
    const result = await recalculateCourseProgressBatch(job, batchSize);

    if (result.processed === 0 || !result.lastEnrollmentId) {
      const shouldRunAgain = await finishCourseProgressRecalculationJob(job.id);
      if (shouldRunAgain) {
        await wakeCourseProgressRecalculationJob(job.id);
      }
      return;
    }

    await updateCourseProgressRecalculationCursor(job.id, result.processed, result.lastEnrollmentId);
    job.last_enrollment_id = result.lastEnrollmentId;
    job.processed_count += result.processed;

    if (result.processed < batchSize) {
      const shouldRunAgain = await finishCourseProgressRecalculationJob(job.id);
      if (shouldRunAgain) {
        await wakeCourseProgressRecalculationJob(job.id);
      }
      return;
    }
  }

  await pauseCourseProgressRecalculationJob(job.id);
  await wakeCourseProgressRecalculationJob(job.id);
}

export async function requeuePendingCourseProgressRecalculationJobs(limit = 100): Promise<void> {
  try {
    await query(
      `
        UPDATE course_progress_recalculation_jobs
        SET status = 'queued', updated_at = now()
        WHERE status = 'running'
          AND updated_at < now() - interval '10 minutes'
      `,
    );

    const result = await query<{ id: string }>(
      `
        SELECT id
        FROM course_progress_recalculation_jobs
        WHERE status = 'queued'
        ORDER BY requested_at ASC
        LIMIT $1
      `,
      [limit],
    );

    for (const row of result.rows) {
      await wakeCourseProgressRecalculationJob(row.id);
    }
  } catch (error) {
    if (isMissingJobTableError(error)) {
      console.warn('[course-progress-recalculation] Job table is missing; pending-job requeue skipped');
      return;
    }
    throw error;
  }
}
