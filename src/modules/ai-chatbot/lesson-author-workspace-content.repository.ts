import { z } from 'zod';
import type { LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { WorkspaceEditAcceptance, WorkspaceEditContext } from './lesson-author-workspace-edit.repository.js';
import type { WorkspaceRevisionCandidate } from './lesson-author-workspace.logic.js';
import { readWorkspaceContent } from './lesson-author-workspace.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { editWorkspaceComponent, hydrateWorkspaceComponent, validateWorkspaceReadyComponentChapter, WorkspaceComponentError } from './lesson-author-workspace-component.logic.js';
import { readOrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import { prepareOrchestrationV2InventoryIdentity } from './lesson-author-orchestration-v2-inventory.logic.js';

// No connection/provider imports. Caller holds course/workspace/node locks and
// runs current RBAC, source and capability checks using this SAME transaction.
const MAX_NODES = 2048;
const MAX_SCOPE_BYTES = 16 * 1024 * 1024;
const ids = z.array(z.string().min(1).max(160)).max(4096).refine(v => new Set(v).size === v.length);
const planSchema = z.object({ component_plan_id: z.string().min(1).max(160),
  type: z.enum(['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram']),
  source_fact_ids: ids, supporting_evidence_fact_ids: ids.optional(), learning_objective_refs: ids.optional(),
  learning_block_ids: ids.optional(), title: z.string().optional(), rationale: z.string().optional(),
  purpose: z.enum(['explain', 'assess', 'clarify', 'sequence', 'relationship', 'terminology']).optional(),
  reason_code: z.string().optional(), content_requirements: z.array(z.string()).optional(),
  required_artifacts: z.array(z.object({ type: z.enum(['ordered_list', 'checklist', 'table', 'warning', 'requirement', 'exception', 'comparison']), minimum_items: z.number().int().positive().optional() })).optional(),
}).passthrough();
const unitSchema = z.object({ title: z.string().min(1), source_fact_ids: ids, supporting_evidence_fact_ids: ids.optional(),
  concept_ids: ids.optional(), learning_objective_refs: ids.optional(),
  learning_blocks: z.array(z.object({ id: z.string(), intent: z.string(), source_fact_ids: ids.optional(), learning_objective_refs: ids.optional() }).passthrough()).optional(),
  component_plan: z.array(planSchema).min(1).max(64),
}).passthrough();
const chapterSchema = z.object({ title: z.string().min(1), lessons: z.array(z.object({ title: z.string().min(1),
  learning_objectives: z.array(z.string().min(1)).max(12).optional(), primary_concept_ids: ids.optional(), supporting_concept_ids: ids.optional(),
  assessment_required: z.boolean().optional(), assessment_objective_refs: ids.optional(),
  units: z.array(unitSchema).min(1).max(256),
}).passthrough()).min(1).max(256) }).passthrough();
type Row = Record<string, unknown>;
function fail(code: 'WORKSPACE_COMPONENT_BINDING_INVALID' | 'WORKSPACE_COMPONENT_SCOPE_INCOMPLETE' | 'WORKSPACE_COMPONENT_ACCEPTANCE_FAILED' = 'WORKSPACE_COMPONENT_BINDING_INVALID'): never { throw new WorkspaceComponentError(code); }
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);
const setEqual = (a: unknown, b: unknown) => {
  const left = ids.safeParse(a ?? []), right = ids.safeParse(b ?? []);
  return left.success && right.success && left.data.length === right.data.length && left.data.every(v => right.data.includes(v));
};
const integer = (value: unknown): number => {
  if ((typeof value !== 'number' && !(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)))
    || !Number.isSafeInteger(Number(value)) || Number(value) < 0) fail();
  return Number(value);
};
function checkedRevision(row: Row, baseline: boolean) {
  const value = readWorkspaceContent(row[baseline ? 'baseline_content' : 'current_content']);
  if (hash(value) !== row[baseline ? 'baseline_hash' : 'current_hash']) fail();
  return value;
}
export interface WorkspaceContentDiagnostic {
  event: 'workspace_content_validation'; correlation_id: string; workspace_id: string; node_id: string;
  validation_contract: 'workspace-component-edit-ready-1' | 'workspace-component-edit-v2-ready-1'; status: 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL';
  scope_complete: boolean; ready_unit_count: number; deferred_check_count: number; finding_count: number;
  findings: Array<{ code: string; path: string }>; deferred_checks: Array<{ code: string; path: string }>;
  semantic_fidelity: 'not_measured'; duration_ms: number;
}

