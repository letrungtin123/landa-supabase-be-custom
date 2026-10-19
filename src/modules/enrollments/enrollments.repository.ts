// ═══════════════════════════════════════════════════════════════
// Enrollments repository: enroll, bulk enroll, unenroll, progress, study
// sessions and the study time series, and the enrollment lists of a user
// and of a course. SQL only; moved unchanged from enrollments.service.ts,
// which keeps the rules (who may be enrolled, demo iframe lock, date
// ranges, caches, progress recalculation).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface EnrollmentsDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Enrollment {
  id: string;
  user_id: string;
  course_id: string;
  tenant_id: string;
  enrolled_at: string;
  is_active: boolean;
  progress: number;
  is_completed: boolean;
  completed_at: string | null;
  last_activity_at: string | null;
}

export interface EnrollmentWithUser extends Enrollment {
  username: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
}

export interface EnrollmentWithCourse extends Enrollment {
  course_name: string;
  course_image: string | null;
}

/** One bucket of the study time series, both as text. */
export interface StudyTimeBucketRow {
  date: string;
  minutes: string;
}

export interface StudySessionEntryInput {
  study_date: string;
  minutes: number;
  course_id: string | null;
}

export type CourseEnrollmentStatus = 'all' | 'not_started' | 'learning' | 'completed';

/** Only learner accounts of the course's own tenant can be enrolled (`u` = users). */
function enrollableLearnerSql(tenantParam: '$2' | '$3'): string {
  return `u.tenant_id = ${tenantParam}::uuid
         AND u.role IN ('learner', 'learner_plus')
         AND u.deletion_requested_at IS NULL`;
}

