import type { AuthUser } from '../../../types/express.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { createWorkspaceAuthority } from './lesson-author-workspace-authority.repository.js';
import { verifiedWorkspaceContent } from './lesson-author-workspace-author-notes.repository.js';
import { WORKSPACE_REVIEW_LIST_LIMIT, WORKSPACE_REVIEW_REQUIRED_CODE, WorkspaceReviewError, workspaceReviewComponentAccepted,
  workspaceReviewEvidenceHash, workspaceReviewItem, type WorkspaceReviewCandidateRow, type WorkspaceReviewDecision,
  type WorkspaceReviewList, type WorkspaceReviewResolveInput } from './lesson-author-workspace-review.logic.js';
import { TENANT_DATA_LIMIT_REACHED_SQLSTATE, TENANT_DATA_QUOTA_RECONCILING_SQLSTATE } from '../../tenants/tenant-data-quota.constants.js';
import { isUuid } from '../../../utils/uuid.js';

type Row = Record<string, unknown>;
/** Session scope of a review read: `userId` is the session creator (shared sessions). */
export interface WorkspaceReviewOwner { tenantId: string; userId: string; conversationId: string; courseId: string; }
export interface WorkspaceReviewTarget { tenantId: string; courseId: string; conversationId: string; workspaceId: string; }
export interface WorkspaceReviewReceipt {
  obligation_id: string;
  decision: WorkspaceReviewDecision;
  status: 'resolved';
  replayed: boolean;
  open_count: number;
  total_count: number;
}
/** Written in the resolve transaction: who marked a held question as checked. */
export interface WorkspaceReviewResolvedAuditEvent {
  tenantId: string; actorId: string; actorUsername: string; courseId: string; courseName: string;
  conversationId: string; sessionTitle: string;
}

const count = (value: unknown): number => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) throw new WorkspaceReviewError('WORKSPACE_REVIEW_UNAVAILABLE');
  return number;
};
const revision = (content: unknown, contentHash: unknown) => {
  const verified = verifiedWorkspaceContent(content, contentHash);
  return verified ? { content: verified, content_hash: String(contentHash) } : null;
};
const LESSON_ORDER = `(substring(o.unit_path from '^chapter_([0-9]+)'))::integer,(substring(o.unit_path from '\\.lesson_([0-9]+)'))::integer,
  (substring(o.unit_path from '\\.unit_([0-9]+)$'))::integer,o.planned_component_index,o.id`;
const OBLIGATION_COUNTS = `SELECT count(*) AS total_count,count(*) FILTER (WHERE status='open') AS open_count
  FROM lesson_author_workspace_v2_assessment_obligations
  WHERE run_id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4`;

/** Session, course and run of a resolve, read with share locks; the workspace stays bound to its creator. */
async function loadResolveAuthority(tx: GenerationJobSql, target: WorkspaceReviewTarget) {
  const course = await tx.query(`SELECT display_name FROM courses WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR SHARE`,
    [target.courseId, target.tenantId]);
  const session = await tx.query(`SELECT c.user_id::text AS creator_id,c.title FROM chat_conversations c
    WHERE c.id=$1 AND c.tenant_id=$2 AND c.course_id=$3 AND c.target='lesson_author' FOR SHARE OF c`,
  [target.conversationId, target.tenantId, target.courseId]);
  const creator = session.rows[0] as Row | undefined;
  if (course.rows.length !== 1 || session.rows.length !== 1 || !creator || !isUuid(creator.creator_id)) {
    throw new WorkspaceReviewError('WORKSPACE_REVIEW_NOT_FOUND');
  }
  const deleting = await tx.query(`SELECT id FROM lesson_author_session_deletion_jobs
    WHERE tenant_id=$1 AND course_id=$2 AND conversation_id=$3
      AND is_terminal=false AND status IN ('queued','running','failed') FOR SHARE`,
  [target.tenantId, target.courseId, target.conversationId]);
  if (deleting.rows.length) throw new WorkspaceReviewError('WORKSPACE_REVIEW_UNAVAILABLE');
  // FOR SHARE: resolutions of different items run side by side; an Apply
  // (FOR UPDATE of the workspace) finishes first.
  const workspace = await tx.query(`SELECT r.id::text AS run_id,r.status AS run_status,r.failure_code
    FROM lesson_author_workspaces w
    JOIN lesson_author_workspace_v2_runs r ON r.workspace_id=w.id AND r.tenant_id=w.tenant_id AND r.course_id=w.course_id
    WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5
      AND w.blueprint_id IS NULL FOR SHARE OF w,r`,
  [target.workspaceId, target.tenantId, target.courseId, target.conversationId, creator.creator_id]);
  const run = workspace.rows[0] as Row | undefined;
  if (workspace.rows.length !== 1 || !run || !isUuid(run.run_id)) throw new WorkspaceReviewError('WORKSPACE_REVIEW_NOT_FOUND');
  return { courseName: String((course.rows[0] as Row).display_name ?? ''),
    sessionTitle: typeof creator.title === 'string' ? creator.title : '', runId: run.run_id,
    reviewRequired: run.run_status === 'needs_action' && run.failure_code === WORKSPACE_REVIEW_REQUIRED_CODE };
}

