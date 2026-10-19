// ═══════════════════════════════════════════════════════════════
// Course deletion repository: deletion jobs, the course and block rows they
// mark and purge, the rows linked to a course, and the reads that build the
// Storage manifest. SQL only, moved unchanged from course-deletion.service.ts,
// which keeps the rules (purge order, batching, Storage path ownership,
// warnings, leases, retries, caches, wake-ups, messages).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface CourseDeletionDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export type DeleteTargetType = 'course' | 'block';
export type DeleteJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface DeleteJobRow {
  id: string;
  tenant_id: string;
  course_id: string;
  root_block_id: string | null;
  target_type: DeleteTargetType;
  status: DeleteJobStatus;
  attempts: number;
  is_terminal: boolean;
}

export interface BlockPayloadRow {
  id: string;
  data: unknown;
  metadata: unknown;
  published_data: unknown;
  published_metadata: unknown;
}

export interface RetryableJobRow {
  course_id: string | null;
  root_block_id: string | null;
  target_type: DeleteTargetType;
  is_terminal: boolean;
}

export interface RequeuedJobRow {
  id: string;
  course_id: string;
  root_block_id: string | null;
  target_type: DeleteTargetType;
}

export interface DeleteJobStatusRow<Stats = unknown> {
  id: string;
  course_id: string | null;
  target_type: DeleteTargetType;
  status: DeleteJobStatus;
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  attempts: number;
  is_terminal: boolean;
  next_attempt_at: Date | null;
  last_error: string | null;
  stats: Stats;
}

/** Tables whose rows reference a course by course_id and are deleted in batches. */
export type CourseReferenceTable =
  | 'notifications'
  | 'study_sessions'
  | 'chat_conversations'
  | 'assignment_feedback_history'
  | 'notification_email_jobs'
  | 'lesson_author_blueprints'
  | 'lesson_author_jobs'
  | 'lesson_author_transcription_jobs'
  | 'course_mentor_assignment_history'
  | 'course_mentor_sections'
  | 'team_courses'
  | 'course_category_courses'
  | 'course_modal_configs'
  | 'course_modal_states'
  | 'section_modal_configs'
  | 'section_modal_shown'
  | 'tenant_badge_rule_courses';