export function createEnrollmentsRepository(db: EnrollmentsDb) {
  return {
    /** Learner display name and course name for audit entries (tenant-scoped); undefined when either is missing. */
    async selectAuditContext(
      userId: string,
      courseId: string,
      tenantId: string,
    ): Promise<{ username: string; course_name: string } | undefined> {
      const result = await db.query<{
        username: string;
        course_name: string;
      }>(
        `SELECT COALESCE(NULLIF(u.full_name, ''), u.username, u.email, u.id::text) AS username,
            c.display_name AS course_name
     FROM users u
     JOIN courses c ON c.id = $2 AND c.tenant_id = $3 AND c.deleted_at IS NULL
     WHERE u.id = $1 AND u.tenant_id = $3`,
        [userId, courseId, tenantId],
      );
      return result.rows[0];
    },

    async selectCourseName(courseId: string, tenantId: string): Promise<{ display_name: string } | undefined> {
      const result = await db.query<{ display_name: string }>(
        `SELECT display_name FROM courses WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [courseId, tenantId],
      );
      return result.rows[0];
    },

    /** Whether the user is an enrollable learner of the tenant. */
    async isEnrollableLearner(userId: string, tenantId: string): Promise<boolean> {
      const result = await db.query(
        `SELECT 1
     FROM users u
     WHERE u.id = $1::uuid
       AND ${enrollableLearnerSql('$2')}`,
        [userId, tenantId],
      );
      return result.rowCount !== 0;
    },

    /** The user's enrollment in the course (active or not). */
    async selectEnrollment(
      userId: string,
      courseId: string,
      tenantId: string,
    ): Promise<{ id: string; is_active: boolean } | undefined> {
      const existing = await db.query<{ id: string; is_active: boolean }>(
        `SELECT id, is_active FROM enrollments WHERE user_id = $1 AND course_id = $2 AND tenant_id = $3`,
        [userId, courseId, tenantId],
      );
      return existing.rowCount && existing.rowCount > 0 ? existing.rows[0] : undefined;
    },

    async reactivateEnrollment(enrollmentId: string): Promise<void> {
      await db.query(
        `UPDATE enrollments SET is_active = true WHERE id = $1 AND is_active = false`,
        [enrollmentId],
      );
    },

    /** Creates the enrollment and its progress row in one statement; the new enrollment id. */
    async insertEnrollmentWithProgress(userId: string, courseId: string, tenantId: string): Promise<string> {
      const result = await db.query<{ id: string }>(
        `WITH new_enrollment AS (
       INSERT INTO enrollments (user_id, course_id, tenant_id)
       VALUES ($1, $2, $3)
       RETURNING id
     )
     INSERT INTO course_progress (enrollment_id)
     SELECT id FROM new_enrollment
     RETURNING (SELECT id FROM new_enrollment) AS id`,
        [userId, courseId, tenantId],
      );
      return result.rows[0].id;
    },

    /**
     * Enrolls the enrollable learners among `userIds` (reactivating inactive
     * enrollments) in one statement; the counts, or undefined without a row.
     */
    async bulkEnroll(
      userIds: string[],
      courseId: string,
      tenantId: string,
    ): Promise<{ inserted_count: number; reactivated_count: number } | undefined> {
      const result = await db.query<{ inserted_count: number; reactivated_count: number }>(
        `WITH requested_users AS (
       -- Users of another tenant and non-learner accounts are skipped.
       SELECT DISTINCT r.uid
       FROM unnest($1::uuid[]) AS r(uid)
       JOIN users u ON u.id = r.uid
       WHERE ${enrollableLearnerSql('$3')}
     ),
     reactivated AS (
       UPDATE enrollments e
       SET is_active = true
       FROM requested_users ru
       WHERE e.user_id = ru.uid
         AND e.course_id = $2
         AND e.tenant_id = $3
         AND e.is_active = false
       RETURNING e.id
     ),
     to_enroll AS (
       INSERT INTO enrollments (user_id, course_id, tenant_id)
       SELECT ru.uid, $2, $3
       FROM requested_users ru
       WHERE NOT EXISTS (
         SELECT 1
         FROM enrollments e
         WHERE e.user_id = ru.uid
           AND e.course_id = $2
           AND e.tenant_id = $3
       )
       RETURNING id
     ),
     inserted_progress AS (
       INSERT INTO course_progress (enrollment_id)
       SELECT id FROM to_enroll
       ON CONFLICT (enrollment_id) DO NOTHING
       RETURNING enrollment_id
     )
     SELECT
       (SELECT COUNT(*)::int FROM to_enroll) AS inserted_count,
       (SELECT COUNT(*)::int FROM reactivated) AS reactivated_count`,
        [userIds, courseId, tenantId],
      );
      return result.rows[0];
    },

    /** Deactivates the active enrollment; the number of rows changed. */
    async deactivateEnrollment(userId: string, courseId: string, tenantId: string): Promise<number> {
      const result = await db.query(
        `UPDATE enrollments
     SET is_active = false
     WHERE user_id = $1 AND course_id = $2 AND tenant_id = $3::uuid AND is_active = true`,
        [userId, courseId, tenantId],
      );
      return result.rowCount ?? 0;
    },

    /** Progress of the active enrollment, row-locked (FOR UPDATE OF cp) until commit. */
    async lockProgress(userId: string, courseId: string, tenantId: string): Promise<{ progress: number } | undefined> {
      const current = await db.query<{ progress: number }>(
        `SELECT cp.progress
     FROM course_progress cp
     JOIN enrollments e ON e.id = cp.enrollment_id
     WHERE e.user_id = $1 AND e.course_id = $2 AND e.tenant_id = $3::uuid AND e.is_active = true
     FOR UPDATE OF cp`,
        [userId, courseId, tenantId],
      );
      return current.rows[0];
    },

    /** Sets the progress of the active enrollment; the new progress row (undefined when none) and rowCount. */
    async updateProgress(
      userId: string,
      courseId: string,
      tenantId: string,
      progress: number,
      isCompleted: boolean,
    ): Promise<{ row: { progress: number } | undefined; rowCount: number }> {
      const result = await db.query<{ progress: number }>(
        `UPDATE course_progress cp SET
       progress = $4,
       is_completed = $5,
       completed_at = CASE WHEN $5 AND cp.completed_at IS NULL THEN now() ELSE cp.completed_at END,
       last_activity_at = now()
     FROM enrollments e
     WHERE cp.enrollment_id = e.id
       AND e.user_id = $1
       AND e.course_id = $2
       AND e.tenant_id = $3::uuid
       AND e.is_active = true
     RETURNING cp.progress`,
        [userId, courseId, tenantId, progress, isCompleted],
      );
      return { row: result.rows[0], rowCount: result.rowCount ?? 0 };
    },

    /** One study session per user and day: a later end extends the day's session. */
    async upsertStudySession(
      userId: string,
      courseId: string | null,
      tenantId: string,
      start: Date,
      endedAt: Date,
      studyDate: string,
    ): Promise<void> {
      await db.query(
        `INSERT INTO study_sessions (user_id, course_id, tenant_id, started_at, ended_at, study_date)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, study_date)
     DO UPDATE SET
       ended_at = GREATEST(study_sessions.ended_at, EXCLUDED.ended_at)`,
        [userId, courseId, tenantId, start, endedAt, studyDate],
      );
    },

    /** Upserts one session per entry day; the number of rows written, as text (undefined without a row). */
    async upsertStudySessionEntries(
      userId: string,
      tenantId: string,
      entries: StudySessionEntryInput[],
    ): Promise<{ synced: string } | undefined> {
      const result = await db.query<{ synced: string }>(
        `WITH input AS (
       SELECT x.study_date::DATE AS study_date,
              GREATEST(0, LEAST(1440, x.minutes))::INT AS duration_minutes,
              NULLIF(x.course_id, '')::VARCHAR AS course_id
       FROM jsonb_to_recordset($3::jsonb) AS x(study_date DATE, minutes INT, course_id TEXT)
       WHERE x.study_date IS NOT NULL AND x.minutes > 0
     ),
     normalized AS (
       SELECT $1::UUID AS user_id,
              $2::UUID AS tenant_id,
              course_id,
              study_date,
              (study_date::TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh') AS started_at,
              (study_date::TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')
                + (duration_minutes || ' minutes')::INTERVAL AS ended_at
       FROM input
     ),
     upserted AS (
       INSERT INTO study_sessions (user_id, course_id, tenant_id, started_at, ended_at, study_date)
       SELECT user_id, course_id, tenant_id, started_at, ended_at, study_date
       FROM normalized
       ON CONFLICT (user_id, study_date)
       DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         course_id = COALESCE(EXCLUDED.course_id, study_sessions.course_id),
         started_at = LEAST(study_sessions.started_at, EXCLUDED.started_at),
         ended_at = GREATEST(COALESCE(study_sessions.ended_at, EXCLUDED.ended_at), EXCLUDED.ended_at)
       RETURNING 1
     )
     SELECT COUNT(*)::TEXT AS synced FROM upserted`,
        [userId, tenantId, JSON.stringify(entries)],
      );
      return result.rows[0];
    },

    /** Minutes per calendar month of [from, to] (`params` = user, from, to, tenant). */
    async selectStudyMinutesByMonth(params: unknown[]): Promise<StudyTimeBucketRow[]> {
      const result = await db.query<StudyTimeBucketRow>(
        `WITH bounds AS (
         SELECT $2::DATE AS from_date, $3::DATE AS to_date
       ),
       months AS (
         SELECT generate_series(
           date_trunc('month', from_date)::DATE,
           date_trunc('month', to_date)::DATE,
           '1 month'
         )::DATE AS bucket
         FROM bounds
       )
       SELECT months.bucket::TEXT AS date,
              COALESCE(SUM(ss.duration_minutes), 0)::TEXT AS minutes
       FROM months
       LEFT JOIN study_sessions ss
         ON ss.user_id = $1
        AND ss.tenant_id = $4
        AND ss.study_date >= months.bucket
        AND ss.study_date < (months.bucket + INTERVAL '1 month')
        AND ss.study_date >= (SELECT from_date FROM bounds)
        AND ss.study_date <= (SELECT to_date FROM bounds)
       GROUP BY months.bucket
       ORDER BY months.bucket`,
        params,
      );
      return result.rows;
    },

    /** Minutes per calendar year of [from, to] (`params` = user, from, to, tenant). */
    async selectStudyMinutesByYear(params: unknown[]): Promise<StudyTimeBucketRow[]> {
      const result = await db.query<StudyTimeBucketRow>(
        `WITH bounds AS (
         SELECT $2::DATE AS from_date, $3::DATE AS to_date
       ),
       years AS (
         SELECT generate_series(
           date_trunc('year', from_date)::DATE,
           date_trunc('year', to_date)::DATE,
           '1 year'
         )::DATE AS bucket
         FROM bounds
       )
       SELECT years.bucket::TEXT AS date,
              COALESCE(SUM(ss.duration_minutes), 0)::TEXT AS minutes
       FROM years
       LEFT JOIN study_sessions ss
         ON ss.user_id = $1
        AND ss.tenant_id = $4
        AND ss.study_date >= years.bucket
        AND ss.study_date < (years.bucket + INTERVAL '1 year')
        AND ss.study_date >= (SELECT from_date FROM bounds)
        AND ss.study_date <= (SELECT to_date FROM bounds)
       GROUP BY years.bucket
       ORDER BY years.bucket`,
        params,
      );
      return result.rows;
    },

    /** Minutes per day of [from, to] (`params` = user, from, to, tenant). */
    async selectStudyMinutesByDay(params: unknown[]): Promise<StudyTimeBucketRow[]> {
      // Cast ::TEXT tránh pg driver serialize DATE thành JS Date (bị lệch timezone)
      const result = await db.query<StudyTimeBucketRow>(
        `WITH bounds AS (
       SELECT $2::DATE AS from_date, $3::DATE AS to_date
     )
     SELECT g::DATE::TEXT AS date,
            COALESCE(SUM(ss.duration_minutes), 0)::TEXT AS minutes
     FROM bounds, generate_series(bounds.from_date, bounds.to_date, '1 day') AS g
     LEFT JOIN study_sessions ss
       ON ss.study_date = g::DATE
      AND ss.user_id = $1
      AND ss.tenant_id = $4
     GROUP BY g
     ORDER BY g`,
        params,
      );
      return result.rows;
    },

    /**
     * The user's active enrollments of the tenant (course not deleted),
     * newest first, and their count. The count statement is sent exactly as
     * before: with a search it names $5 but receives three parameters.
     */
    async selectUserEnrollmentPage(
      userId: string,
      tenantId: string,
      pageSize: number,
      offset: number,
      search: string,
    ): Promise<{ countRow: { count: string } | undefined; rows: EnrollmentWithCourse[] }> {
      const searchFilter = search ? `AND c.display_name ILIKE '%' || $5 || '%'` : '';
      const params: unknown[] = [userId, tenantId, pageSize, offset];
      if (search) params.push(search);

      const countResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id AND c.deleted_at IS NULL
     WHERE e.user_id = $1 AND e.tenant_id = $2 AND e.is_active = true ${searchFilter}`,
        params.slice(0, search ? 5 : 4).filter((_, i) => i < 2 || i === 4),
      );

      const dataResult = await db.query<EnrollmentWithCourse>(
        `SELECT e.id, e.user_id, e.course_id, e.tenant_id, e.enrolled_at, e.is_active,
            COALESCE(cp.progress, 0) AS progress,
            COALESCE(cp.is_completed, false) AS is_completed,
            cp.completed_at, cp.last_activity_at,
            c.display_name AS course_name, c.image_url AS course_image
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id AND c.deleted_at IS NULL
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE e.user_id = $1 AND e.tenant_id = $2 AND e.is_active = true ${searchFilter}
     ORDER BY e.enrolled_at DESC
     LIMIT $3 OFFSET $4`,
        params,
      );

      return { countRow: countResult.rows[0], rows: dataResult.rows };
    },

    /** The course's active enrollments of tenant learners, newest first, and their count. */
    async selectCourseEnrollmentPage(
      courseId: string,
      tenantId: string,
      pageSize: number,
      offset: number,
      search: string,
      status: CourseEnrollmentStatus | undefined,
    ): Promise<{ countRow: { count: string } | undefined; rows: EnrollmentWithUser[] }> {
      const conditions: string[] = [
        'e.course_id = $1',
        'e.tenant_id = $2',
        // Older rows may point at a user of another tenant; never list them.
        'u.tenant_id = $2',
        'e.is_active = true',
        'c.deleted_at IS NULL',
      ];
      const params: unknown[] = [courseId, tenantId];
      let paramIdx = 3;

      if (search) {
        conditions.push(`(u.username ILIKE '%' || $${paramIdx} || '%' OR u.email ILIKE '%' || $${paramIdx} || '%' OR u.full_name ILIKE '%' || $${paramIdx} || '%')`);
        params.push(search);
        paramIdx++;
      }

      if (status && status !== 'all') {
        if (status === 'completed') {
          conditions.push('cp.is_completed = true');
        } else if (status === 'learning') {
          conditions.push('cp.is_completed = false AND cp.progress > 0');
        } else if (status === 'not_started') {
          conditions.push('(cp.progress IS NULL OR cp.progress = 0)');
        }
      }

      const whereClause = conditions.join(' AND ');

      const countResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     JOIN users u ON u.id = e.user_id
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE ${whereClause}`,
        params,
      );

      params.push(pageSize, offset);

      const dataResult = await db.query<EnrollmentWithUser>(
        `SELECT e.id, e.user_id, e.course_id, e.tenant_id, e.enrolled_at, e.is_active,
            COALESCE(cp.progress, 0) AS progress,
            COALESCE(cp.is_completed, false) AS is_completed,
            cp.completed_at, cp.last_activity_at,
            u.username, u.email, u.full_name, u.avatar_url
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     JOIN users u ON u.id = e.user_id
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE ${whereClause}
     ORDER BY e.enrolled_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        params,
      );

      return { countRow: countResult.rows[0], rows: dataResult.rows };
    },
  };
}

export type EnrollmentsRepository = ReturnType<typeof createEnrollmentsRepository>;
