import type { LessonAuthorBlueprint } from './chat.service.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { WorkspaceEditAcceptance, WorkspaceEditContext } from './lesson-author-workspace-edit.repository.js';
import { WorkspaceEditError } from './lesson-author-workspace-edit.repository.js';
import type { WorkspaceRevisionCandidate } from './lesson-author-workspace.logic.js';
import { WorkspaceContractError } from './lesson-author-workspace.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { editWorkspaceStoryboard, workspaceStoryboardBoundSeed, workspaceStoryboardSeed,
  WORKSPACE_AGGREGATE_EDIT, WORKSPACE_MEDIA_EDIT } from './lesson-author-workspace-storyboard.logic.js';
import { createWorkspaceComponentAcceptance, type WorkspaceContentDiagnostic } from './lesson-author-workspace-content.repository.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import { readOrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import { prepareOrchestrationV2InventoryIdentity } from './lesson-author-orchestration-v2-inventory.logic.js';

export interface WorkspaceStoryboardDiagnostic {
  event: 'workspace_storyboard_validation'; correlation_id: string; workspace_id: string; node_id: string;
  node_kind: string; status: 'PASS_METADATA_ONLY' | 'FAIL'; internal_failure_code: string | null;
  failure_stage: 'workspace_storyboard_binding' | 'workspace_storyboard_payload' | null;
  validation_contract: string; pedagogy: 'NOT_RUN'; registry: 'NOT_APPLICABLE';
  semantic_fidelity: 'not_measured'; apply_readiness: 'NOT_EVALUATED'; duration_ms: number;
}
function invalid(): never { throw new WorkspaceContractError('WORKSPACE_CONTRACT_INVALID'); }

/** Same locked/authorized transaction as Save/Reset. No connection/provider
 * imports; no persistence beyond the surrounding revision repository.
 * Exact approved metadata projection is the baseline, not a fabricated course
 * or media asset. Does NOT authorize Apply or claim educational validation.
 */
