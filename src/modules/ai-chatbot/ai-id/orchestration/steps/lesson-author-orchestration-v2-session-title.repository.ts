import type { GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import {
  LESSON_AUTHOR_DEFAULT_SESSION_TITLE, lessonAuthorSessionTitleFromCourseTitle,
} from '../../shared/lesson-author-session-title.logic.js';

/** The workspace whose session is named, and the run/task for the log line. */
export interface SessionTitleTarget {
  workspace_id: string;
  tenant_id: string;
  course_id: string;
  run_id?: string;
  task_id?: string;
}

/** A session title write that failed and was rolled back alone (the skeleton success still commits). */
export interface SessionTitleSkipped {
  event: 'session_title_skipped';
  tenant_id: string;
  workspace_id: string;
  run_id: string | null;
  task_id: string | null;
  /** SQLSTATE of the failure, or SESSION_TITLE_WRITE_FAILED without one. */
  code: string;
}

const SAVEPOINT = 'lesson_author_session_title';

function failureCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'SESSION_TITLE_WRITE_FAILED';
}

const warn = (event: SessionTitleSkipped) => console.warn(`[LessonAuthorOrchestrationV2] ${JSON.stringify(event)}`);

/**
 * C1: the session (the workspace's chat_conversations row) takes the AI course title while it still has
 * the default title; a title the author chose is kept. Called inside the course skeleton success
 * transaction, so a retried success writes it once and a later run of the session finds a title and
 * changes nothing. The conversation is a course-scoped row, written last (lock order step 4); updated_at
 * moves like a rename's, so a rename sent with the previous updated_at is refused, not lost.
 *
 * It must never fail or roll back the skeleton success: the row's user deletion fence
 * (assert_active_user_deletion_fence) raises 23503 for an inactive or deletion-requested owner, so the
 * UPDATE only matches an active owner without a deletion request, and runs under a SAVEPOINT: any other
 * failure (a race with a deactivation, a lock timeout) is rolled back alone and reported with its code.
 * true when the title was set.
 */
export async function adoptCourseTitleAsSessionTitle(
  tx: GenerationJobSql,
  target: SessionTitleTarget,
  courseTitle: unknown,
  report: (event: SessionTitleSkipped) => void = warn,
): Promise<boolean> {
  const title = lessonAuthorSessionTitleFromCourseTitle(courseTitle);
  if (!title) return false;
  await tx.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const updated = await tx.query(`UPDATE chat_conversations c SET title=$5,updated_at=clock_timestamp()
      FROM lesson_author_workspaces w, users u
      WHERE w.id=$1::uuid AND w.tenant_id=$2::uuid AND w.course_id=$3
        AND c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.course_id=w.course_id
        AND c.target='lesson_author' AND c.title=$4
        AND u.id=c.user_id AND u.is_active=true AND u.deletion_requested_at IS NULL
      RETURNING c.id`,
    [target.workspace_id, target.tenant_id, target.course_id, LESSON_AUTHOR_DEFAULT_SESSION_TITLE, title]);
    await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return updated.rows.length === 1;
  } catch (error) {
    // A failed rollback means a broken connection: the whole transaction is lost anyway, so it propagates.
    await tx.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    report({ event: 'session_title_skipped', tenant_id: target.tenant_id, workspace_id: target.workspace_id,
      run_id: target.run_id ?? null, task_id: target.task_id ?? null, code: failureCode(error) });
    return false;
  }
}

/** The course skeleton's `afterSuccess` (both pipelines): `next` (the chapter fan-out), then the session name. */
export function thenAdoptSessionTitle(
  next: (tx: GenerationJobSql) => Promise<void>,
  target: SessionTitleTarget,
  courseTitle: unknown,
  report?: (event: SessionTitleSkipped) => void,
): (tx: GenerationJobSql) => Promise<void> {
  return async tx => {
    await next(tx);
    await adoptCourseTitleAsSessionTitle(tx, target, courseTitle, report);
  };
}
