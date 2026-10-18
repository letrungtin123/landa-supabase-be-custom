// ═══════════════════════════════════════════════════════════════
// Learner progress repository: enrollments, self-enrollment, block
// completions, course progress and the shown flag of earned badges. SQL
// only; moved unchanged from learner.service.ts, which keeps the rules
// (demo accounts, access, what to recalculate and invalidate).
// ═══════════════════════════════════════════════════════════════

import type { LearnerDb } from './learner-courses.repository.js';
import type { ActiveBlockCompletionRow } from './learner-completion.logic.js';

/** Timestamps are typed as the answer types them: pg's Date reaches the client as ISO text. */
export interface LearnerEnrollmentRow {
  id: string;
  course_id: string;
  enrolled_at: string;
  is_active: boolean;
  display_name: string;
  image_url: string | null;
  org: string | null;
  progress: string;
  is_completed: boolean;
  completed_at: string | null;
  last_activity_at: string | null;
}

export interface CourseProgressRow {
  progress: string;
  is_completed: boolean;
  completed_at: string | null;
  last_activity_at: string | null;
}

export interface BatchProgressRow {
  course_id: string;
  progress: string;
  is_completed: boolean;
  completed_at: string | null;
}

export function createLearnerProgressRepository(db: LearnerDb) {
  return {
    /** The user's active enrollments of the tenant (course not deleted) with their progress, newest first. */
    async selectEnrollments(userId: string, tenantId: string): Promise<LearnerEnrollmentRow[]> {
      const result = await db.query<LearnerEnrollmentRow>(
        `SELECT e.id, e.course_id, e.enrolled_at, e.is_active,
            c.display_name, c.image_url, c.org,
            COALESCE(cp.progress, 0) AS progress,
            COALESCE(cp.is_completed, false) AS is_completed,
            cp.completed_at, cp.last_activity_at
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE e.user_id = $1 AND e.tenant_id = $2 AND e.is_active = true AND c.deleted_at IS NULL
     ORDER BY e.enrolled_at DESC`,
        [userId, tenantId],
      );
      return result.rows;
    },

    /** The user's enrollment of the course in the tenant, active or not. */
    async findEnrollment(userId: string, courseId: string, tenantId: string): Promise<{ id: string; is_active: boolean } | undefined> {
      const existing = await db.query<{ id: string; is_active: boolean }>(
        'SELECT id, is_active FROM enrollments WHERE user_id = $1 AND course_id = $2 AND tenant_id = $3',
        [userId, courseId, tenantId],
      );
      return existing.rowCount! > 0 ? existing.rows[0] : undefined;
    },

    async reactivateEnrollment(enrollmentId: string): Promise<void> {
      await db.query<Record<string, unknown>>('UPDATE enrollments SET is_active = true WHERE id = $1', [enrollmentId]);
    },

    /** A new enrollment with its empty progress row; returns the enrollment id. */
    async createEnrollment(userId: string, courseId: string, tenantId: string): Promise<string> {
      const result = await db.query<{ id: string }>(
        `INSERT INTO enrollments (user_id, course_id, tenant_id) VALUES ($1, $2, $3) RETURNING id`,
        [userId, courseId, tenantId],
      );
      const enrollmentId = result.rows[0].id;

      await db.query<Record<string, unknown>>(
        'INSERT INTO course_progress (enrollment_id) VALUES ($1)',
        [enrollmentId],
      );
      return enrollmentId;
    },

    /** Moves "last activity" of the enrollment, at most once per 5 minutes. */
    async touchLastActivity(enrollmentId: string): Promise<void> {
      await db.query<Record<string, unknown>>(
        `UPDATE course_progress
     SET last_activity_at = now()
     WHERE enrollment_id = $1::uuid
       AND (last_activity_at IS NULL OR last_activity_at < now() - interval '5 minutes')`,
        [enrollmentId],
      );
    },

    /** The user's active enrollment of the course (course not deleted). */
    async findActiveEnrollmentId(userId: string, courseId: string): Promise<string | undefined> {
      const enrollment = await db.query<{ id: string }>(
        `SELECT e.id
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     WHERE e.user_id = $1
       AND e.course_id = $2
       AND e.is_active = true
       AND c.deleted_at IS NULL
     LIMIT 1`,
        [userId, courseId],
      );
      return enrollment.rowCount === 0 ? undefined : enrollment.rows[0].id;
    },

    /**
     * The requested blocks that are live, published leaf blocks of the
     * course (no deleted ancestor), each with whether the enrollment
     * already completed it.
     */
    async selectActiveBlocks(courseId: string, blockIds: string[], enrollmentId: string): Promise<ActiveBlockCompletionRow[]> {
      const activeBlocks = await db.query<ActiveBlockCompletionRow>(
        `WITH RECURSIVE ancestors AS (
       SELECT id AS root_id, id, parent_id, deleted_at
       FROM course_blocks
       WHERE id = ANY($2::uuid[])
       UNION ALL
       SELECT a.root_id, parent.id, parent.parent_id, parent.deleted_at
       FROM course_blocks parent
       JOIN ancestors a ON parent.id = a.parent_id
     )
     SELECT b.id,
            EXISTS (
              SELECT 1
              FROM block_completions bc
              WHERE bc.enrollment_id = $3::uuid
                AND bc.block_id = b.id
            ) AS completed
     FROM course_blocks b
     WHERE b.course_id = $1
       AND b.id = ANY($2::uuid[])
       AND b.is_published = true
       AND b.deleted_at IS NULL
       AND b.block_type NOT IN ('course','chapter','sequential','vertical')
       AND NOT EXISTS (
         SELECT 1
         FROM ancestors a
         WHERE a.root_id = b.id
           AND a.deleted_at IS NOT NULL
       )`,
        [courseId, blockIds, enrollmentId],
      );
      return activeBlocks.rows;
    },

    /** Inserts the completions not there yet; returns how many were inserted. */
    async insertBlockCompletions(enrollmentId: string, blockIds: string[]): Promise<number> {
      const inserted = await db.query<{ block_id: string }>(
        `INSERT INTO block_completions (enrollment_id, block_id)
     SELECT $1::uuid, block_id
     FROM unnest($2::uuid[]) AS requested(block_id)
     ON CONFLICT DO NOTHING
     RETURNING block_id`,
        [enrollmentId, blockIds],
      );
      return inserted.rowCount ?? inserted.rows.length;
    },

    /** The progress of the user's active enrollment of the course (course not deleted). */
    async selectProgress(userId: string, courseId: string): Promise<CourseProgressRow | undefined> {
      const result = await db.query<CourseProgressRow>(
        `SELECT cp.progress, cp.is_completed, cp.completed_at, cp.last_activity_at
     FROM course_progress cp
     JOIN enrollments e ON e.id = cp.enrollment_id
     JOIN courses c ON c.id = e.course_id
     WHERE e.user_id = $1 AND e.course_id = $2 AND e.is_active = true
       AND c.deleted_at IS NULL
     LIMIT 1`,
        [userId, courseId],
      );
      return result.rowCount === 0 ? undefined : result.rows[0];
    },

    /** The progress of the user's active enrollments of these courses in the tenant. */
    async selectBatchProgress(userId: string, tenantId: string, courseIds: string[]): Promise<BatchProgressRow[]> {
      const result = await db.query<BatchProgressRow>(
        `SELECT e.course_id,
            COALESCE(cp.progress, 0) AS progress,
            COALESCE(cp.is_completed, false) AS is_completed,
            cp.completed_at
     FROM enrollments e
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE e.user_id = $1
       AND e.tenant_id = $2
       AND e.course_id = ANY($3)
       AND e.is_active = true`,
        [userId, tenantId, courseIds],
      );
      return result.rows;
    },

    async setBadgeShown(userId: string, badgeId: string, isShown: boolean): Promise<void> {
      await db.query<Record<string, unknown>>(
        'UPDATE user_badges SET is_shown = $1 WHERE user_id = $2 AND badge_id = $3',
        [isShown, userId, badgeId],
      );
    },
  };
}

export type LearnerProgressRepository = ReturnType<typeof createLearnerProgressRepository>;