/**
 * Node evidence of a `valid_assessment`: a replay is bound to the revision it
 * recorded; a new resolution needs a ready Problem of the obligation's own lesson.
 */
async function resolvedComponent(tx: GenerationJobSql, target: WorkspaceReviewTarget, obligation: Row,
  input: WorkspaceReviewResolveInput): Promise<{ id: string; revision: number } | null> {
  if (input.decision !== 'valid_assessment' || !input.component_node_id) return null;
  if (obligation.status === 'resolved') {
    return typeof obligation.resolved_node_id === 'string'
      && obligation.resolved_node_id.toLowerCase() === input.component_node_id.toLowerCase()
      ? { id: obligation.resolved_node_id, revision: count(obligation.resolved_node_revision) } : null;
  }
  const component = await tx.query(`SELECT n.id::text AS node_id,n.kind,n.canonical_path,n.content_state,n.current_revision,
      n.protected_contract->>'component_type' AS component_type
    FROM lesson_author_workspace_nodes n
    WHERE n.workspace_id=$1 AND n.id=$2 AND n.tenant_id=$3 AND n.course_id=$4 FOR SHARE`,
  [target.workspaceId, input.component_node_id, target.tenantId, target.courseId]);
  const node = component.rows[0] as Row | undefined;
  if (component.rows.length !== 1 || !node || !workspaceReviewComponentAccepted({ kind: String(node.kind),
    canonical_path: String(node.canonical_path), content_state: String(node.content_state),
    component_type: typeof node.component_type === 'string' ? node.component_type : null,
    current_revision: node.current_revision === null ? null : count(node.current_revision) }, String(obligation.unit_path))) {
    throw new WorkspaceReviewError('WORKSPACE_REVIEW_COMPONENT_INVALID');
  }
  return { id: String(node.node_id), revision: count(node.current_revision) };
}

/**
 * Review items of one AI ID run ("Chờ duyệt"). Reads are bound to the exact
 * session/workspace/tenant/course; a resolve is one short transaction that
 * re-checks the actor's course-editor authority, the run state and the row,
 * then makes the only transition the DB guard allows (open -> resolved).
 */
