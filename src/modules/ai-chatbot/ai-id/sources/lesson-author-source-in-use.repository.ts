import type { GenerationJobSql } from '../shared/lesson-author-generation-job.repository.js';
import { LESSON_AUTHOR_ACTIVE_V2_RUN_STATUSES } from '../sessions/lesson-author-session-access.repository.js';

type Sql = Pick<GenerationJobSql, 'query'>;

/** A knowledge base document an AI ID run is still designing a course from. */
export interface LessonAuthorSourceInUse {
  document_id: string;
  name: string;
}

/**
 * Which of these documents of the knowledge base are a source of an AI ID workspace whose V2 run is still
 * active (planning, executing, finalizing: not ready, needs_action or canceled). Such a document must not
 * be deleted. Tenant-scoped; served by idx_la_ws_v2_run_tenant_status (a tenant has few active runs).
 *
 * Race: an admission locks its source documents FOR SHARE before it inserts the run, and the deletions
 * lock the rows FOR UPDATE before they call this, so a deletion either sees the committed run or the
 * admission finds the document gone.
 */
export async function findSourceDocumentsInActiveRuns(db: Sql, input: {
  tenantId: string; kbId: string; documentIds: readonly string[];
}): Promise<LessonAuthorSourceInUse[]> {
  if (input.documentIds.length === 0) return [];
  const result = await db.query<{ document_id: string; name: string }>(`SELECT DISTINCT d.id::text AS document_id,d.name
    FROM lesson_author_workspace_v2_runs r
    JOIN lesson_author_workspaces w ON w.id=r.workspace_id AND w.tenant_id=r.tenant_id AND w.course_id=r.course_id
    JOIN kb_documents d ON d.id=ANY(w.source_document_ids) AND d.tenant_id=w.tenant_id AND d.kb_id=w.kb_id
    WHERE r.tenant_id=$1::uuid AND r.status=ANY($2::text[]) AND w.kb_id=$3::uuid AND d.id=ANY($4::uuid[])
    ORDER BY name,document_id`,
  [input.tenantId, [...LESSON_AUTHOR_ACTIVE_V2_RUN_STATUSES], input.kbId, [...input.documentIds]]);
  return result.rows.map(row => ({ document_id: String(row.document_id), name: String(row.name) }));
}

/**
 * Whether an AI ID workspace whose V2 run is still active designs from this knowledge base (its sources are
 * documents of `w.kb_id`). The whole knowledge base must not be deleted then. Same index as above.
 */
export async function knowledgebaseHasActiveRuns(db: Sql, input: { tenantId: string; kbId: string }): Promise<boolean> {
  const result = await db.query<{ in_use: boolean }>(`SELECT EXISTS (SELECT 1
      FROM lesson_author_workspace_v2_runs r
      JOIN lesson_author_workspaces w ON w.id=r.workspace_id AND w.tenant_id=r.tenant_id AND w.course_id=r.course_id
      WHERE r.tenant_id=$1::uuid AND r.status=ANY($2::text[]) AND w.kb_id=$3::uuid) AS in_use`,
  [input.tenantId, [...LESSON_AUTHOR_ACTIVE_V2_RUN_STATUSES], input.kbId]);
  return result.rows[0]?.in_use === true;
}