export function createWorkspaceStoryboardAcceptance(report: (event: WorkspaceStoryboardDiagnostic) => void) {
  return async (tx: GenerationJobSql, context: WorkspaceEditContext, candidate: WorkspaceRevisionCandidate): Promise<WorkspaceEditAcceptance> => {
    const started = performance.now(), t = context.target;
    const validationContract = context.node.kind === 'media_brief' ? WORKSPACE_MEDIA_EDIT : WORKSPACE_AGGREGATE_EDIT;
    let stage: WorkspaceStoryboardDiagnostic['failure_stage'] = 'workspace_storyboard_binding';
    const emit = (code: string | null) => {
      try { report({ event: 'workspace_storyboard_validation', correlation_id: context.correlation_id, workspace_id: t.workspaceId,
        node_id: t.nodeId, node_kind: context.node.kind, status: code ? 'FAIL' : 'PASS_METADATA_ONLY', internal_failure_code: code,
        failure_stage: code ? stage : null, validation_contract: validationContract, pedagogy: 'NOT_RUN', registry: 'NOT_APPLICABLE',
        semantic_fidelity: 'not_measured', apply_readiness: 'NOT_EVALUATED', duration_ms: Math.max(0, Math.round(performance.now() - started)) });
      } catch { /* Metadata logging cannot change transaction outcome. */ }
    };
    try {
      if (!['course', 'chapter', 'lesson', 'unit', 'media_brief'].includes(context.node.kind)
        || context.node.kind === 'component' || context.node.current_revision !== candidate.parent_revision
        || candidate.content_hash !== hash(candidate.content)) invalid();
      const result = await tx.query(`SELECT w.blueprint_id::text,n.id::text,n.parent_id::text,n.kind,n.canonical_path,n.sort_order,n.current_revision,
          n.protected_contract,n.contract_hash,p.canonical_path AS parent_path,p.kind AS parent_kind
        FROM lesson_author_workspaces w
        JOIN lesson_author_workspace_nodes n ON n.workspace_id=w.id AND n.tenant_id=w.tenant_id AND n.course_id=w.course_id
        LEFT JOIN lesson_author_workspace_nodes p ON p.id=n.parent_id AND p.workspace_id=n.workspace_id AND p.tenant_id=n.tenant_id AND p.course_id=n.course_id
        WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5 AND n.id=$6
          AND w.contract_version=1 AND w.engine='self_built_rag' AND w.source_snapshot_hash=$7
          AND n.content_state='content_ready'
          AND EXISTS (SELECT 1 FROM lesson_author_workspace_events e WHERE e.workspace_id=w.id AND e.event_kind='structure_ready')
        FOR SHARE OF w,n`, [t.workspaceId, t.tenantId, t.courseId, t.conversationId, t.userId, t.nodeId, context.source_snapshot_hash]);
      const row = result.rows[0];
      if (result.rows.length !== 1 || row.kind !== context.node.kind || typeof row.canonical_path !== 'string'
        || (row.parent_path !== null && typeof row.parent_path !== 'string')
        || !Number.isSafeInteger(Number(row.current_revision)) || row.current_revision === null
        || Number(row.current_revision) !== candidate.parent_revision || row.contract_hash !== context.contract_hash
        || hash(context.protected_contract) !== context.contract_hash || hash(row.protected_contract) !== row.contract_hash) invalid();
      let seed: ReturnType<typeof workspaceStoryboardSeed>;
      if (row.blueprint_id !== null) {
        const blueprint = await tx.query(`SELECT CASE WHEN octet_length(b.blueprint::text)<=16777216 THEN b.blueprint ELSE NULL END AS blueprint
          FROM lesson_author_blueprints b JOIN lesson_author_workspaces w ON w.id=$1 AND w.blueprint_id=b.id
          WHERE b.id=$2 AND b.tenant_id=$3 AND b.course_id=$4 AND b.conversation_id=$5 AND b.kb_id=w.kb_id
            AND b.engine='self_built_rag' AND b.status='proposed' AND b.source_snapshot_hash=$6
          FOR SHARE OF b`, [t.workspaceId, row.blueprint_id, t.tenantId, t.courseId, t.conversationId, context.source_snapshot_hash]);
        if (blueprint.rows.length !== 1 || !blueprint.rows[0].blueprint) invalid();
        seed = workspaceStoryboardSeed(blueprint.rows[0].blueprint as LessonAuthorBlueprint, context.node.kind, row.canonical_path);
      } else {
        const architecture = await tx.query(`SELECT r.id::text AS run_id,a.payload,a.artifact_hash
          FROM lesson_author_workspace_v2_runs r
          JOIN lesson_author_workspace_v2_tasks task ON task.run_id=r.id AND task.workspace_id=r.workspace_id
            AND task.tenant_id=r.tenant_id AND task.course_id=r.course_id
            AND task.kind='validate_architecture' AND task.status='succeeded'
          JOIN lesson_author_workspace_v2_artifacts a ON a.task_id=task.id AND a.run_id=task.run_id
            AND a.workspace_id=task.workspace_id AND a.tenant_id=task.tenant_id AND a.course_id=task.course_id
            AND a.artifact_kind='architecture_validation' AND a.artifact_hash=task.result_hash
          WHERE r.workspace_id=$1 AND r.tenant_id=$2 AND r.course_id=$3
            AND r.status IN ('executing','ready','needs_action') FOR SHARE OF r,task,a`,
        [t.workspaceId, t.tenantId, t.courseId]);
        if (architecture.rows.length !== 1) invalid();
        let expected: ReturnType<typeof prepareOrchestrationV2InventoryIdentity>['nodes'][number] | undefined;
        try {
          const assembly = readOrchestrationV2ArchitectureAssembly(architecture.rows[0].payload);
          if (assembly.assembly_hash !== architecture.rows[0].artifact_hash
            || assembly.source_snapshot_hash !== context.source_snapshot_hash) invalid();
          const identity = prepareOrchestrationV2InventoryIdentity({ run_id: String(architecture.rows[0].run_id), assembly });
          expected = identity.nodes.find(node => node.canonical_path === row.canonical_path);
        } catch (error) {
          if (error instanceof WorkspaceContractError) throw error;
          invalid();
        }
        if (!expected || expected.id !== row.id || expected.parent_id !== row.parent_id
          || expected.kind !== row.kind || expected.sort_order !== Number(row.sort_order)
          || expected.contract_hash !== row.contract_hash || hash(expected.protected_contract) !== hash(row.protected_contract)) invalid();
        seed = workspaceStoryboardBoundSeed({ kind: context.node.kind, canonical_path: row.canonical_path,
          parent_path: row.parent_path, sort_order: Number(row.sort_order), binding: row.protected_contract,
          baseline: context.node.baseline });
      }
      const parentKind = { course: null, chapter: 'course', lesson: 'chapter', unit: 'lesson', media_brief: 'unit' }[context.node.kind];
      if (!seed || row.parent_path !== seed.parent_path || row.parent_kind !== parentKind || row.sort_order !== seed.sort_order
        || hash(seed.binding) !== context.contract_hash || hash(seed.baseline) !== hash(context.node.baseline)) invalid();
      stage = 'workspace_storyboard_payload';
      editWorkspaceStoryboard(seed, context.node.current);
      editWorkspaceStoryboard(seed, candidate.content);
      emit(null);
      return { workspace_id: t.workspaceId, node_id: t.nodeId, expected_revision: candidate.parent_revision,
        content_hash: candidate.content_hash, source_snapshot_hash: context.source_snapshot_hash, contract_hash: context.contract_hash,
        validation_contract: validationContract,
        checks: { schema: 'PASS', security: 'PASS', references: 'PASS', pedagogy: 'NOT_RUN', registry: 'NOT_APPLICABLE' } };
    } catch (error) {
      emit(error instanceof WorkspaceContractError ? error.code : 'WORKSPACE_EDIT_UNAVAILABLE');
      if (error instanceof WorkspaceContractError) throw error;
      // DB/projection exception text is not safe educational telemetry.
      throw new WorkspaceEditError('WORKSPACE_EDIT_UNAVAILABLE');
    }
  };
}

/** Required validation dependency for future HTTP wiring. Branch only on the
 * locked server node kind, never a request-body type or a client receipt.
 * Metadata is never coerced into component content or accepted for Apply.
 */
export function createWorkspaceAcceptance(reports: {
  component: (event: WorkspaceContentDiagnostic) => void;
  storyboard: (event: WorkspaceStoryboardDiagnostic) => void;
}) {
  const component = createWorkspaceComponentAcceptance(reports.component);
  const storyboard = createWorkspaceStoryboardAcceptance(reports.storyboard);
  return (tx: GenerationJobSql, context: WorkspaceEditContext, candidate: WorkspaceRevisionCandidate,
    allowed: ReadonlySet<CourseComponentType>) => context.node.kind === 'component'
      ? component(tx, context, candidate, allowed) : storyboard(tx, context, candidate);
}