export function createCourseDeletionRepository(db: CourseDeletionDb) {
  return {
    // ── Requests ──

    async lockActiveCourse(courseId: string, tenantId: string): Promise<QueryResult<{ id: string; display_name: string | null }>> {
      return db.query<{ id: string; display_name: string | null }>(
        `SELECT id, display_name
         FROM courses
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [courseId, tenantId],
      );
    },

    async lockActiveBlock(blockId: string, tenantId: string): Promise<QueryResult<{ id: string; course_id: string; block_type: string }>> {
      return db.query<{ id: string; course_id: string; block_type: string }>(
        `SELECT b.id, b.course_id, b.block_type
         FROM course_blocks b
         JOIN courses c ON c.id = b.course_id
         WHERE b.id = $1
           AND c.tenant_id = $2
           AND c.deleted_at IS NULL
           AND b.deleted_at IS NULL
         FOR UPDATE OF b`,
        [blockId, tenantId],
      );
    },

    /** Name of the outline transfer job table, or null before its SQL is applied. */
    async selectOutlineTransferTable(): Promise<string | null | undefined> {
      const result = await db.query<{ jobs: string | null }>(
        `SELECT to_regclass('public.course_outline_transfer_jobs')::text AS jobs`,
      );
      return result.rows[0]?.jobs;
    },

    /** True when a queued or running outline transfer reads or writes the course. */
    async hasActiveOutlineTransfer(tenantId: string, courseId: string): Promise<boolean | undefined> {
      const result = await db.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1
             FROM course_outline_transfer_jobs
            WHERE tenant_id = $1::uuid
              AND status IN ('queued', 'running')
              AND (source_course_id = $2 OR destination_course_id = $2)
         ) AS exists`,
        [tenantId, courseId],
      );
      return result.rows[0]?.exists;
    },

    async insertCourseJob(tenantId: string, courseId: string, requestedBy: string): Promise<string> {
      const result = await db.query<{ id: string }>(
        `INSERT INTO course_deletion_jobs (tenant_id, course_id, target_type, requested_by)
         VALUES ($1, $2, 'course', $3)
         RETURNING id`,
        [tenantId, courseId, requestedBy],
      );
      return result.rows[0].id;
    },

    async insertBlockJob(tenantId: string, courseId: string, blockId: string, requestedBy: string): Promise<string> {
      const result = await db.query<{ id: string }>(
        `INSERT INTO course_deletion_jobs (tenant_id, course_id, root_block_id, target_type, requested_by)
         VALUES ($1, $2, $3, 'block', $4)
         RETURNING id`,
        [tenantId, courseId, blockId, requestedBy],
      );
      return result.rows[0].id;
    },

    async markCourseDeleteQueued(courseId: string, tenantId: string, jobId: string, requestedBy: string): Promise<void> {
      await db.query(
        `UPDATE courses
         SET deleted_at = now(),
             delete_status = 'queued',
             delete_job_id = $3,
             deleted_by = $4,
             updated_at = now()
         WHERE id = $1 AND tenant_id = $2`,
        [courseId, tenantId, jobId, requestedBy],
      );
    },

    async markBlockDeleteQueued(blockId: string, jobId: string, requestedBy: string): Promise<void> {
      await db.query(
        `UPDATE course_blocks
         SET deleted_at = now(),
             delete_status = 'queued',
             delete_job_id = $2,
             deleted_by = $3,
             updated_at = now()
         WHERE id = $1`,
        [blockId, jobId, requestedBy],
      );
    },

    /** The block and every descendant in the course. */
    async selectBlockSubtreeIds(blockId: string, courseId: string): Promise<string[]> {
      const result = await db.query<{ id: string }>(
        `WITH RECURSIVE subtree AS (
           SELECT id
           FROM course_blocks
           WHERE id = $1 AND course_id = $2
           UNION ALL
           SELECT child.id
           FROM course_blocks child
           JOIN subtree s ON child.parent_id = s.id
           WHERE child.course_id = $2
         )
         SELECT id FROM subtree`,
        [blockId, courseId],
      );
      return result.rows.map((row) => row.id);
    },

    // ── Job state ──

    /** Claims a runnable job (queued, failed, or running with an expired lease) and leases it. */
    async markJobRunning(jobId: string, leaseSeconds: number): Promise<DeleteJobRow | null> {
      const result = await db.query<DeleteJobRow>(
        `UPDATE course_deletion_jobs
         SET status = 'running',
             attempts = attempts + 1,
             started_at = COALESCE(started_at, now()),
             lease_expires_at = now() + ($2::int * interval '1 second'),
             updated_at = now()
         WHERE id = $1
           AND is_terminal = false
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           AND (
             status IN ('queued', 'failed')
             OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
           )
         RETURNING id, tenant_id, course_id, root_block_id, target_type, status, attempts`,
        [jobId, leaseSeconds],
      );
      return result.rows[0] ?? null;
    },

    async touchJobLease(jobId: string, leaseSeconds: number): Promise<void> {
      await db.query(
        `UPDATE course_deletion_jobs
         SET lease_expires_at = now() + ($2::int * interval '1 second'), updated_at = now()
         WHERE id = $1 AND status = 'running'`,
        [jobId, leaseSeconds],
      );
    },

    async deleteManifestItems(jobId: string): Promise<void> {
      await db.query(
        `DELETE FROM deletion_storage_items
         WHERE job_kind = 'course' AND job_id = $1::uuid`,
        [jobId],
      );
    },

    async deleteManifestScanCursors(jobId: string): Promise<void> {
      await db.query(
        `DELETE FROM deletion_storage_scan_cursors
         WHERE job_kind = 'course' AND job_id = $1::uuid`,
        [jobId],
      );
    },

    /** Marks the job succeeded with its stats (JSON text) and drops its course and block ids. */
    async markJobSucceeded(jobId: string, statsJson: string): Promise<void> {
      await db.query(
        `UPDATE course_deletion_jobs
         SET status = 'succeeded',
             course_id = NULL,
             root_block_id = NULL,
             is_terminal = false,
             finished_at = now(),
             lease_expires_at = NULL,
             next_attempt_at = now(),
             updated_at = now(),
             stats = $2::jsonb,
             last_error = NULL
         WHERE id = $1`,
        [jobId, statsJson],
      );
    },

    /** Requeues a running job with backoff, or fails it for good once `maxAttempts` is reached. */
    async markJobRetryable(values: {
      jobId: string;
      message: string;
      maxAttempts: number;
      retryBaseMs: number;
      retryMaxMs: number;
    }): Promise<RetryableJobRow | undefined> {
      const result = await db.query<RetryableJobRow>(
        `UPDATE course_deletion_jobs
         SET status = CASE WHEN attempts >= $3::int THEN 'failed' ELSE 'queued' END,
             is_terminal = attempts >= $3::int,
             lease_expires_at = NULL,
             next_attempt_at = CASE
               -- Terminal jobs are filtered by is_terminal; retain a valid
               -- timestamp to conform to the NOT NULL retry schedule column.
               WHEN attempts >= $3::int THEN now()
               ELSE now() + (
                 LEAST(
                   $4::numeric * power(2::numeric, GREATEST(attempts - 1, 0)),
                   $5::numeric
                 ) * (0.75 + random() * 0.5)
               ) * interval '1 millisecond'
             END,
             last_error = $2,
             updated_at = now()
         WHERE id = $1 AND status = 'running'
         RETURNING course_id, root_block_id, target_type, is_terminal`,
        [values.jobId, values.message, values.maxAttempts, values.retryBaseMs, values.retryMaxMs],
      );
      return result.rows[0];
    },

    async markCourseDeleteFailed(courseId: string): Promise<void> {
      await db.query(
        `UPDATE courses
         SET delete_status = 'failed', updated_at = now()
         WHERE id = $1 AND deleted_at IS NOT NULL`,
        [courseId],
      );
    },

    async markBlockDeleteFailed(blockId: string): Promise<void> {
      await db.query(
        `UPDATE course_blocks
         SET delete_status = 'failed', updated_at = now()
         WHERE id = $1 AND deleted_at IS NOT NULL`,
        [blockId],
      );
    },

    /** Jobs the sweeper wakes up: runnable and not terminal, oldest first. */
    async selectRunnableJobIds(limit: number): Promise<string[]> {
      const result = await db.query<{ id: string }>(
        `SELECT id
         FROM course_deletion_jobs
         WHERE is_terminal = false
           AND (
             (status IN ('queued', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
             OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
           )
         ORDER BY requested_at ASC
         LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => row.id);
    },

    /** Requeues a terminal job of the tenant that still has its course, with a fresh retry budget. */
    async requeueTerminalJob(jobId: string, tenantId: string): Promise<RequeuedJobRow | undefined> {
      const result = await db.query<RequeuedJobRow>(
        `UPDATE course_deletion_jobs
         SET status = 'queued',
             is_terminal = false,
             attempts = 0,
             started_at = NULL,
             finished_at = NULL,
             next_attempt_at = now(),
             lease_expires_at = NULL,
             last_error = NULL,
             updated_at = now()
         WHERE id = $1::uuid
           AND tenant_id = $2::uuid
           AND is_terminal = true
           AND course_id IS NOT NULL
         RETURNING id, course_id, root_block_id, target_type`,
        [jobId, tenantId],
      );
      return result.rows[0];
    },

    async markCourseDeleteRequeued(courseId: string, tenantId: string): Promise<void> {
      await db.query(
        `UPDATE courses
         SET delete_status = 'queued', updated_at = now()
         WHERE id = $1::varchar AND tenant_id = $2::uuid AND deleted_at IS NOT NULL`,
        [courseId, tenantId],
      );
    },

    async markBlockDeleteRequeued(blockId: string, courseId: string): Promise<void> {
      await db.query(
        `UPDATE course_blocks
         SET delete_status = 'queued', updated_at = now()
         WHERE id = $1::uuid AND course_id = $2::varchar AND deleted_at IS NOT NULL`,
        [blockId, courseId],
      );
    },

    async selectJobStatus<Stats>(jobId: string, tenantId: string): Promise<QueryResult<DeleteJobStatusRow<Stats>>> {
      return db.query<DeleteJobStatusRow<Stats>>(
        `SELECT id, course_id, target_type, status, requested_at, started_at, finished_at, attempts,
                is_terminal, next_attempt_at, last_error, stats
         FROM course_deletion_jobs
         WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [jobId, tenantId],
      );
    },

    // ── Retained Storage reference warnings ──

    async selectWarnings(jobId: string): Promise<unknown> {
      const result = await db.query<{ warnings: unknown }>(
        `SELECT stats -> 'warnings' AS warnings
         FROM course_deletion_jobs
         WHERE id = $1::uuid`,
        [jobId],
      );
      return result.rows[0]?.warnings;
    },

    /** Stores the warnings (JSON text) in stats.warnings of a running job. */
    async saveWarnings(jobId: string, warningsJson: string): Promise<void> {
      await db.query(
        `UPDATE course_deletion_jobs
         SET stats = jsonb_set(COALESCE(stats, '{}'::jsonb), '{warnings}', $2::jsonb, true),
             updated_at = now()
         WHERE id = $1::uuid AND status = 'running'`,
        [jobId, warningsJson],
      );
    },

    // ── Storage manifest reads ──

    async selectManifestCompletedAt(jobId: string): Promise<Date | null | undefined> {
      const result = await db.query<{ manifest_completed_at: Date | null }>(
        `SELECT manifest_completed_at
         FROM course_deletion_jobs
         WHERE id = $1::uuid`,
        [jobId],
      );
      return result.rows[0]?.manifest_completed_at;
    },

    async markManifestCompleted(jobId: string): Promise<void> {
      await db.query(
        `UPDATE course_deletion_jobs
         SET manifest_completed_at = now(), updated_at = now()
         WHERE id = $1::uuid AND status = 'running'`,
        [jobId],
      );
    },

    async selectCourseImage(courseId: string, tenantId: string): Promise<QueryResult<{ image_url: string | null }>> {
      return db.query<{ image_url: string | null }>(
        `SELECT image_url FROM courses WHERE id = $1 AND tenant_id = $2`,
        [courseId, tenantId],
      );
    },

    async selectMentorLogos(courseId: string, tenantId: string): Promise<{ logo_light_path: string | null; logo_dark_path: string | null } | undefined> {
      const result = await db.query<{ logo_light_path: string | null; logo_dark_path: string | null }>(
        `SELECT logo_light_path, logo_dark_path
         FROM course_mentor_sections
         WHERE course_id = $1 AND tenant_id = $2`,
        [courseId, tenantId],
      );
      return result.rows[0];
    },

    async transcriptionJobsTableExists(): Promise<boolean | undefined> {
      const result = await db.query<{ exists: boolean }>(
        `SELECT to_regclass('public.lesson_author_transcription_jobs') IS NOT NULL AS exists`,
      );
      return result.rows[0]?.exists;
    },

    async selectTranscriptionPaths(tenantId: string, courseId: string): Promise<{ source_storage_path: string | null; transcript_storage_path: string | null }[]> {
      const result = await db.query<{ source_storage_path: string | null; transcript_storage_path: string | null }>(
        `SELECT source_storage_path, transcript_storage_path
         FROM lesson_author_transcription_jobs
         WHERE tenant_id = $1::uuid
           AND course_id = $2
           AND status IN ('queued', 'running', 'succeeded', 'failed', 'committed')`,
        [tenantId, courseId],
      );
      return result.rows;
    },

    async selectCourseAssetPaths(tenantId: string, courseId: string): Promise<{ storage_path: string | null; url: string | null }[]> {
      const result = await db.query<{ storage_path: string | null; url: string | null }>(
        `SELECT storage_path, url FROM course_assets WHERE tenant_id = $1 AND course_id = $2`,
        [tenantId, courseId],
      );
      return result.rows;
    },

    /** Keyset page of the course's assets after `afterId` (a UUID). */
    async selectCourseAssetPage(tenantId: string, courseId: string, afterId: string, limit: number): Promise<QueryResult<{ id: string; storage_path: string | null; url: string | null }>> {
      return db.query<{ id: string; storage_path: string | null; url: string | null }>(
        `SELECT id, storage_path, url
         FROM course_assets
         WHERE tenant_id = $1 AND course_id = $2 AND id > $3::uuid
         ORDER BY id
         LIMIT $4`,
        [tenantId, courseId, afterId, limit],
      );
    },

    /** Keyset page of the course's block payloads after `afterId` (a UUID). */
    async selectBlockPayloadPage(courseId: string, afterId: string, limit: number): Promise<QueryResult<BlockPayloadRow>> {
      return db.query<BlockPayloadRow>(
        `SELECT id, data, metadata, published_data, published_metadata
         FROM course_blocks
         WHERE course_id = $1 AND id > $2::uuid
         ORDER BY id
         LIMIT $3`,
        [courseId, afterId, limit],
      );
    },

    /** Keyset page of the course's assignment attachments after `afterId` (a UUID). */
    async selectAssignmentAttachmentPage(courseId: string, afterId: string, limit: number): Promise<QueryResult<{ id: string; storage_path: string | null }>> {
      return db.query<{ id: string; storage_path: string | null }>(
        `SELECT id, attachment_file ->> 'storage_path' AS storage_path
         FROM course_assignments
         WHERE course_id = $1 AND id > $2::uuid
         ORDER BY id
         LIMIT $3`,
        [courseId, afterId, limit],
      );
    },

    /** Keyset page of the course's submission files after `afterId` (a UUID). */
    async selectAssignmentFilePage(courseId: string, afterId: string, limit: number): Promise<QueryResult<{ id: string; storage_path: string }>> {
      return db.query<{ id: string; storage_path: string }>(
        `SELECT id, storage_path
         FROM assignment_files
         WHERE course_id = $1 AND id > $2::uuid
         ORDER BY id
         LIMIT $3`,
        [courseId, afterId, limit],
      );
    },

    // ── Purge ──

    async selectCourseAssetsByPaths(tenantId: string, courseId: string, paths: string[]): Promise<{ storage_path: string | null; url: string | null }[]> {
      const result = await db.query<{ storage_path: string | null; url: string | null }>(
        `SELECT storage_path, url
         FROM course_assets
         WHERE tenant_id = $1
           AND course_id = $2
           AND (storage_path = ANY($3::text[]) OR url = ANY($3::text[]))`,
        [tenantId, courseId, paths],
      );
      return result.rows;
    },

    async deleteCourseAssetsByPaths(tenantId: string, courseId: string, paths: string[]): Promise<number | null> {
      const result = await db.query(
        `DELETE FROM course_assets
         WHERE tenant_id = $1
           AND course_id = $2
           AND (storage_path = ANY($3::text[]) OR url = ANY($3::text[]))`,
        [tenantId, courseId, paths],
      );
      return result.rowCount;
    },

    async selectCourseAssetIdBatch(tenantId: string, courseId: string, limit: number): Promise<QueryResult<{ id: string }>> {
      return db.query<{ id: string }>(
        `SELECT id
         FROM course_assets
         WHERE tenant_id = $1 AND course_id = $2
         LIMIT $3`,
        [tenantId, courseId, limit],
      );
    },

    async deleteCourseAssetsByIds(ids: string[]): Promise<number | null> {
      const result = await db.query(
        `DELETE FROM course_assets WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      return result.rowCount;
    },

    async deleteAllCourseBlocks(courseId: string): Promise<number | null> {
      const result = await db.query(
        `DELETE FROM course_blocks
         WHERE course_id = $1`,
        [courseId],
      );
      return result.rowCount;
    },

    /** Deletes up to `limit` leaf blocks of the subtree under the root and returns their payloads. */
    async deleteLeafBlockBatch(rootBlockId: string, courseId: string, limit: number): Promise<QueryResult<BlockPayloadRow>> {
      return db.query<BlockPayloadRow>(
        `WITH RECURSIVE subtree AS (
           SELECT id FROM course_blocks WHERE id = $1 AND course_id = $2
           UNION ALL
           SELECT child.id
           FROM course_blocks child
           JOIN subtree s ON child.parent_id = s.id
           WHERE child.course_id = $2
         ),
         doomed AS (
           SELECT b.id
           FROM course_blocks b
           JOIN subtree s ON s.id = b.id
           WHERE NOT EXISTS (
             SELECT 1 FROM course_blocks child WHERE child.parent_id = b.id
           )
           LIMIT $3
         )
         DELETE FROM course_blocks b
         USING doomed
         WHERE b.id = doomed.id
         RETURNING b.id, b.data, b.metadata, b.published_data, b.published_metadata`,
        [rootBlockId, courseId, limit],
      );
    },

    async deleteSectionModalConfigs(courseId: string, sectionIds: string[]): Promise<number | null> {
      const result = await db.query(
        `DELETE FROM section_modal_configs
         WHERE course_id = $1 AND section_id = ANY($2::text[])`,
        [courseId, sectionIds],
      );
      return result.rowCount;
    },

    async deleteSectionModalShown(courseId: string, sectionIds: string[]): Promise<number | null> {
      const result = await db.query(
        `DELETE FROM section_modal_shown
         WHERE course_id = $1 AND section_id = ANY($2::text[])`,
        [courseId, sectionIds],
      );
      return result.rowCount;
    },

    async deleteEnrollmentBatch(tenantId: string, courseId: string, limit: number): Promise<number | null> {
      const result = await db.query<{ id: string }>(
        `WITH doomed AS (
           SELECT id
           FROM enrollments
           WHERE tenant_id = $1 AND course_id = $2
           LIMIT $3
         )
         DELETE FROM enrollments e
         USING doomed
         WHERE e.id = doomed.id
         RETURNING e.id`,
        [tenantId, courseId, limit],
      );
      return result.rowCount;
    },

    /** to_regclass of a schema-qualified table name. */
    async tableExists(qualifiedName: string): Promise<boolean> {
      const result = await db.query<{ exists: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [qualifiedName],
      );
      return Boolean(result.rows[0]?.exists);
    },

    /** `tableName` is one of CourseReferenceTable (a code constant), never request data. */
    async deleteCourseReferenceBatch(tableName: CourseReferenceTable, courseId: string, limit: number): Promise<number | null> {
      const result = await db.query(
        `WITH doomed AS (
           SELECT ctid
           FROM ${tableName}
           WHERE course_id = $1
           LIMIT $2
         )
         DELETE FROM ${tableName} t
         USING doomed
         WHERE t.ctid = doomed.ctid`,
        [courseId, limit],
      );
      return result.rowCount;
    },

    /** Outbox mails of the course's submissions and notifications, in batches. */
    async deleteCourseOutboxBatch(courseId: string, limit: number): Promise<number | null> {
      const result = await db.query(
        `WITH doomed AS (
           SELECT outbox.ctid
           FROM email_outbox outbox
           WHERE outbox.related_submission_id IN (
                   SELECT id FROM assignment_submissions WHERE course_id = $1
                 )
              OR outbox.related_notification_id IN (
                   SELECT id FROM notifications WHERE course_id = $1
                 )
           LIMIT $2
         )
         DELETE FROM email_outbox outbox
         USING doomed
         WHERE outbox.ctid = doomed.ctid`,
        [courseId, limit],
      );
      return result.rowCount;
    },

    async markCourseDeleteRunning(courseId: string, tenantId: string): Promise<void> {
      await db.query(
        `UPDATE courses
         SET delete_status = 'running', updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL`,
        [courseId, tenantId],
      );
    },

    async courseExists(courseId: string, tenantId: string): Promise<boolean> {
      const result = await db.query<{ id: string }>(
        `SELECT id FROM courses WHERE id = $1 AND tenant_id = $2`,
        [courseId, tenantId],
      );
      return result.rowCount !== 0;
    },

    /** Removes the course's personal data from backup tables (SQL function); returns the rows deleted. */
    async purgeCourseBackupPii(courseId: string): Promise<number> {
      const result = await db.query<{ deleted: number }>(
        `SELECT public.purge_course_backup_pii($1::text) AS deleted`,
        [courseId],
      );
      return Number(result.rows[0]?.deleted || 0);
    },

    async deleteCourse(courseId: string, tenantId: string): Promise<number | null> {
      const result = await db.query(
        `DELETE FROM courses
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL`,
        [courseId, tenantId],
      );
      return result.rowCount;
    },

    async markBlockDeleteRunning(blockId: string): Promise<void> {
      await db.query(
        `UPDATE course_blocks
         SET delete_status = 'running', updated_at = now()
         WHERE id = $1 AND deleted_at IS NOT NULL`,
        [blockId],
      );
    },
  };
}

export type CourseDeletionRepository = ReturnType<typeof createCourseDeletionRepository>;
