import { COURSE_AUTHOR_ASSESSMENT_REVIEWS_MAX, COURSE_AUTHOR_NOTES_KEY, type CourseAuthorAssessmentReviewV1,
  type CourseAuthorNotesV1 } from '../course-authoring/course-author-notes.logic.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';
import { readIdmAuthorNotesGuidance } from './lesson-author-idm-guidance.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { WorkspaceApplyMapping, WorkspaceApplyWrite } from './lesson-author-workspace-apply.logic.js';
import { workspaceAssessmentReviews, workspaceAuthorNotesHash, workspaceAuthorNotesRefreshes, workspaceCourseAuthorNotes,
  type WorkspaceAuthorNotesContext } from './lesson-author-workspace-author-notes.logic.js';
import { readWorkspaceContent, type WorkspaceContent } from './lesson-author-workspace.logic.js';

type Row = Record<string, any>;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored revision's content only when its hash verifies (V1 generation
 * snapshot hash or V2 orchestration hash); otherwise null, never a throw. */
function verifiedWorkspaceContent(content: unknown, contentHash: unknown): WorkspaceContent | null {
  if (content === null || content === undefined || typeof contentHash !== 'string' || !HASH.test(contentHash)) return null;
  try {
    const parsed = readWorkspaceContent(content);
    return generationSnapshotHash(parsed) === contentHash || orchestrationV2Hash(parsed) === contentHash ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Open assessment obligations of a V2 run (QLT-3), read-only and bound to the
 * run, workspace, tenant and course. Each is joined to its unit node by exact
 * canonical path (same workspace/tenant/course) and to the unit's lesson, whose
 * current revision resolves the lesson-local `lo_<n>` refs. Course order,
 * bounded; a row that does not validate is skipped (advisory notes).
 */
export async function readWorkspaceAssessmentReviews(tx: GenerationJobSql, input: {
  tenantId: string; courseId: string; workspaceId: string; runId: string;
}): Promise<CourseAuthorAssessmentReviewV1[]> {
  const rows = (await tx.query(`SELECT o.id::text AS obligation_id,o.unit_path,o.planned_component_index,o.learning_objective_refs,
      o.required_assessment_kind,cardinality(o.relevant_evidence_fact_ids) AS evidence_fact_count,o.unresolved_reason,
      u.id::text AS unit_node_id,ur.content AS unit_content,ur.content_hash AS unit_content_hash,
      lr.content AS lesson_content,lr.content_hash AS lesson_content_hash
    FROM lesson_author_workspace_v2_assessment_obligations o
    LEFT JOIN lesson_author_workspace_nodes u ON u.workspace_id=o.workspace_id AND u.tenant_id=o.tenant_id
      AND u.course_id=o.course_id AND u.kind='unit' AND u.canonical_path=o.unit_path
    LEFT JOIN lesson_author_workspace_revisions ur ON ur.workspace_id=u.workspace_id AND ur.node_id=u.id
      AND ur.tenant_id=u.tenant_id AND ur.course_id=u.course_id AND ur.revision=u.current_revision
    LEFT JOIN lesson_author_workspace_nodes l ON l.workspace_id=u.workspace_id AND l.id=u.parent_id
      AND l.tenant_id=u.tenant_id AND l.course_id=u.course_id AND l.kind='lesson'
    LEFT JOIN lesson_author_workspace_revisions lr ON lr.workspace_id=l.workspace_id AND lr.node_id=l.id
      AND lr.tenant_id=l.tenant_id AND lr.course_id=l.course_id AND lr.revision=l.current_revision
    WHERE o.run_id=$1 AND o.workspace_id=$2 AND o.tenant_id=$3 AND o.course_id=$4 AND o.status='open'
    ORDER BY (substring(o.unit_path from '^chapter_([0-9]+)'))::integer,(substring(o.unit_path from '\\.lesson_([0-9]+)'))::integer,
      (substring(o.unit_path from '\\.unit_([0-9]+)$'))::integer,o.planned_component_index,o.id
    LIMIT ${COURSE_AUTHOR_ASSESSMENT_REVIEWS_MAX}`,
  [input.runId, input.workspaceId, input.tenantId, input.courseId])).rows as Row[];
  const count = (value: unknown): number => typeof value === 'number' ? value
    : typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : -1;
  return workspaceAssessmentReviews(rows.map(row => ({
    obligation_id: String(row.obligation_id), unit_node_id: typeof row.unit_node_id === 'string' && UUID.test(row.unit_node_id) ? row.unit_node_id : null,
    unit_path: String(row.unit_path), component_index: count(row.planned_component_index), required_kind: String(row.required_assessment_kind),
    learning_objective_refs: Array.isArray(row.learning_objective_refs) ? row.learning_objective_refs.map(String) : [],
    unresolved_reason: String(row.unresolved_reason), evidence_fact_count: count(row.evidence_fact_count),
    unit: verifiedWorkspaceContent(row.unit_content, row.unit_content_hash),
    lesson: verifiedWorkspaceContent(row.lesson_content, row.lesson_content_hash),
  })));
}

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
    // V1 revisions use the generation snapshot hash, V2 the orchestration hash.
    const content = verifiedWorkspaceContent(row.content, row.content_hash);
    if (!content) return null;
    return workspaceCourseAuthorNotes({ ...input.context, node_id: input.courseNodeId, revision,
      content_hash: row.content_hash, content, idm_guidance: readIdmAuthorNotesGuidance(design?.rows[0]?.idm ?? null) });
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
  touched.push(...await persistCourseAuthorNotes(tx, input));
  return { delta, touched };
}

/**
 * Course-level notes only, on the locked course root. The root is never an
 * Apply mapping target, so this needs no receipt delta and is safe even for a
 * semantic replay (an already-applied scope re-applied unchanged): that is how
 * a course applied before notes existed gets its course-level notes. Returns
 * the root id when it was written, nothing when the notes are already current.
 */
export async function persistCourseAuthorNotes(tx: GenerationJobSql, input: {
  tenantId: string; courseId: string; workspaceId: string; courseNodeId: string; isV2: boolean; rootId: string;
  context: WorkspaceAuthorNotesContext;
}): Promise<string[]> {
  const courseNotes = await readWorkspaceCourseAuthorNotes(tx, input);
  if (!courseNotes) return [];
  const stored = await tx.query(`SELECT metadata->'${COURSE_AUTHOR_NOTES_KEY}' AS notes FROM course_blocks
    WHERE id=$1 AND course_id=$2 AND parent_id IS NULL AND block_type='course' AND deleted_at IS NULL`, [input.rootId, input.courseId]);
  if (stored.rows.length !== 1) throw new WorkspaceAuthorNotesTargetChanged();
  if (workspaceAuthorNotesHash((stored.rows[0] as Row).notes ?? null) === workspaceAuthorNotesHash(courseNotes)) return [];
  const root = await tx.query(`UPDATE course_blocks SET ${SET_AUTHOR_NOTES_SQL}
    WHERE id=$1 AND course_id=$3 AND parent_id IS NULL AND block_type='course' AND deleted_at IS NULL RETURNING id`,
  [input.rootId, JSON.stringify(courseNotes), input.courseId]);
  if (root.rows.length !== 1) throw new WorkspaceAuthorNotesTargetChanged();
  return [input.rootId];
}
