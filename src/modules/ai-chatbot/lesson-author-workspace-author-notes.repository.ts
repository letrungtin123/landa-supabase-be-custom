import { COURSE_AUTHOR_NOTES_KEY, type CourseAuthorNotesV1 } from '../course-authoring/course-author-notes.logic.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';
import { readIdmAuthorGuidance } from './lesson-author-idm-guidance.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { WorkspaceApplyMapping, WorkspaceApplyWrite } from './lesson-author-workspace-apply.logic.js';
import { workspaceAuthorNotesHash, workspaceAuthorNotesRefreshes, workspaceCourseAuthorNotes,
  type WorkspaceAuthorNotesContext } from './lesson-author-workspace-author-notes.logic.js';
import { readWorkspaceContent } from './lesson-author-workspace.logic.js';

type Row = Record<string, any>;
const HASH = /^[0-9a-f]{64}$/;

/** jsonb_set of the reserved notes key only; every other metadata key, the
 * learner payload (`data`) and the publish state of the block stay untouched. */
export const SET_AUTHOR_NOTES_SQL = `metadata=jsonb_set(CASE WHEN jsonb_typeof(metadata)='object' THEN metadata ELSE '{}'::jsonb END,`
  + `'{${COURSE_AUTHOR_NOTES_KEY}}',$2::jsonb,true),has_draft_changes=true,updated_at=now()`;

export class WorkspaceAuthorNotesTargetChanged extends Error {
  constructor() { super('WORKSPACE_APPLY_TARGET_CHANGED'); this.name = 'WorkspaceAuthorNotesTargetChanged'; }
}

export type WorkspaceAuthorNotesDeltaEntry = {
  node_id: string; block_id: string; revision: number; content_hash: string; before_hash: string; after_hash: string;
};

/** Course-level author notes for the root block, from the locked workspace
 * course node's current revision. Advisory: an unreadable or unverifiable
 * course revision skips the notes and never fails or widens the Apply. */
export async function readWorkspaceCourseAuthorNotes(tx: GenerationJobSql, input: {
  tenantId: string; courseId: string; workspaceId: string; courseNodeId: string; isV2: boolean;
  context: WorkspaceAuthorNotesContext;
}): Promise<CourseAuthorNotesV1 | null> {
  const row = (await tx.query(`SELECT n.content_state,n.current_revision,r.content,r.content_hash
      FROM lesson_author_workspace_nodes n
      JOIN lesson_author_workspace_revisions r ON r.workspace_id=n.workspace_id AND r.node_id=n.id AND r.revision=n.current_revision
      WHERE n.workspace_id=$1 AND n.tenant_id=$2 AND n.course_id=$3 AND n.id=$4 AND n.kind='course'`,
  [input.workspaceId, input.tenantId, input.courseId, input.courseNodeId])).rows[0] as Row | undefined;
  const revision = typeof row?.current_revision === 'string' && /^(0|[1-9][0-9]*)$/.test(row.current_revision)
    ? Number(row.current_revision) : row?.current_revision;
  if (!row || row.content_state !== 'content_ready' || typeof row.content_hash !== 'string' || !HASH.test(row.content_hash)
    || !Number.isSafeInteger(revision) || revision < 0) return null;
  // Database reads stay outside the advisory try: a failed statement aborts
  // the transaction and must surface as an Apply failure, not be swallowed.
  const design = input.isV2 ? await tx.query(`SELECT a.payload->'idm' AS idm FROM lesson_author_workspace_v2_artifacts a
      WHERE a.workspace_id=$1 AND a.tenant_id=$2 AND a.course_id=$3 AND a.artifact_kind='course_skeleton'
      ORDER BY a.created_at DESC,a.id DESC LIMIT 1`, [input.workspaceId, input.tenantId, input.courseId]) : null;
  try {
    const content = readWorkspaceContent(row.content);
    // V1 revisions use the generation snapshot hash, V2 the orchestration hash.
    if (generationSnapshotHash(content) !== row.content_hash && orchestrationV2Hash(content) !== row.content_hash) return null;
    return workspaceCourseAuthorNotes({ ...input.context, node_id: input.courseNodeId, revision,
      content_hash: row.content_hash, content, idm_guidance: readIdmAuthorGuidance(design?.rows[0]?.idm ?? null) });
  } catch {
    console.warn('[LessonAuthorWorkspaceApply] course author notes skipped', { workspace_id: input.workspaceId, node_id: input.courseNodeId });
    return null;
  }
}

