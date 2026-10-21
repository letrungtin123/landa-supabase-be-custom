import type { GenerationJobSql } from '../../shared/lesson-author-generation-job.repository.js';
import {
  LESSON_AUTHOR_DEFAULT_SESSION_TITLE, lessonAuthorSessionTitleFromCourseTitle,
} from '../../shared/lesson-author-session-title.logic.js';

/**
 * C1: the session (the workspace's chat_conversations row) takes the AI course title while it still has
 * the default title; a title the author chose is kept. Called inside the course skeleton success
 * transaction, so a retried success writes it once and a later run of the session finds a title and
 * changes nothing. The conversation is a course-scoped row, written last (lock order step 4); updated_at
 * moves like a rename's, so a rename sent with the previous updated_at is refused, not lost. true when
 * the title was set.
 */
export async function adoptCourseTitleAsSessionTitle(
  tx: GenerationJobSql,
  target: { workspace_id: string; tenant_id: string; course_id: string },
  courseTitle: unknown,
): Promise<boolean> {
  const title = lessonAuthorSessionTitleFromCourseTitle(courseTitle);
  if (!title) return false;
  const updated = await tx.query(`UPDATE chat_conversations c SET title=$5,updated_at=clock_timestamp()
    FROM lesson_author_workspaces w
    WHERE w.id=$1::uuid AND w.tenant_id=$2::uuid AND w.course_id=$3
      AND c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.course_id=w.course_id
      AND c.target='lesson_author' AND c.title=$4
    RETURNING c.id`,
  [target.workspace_id, target.tenant_id, target.course_id, LESSON_AUTHOR_DEFAULT_SESSION_TITLE, title]);
  return updated.rows.length === 1;
}

/** The course skeleton's `afterSuccess` (both pipelines): `next` (the chapter fan-out), then the session name. */
export function thenAdoptSessionTitle(
  next: (tx: GenerationJobSql) => Promise<void>,
  target: { workspace_id: string; tenant_id: string; course_id: string },
  courseTitle: unknown,
): (tx: GenerationJobSql) => Promise<void> {
  return async tx => {
    await next(tx);
    await adoptCourseTitleAsSessionTitle(tx, target, courseTitle);
  };
}