/** Production-content callback for the component Save/Reset branch only.
 * It cannot create nodes, authorize writes, Apply or produce course-ready proof.
 * Other node kinds remain fail-closed until their own typed adapters exist.
 */
export function createWorkspaceComponentAcceptance(report: (event: WorkspaceContentDiagnostic) => void) {
  return async (tx: GenerationJobSql, context: WorkspaceEditContext, candidate: WorkspaceRevisionCandidate,
    allowed: ReadonlySet<CourseComponentType>): Promise<WorkspaceEditAcceptance> => {
    const started = performance.now();
    if (context.node.kind !== 'component' || context.node.current_revision !== candidate.parent_revision
      || hash(candidate.content) !== candidate.content_hash) fail();
    const t = context.target;
    const bound = await tx.query(`SELECT n.canonical_path,b.blueprint,w.blueprint_id::text
      FROM lesson_author_workspaces w LEFT JOIN lesson_author_blueprints b ON b.id=w.blueprint_id
        AND b.tenant_id=w.tenant_id AND b.course_id=w.course_id AND b.conversation_id=w.conversation_id AND b.kb_id=w.kb_id
      JOIN lesson_author_workspace_nodes n ON n.workspace_id=w.id AND n.tenant_id=w.tenant_id AND n.course_id=w.course_id
      WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5 AND n.id=$6
        AND w.contract_version=1 AND w.engine='self_built_rag' AND w.source_snapshot_hash=$7
        AND ((w.blueprint_id IS NULL AND b.id IS NULL) OR (b.engine='self_built_rag' AND b.status='proposed'
          AND b.source_snapshot_hash=w.source_snapshot_hash))
        AND EXISTS (SELECT 1 FROM lesson_author_workspace_events e WHERE e.workspace_id=w.id AND e.event_kind='structure_ready')
      FOR SHARE OF w,n`, [t.workspaceId, t.tenantId, t.courseId, t.conversationId, t.userId, t.nodeId, context.source_snapshot_hash]);
    if (bound.rows.length !== 1) fail();
    const match = typeof bound.rows[0].canonical_path === 'string'
      ? /^(chapter_([1-9][0-9]*))\.lesson_([1-9][0-9]*)\.unit_([1-9][0-9]*)\.component_([1-9][0-9]*)$/.exec(bound.rows[0].canonical_path) : null;
    const blueprint = bound.rows[0].blueprint as Record<string, unknown> | null;
    if (!match) fail();
    const chapterPath = match[1];
    let chapter: z.infer<typeof chapterSchema>;
    let v2Identity: ReturnType<typeof prepareOrchestrationV2InventoryIdentity> | null = null;
    if (blueprint) {
      if (blueprint.architecture_contract_version !== 5 || blueprint.content_contract_version !== 1
        || !Array.isArray(blueprint.chapters)) fail();
      const parsed = chapterSchema.safeParse(blueprint.chapters[Number(match[2]) - 1]);
      if (!parsed.success) fail();
      chapter = parsed.data;
    } else {
      if (bound.rows[0].blueprint_id !== null) fail();
      const architecture = await tx.query(`SELECT r.id::text AS run_id,a.payload,a.artifact_hash
        FROM lesson_author_workspace_v2_runs r
        JOIN lesson_author_workspace_v2_tasks task ON task.run_id=r.id AND task.workspace_id=r.workspace_id
          AND task.tenant_id=r.tenant_id AND task.course_id=r.course_id AND task.kind='validate_architecture' AND task.status='succeeded'
        JOIN lesson_author_workspace_v2_artifacts a ON a.task_id=task.id AND a.run_id=task.run_id
          AND a.workspace_id=task.workspace_id AND a.tenant_id=task.tenant_id AND a.course_id=task.course_id
          AND a.artifact_kind='architecture_validation' AND a.artifact_hash=task.result_hash
        WHERE r.workspace_id=$1 AND r.tenant_id=$2 AND r.course_id=$3 AND r.status IN ('executing','ready','needs_action')
        FOR SHARE OF r,task,a`, [t.workspaceId, t.tenantId, t.courseId]);
      if (architecture.rows.length !== 1) fail();
      const assembly = readOrchestrationV2ArchitectureAssembly(architecture.rows[0].payload);
      if (assembly.assembly_hash !== architecture.rows[0].artifact_hash
        || assembly.source_snapshot_hash !== context.source_snapshot_hash) fail();
      v2Identity = prepareOrchestrationV2InventoryIdentity({ run_id: String(architecture.rows[0].run_id), assembly });
      const source = assembly.architecture.chapters[Number(match[2]) - 1];
      if (!source) fail();
      const identityByPath = new Map(v2Identity.nodes.map(node => [node.canonical_path, node]));
      const parsed = chapterSchema.safeParse({ title: source.title, lessons: source.lessons.map((lesson, li) => ({
        title: lesson.title, learning_objectives: lesson.learning_objectives,
        units: lesson.units.map((unit, ui) => ({ title: unit.title, source_fact_ids: [],
          learning_objective_refs: unit.learning_objective_refs,
          component_plan: unit.component_plan.map((plan, ci) => {
            const expected = identityByPath.get(`${chapterPath}.lesson_${li + 1}.unit_${ui + 1}.component_${ci + 1}`);
            const metadata = expected?.protected_contract.metadata as Record<string, unknown> | undefined;
            return { type: plan.type, title: plan.title, rationale: plan.rationale,
              component_plan_id: metadata?.component_plan_id,
              source_fact_ids: metadata?.source_fact_ids ?? [],
              supporting_evidence_fact_ids: metadata?.supporting_evidence_fact_ids ?? [],
              learning_objective_refs: metadata?.learning_objective_refs ?? [] };
          }) })),
      })) });
      if (!parsed.success) fail();
      chapter = parsed.data;
    }
    const params = [t.workspaceId, t.tenantId, t.courseId, chapterPath];
    // Inspect sizes before transferring learner payloads; overflow is explicit,
    // never a truncated graph that might accidentally pass coverage validation.
    const size = await tx.query(`SELECT count(*)::text AS node_count,
        COALESCE(sum(octet_length(n.protected_contract::text)+COALESCE(octet_length(b.content::text),0)+COALESCE(octet_length(r.content::text),0)),0)::text AS scope_bytes
      FROM lesson_author_workspace_nodes n
      LEFT JOIN lesson_author_workspace_revisions b ON b.workspace_id=n.workspace_id AND b.node_id=n.id AND b.revision=0
      LEFT JOIN lesson_author_workspace_revisions r ON r.workspace_id=n.workspace_id AND r.node_id=n.id AND r.revision=n.current_revision
      WHERE n.workspace_id=$1 AND n.tenant_id=$2 AND n.course_id=$3 AND split_part(n.canonical_path,'.',1)=$4
        AND n.kind IN ('chapter','lesson','unit','component')`, params);
    if (size.rows.length !== 1 || integer(size.rows[0].node_count) > MAX_NODES || integer(size.rows[0].scope_bytes) > MAX_SCOPE_BYTES) fail('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE');
    const result = await tx.query(`SELECT n.id,n.parent_id,n.kind,n.canonical_path,n.sort_order,n.content_state,n.current_revision,n.protected_contract,n.contract_hash,
        b.origin AS baseline_origin,b.user_modified AS baseline_modified,b.content AS baseline_content,b.content_hash AS baseline_hash,
        r.content AS current_content,r.content_hash AS current_hash
      FROM lesson_author_workspace_nodes n
      LEFT JOIN lesson_author_workspace_revisions b ON b.workspace_id=n.workspace_id AND b.node_id=n.id AND b.revision=0
      LEFT JOIN lesson_author_workspace_revisions r ON r.workspace_id=n.workspace_id AND r.node_id=n.id AND r.revision=n.current_revision
      WHERE n.workspace_id=$1 AND n.tenant_id=$2 AND n.course_id=$3 AND split_part(n.canonical_path,'.',1)=$4
        AND n.kind IN ('chapter','lesson','unit','component')
      ORDER BY n.canonical_path LIMIT 2049`, params);
    if (result.rows.length !== integer(size.rows[0].node_count) || result.rows.length > MAX_NODES) fail();
    const nodes = new Map<string, Row>();
    const v2Expected = v2Identity ? new Map(v2Identity.nodes
      .filter(node => node.canonical_path === chapterPath || node.canonical_path.startsWith(`${chapterPath}.`))
      .filter(node => ['chapter', 'lesson', 'unit', 'component'].includes(node.kind))
      .map(node => [node.canonical_path, node])) : null;
    for (const row of result.rows) {
      if (typeof row.canonical_path !== 'string' || nodes.has(row.canonical_path) || hash(row.protected_contract) !== row.contract_hash) fail();
      const expected = v2Expected?.get(row.canonical_path);
      if (v2Expected && (!expected || row.id !== expected.id || row.parent_id !== expected.parent_id
        || row.kind !== expected.kind || integer(row.sort_order) !== expected.sort_order
        || row.contract_hash !== expected.contract_hash || !equal(row.protected_contract, expected.protected_contract))) fail();
      nodes.set(row.canonical_path, row);
    }
    if (v2Expected && nodes.size !== v2Expected.size) fail('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE');

    // Orchestration v2 already binds the complete chapter topology to the
    // hashed architecture artifact above. Saving one component must validate
    // that exact component against its immutable binding, but it must not
    // materialize every sibling payload: a stale/unrelated sibling would make
    // an otherwise valid author edit impossible to save. Apply/finalization
    // still compile and validate the requested hierarchy as a whole.
    if (v2Expected) {
      const targetRow = nodes.get(String(bound.rows[0].canonical_path));
      const lesson = chapter.lessons[Number(match[3]) - 1];
      const unit = lesson?.units[Number(match[4]) - 1];
      const plan = unit?.component_plan[Number(match[5]) - 1];
      const unitPath = `${chapterPath}.lesson_${match[3]}.unit_${match[4]}`;
      const unitRow = nodes.get(unitPath);
      if (!targetRow || targetRow.kind !== 'component' || !unitRow || unitRow.kind !== 'unit'
        || unitRow.content_state !== 'content_ready' || !plan
        || targetRow.id !== t.nodeId || targetRow.contract_hash !== context.contract_hash
        || !equal(targetRow.protected_contract, context.protected_contract)
        || targetRow.content_state !== 'content_ready' || targetRow.current_revision === null
        || integer(targetRow.current_revision) !== candidate.parent_revision
        || targetRow.baseline_origin !== 'ai_baseline' || targetRow.baseline_modified !== false) fail();
      const baseline = checkedRevision(targetRow, true), current = checkedRevision(targetRow, false);
      if (!equal(baseline, context.node.baseline) || !equal(current, context.node.current)) fail();
      const original = hydrateWorkspaceComponent(targetRow.protected_contract, baseline, allowed);
      const metadata = original.metadata ?? {};
      if (original.type !== plan.type || metadata.component_plan_id !== plan.component_plan_id
        || !setEqual(metadata.source_fact_ids, plan.source_fact_ids)
        || !setEqual(metadata.supporting_evidence_fact_ids, plan.supporting_evidence_fact_ids)
        || (metadata.learning_objective_refs !== undefined
          && !setEqual(metadata.learning_objective_refs, plan.learning_objective_refs))) fail();
      // Validate both the persisted parent and the requested candidate. This
      // catches capability/schema/reference drift without coupling Save to
      // unrelated learner payloads elsewhere in the chapter.
      editWorkspaceComponent(original, current, allowed);
      editWorkspaceComponent(original, candidate.content, allowed);
      const unitPaths = chapter.lessons.flatMap((chapterLesson, lessonIndex) => chapterLesson.units.map((_chapterUnit, unitIndex) =>
        `${chapterPath}.lesson_${lessonIndex + 1}.unit_${unitIndex + 1}`));
      const readyUnitCount = unitPaths.filter(path => nodes.get(path)?.content_state === 'content_ready').length;
      const deferredChecks = unitPaths.filter(path => nodes.get(path)?.content_state !== 'content_ready')
        .map(path => ({ code: 'WORKSPACE_UNIT_CONTENT_PENDING', path }));
      const validationContract = 'workspace-component-edit-v2-ready-1' as const;
      try { report({ event: 'workspace_content_validation', correlation_id: context.correlation_id, workspace_id: t.workspaceId, node_id: t.nodeId,
        validation_contract: validationContract, status: 'PASS', scope_complete: readyUnitCount === unitPaths.length,
        ready_unit_count: readyUnitCount, deferred_check_count: deferredChecks.length, finding_count: 0,
        findings: [], deferred_checks: deferredChecks, semantic_fidelity: 'not_measured',
        duration_ms: Math.max(0, Math.round(performance.now() - started)) }); } catch { /* Telemetry does not change acceptance. */ }
      return { workspace_id: t.workspaceId, node_id: t.nodeId, expected_revision: candidate.parent_revision,
        content_hash: candidate.content_hash, source_snapshot_hash: context.source_snapshot_hash, contract_hash: context.contract_hash,
        validation_contract: validationContract,
        checks: { schema: 'PASS', security: 'PASS', references: 'PASS', pedagogy: 'NOT_RUN', registry: 'PASS' } };
    }
    const seen = new Set<string>();
    function take(path: string, kind: string, parent?: Row, order?: number) {
      const row = nodes.get(path);
      if (!row || row.kind !== kind || (parent && row.parent_id !== parent.id) || (order !== undefined && integer(row.sort_order) !== order)) fail();
      seen.add(path); return row;
    }
    const root = take(chapterPath, 'chapter');
    const readyUnits = new Set<string>();
    let targetSeen = false;
    const proposal: LessonAuthorProposal = { summary: '', chapters: [{ title: chapter.title, lessons: chapter.lessons.map((lesson, li) => {
      const lessonPath = `${chapterPath}.lesson_${li + 1}`, lessonNode = take(lessonPath, 'lesson', root, li);
      return { title: lesson.title, units: lesson.units.map((unit, ui) => {
        const unitPath = `${lessonPath}.unit_${ui + 1}`, unitNode = take(unitPath, 'unit', lessonNode, ui);
        const ready = unitNode.content_state === 'content_ready';
        if (ready) readyUnits.add(`${li}:${ui}`);
        const components = unit.component_plan.map((plan, ci) => {
          const path = `${unitPath}.component_${ci + 1}`, node = take(path, 'component', unitNode, ci);
          if (!ready) {
            if (node.content_state === 'content_ready' || node.current_revision !== null || node.baseline_content !== null) fail('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE');
            return null;
          }
          if (node.content_state !== 'content_ready' || node.current_revision === null || node.baseline_origin !== 'ai_baseline' || node.baseline_modified !== false) fail('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE');
          integer(node.current_revision);
          const baseline = checkedRevision(node, true), current = checkedRevision(node, false);
          const original = hydrateWorkspaceComponent(node.protected_contract, baseline, allowed);
          const metadata = original.metadata ?? {};
          if (original.type !== plan.type || metadata.component_plan_id !== plan.component_plan_id
            || !setEqual(metadata.source_fact_ids, plan.source_fact_ids)
            || !setEqual(metadata.supporting_evidence_fact_ids, plan.supporting_evidence_fact_ids)
            || (metadata.learning_objective_refs !== undefined && !setEqual(metadata.learning_objective_refs, plan.learning_objective_refs))) fail();
          if (node.id === t.nodeId) {
            if (targetSeen || node.canonical_path !== bound.rows[0].canonical_path || node.contract_hash !== context.contract_hash
              || !equal(node.protected_contract, context.protected_contract) || integer(node.current_revision) !== candidate.parent_revision
              || !equal(baseline, context.node.baseline) || !equal(current, context.node.current)) fail();
            targetSeen = true;
            return editWorkspaceComponent(original, candidate.content, allowed);
          }
          return editWorkspaceComponent(original, current, allowed);
        }).filter((c): c is NonNullable<typeof c> => c !== null);
        return { title: unit.title, source_fact_ids: unit.source_fact_ids, components };
      }) };
    }) }] };
    if (!targetSeen || seen.size !== nodes.size) fail();
    const validation = v2Identity ? {
      status: 'PASS' as const, findings: [] as Array<{ code: string; path: string }>,
      scope_complete: readyUnits.size === chapter.lessons.reduce((count, lesson) => count + lesson.units.length, 0),
      deferred_checks: chapter.lessons.flatMap((lesson, li) => lesson.units.flatMap((_unit, ui) => readyUnits.has(`${li}:${ui}`)
        ? [] : [{ code: 'WORKSPACE_UNIT_CONTENT_PENDING', path: `chapter_1.lesson_${li + 1}.unit_${ui + 1}` }])),
    } : validateWorkspaceReadyComponentChapter({ proposal, blueprint: chapter, allowed, readyUnits });
    const validationContract = v2Identity ? 'workspace-component-edit-v2-ready-1' as const : 'workspace-component-edit-ready-1' as const;
    try { report({ event: 'workspace_content_validation', correlation_id: context.correlation_id, workspace_id: t.workspaceId, node_id: t.nodeId,
      validation_contract: validationContract, status: validation.status, scope_complete: validation.scope_complete,
      ready_unit_count: readyUnits.size, deferred_check_count: validation.deferred_checks.length, finding_count: validation.findings.length,
      findings: validation.findings.slice(0, 100).map(f => ({ ...f, path: f.path.replace(/^chapter_1(?=\.|$)/, chapterPath) })),
      deferred_checks: validation.deferred_checks.slice(0, 100).map(f => ({ ...f, path: f.path.replace(/^chapter_1(?=\.|$)/, chapterPath) })),
      semantic_fidelity: 'not_measured', duration_ms: Math.max(0, Math.round(performance.now() - started)) }); } catch { /* Telemetry does not change acceptance. */ }
    if (validation.status === 'FAIL') fail('WORKSPACE_COMPONENT_ACCEPTANCE_FAILED');
    return { workspace_id: t.workspaceId, node_id: t.nodeId, expected_revision: candidate.parent_revision,
      content_hash: candidate.content_hash, source_snapshot_hash: context.source_snapshot_hash, contract_hash: context.contract_hash,
      validation_contract: validationContract,
      checks: { schema: 'PASS', security: 'PASS', references: 'PASS',
        pedagogy: v2Identity ? 'NOT_RUN' : 'PASS', registry: 'PASS' } };
  };
}
