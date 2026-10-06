import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../../types/express.js';
import { invalidateBlockReadCaches, invalidateCourseReadCaches } from '../../config/cache-invalidation.js';
import type { LessonAuthorBlueprint } from './chat.service.js';
import type { LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { createWorkspaceAuthority } from './lesson-author-workspace-authority.repository.js';
import { compileWorkspaceApply, workspaceApplyEstablishedParentOffsets, workspaceApplyMaterializationPlan, workspaceApplyScopeChapter, workspaceApplyTargetHash, workspaceApplyWriteAlreadyMaterialized,
  WorkspaceApplyCompileError, type WorkspaceApplyMapping, type WorkspaceApplyNode } from './lesson-author-workspace-apply.logic.js';
import { hydrateWorkspaceComponent } from './lesson-author-workspace-component.logic.js';
import { readWorkspaceContent, workspaceLocale } from './lesson-author-workspace.logic.js';
import type { WorkspaceApplyReceipt } from './lesson-author-workspace-apply.controller.js';
import { compileOrchestrationV2WorkspaceApply, type OrchestrationV2ApplyArtifact,
  type OrchestrationV2ApplyChapterReceipt } from './lesson-author-orchestration-v2-apply.logic.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
export type WorkspaceApplyCode = 'WORKSPACE_APPLY_FORBIDDEN' | 'WORKSPACE_APPLY_NOT_FOUND' | 'WORKSPACE_APPLY_STATE_INVALID'
  | 'WORKSPACE_APPLY_SOURCE_CHANGED' | 'WORKSPACE_APPLY_REVISION_CONFLICT' | 'WORKSPACE_APPLY_TARGET_CHANGED'
  | 'WORKSPACE_APPLY_NOT_READY' | 'WORKSPACE_APPLY_DEPENDENCY_REQUIRED' | 'WORKSPACE_APPLY_VALIDATION_FAILED'
  | 'WORKSPACE_APPLY_UNAVAILABLE';
export class WorkspaceApplyError extends Error { constructor(readonly code: WorkspaceApplyCode) { super(code); this.name = 'WorkspaceApplyError'; } }
export interface WorkspaceApplyTarget { tenantId: string; userId: string; courseId: string; conversationId: string; workspaceId: string; nodeId: string; operationId: string; }
type Row = Record<string, any>;
const integer = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new WorkspaceApplyError('WORKSPACE_APPLY_NOT_READY'); return n;
};
const text = (v: unknown): string => { if (typeof v !== 'string' || !v) throw new WorkspaceApplyError('WORKSPACE_APPLY_NOT_READY'); return v; };
const isHash = (v: unknown): v is string => typeof v === 'string' && HASH.test(v);

/** Transactional, mapping-only course materializer. It never looks up a target
 * by title, never accepts browser content, and writes draft blocks only. SQL
 * guards prove the receipt, mapping delta, revision manifest and scope event
 * are committed together. */
