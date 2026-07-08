import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { query as databaseQuery } from '../../config/database.js';

type Queryable = Pick<PoolClient, 'query'>;

async function runQuery<T extends QueryResultRow = any>(
  client: Queryable | undefined,
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return client ? client.query<T>(text, params) : databaseQuery<T>(text, params);
}

const LEAF_BLOCK_TYPES_SQL = `('course','chapter','sequential','vertical')`;

function activeLeafBlocksCte(): string {
  return `WITH RECURSIVE active_tree AS (
       SELECT b.id, b.parent_id, b.block_type
       FROM course_blocks b
       JOIN courses c ON c.id = b.course_id
       WHERE b.course_id = $2
         AND b.parent_id IS NULL
         AND b.is_published = true
         AND b.deleted_at IS NULL
         AND c.deleted_at IS NULL
       UNION ALL
       SELECT child.id, child.parent_id, child.block_type
       FROM course_blocks child
       JOIN active_tree parent ON parent.id = child.parent_id
       WHERE child.is_published = true
         AND child.deleted_at IS NULL
     ),
     leaf_blocks AS (
       SELECT id
       FROM active_tree
       WHERE block_type NOT IN ${LEAF_BLOCK_TYPES_SQL}
     )`;
}

export async function getEnrollmentContentCompletion(
  enrollmentId: string,
  courseId: string,
  client?: Queryable,
): Promise<{ total: number; completed: number; is_complete: boolean }> {
  const result = await runQuery<{ total: string; completed: string }>(
    client,
    `${activeLeafBlocksCte()}
     SELECT
       COUNT(lb.id)::text AS total,
       COUNT(bc.id)::text AS completed
     FROM leaf_blocks lb
     LEFT JOIN block_completions bc
       ON bc.block_id = lb.id
      AND bc.enrollment_id = $1`,
    [enrollmentId, courseId],
  );

  const total = Number(result.rows[0]?.total || 0);
  const completed = Number(result.rows[0]?.completed || 0);
  return {
    total,
    completed,
    is_complete: total === 0 || completed >= total,
  };
}

export async function recalculateEnrollmentProgress(
  enrollmentId: string,
  courseId: string,
  client?: Queryable,
): Promise<void> {
  const result = await runQuery<{ total: string; completed: string }>(
    client,
    `${activeLeafBlocksCte()},
     assignment_totals AS (
       SELECT COUNT(*)::int AS total
       FROM course_assignments ca
       WHERE ca.course_id = $2
         AND ca.deleted_at IS NULL
         AND ca.is_published = true
     ),
     assignment_completed AS (
       SELECT COUNT(DISTINCT ca.id)::int AS completed
       FROM course_assignments ca
       JOIN assignment_submissions s
         ON s.assignment_id = ca.id
        AND s.enrollment_id = $1
        AND s.status IN ('submitted', 'feedback_given')
       WHERE ca.course_id = $2
         AND ca.deleted_at IS NULL
         AND ca.is_published = true
     )
     SELECT
       (COUNT(lb.id) + (SELECT total FROM assignment_totals))::text AS total,
       (COUNT(bc.id) + (SELECT completed FROM assignment_completed))::text AS completed
     FROM leaf_blocks lb
     LEFT JOIN block_completions bc
       ON bc.block_id = lb.id
      AND bc.enrollment_id = $1`,
    [enrollmentId, courseId],
  );

  const total = Number(result.rows[0]?.total || 0);
  const completed = Number(result.rows[0]?.completed || 0);
  const progress = total > 0 ? Math.round((completed / total) * 10000) / 100 : 0;
  const isCompleted = total > 0 && completed >= total;

  await runQuery(
    client,
    `UPDATE course_progress
     SET progress = $1,
         is_completed = $2,
         completed_at = CASE WHEN $2 THEN COALESCE(completed_at, now()) ELSE NULL END,
         last_activity_at = now(),
         updated_at = now()
     WHERE enrollment_id = $3`,
    [progress, isCompleted, enrollmentId],
  );
}

export async function recalculateCourseProgressForActiveEnrollments(
  courseId: string,
  client?: Queryable,
): Promise<number> {
  const result = await runQuery<{ enrollment_id: string }>(
    client,
    `WITH RECURSIVE active_tree AS (
       SELECT b.id, b.parent_id, b.block_type
       FROM course_blocks b
       JOIN courses c ON c.id = b.course_id
       WHERE b.course_id = $1
         AND b.parent_id IS NULL
         AND b.is_published = true
         AND b.deleted_at IS NULL
         AND c.deleted_at IS NULL
       UNION ALL
       SELECT child.id, child.parent_id, child.block_type
       FROM course_blocks child
       JOIN active_tree parent ON parent.id = child.parent_id
       WHERE child.is_published = true
         AND child.deleted_at IS NULL
     ),
     leaf_blocks AS (
       SELECT id
       FROM active_tree
       WHERE block_type NOT IN ${LEAF_BLOCK_TYPES_SQL}
     ),
     active_enrollments AS (
       SELECT id
       FROM enrollments
       WHERE course_id = $1
         AND is_active = true
     ),
     totals AS (
       SELECT
         (SELECT COUNT(*) FROM leaf_blocks)
         +
         (
           SELECT COUNT(*)
           FROM course_assignments ca
           WHERE ca.course_id = $1
             AND ca.deleted_at IS NULL
             AND ca.is_published = true
         ) AS total
     ),
     completed_blocks AS (
       SELECT bc.enrollment_id, COUNT(*)::int AS completed
       FROM block_completions bc
       JOIN leaf_blocks lb ON lb.id = bc.block_id
       JOIN active_enrollments ae ON ae.id = bc.enrollment_id
       GROUP BY bc.enrollment_id
     ),
     completed_assignments AS (
       SELECT s.enrollment_id, COUNT(DISTINCT ca.id)::int AS completed
       FROM assignment_submissions s
       JOIN active_enrollments ae ON ae.id = s.enrollment_id
       JOIN course_assignments ca
         ON ca.id = s.assignment_id
        AND ca.course_id = $1
        AND ca.deleted_at IS NULL
        AND ca.is_published = true
       WHERE s.status IN ('submitted', 'feedback_given')
       GROUP BY s.enrollment_id
     )
     UPDATE course_progress cp
     SET progress = CASE
           WHEN totals.total > 0 THEN ROUND((((COALESCE(cb.completed, 0) + COALESCE(ca.completed, 0))::numeric / totals.total::numeric) * 10000)) / 100
           ELSE 0
         END,
         is_completed = totals.total > 0 AND (COALESCE(cb.completed, 0) + COALESCE(ca.completed, 0)) >= totals.total,
         completed_at = CASE
           WHEN totals.total > 0 AND (COALESCE(cb.completed, 0) + COALESCE(ca.completed, 0)) >= totals.total THEN COALESCE(cp.completed_at, now())
           ELSE NULL
         END,
         last_activity_at = now(),
         updated_at = now()
     FROM active_enrollments ae
     CROSS JOIN totals
     LEFT JOIN completed_blocks cb ON cb.enrollment_id = ae.id
     LEFT JOIN completed_assignments ca ON ca.enrollment_id = ae.id
     WHERE cp.enrollment_id = ae.id
     RETURNING ae.id AS enrollment_id`,
    [courseId],
  );

  return result.rowCount ?? 0;
}