/**
 * Runs inside the Apply transaction after content materialization.
 *
 * 1. Mapped blocks whose learner content is already current but whose notes
 *    are stale (an edited media brief, or a block applied before notes
 *    existed) get a notes-only refresh, fenced by the exact mapped before-hash
 *    and recorded as an ordinary receipt delta (same revision), so the SQL
 *    receipt/mapping guards keep proving every block write.
 * 2. The workspace course node is not an Apply scope; its notes replace only
 *    the reserved key on the locked course root. Course title/description are
 *    never written here.
 *
 * Identical notes write nothing, so re-applying one revision is a no-op.
 */
export async function persistWorkspaceAuthorNotes(tx: GenerationJobSql, input: {
  tenantId: string; courseId: string; workspaceId: string; courseNodeId: string; isV2: boolean; rootId: string;
  context: WorkspaceAuthorNotesContext;
  /** Compiled writes already current in the course (not rewritten this Apply). */
  materialized: readonly WorkspaceApplyWrite[];
  mappings: readonly WorkspaceApplyMapping[];
  blockHash: (blockId: string) => Promise<string>;
}): Promise<{ delta: WorkspaceAuthorNotesDeltaEntry[]; touched: string[] }> {
  const delta: WorkspaceAuthorNotesDeltaEntry[] = [], touched: string[] = [];
  const byNode = new Map(input.mappings.map(mapping => [mapping.node_id, mapping]));
  const materialized = input.materialized.filter(write => byNode.has(write.node_id));
  const storedNotes = new Map<string, unknown>();
  if (materialized.length) {
    const stored = await tx.query(`SELECT id::text AS id,metadata->'${COURSE_AUTHOR_NOTES_KEY}' AS notes FROM course_blocks
      WHERE course_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL FOR UPDATE`,
    [input.courseId, materialized.map(write => byNode.get(write.node_id)!.target_block_id)]);
    for (const row of stored.rows as Row[]) storedNotes.set(String(row.id), row.notes ?? null);
  }
  for (const refresh of workspaceAuthorNotesRefreshes({ materialized, mappings: input.mappings, stored_notes: storedNotes, context: input.context })) {
    const updated = await tx.query(`UPDATE course_blocks SET ${SET_AUTHOR_NOTES_SQL}
      WHERE id=$1 AND course_id=$3 AND parent_id=$4 AND block_type=$5 AND deleted_at IS NULL
        AND workspace_course_block_hash(id,course_id,$6)=$7 RETURNING id`,
    [refresh.mapping.target_block_id, JSON.stringify(refresh.notes), input.courseId, refresh.mapping.target_parent_id,
      refresh.write.block_type, input.tenantId, refresh.mapping.target_hash]);
    if (updated.rows.length !== 1) throw new WorkspaceAuthorNotesTargetChanged();
    const after = await input.blockHash(refresh.mapping.target_block_id);
    touched.push(refresh.mapping.target_block_id);
    delta.push({ node_id: refresh.write.node_id, block_id: refresh.mapping.target_block_id, revision: refresh.write.revision,
      content_hash: refresh.write.content_hash, before_hash: refresh.mapping.target_hash, after_hash: after });
  }
  const courseNotes = await readWorkspaceCourseAuthorNotes(tx, input);
  if (courseNotes) {
    const stored = await tx.query(`SELECT metadata->'${COURSE_AUTHOR_NOTES_KEY}' AS notes FROM course_blocks
      WHERE id=$1 AND course_id=$2 AND parent_id IS NULL AND block_type='course' AND deleted_at IS NULL`, [input.rootId, input.courseId]);
    if (stored.rows.length !== 1) throw new WorkspaceAuthorNotesTargetChanged();
    if (workspaceAuthorNotesHash((stored.rows[0] as Row).notes ?? null) !== workspaceAuthorNotesHash(courseNotes)) {
      const root = await tx.query(`UPDATE course_blocks SET ${SET_AUTHOR_NOTES_SQL}
        WHERE id=$1 AND course_id=$3 AND parent_id IS NULL AND block_type='course' AND deleted_at IS NULL RETURNING id`,
      [input.rootId, JSON.stringify(courseNotes), input.courseId]);
      if (root.rows.length !== 1) throw new WorkspaceAuthorNotesTargetChanged();
      touched.push(input.rootId);
    }
  }
  return { delta, touched };
}