export function createWorkspaceApplyRepository(deps: { db: GenerationJobDatabase; }) {
  async function blockHash(tx: GenerationJobSql, blockId: string, courseId: string, tenantId: string): Promise<string> {
    const result = await tx.query(`SELECT workspace_course_block_hash($1::uuid,$2::varchar,$3::uuid) AS hash`, [blockId, courseId, tenantId]);
    const value = result.rows[0]?.hash; if (result.rows.length !== 1 || !isHash(value)) throw new WorkspaceApplyError('WORKSPACE_APPLY_TARGET_CHANGED'); return value;
  }
  async function apply(user: AuthUser, target: WorkspaceApplyTarget, expectedWorkspaceRevision: number): Promise<WorkspaceApplyReceipt> {
    if (!Number.isSafeInteger(expectedWorkspaceRevision) || expectedWorkspaceRevision < 0 || ![target.tenantId, target.userId, target.workspaceId, target.conversationId, target.nodeId, target.operationId].every(v => UUID.test(v))) throw new WorkspaceApplyError('WORKSPACE_APPLY_NOT_READY');
    let cacheIds: string[] = [];
    let failureStage = 'transaction_open';
    try {
      const receipt = await deps.db.transaction(async tx => {
        failureStage = 'authorization';
        const authority = createWorkspaceAuthority(user);
        if (!await authority.canEdit(tx, target)) throw new WorkspaceApplyError('WORKSPACE_APPLY_FORBIDDEN');
        await tx.query("SET LOCAL lock_timeout = '3000ms'");
        const locked = await tx.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired`, [`course:${target.tenantId}:${target.courseId}`]);
        if (locked.rows[0]?.acquired !== true) throw new WorkspaceApplyError('WORKSPACE_APPLY_REVISION_CONFLICT');
        const course = await tx.query(`SELECT id,display_name FROM courses WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [target.courseId, target.tenantId]);
        if (course.rows.length !== 1) throw new WorkspaceApplyError('WORKSPACE_APPLY_NOT_FOUND');
        const deleting = await tx.query(`SELECT id FROM lesson_author_session_deletion_jobs
          WHERE tenant_id=$1 AND course_id=$2 AND requested_by=$3 AND conversation_id=$4
            AND is_terminal=false AND status IN ('queued','running','failed') FOR SHARE`,
        [target.tenantId, target.courseId, target.userId, target.conversationId]);
        if (deleting.rows.length) throw new WorkspaceApplyError('WORKSPACE_APPLY_UNAVAILABLE');
        failureStage = 'workspace_authority';
        const workspace = await tx.query(`SELECT w.id,w.status,w.event_head,w.content_locale,w.correlation_id,w.source_snapshot_hash,
            COALESCE(run.runtime_config_hash,v2.runtime_config_hash) AS runtime_config_hash,
            w.blueprint_id,b.blueprint,b.source_snapshot_hash AS blueprint_source_hash,v2.id::text AS v2_run_id
          FROM lesson_author_workspaces w
          LEFT JOIN lesson_author_blueprints b ON b.id=w.blueprint_id AND b.tenant_id=w.tenant_id AND b.course_id=w.course_id AND b.conversation_id=w.conversation_id AND b.status='proposed'
          LEFT JOIN lesson_author_workspace_runs run ON run.workspace_id=w.id AND run.tenant_id=w.tenant_id AND run.course_id=w.course_id
          LEFT JOIN lesson_author_workspace_v2_runs v2 ON v2.workspace_id=w.id AND v2.tenant_id=w.tenant_id AND v2.course_id=w.course_id
          JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.user_id=w.requested_by AND c.course_id=w.course_id AND c.target='lesson_author'
          WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5 AND w.contract_version=1 AND w.engine='self_built_rag'
          FOR UPDATE OF w`, [target.workspaceId, target.tenantId, target.courseId, target.conversationId, target.userId]);
        const w = workspace.rows[0] as Row | undefined;
        if (!w || workspace.rows.length !== 1) throw new WorkspaceApplyError('WORKSPACE_APPLY_NOT_FOUND');
        const isV2 = w.blueprint_id === null && typeof w.v2_run_id === 'string';
        const isV1 = typeof w.blueprint_id === 'string' && w.v2_run_id === null;
        if (!['drafting', 'ready', 'needs_action'].includes(w.status) || !isHash(w.source_snapshot_hash)
          || !isHash(w.runtime_config_hash) || !UUID.test(text(w.correlation_id)) || (!isV1 && !isV2)
          || isV1 && w.blueprint_source_hash !== w.source_snapshot_hash) throw new WorkspaceApplyError('WORKSPACE_APPLY_STATE_INVALID');
        if (isV1) {
          const blueprintAuthority = await tx.query(`SELECT id FROM lesson_author_blueprints
            WHERE id=$1 AND tenant_id=$2 AND course_id=$3 AND conversation_id=$4 AND status='proposed' FOR UPDATE`,
          [w.blueprint_id, target.tenantId, target.courseId, target.conversationId]);
          if (blueprintAuthority.rows.length !== 1) throw new WorkspaceApplyError('WORKSPACE_APPLY_STATE_INVALID');
        } else {
          const runAuthority = await tx.query(`SELECT id FROM lesson_author_workspace_v2_runs
            WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 AND runtime_config_hash=$5 FOR SHARE`,
          [w.v2_run_id, target.workspaceId, target.tenantId, target.courseId, w.runtime_config_hash]);
          if (runAuthority.rows.length !== 1) throw new WorkspaceApplyError('WORKSPACE_APPLY_STATE_INVALID');
        }
        const requestHash = hash({ operation_id: target.operationId, expected_workspace_revision: expectedWorkspaceRevision, scope_node_id: target.nodeId });
        const prior = await tx.query(`SELECT id,scope_node_id,request_hash,revision_set_hash FROM lesson_author_workspace_apply_receipts
          WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 AND idempotency_key=$4 FOR UPDATE`, [target.workspaceId, target.tenantId, target.courseId, target.operationId]);
        if (prior.rows.length > 1) throw new WorkspaceApplyError('WORKSPACE_APPLY_UNAVAILABLE');
        if (prior.rows.length === 1) {
          const r = prior.rows[0] as Row;
          if (r.scope_node_id !== target.nodeId || r.request_hash !== requestHash || !isHash(r.revision_set_hash)) throw new WorkspaceApplyError('WORKSPACE_APPLY_REVISION_CONFLICT');
          return { receipt_id: text(r.id), workspace_id: target.workspaceId, node_id: target.nodeId, correlation_id: text(w.correlation_id), revision_set_hash: r.revision_set_hash,
            created_block_count: 0, updated_block_count: 0, replayed: true };
        }
        if (integer(w.event_head) !== expectedWorkspaceRevision) throw new WorkspaceApplyError('WORKSPACE_APPLY_REVISION_CONFLICT');
        const scope = await tx.query(`SELECT id,kind,canonical_path FROM lesson_author_workspace_nodes WHERE workspace_id=$1 AND id=$2 AND tenant_id=$3 AND course_id=$4 FOR UPDATE`, [target.workspaceId, target.nodeId, target.tenantId, target.courseId]);
        const scopeRow = scope.rows[0] as Row | undefined;
        const chapterCount = scopeRow && typeof scopeRow.canonical_path === 'string'
          ? workspaceApplyScopeChapter(scopeRow.kind, scopeRow.canonical_path) : null;
        if (!scopeRow || scope.rows.length !== 1 || chapterCount === null) throw new WorkspaceApplyError('WORKSPACE_APPLY_NOT_READY');
        const freshSource = await authority.currentSourceHash(tx, { target, source_snapshot_hash: w.source_snapshot_hash });
        if (freshSource !== w.source_snapshot_hash) throw new WorkspaceApplyError('WORKSPACE_APPLY_SOURCE_CHANGED');
        const allowed = await authority.allowedComponents(tx, target);
        const courseNode = await tx.query(`SELECT id FROM lesson_author_workspace_nodes WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 AND kind='course' AND canonical_path='course' FOR UPDATE`, [target.workspaceId, target.tenantId, target.courseId]);
        const courseNodeId = text(courseNode.rows[0]?.id);
        if (courseNode.rows.length !== 1) throw new WorkspaceApplyError('WORKSPACE_APPLY_NOT_READY');
        failureStage = 'workspace_evidence';
        const rawNodes = await tx.query(`SELECT n.id AS node_id,n.parent_id,n.kind,n.canonical_path,n.sort_order,n.content_state,n.current_revision,n.protected_contract,n.contract_hash,
            b.content AS baseline_content,b.content_hash AS baseline_hash,r.content AS current_content,r.content_hash AS current_hash
          FROM lesson_author_workspace_nodes n LEFT JOIN lesson_author_workspace_revisions b ON b.workspace_id=n.workspace_id AND b.node_id=n.id AND b.revision=0
          LEFT JOIN lesson_author_workspace_revisions r ON r.workspace_id=n.workspace_id AND r.node_id=n.id AND r.revision=n.current_revision
          WHERE n.workspace_id=$1 AND n.tenant_id=$2 AND n.course_id=$3 AND n.kind<>'course'
            AND (substring(n.canonical_path from '^chapter_([0-9]+)'))::integer <= $4
          -- Revisions are append-only. Locking the mutable node row is sufficient
          -- and avoids PostgreSQL's prohibition on locking nullable LEFT JOIN sides.
          ORDER BY n.canonical_path FOR UPDATE OF n`, [target.workspaceId, target.tenantId, target.courseId, chapterCount]);
        const nodes: WorkspaceApplyNode[] = rawNodes.rows.map((r: Row) => ({ node_id: text(r.node_id), parent_id: text(r.parent_id), kind: r.kind, canonical_path: text(r.canonical_path), sort_order: integer(r.sort_order), content_state: r.content_state,
          current_revision: r.current_revision === null ? null : integer(r.current_revision), protected_contract: r.protected_contract, contract_hash: text(r.contract_hash),
          baseline: r.baseline_content === null ? null : { content: readWorkspaceContent(r.baseline_content), content_hash: text(r.baseline_hash) },
          current: r.current_content === null ? null : { content: readWorkspaceContent(r.current_content), content_hash: text(r.current_hash) },
        } as WorkspaceApplyNode));
        const blueprint = w.blueprint as LessonAuthorBlueprint | null;
        let v2Evidence: { architecture: Row; inventory: Row; units: OrchestrationV2ApplyArtifact[];
          chapters: OrchestrationV2ApplyChapterReceipt[] } | null = null;
        let accepted: Array<{ chapter_path: string; proposal: LessonAuthorProposal; content_hash: string }> = [];
        if (isV1) {
          if (!blueprint || typeof blueprint !== 'object' || !Array.isArray(blueprint.chapters)
            || chapterCount > blueprint.chapters.length) throw new WorkspaceApplyError('WORKSPACE_APPLY_NOT_READY');
          const byPath = new Map(nodes.map(n => [n.canonical_path, n]));
          accepted = blueprint.chapters.slice(0, chapterCount).map((chapter, ci) => {
            const proposal: LessonAuthorProposal = { summary: '', chapters: [{ title: chapter.title, lessons: chapter.lessons.map((lesson, li) => ({ title: lesson.title, units: lesson.units.map((unit, ui) => ({ title: unit.title, source_fact_ids: unit.source_fact_ids, components: unit.component_plan.map((_plan, pi) => {
              const node = byPath.get(`chapter_${ci + 1}.lesson_${li + 1}.unit_${ui + 1}.component_${pi + 1}`);
              if (!node?.baseline) throw new WorkspaceApplyError('WORKSPACE_APPLY_NOT_READY');
              return hydrateWorkspaceComponent(node.protected_contract, node.baseline.content, allowed);
            }) })) })) }] };
            return { chapter_path: `chapter_${ci + 1}`, proposal, content_hash: hash(proposal) };
          });
        } else {
          const planning = await tx.query(`SELECT a.artifact_kind,a.artifact_hash,a.payload
            FROM lesson_author_workspace_v2_artifacts a
            JOIN lesson_author_workspace_v2_tasks t ON t.id=a.task_id AND t.run_id=a.run_id
              AND t.workspace_id=a.workspace_id AND t.tenant_id=a.tenant_id AND t.course_id=a.course_id
            WHERE a.run_id=$1 AND a.workspace_id=$2 AND a.tenant_id=$3 AND a.course_id=$4
              AND t.status='succeeded' AND a.artifact_kind IN ('architecture_validation','inventory_receipt')
            ORDER BY a.artifact_kind FOR SHARE OF a,t`, [w.v2_run_id, target.workspaceId, target.tenantId, target.courseId]);
          const architecture = planning.rows.find((row: Row) => row.artifact_kind === 'architecture_validation');
          const inventory = planning.rows.find((row: Row) => row.artifact_kind === 'inventory_receipt');
          if (planning.rows.length !== 2 || !architecture || !inventory) throw new WorkspaceApplyError('WORKSPACE_APPLY_NOT_READY');
          const units = await tx.query(`SELECT t.id::text AS task_id,t.task_key,t.node_id::text,t.chapter_key,
              a.artifact_hash,a.payload
            FROM lesson_author_workspace_v2_tasks t
            JOIN lesson_author_workspace_nodes n ON n.id=t.node_id AND n.workspace_id=t.workspace_id
              AND n.tenant_id=t.tenant_id AND n.course_id=t.course_id AND n.kind='unit'
            JOIN lesson_author_workspace_v2_artifacts a ON a.task_id=t.id AND a.run_id=t.run_id
              AND a.artifact_kind='unit_baseline' AND a.artifact_hash=t.result_hash
            WHERE t.run_id=$1 AND t.workspace_id=$2 AND t.tenant_id=$3 AND t.course_id=$4
              AND t.kind='generate_unit' AND t.status='succeeded'
              AND (substring(n.canonical_path from '^chapter_([0-9]+)'))::integer <= $5
            ORDER BY t.ordinal FOR SHARE OF t,n,a`, [w.v2_run_id, target.workspaceId, target.tenantId, target.courseId, chapterCount]);
          const chapters = await tx.query(`SELECT t.chapter_key,a.artifact_hash,a.payload
            FROM lesson_author_workspace_v2_tasks t
            JOIN lesson_author_workspace_nodes n ON n.id=t.node_id AND n.workspace_id=t.workspace_id
              AND n.tenant_id=t.tenant_id AND n.course_id=t.course_id AND n.kind='chapter'
            JOIN lesson_author_workspace_v2_artifacts a ON a.task_id=t.id AND a.run_id=t.run_id
              AND a.artifact_kind='chapter_receipt' AND a.artifact_hash=t.result_hash
            WHERE t.run_id=$1 AND t.workspace_id=$2 AND t.tenant_id=$3 AND t.course_id=$4
              AND t.kind='validate_chapter' AND t.status='succeeded'
              AND (substring(n.canonical_path from '^chapter_([0-9]+)'))::integer <= $5
            ORDER BY t.ordinal FOR SHARE OF t,n,a`, [w.v2_run_id, target.workspaceId, target.tenantId, target.courseId, chapterCount]);
          v2Evidence = { architecture, inventory, units: units.rows.map((row: Row) => ({ task_id: text(row.task_id),
            task_key: text(row.task_key), node_id: text(row.node_id), chapter_key: text(row.chapter_key),
            artifact_hash: text(row.artifact_hash), payload: row.payload })),
          chapters: chapters.rows.map((row: Row) => ({ chapter_key: text(row.chapter_key),
            artifact_hash: text(row.artifact_hash), payload: row.payload })) };
        }
        failureStage = 'target_authority';
        let root = await tx.query(`SELECT id FROM course_blocks WHERE course_id=$1 AND parent_id IS NULL AND block_type='course' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 2 FOR UPDATE`, [target.courseId]);
        if (root.rows.length > 1) throw new WorkspaceApplyError('WORKSPACE_APPLY_TARGET_CHANGED');
        if (!root.rows.length) root = await tx.query(`INSERT INTO course_blocks(course_id,block_type,display_name,is_published,has_draft_changes) VALUES($1,'course',$2,true,true) RETURNING id`, [target.courseId, text(course.rows[0].display_name)]);
        const rootId = text(root.rows[0]?.id), rootHash = await blockHash(tx, rootId, target.courseId, target.tenantId);
        const mapRows = await tx.query(`SELECT m.node_id,m.target_block_id,m.target_parent_id,m.target_block_type,m.target_sort_order,m.applied_revision,m.applied_content_hash,m.target_hash,r.revision_manifest,
            workspace_course_block_hash(m.target_block_id,m.course_id,m.tenant_id) AS actual_target_hash
          FROM lesson_author_workspace_apply_mappings m
          JOIN lesson_author_workspace_apply_receipts r ON r.id=m.receipt_id AND r.workspace_id=m.workspace_id
          JOIN lesson_author_workspace_nodes mapped_node ON mapped_node.workspace_id=m.workspace_id AND mapped_node.id=m.node_id
            AND mapped_node.tenant_id=m.tenant_id AND mapped_node.course_id=m.course_id
          WHERE m.workspace_id=$1 AND m.tenant_id=$2 AND m.course_id=$3
            AND (substring(mapped_node.canonical_path from '^chapter_([0-9]+)'))::integer <= $4
          FOR UPDATE OF m,r,mapped_node`, [target.workspaceId, target.tenantId, target.courseId, chapterCount]);
        const mappings: WorkspaceApplyMapping[] = mapRows.rows.map((m: Row) => ({ node_id: text(m.node_id), target_block_id: text(m.target_block_id), target_parent_id: text(m.target_parent_id), target_block_type: text(m.target_block_type), target_sort_order: integer(m.target_sort_order), applied_revision: integer(m.applied_revision), applied_content_hash: text(m.applied_content_hash), target_hash: text(m.target_hash), actual_target_hash: text(m.actual_target_hash), receipt_revision_manifest: m.revision_manifest }));
        const manifest = nodes.map(n => ({ node_id: n.node_id, revision: n.current_revision!, content_hash: n.current!.content_hash }));
        const targets = { course_root_id: rootId, course_root_hash: rootHash, mappings };
        const request = { scope_node_id: target.nodeId, expected_workspace_revision: expectedWorkspaceRevision,
          expected_revision_manifest: manifest, expected_target_snapshot_hash: workspaceApplyTargetHash(targets) };
        failureStage = 'compile';
        const compiled = isV1 ? compileWorkspaceApply({ workspace_id: target.workspaceId, course_node_id: courseNodeId,
          content_locale: workspaceLocale(w.content_locale), event_head: expectedWorkspaceRevision,
          source_snapshot_hash: w.source_snapshot_hash, runtime_config_hash: w.runtime_config_hash,
          blueprint: blueprint!, blueprint_hash: hash(blueprint), nodes, accepted_baselines: accepted, allowed, targets, request })
          : compileOrchestrationV2WorkspaceApply({ workspace_id: target.workspaceId, course_node_id: courseNodeId,
            run_id: text(w.v2_run_id), content_locale: workspaceLocale(w.content_locale), event_head: expectedWorkspaceRevision,
            source_snapshot_hash: w.source_snapshot_hash, runtime_config_hash: w.runtime_config_hash,
            architecture: v2Evidence!.architecture.payload, architecture_hash: text(v2Evidence!.architecture.artifact_hash),
             inventory_hash: text((v2Evidence!.inventory.payload as Row)?.inventory_hash), nodes,
             unit_artifacts: v2Evidence!.units, chapter_receipts: v2Evidence!.chapters, allowed, targets, request });
        const v2Compiled = isV2
          ? compiled as ReturnType<typeof compileOrchestrationV2WorkspaceApply>
          : null;
        // A retry with a fresh HTTP idempotency key is still a semantic replay
        // when the exact scope and effective revisions were already committed.
        // Return the durable receipt instead of colliding with its unique proof.
        const semanticPrior = await tx.query(`SELECT id,revision_set_hash FROM lesson_author_workspace_apply_receipts
          WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 AND scope_node_id=$4 AND revision_set_hash=$5 FOR SHARE`,
        [target.workspaceId, target.tenantId, target.courseId, target.nodeId, compiled.revision_set_hash]);
        if (semanticPrior.rows.length > 1) throw new WorkspaceApplyError('WORKSPACE_APPLY_UNAVAILABLE');
        if (semanticPrior.rows.length === 1) {
          const priorReceipt = semanticPrior.rows[0] as Row;
          return { receipt_id: text(priorReceipt.id), workspace_id: target.workspaceId, node_id: target.nodeId,
            correlation_id: text(w.correlation_id), revision_set_hash: text(priorReceipt.revision_set_hash),
            created_block_count: 0, updated_block_count: 0, replayed: true };
        }
        const mappingsByNode = new Map(mappings.map(mapping => [mapping.node_id, mapping]));
        const materialization = workspaceApplyMaterializationPlan(compiled.writes, mappings, target.nodeId);
        const targetIds = new Map(mappings.map(m => [m.node_id, m.target_block_id])); const targetHashes = new Map(mappings.map(m => [m.node_id, m.target_hash]));
        // Offset authority must include every already-mapped sibling, including
        // later chapters outside the selected prefix. These rows are identity
        // metadata only; content/revision authority remains the scoped compile
        // input above.
        const offsetRows = await tx.query(`SELECT mapped_node.parent_id::text AS parent_node_id,
            mapped_node.sort_order AS node_sort_order,m.target_sort_order
          FROM lesson_author_workspace_apply_mappings m
          JOIN lesson_author_workspace_nodes mapped_node ON mapped_node.workspace_id=m.workspace_id AND mapped_node.id=m.node_id
            AND mapped_node.tenant_id=m.tenant_id AND mapped_node.course_id=m.course_id
          WHERE m.workspace_id=$1 AND m.tenant_id=$2 AND m.course_id=$3
          ORDER BY mapped_node.parent_id,mapped_node.sort_order,mapped_node.id FOR SHARE OF m,mapped_node`,
        [target.workspaceId,target.tenantId,target.courseId]);
        const parentOffsets = workspaceApplyEstablishedParentOffsets(offsetRows.rows.map((row: Row) => ({
          parent_node_id: text(row.parent_node_id), node_sort_order: integer(row.node_sort_order),
          target_sort_order: integer(row.target_sort_order),
        })));
        const delta: Array<Record<string, unknown>> = []; let created = 0, updated = 0;
        failureStage = 'materialize_blocks';
        for (const write of materialization.writes) {
          failureStage = `materialize_block:${write.node_id}`;
          const parent = write.kind === 'chapter' ? rootId : targetIds.get(write.parent_node_id);
          if (!parent) throw new WorkspaceApplyError('WORKSPACE_APPLY_TARGET_CHANGED');
          const metadata = { ...(write.component?.metadata ?? {}), workspace_id: target.workspaceId, workspace_node_id: write.node_id, generated_by: 'lesson_author_ai', ...(write.kind === 'component' ? {} : { workspace_storyboard: write.author_metadata.storyboard }) };
          const data = write.component ? write.component.data : {};
          let blockId = targetIds.get(write.node_id); const before = blockId ? targetHashes.get(write.node_id)! : null;
          if (blockId) {
            const row = await tx.query(`UPDATE course_blocks SET display_name=$4,data=$5::jsonb,metadata=$6::jsonb,has_draft_changes=true,is_published=false,updated_at=now()
              WHERE id=$1 AND course_id=$2 AND parent_id=$3 AND block_type=$7 AND deleted_at IS NULL RETURNING id`, [blockId, target.courseId, parent, write.title, JSON.stringify(data), JSON.stringify(metadata), write.block_type]);
            if (row.rows.length !== 1) throw new WorkspaceApplyError('WORKSPACE_APPLY_TARGET_CHANGED'); updated++;
          } else {
            let offset = parentOffsets.get(write.parent_node_id);
            if (offset === undefined) { const last = await tx.query(`SELECT sort_order FROM course_blocks WHERE course_id=$1 AND parent_id=$2 AND deleted_at IS NULL ORDER BY sort_order DESC,id DESC LIMIT 1 FOR UPDATE`, [target.courseId, parent]); offset = (last.rows.length ? integer(last.rows[0].sort_order) + 1 : 0) - write.sort_order; if (offset < 0) offset = 0; parentOffsets.set(write.parent_node_id, offset); }
            const row = await tx.query(`INSERT INTO course_blocks(course_id,parent_id,block_type,display_name,data,metadata,sort_order,is_published,has_draft_changes) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,false,true) RETURNING id`, [target.courseId, parent, write.block_type, write.title, JSON.stringify(data), JSON.stringify(metadata), write.sort_order + offset]);
            blockId = text(row.rows[0]?.id); targetIds.set(write.node_id, blockId); created++;
          }
          const after = await blockHash(tx, blockId, target.courseId, target.tenantId); targetHashes.set(write.node_id, after); cacheIds.push(blockId);
          delta.push({ node_id: write.node_id, block_id: blockId, revision: write.revision, content_hash: write.content_hash, before_hash: before, after_hash: after });
        }
        // The selected scope can already be fully current because it was
        // materialized by a broader Apply. Record one exact no-op mapping proof
        // so the immutable receipt remains non-empty without touching a block.
        if (!delta.length) {
          const anchor = materialization.noopAnchor;
          const mapping = anchor ? mappingsByNode.get(anchor.node_id) : undefined;
          if (!anchor || !mapping || !workspaceApplyWriteAlreadyMaterialized(anchor, mapping)) {
            throw new WorkspaceApplyError('WORKSPACE_APPLY_TARGET_CHANGED');
          }
          delta.push({ node_id: anchor.node_id, block_id: mapping.target_block_id, revision: anchor.revision,
            content_hash: anchor.content_hash, before_hash: mapping.target_hash, after_hash: mapping.target_hash });
        }
        const receiptId = randomUUID();
        const afterHash = hash({ course_root_id: rootId, mapping_delta: delta });
        failureStage = 'persist_receipt';
        let qualityReceiptId: string | null = null;
        if (v2Compiled) {
          qualityReceiptId = randomUUID();
          const quality = v2Compiled.quality_receipt;
          const qualityInserted = await tx.query(`INSERT INTO lesson_author_workspace_quality_receipts
              (id,workspace_id,tenant_id,course_id,scope_node_id,revision_set_hash,subject_content_hash,
               source_snapshot_hash,evidence_dependency_hash,canonicalization_version,evaluator_kind,evaluator_version,
               origin_summary,checks,findings)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb)
            RETURNING id`, [qualityReceiptId,target.workspaceId,target.tenantId,target.courseId,target.nodeId,
            v2Compiled.revision_set_hash,quality.subject_content_hash,w.source_snapshot_hash,
            quality.evidence_dependency_hash,quality.canonicalization_version,quality.evaluator_kind,
            quality.evaluator_version,JSON.stringify(quality.origin_summary),JSON.stringify(quality.checks),
            JSON.stringify(quality.findings)]);
          if (qualityInserted.rows.length !== 1) throw new WorkspaceApplyError('WORKSPACE_APPLY_UNAVAILABLE');
        }
        await tx.query(`INSERT INTO lesson_author_workspace_apply_receipts(id,workspace_id,tenant_id,course_id,scope_node_id,actor_id,idempotency_key,request_hash,expected_workspace_revision,revision_set_hash,source_snapshot_hash,runtime_config_hash,target_before_hash,target_after_hash,quality_receipt_id,validation_contract,revision_manifest,mapping_delta,checks)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb)`, [receiptId,target.workspaceId,target.tenantId,target.courseId,target.nodeId,target.userId,target.operationId,requestHash,expectedWorkspaceRevision,compiled.revision_set_hash,w.source_snapshot_hash,w.runtime_config_hash,compiled.acceptance.target_snapshot_hash,afterHash,qualityReceiptId,compiled.validation_contract,JSON.stringify(compiled.revision_manifest),JSON.stringify(delta),JSON.stringify(compiled.acceptance.checks)]);
        failureStage = 'persist_mappings';
        for (const entry of delta) {
          failureStage = `persist_mapping:${String(entry.node_id)}`;
          await tx.query(`INSERT INTO lesson_author_workspace_apply_mappings(workspace_id,node_id,tenant_id,course_id,target_block_id,target_parent_id,target_block_type,target_sort_order,applied_revision,applied_content_hash,target_hash,receipt_id)
            SELECT $1,n.id,$2,$3,$4,b.parent_id,b.block_type,b.sort_order,$5,$6,$7,$8 FROM lesson_author_workspace_nodes n JOIN course_blocks b ON b.id=$4 AND b.course_id=$3 WHERE n.workspace_id=$1 AND n.id=$9
            ON CONFLICT(workspace_id,node_id) DO UPDATE SET applied_revision=EXCLUDED.applied_revision,
              applied_content_hash=EXCLUDED.applied_content_hash,target_hash=EXCLUDED.target_hash,
              receipt_id=EXCLUDED.receipt_id,updated_at=clock_timestamp()`,
          [target.workspaceId,target.tenantId,target.courseId,entry.block_id,entry.revision,
            entry.content_hash,entry.after_hash,receiptId,entry.node_id]);
        }
        failureStage = 'persist_event';
        const event = await tx.query(`INSERT INTO lesson_author_workspace_events(workspace_id,tenant_id,course_id,event_kind,node_id,operation_id) VALUES($1,$2,$3,'scope_applied',$4,$5) RETURNING sequence`, [target.workspaceId,target.tenantId,target.courseId,target.nodeId,receiptId]);
        if (event.rows.length !== 1) throw new WorkspaceApplyError('WORKSPACE_APPLY_UNAVAILABLE');
        failureStage = 'final_authority_fence';
        if (!await authority.canEdit(tx, target) || await authority.currentSourceHash(tx, { target, source_snapshot_hash: w.source_snapshot_hash }) !== w.source_snapshot_hash) throw new WorkspaceApplyError('WORKSPACE_APPLY_SOURCE_CHANGED');
        failureStage = 'transaction_commit';
        return { receipt_id: receiptId, workspace_id: target.workspaceId, node_id: target.nodeId, correlation_id: text(w.correlation_id), revision_set_hash: compiled.revision_set_hash, created_block_count: created, updated_block_count: updated, replayed: false };
      });
      failureStage = 'cache_invalidation';
      await invalidateBlockReadCaches(cacheIds); await invalidateCourseReadCaches(target.courseId, target.tenantId); return receipt;
    } catch (error) {
      if (error instanceof WorkspaceApplyError) throw error;
      if (error instanceof WorkspaceApplyCompileError) {
        console.warn('[LessonAuthorWorkspaceApply] compile rejected', {
          workspace_id: target.workspaceId,
          node_id: target.nodeId,
          operation_id: target.operationId,
          failure_stage: failureStage,
          compile_code: error.code,
          finding_paths: error.findings.slice(0, 8).map(finding => finding.path),
          finding_count: error.findings.length,
        });
        throw new WorkspaceApplyError(error.code.includes('VALIDATION') ? 'WORKSPACE_APPLY_VALIDATION_FAILED' : error.code.includes('REVISION') ? 'WORKSPACE_APPLY_REVISION_CONFLICT' : error.code.includes('TARGET') ? 'WORKSPACE_APPLY_TARGET_CHANGED' : error.code.includes('DEPENDENCY') ? 'WORKSPACE_APPLY_DEPENDENCY_REQUIRED' : 'WORKSPACE_APPLY_NOT_READY');
      }
      const authorityCode = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code : null;
      if (authorityCode === 'WORKSPACE_SOURCE_CHANGED') throw new WorkspaceApplyError('WORKSPACE_APPLY_SOURCE_CHANGED');
      if (authorityCode === 'WORKSPACE_EDIT_FORBIDDEN') throw new WorkspaceApplyError('WORKSPACE_APPLY_FORBIDDEN');
      if ((error as { code?: unknown })?.code === '40001') throw new WorkspaceApplyError('WORKSPACE_APPLY_REVISION_CONFLICT');
      const databaseError = error && typeof error === 'object' ? error as {
        code?: unknown; constraint?: unknown; table?: unknown; routine?: unknown;
      } : null;
      console.error('[LessonAuthorWorkspaceApply] persistence rejected', {
        workspace_id: target.workspaceId,
        node_id: target.nodeId,
        operation_id: target.operationId,
        failure_stage: failureStage,
        sqlstate: typeof databaseError?.code === 'string' ? databaseError.code : null,
        constraint: typeof databaseError?.constraint === 'string' ? databaseError.constraint : null,
        table: typeof databaseError?.table === 'string' ? databaseError.table : null,
        routine: typeof databaseError?.routine === 'string' ? databaseError.routine : null,
      });
      throw new WorkspaceApplyError('WORKSPACE_APPLY_UNAVAILABLE');
    }
  }
  return { apply };
}
