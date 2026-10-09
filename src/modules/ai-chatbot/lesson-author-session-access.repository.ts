import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { lessonAuthorSessionOwnerName } from './lesson-author-session-access.logic.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** V2 run states in which generation is still executing (schema CHECK values). */
export const LESSON_AUTHOR_ACTIVE_V2_RUN_STATUSES = ['planning', 'executing', 'finalizing'] as const;
/** Legacy chat Blueprint generation states that still hold provider work. */
export const LESSON_AUTHOR_ACTIVE_GENERATION_STATUSES = ['queued', 'running'] as const;
export const LESSON_AUTHOR_ACTIVE_RUN_LIMIT = 10;

type Sql = Pick<GenerationJobSql, 'query'>;

export interface LessonAuthorSessionOwnerRow {
  owner_id: string;
  course_id: string;
}

/**
 * Tenant-scoped primary-key lookup of the session creator. Returns null for a
 * missing conversation, another tenant's conversation, or a non lesson-author
 * conversation, so callers keep their existing not-found behaviour.
 */
export async function findLessonAuthorSessionOwner(db: Sql, input: {
  tenantId: string; conversationId: string; courseId?: string;
}): Promise<LessonAuthorSessionOwnerRow | null> {
  if (!UUID.test(input.tenantId) || !UUID.test(input.conversationId)) return null;
  const result = await db.query<{ owner_id: string; course_id: string }>(`SELECT c.user_id::text AS owner_id,c.course_id
    FROM chat_conversations c
    WHERE c.id=$1::uuid AND c.tenant_id=$2::uuid AND c.target='lesson_author'
      AND ($3::text IS NULL OR c.course_id=$3)`,
  [input.conversationId, input.tenantId, input.courseId ?? null]);
  const row = result.rows[0];
  return row && typeof row.owner_id === 'string' && UUID.test(row.owner_id) ? { owner_id: row.owner_id, course_id: row.course_id } : null;
}

export interface LessonAuthorActiveRun {
  conversation_id: string;
  title: string;
  owner: { user_id: string; display_name: string };
  is_mine: boolean;
  started_at: string;
}

/**
 * Sessions of one course whose generation is still running: V2 runs in a
 * non-terminal state, plus legacy chat Blueprint jobs still queued/running.
 * Both sets are small and served by the existing status indexes
 * (idx_la_ws_v2_run_tenant_status, idx_la_generation_deadline).
 */
export async function listLessonAuthorActiveRuns(db: Sql, input: {
  tenantId: string; courseId: string; actorId: string;
}): Promise<LessonAuthorActiveRun[]> {
  const result = await db.query<{ conversation_id: string; title: string | null; owner_id: string;
    full_name: string | null; username: string | null; started_at: Date | string }>(`SELECT active.conversation_id,
      c.title,c.user_id::text AS owner_id,u.full_name,u.username,MIN(active.started_at) AS started_at
    FROM (
      SELECT w.conversation_id,r.created_at AS started_at
      FROM lesson_author_workspace_v2_runs r
      JOIN lesson_author_workspaces w ON w.id=r.workspace_id AND w.tenant_id=r.tenant_id AND w.course_id=r.course_id
      WHERE r.tenant_id=$1::uuid AND r.course_id=$2 AND r.status=ANY($3::text[])
      UNION ALL
      SELECT g.conversation_id,g.created_at AS started_at
      FROM lesson_author_generation_jobs g
      WHERE g.tenant_id=$1::uuid AND g.status=ANY($4::text[])
    ) active
    JOIN chat_conversations c ON c.id=active.conversation_id AND c.tenant_id=$1::uuid
      AND c.course_id=$2 AND c.target='lesson_author'
    JOIN courses course ON course.id=c.course_id AND course.tenant_id=c.tenant_id AND course.deleted_at IS NULL
    LEFT JOIN users u ON u.id=c.user_id
    GROUP BY active.conversation_id,c.title,c.user_id,u.full_name,u.username
    ORDER BY MIN(active.started_at) DESC,active.conversation_id DESC
    LIMIT $5`,
  [input.tenantId, input.courseId, [...LESSON_AUTHOR_ACTIVE_V2_RUN_STATUSES], [...LESSON_AUTHOR_ACTIVE_GENERATION_STATUSES],
    LESSON_AUTHOR_ACTIVE_RUN_LIMIT]);
  return result.rows.map(row => ({
    conversation_id: row.conversation_id,
    title: typeof row.title === 'string' ? row.title.trim().slice(0, 200) : '',
    owner: { user_id: row.owner_id, display_name: lessonAuthorSessionOwnerName(row.full_name, row.username) },
    is_mine: row.owner_id === input.actorId,
    started_at: new Date(row.started_at).toISOString(),
  }));
}