export function createWorkspaceReviewRepository(deps: { db: GenerationJobDatabase;
  /** Same-transaction audit entry of a resolution (nested transactions join the open one). */
  audit?: (event: WorkspaceReviewResolvedAuditEvent) => Promise<void>; }) {
  async function list(owner: WorkspaceReviewOwner, workspaceId: string): Promise<WorkspaceReviewList> {
    if (![owner.tenantId, owner.userId, owner.conversationId, workspaceId].every(isUuid)) throw new WorkspaceReviewError('WORKSPACE_REVIEW_NOT_FOUND');
    return deps.db.transaction(async tx => {
      const head = await tx.query(`SELECT w.id::text AS workspace_id,r.id::text AS run_id,r.status AS run_status,r.failure_code,
          count(o.id) AS total_count,count(o.id) FILTER (WHERE o.status='open') AS open_count
        FROM lesson_author_workspaces w
        JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.user_id=w.requested_by
          AND c.course_id=w.course_id AND c.target='lesson_author'
        JOIN courses course ON course.id=w.course_id AND course.tenant_id=w.tenant_id AND course.deleted_at IS NULL
        LEFT JOIN lesson_author_workspace_v2_runs r ON r.workspace_id=w.id AND r.tenant_id=w.tenant_id AND r.course_id=w.course_id
        LEFT JOIN lesson_author_workspace_v2_assessment_obligations o ON o.run_id=r.id AND o.workspace_id=w.id
          AND o.tenant_id=w.tenant_id AND o.course_id=w.course_id
        WHERE w.id=$1 AND w.tenant_id=$2 AND w.conversation_id=$3 AND w.requested_by=$4 AND w.course_id=$5
        GROUP BY w.id,r.id,r.status,r.failure_code`, [workspaceId, owner.tenantId, owner.conversationId, owner.userId, owner.courseId]);
      const run = head.rows[0] as Row | undefined;
      if (head.rows.length !== 1 || !run) throw new WorkspaceReviewError('WORKSPACE_REVIEW_NOT_FOUND');
      const reviewRequired = run.run_status === 'needs_action' && run.failure_code === WORKSPACE_REVIEW_REQUIRED_CODE;
      const empty: WorkspaceReviewList = { workspace_id: workspaceId, review_required: reviewRequired, total_count: 0,
        open_count: 0, resolved_count: 0, has_more: false, items: [] };
      if (!isUuid(run.run_id)) return empty;
      const total = count(run.total_count), open = count(run.open_count);
      if (!total) return empty;
      const rows = (await tx.query(`SELECT o.id::text AS obligation_id,o.status,o.resolution_kind,o.resolved_at,o.unit_path,
          o.required_assessment_kind,o.unresolved_reason,o.learning_objective_refs,
          cardinality(o.relevant_evidence_fact_ids) AS evidence_fact_count,
          ur.content AS unit_content,ur.content_hash AS unit_hash,lr.content AS lesson_content,lr.content_hash AS lesson_hash,
          cr.content AS chapter_content,cr.content_hash AS chapter_hash
        FROM lesson_author_workspace_v2_assessment_obligations o
        LEFT JOIN lesson_author_workspace_nodes u ON u.workspace_id=o.workspace_id AND u.tenant_id=o.tenant_id
          AND u.course_id=o.course_id AND u.kind='unit' AND u.canonical_path=o.unit_path
        LEFT JOIN lesson_author_workspace_revisions ur ON ur.workspace_id=u.workspace_id AND ur.node_id=u.id
          AND ur.tenant_id=u.tenant_id AND ur.course_id=u.course_id AND ur.revision=u.current_revision
        LEFT JOIN lesson_author_workspace_nodes l ON l.workspace_id=u.workspace_id AND l.id=u.parent_id
          AND l.tenant_id=u.tenant_id AND l.course_id=u.course_id AND l.kind='lesson'
        LEFT JOIN lesson_author_workspace_revisions lr ON lr.workspace_id=l.workspace_id AND lr.node_id=l.id
          AND lr.tenant_id=l.tenant_id AND lr.course_id=l.course_id AND lr.revision=l.current_revision
        LEFT JOIN lesson_author_workspace_nodes ch ON ch.workspace_id=l.workspace_id AND ch.id=l.parent_id
          AND ch.tenant_id=l.tenant_id AND ch.course_id=l.course_id AND ch.kind='chapter'
        LEFT JOIN lesson_author_workspace_revisions cr ON cr.workspace_id=ch.workspace_id AND cr.node_id=ch.id
          AND cr.tenant_id=ch.tenant_id AND cr.course_id=ch.course_id AND cr.revision=ch.current_revision
        WHERE o.run_id=$1 AND o.workspace_id=$2 AND o.tenant_id=$3 AND o.course_id=$4
        ORDER BY ${LESSON_ORDER} LIMIT ${WORKSPACE_REVIEW_LIST_LIMIT + 1}`,
      [run.run_id, workspaceId, owner.tenantId, owner.courseId])).rows as Row[];
      const page = rows.slice(0, WORKSPACE_REVIEW_LIST_LIMIT);
      const unitPaths = [...new Set(page.map(row => String(row.unit_path)))];
      const candidates = unitPaths.length ? (await tx.query(`SELECT n.id::text AS node_id,n.canonical_path,r.content,r.content_hash
        FROM lesson_author_workspace_nodes n
        JOIN lesson_author_workspace_revisions r ON r.workspace_id=n.workspace_id AND r.node_id=n.id
          AND r.tenant_id=n.tenant_id AND r.course_id=n.course_id AND r.revision=n.current_revision
        WHERE n.workspace_id=$1 AND n.tenant_id=$2 AND n.course_id=$3 AND n.kind='component'
          AND n.content_state='content_ready' AND n.protected_contract->>'component_type'='problem'
          AND substring(n.canonical_path from '^(chapter_[0-9]+\\.lesson_[0-9]+\\.unit_[0-9]+)\\.component_[0-9]+$')=ANY($4::text[])
        ORDER BY n.canonical_path`, [workspaceId, owner.tenantId, owner.courseId, unitPaths])).rows as Row[] : [];
      const candidateRows: WorkspaceReviewCandidateRow[] = candidates.map(row => ({ node_id: String(row.node_id),
        canonical_path: String(row.canonical_path), content: verifiedWorkspaceContent(row.content, row.content_hash) }));
      const items = page.flatMap(row => {
        const item = workspaceReviewItem({ obligation_id: String(row.obligation_id), status: String(row.status),
          resolution_kind: typeof row.resolution_kind === 'string' ? row.resolution_kind : null,
          resolved_at: row.resolved_at instanceof Date || typeof row.resolved_at === 'string' ? row.resolved_at : null,
          unit_path: String(row.unit_path), required_kind: String(row.required_assessment_kind), reason: String(row.unresolved_reason),
          learning_objective_refs: Array.isArray(row.learning_objective_refs) ? row.learning_objective_refs.map(String) : [],
          evidence_fact_count: count(row.evidence_fact_count),
          chapter: revision(row.chapter_content, row.chapter_hash), lesson: revision(row.lesson_content, row.lesson_hash),
          unit: revision(row.unit_content, row.unit_hash) }, candidateRows);
        return item ? [item] : [];
      });
      return { workspace_id: workspaceId, review_required: reviewRequired, total_count: total, open_count: open,
        resolved_count: total - open, has_more: rows.length > WORKSPACE_REVIEW_LIST_LIMIT, items };
    });
  }

  async function resolve(user: AuthUser, target: WorkspaceReviewTarget, obligationId: string,
    input: WorkspaceReviewResolveInput): Promise<WorkspaceReviewReceipt> {
    if (![target.tenantId, target.conversationId, target.workspaceId, obligationId, input.operation_id].every(isUuid)
      || user.tenantId !== target.tenantId) throw new WorkspaceReviewError('WORKSPACE_REVIEW_NOT_FOUND');
    let stage = 'transaction_open';
    try {
      return await deps.db.transaction(async tx => {
        stage = 'authorization';
        // Apply's permission model: the ACTOR's fresh course-editor authority
        // (any editor of a shared session); the workspace stays bound to its creator.
        if (!await createWorkspaceAuthority(user).canEdit(tx, { tenantId: target.tenantId, userId: user.id,
          conversationId: target.conversationId, courseId: target.courseId })) throw new WorkspaceReviewError('WORKSPACE_REVIEW_FORBIDDEN');
        await tx.query("SET LOCAL lock_timeout = '3000ms'");
        stage = 'workspace_authority';
        const authority = await loadResolveAuthority(tx, target);
        stage = 'obligation';
        const found = await tx.query(`SELECT id::text AS obligation_id,planned_slot_key,unit_path,status,resolution_evidence_hash,
            resolved_node_id::text AS resolved_node_id,resolved_node_revision
          FROM lesson_author_workspace_v2_assessment_obligations
          WHERE id=$1 AND run_id=$2 AND workspace_id=$3 AND tenant_id=$4 AND course_id=$5 FOR UPDATE`,
        [obligationId, authority.runId, target.workspaceId, target.tenantId, target.courseId]);
        const obligation = found.rows[0] as Row | undefined;
        if (found.rows.length !== 1 || !obligation) throw new WorkspaceReviewError('WORKSPACE_REVIEW_ITEM_NOT_FOUND');
        const counts = async () => {
          const result = (await tx.query(OBLIGATION_COUNTS, [authority.runId, target.workspaceId, target.tenantId, target.courseId])).rows[0] as Row | undefined;
          return { open_count: count(result?.open_count), total_count: count(result?.total_count) };
        };
        const alreadyResolved = obligation.status === 'resolved';
        if (!alreadyResolved && obligation.status !== 'open') throw new WorkspaceReviewError('WORKSPACE_REVIEW_UNAVAILABLE');
        // The DB guard accepts the transition only while the run waits for this review.
        if (!alreadyResolved && !authority.reviewRequired) throw new WorkspaceReviewError('WORKSPACE_REVIEW_STATE_INVALID');
        const resolvedNode = await resolvedComponent(tx, target, obligation, input);
        const evidenceHash = workspaceReviewEvidenceHash({ obligation_id: String(obligation.obligation_id),
          planned_slot_key: String(obligation.planned_slot_key), decision: input.decision,
          resolved_node_id: resolvedNode?.id ?? null, resolved_node_revision: resolvedNode?.revision ?? null,
          actor_id: user.id, operation_id: input.operation_id.toLowerCase(), note: input.note });
        if (alreadyResolved) {
          // Idempotent: the same operation (same actor, decision, question, note) is answered again.
          if (obligation.resolution_evidence_hash === evidenceHash) {
            return { obligation_id: String(obligation.obligation_id), decision: input.decision, status: 'resolved' as const,
              replayed: true, ...await counts() };
          }
          throw new WorkspaceReviewError('WORKSPACE_REVIEW_ALREADY_RESOLVED');
        }
        stage = 'resolve';
        const updated = await tx.query(`UPDATE lesson_author_workspace_v2_assessment_obligations
          SET status='resolved',resolution_kind=$6,resolution_evidence_hash=$7,resolved_node_id=$8::uuid,
            resolved_node_revision=$9,resolved_at=clock_timestamp()
          WHERE id=$1 AND run_id=$2 AND workspace_id=$3 AND tenant_id=$4 AND course_id=$5 AND status='open' RETURNING id`,
        [obligationId, authority.runId, target.workspaceId, target.tenantId, target.courseId, input.decision, evidenceHash,
          resolvedNode?.id ?? null, resolvedNode?.revision ?? null]);
        if (updated.rows.length !== 1) throw new WorkspaceReviewError('WORKSPACE_REVIEW_UNAVAILABLE');
        const totals = await counts();
        if (deps.audit) {
          stage = 'audit';
          await deps.audit({ tenantId: target.tenantId, actorId: user.id, actorUsername: user.username,
            courseId: target.courseId, courseName: authority.courseName,
            conversationId: target.conversationId, sessionTitle: authority.sessionTitle });
        }
        return { obligation_id: String(obligation.obligation_id), decision: input.decision, status: 'resolved' as const,
          replayed: false, ...totals };
      });
    } catch (error) {
      if (error instanceof WorkspaceReviewError) throw error;
      const database = error && typeof error === 'object' ? error as { code?: unknown; constraint?: unknown; table?: unknown } : null;
      const sqlstate = typeof database?.code === 'string' ? database.code : null;
      console.error('[LessonAuthorWorkspaceReview] resolve rejected', { workspace_id: target.workspaceId,
        obligation_id: obligationId, operation_id: input.operation_id, failure_stage: stage, sqlstate,
        constraint: typeof database?.constraint === 'string' ? database.constraint : null,
        table: typeof database?.table === 'string' ? database.table : null });
      if (sqlstate === TENANT_DATA_LIMIT_REACHED_SQLSTATE || sqlstate === TENANT_DATA_QUOTA_RECONCILING_SQLSTATE) throw error;
      // The obligation guard refused the transition: the run left needs_action meanwhile.
      if (sqlstate === '23514' && stage === 'resolve') throw new WorkspaceReviewError('WORKSPACE_REVIEW_STATE_INVALID');
      throw new WorkspaceReviewError('WORKSPACE_REVIEW_UNAVAILABLE');
    }
  }

  return { list, resolve };
}
