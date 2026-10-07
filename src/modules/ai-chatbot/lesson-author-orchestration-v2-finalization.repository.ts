import { randomUUID } from 'node:crypto';
import type { GenerationJobDatabase } from './lesson-author-generation-job.repository.js';
import { readOrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import type { OrchestrationV2ChapterReceipt } from './lesson-author-orchestration-v2-chapter.logic.js';
import {
  finalizeOrchestrationV2Course,
  ORCHESTRATION_V2_COURSE_CONTRACT,
  ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT,
  type OrchestrationV2AssessmentObligationEvidence,
  type OrchestrationV2CourseFinalization,
  type OrchestrationV2FinalizationTask,
} from './lesson-author-orchestration-v2-finalization.logic.js';
import { orchestrationV2Hash, type OrchestrationV2TaskKind } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2TaskLease, createOrchestrationV2WorkerRepository } from './lesson-author-orchestration-v2-worker.repository.js';
import { IDM_DISPOSITIONS } from './lesson-author-idm.contract.js';
import { loadIdmRunScopeView } from './lesson-author-idm-scope-view.repository.js';

type WorkerRepository = ReturnType<typeof createOrchestrationV2WorkerRepository>;

export class OrchestrationV2FinalizationRepositoryError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_FINALIZATION_AUTHORITY_INVALID'
    | 'ORCHESTRATION_V2_FINALIZATION_EVIDENCE_INVALID'
    | 'ORCHESTRATION_V2_FINALIZATION_STATE_INVALID'
    | 'ORCHESTRATION_V2_FINALIZATION_WRITE_UNCONFIRMED') {
    super(code);
    this.name = 'OrchestrationV2FinalizationRepositoryError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const fail = (code: OrchestrationV2FinalizationRepositoryError['code']): never => {
  throw new OrchestrationV2FinalizationRepositoryError(code);
};
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;
const liveLeaseSql = (alias = 't') => `${alias}.id=$1 AND ${alias}.run_id=$2 AND ${alias}.workspace_id=$3
  AND ${alias}.tenant_id=$4 AND ${alias}.status='running' AND ${alias}.lease_token=$5::uuid
  AND ${alias}.lease_expires_at>clock_timestamp() AND ${alias}.deadline_at>clock_timestamp()`;

export function createOrchestrationV2FinalizationRepository(
  db: GenerationJobDatabase,
  worker: WorkerRepository,
  id: () => string = randomUUID,
) {
  async function load(lease: OrchestrationV2TaskLease): Promise<Readonly<OrchestrationV2CourseFinalization>> {
    if (lease.kind !== 'finalize_course' || lease.chapter_key !== null || lease.node_id !== null
      || !lease.input_context_hash) fail('ORCHESTRATION_V2_FINALIZATION_STATE_INVALID');
    return db.transaction(async tx => {
      const authority = await tx.query(`SELECT w.status AS workspace_status,w.blueprint_id::text,
          r.status AS run_status,r.manifest_hash,r.task_count,r.chapter_count,r.admitted_fact_count,
          s.status AS snapshot_status,s.fact_count AS snapshot_fact_count,t.execution_budget_ms
        FROM lesson_author_workspace_v2_tasks t
        JOIN lesson_author_workspace_v2_runs r ON r.id=t.run_id AND r.workspace_id=t.workspace_id
          AND r.tenant_id=t.tenant_id AND r.course_id=t.course_id
        JOIN lesson_author_workspace_source_snapshots s ON s.id=r.source_snapshot_id AND s.workspace_id=r.workspace_id
        JOIN lesson_author_workspaces w ON w.id=t.workspace_id AND w.tenant_id=t.tenant_id AND w.course_id=t.course_id
        JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.user_id=w.requested_by
          AND c.course_id=w.course_id AND c.bot_id=w.bot_id AND c.target='lesson_author'
        WHERE ${liveLeaseSql()} AND w.status='drafting' AND w.blueprint_id IS NULL
          AND r.status='executing' AND s.status='sealed' FOR SHARE OF w,r,s,c`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      const row = authority.rows[0];
      if (authority.rows.length !== 1 || !row || !HASH.test(String(row.manifest_hash))
        || Number(row.admitted_fact_count) !== Number(row.snapshot_fact_count)
        || Number(row.task_count) < 1 || Number(row.chapter_count) < 1) {
        fail('ORCHESTRATION_V2_FINALIZATION_AUTHORITY_INVALID');
      }
      const artifacts = await tx.query(`SELECT a.artifact_kind,a.artifact_hash,a.payload,t.task_key,t.kind,
          t.chapter_key,t.node_id::text,t.result_hash,t.validation_contract,t.ordinal
        FROM lesson_author_workspace_v2_artifacts a
        JOIN lesson_author_workspace_v2_tasks t ON t.id=a.task_id AND t.run_id=a.run_id
        WHERE a.run_id=$1 AND a.workspace_id=$2 AND a.tenant_id=$3 AND a.course_id=$4
          AND t.status='succeeded' AND a.artifact_kind IN
            ('architecture_validation','inventory_receipt','chapter_receipt')
        ORDER BY t.ordinal,a.artifact_kind`,
      [lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id]);
      const architectureRow = artifacts.rows.find(item => item.artifact_kind === 'architecture_validation');
      const inventoryRow = artifacts.rows.find(item => item.artifact_kind === 'inventory_receipt');
      const inventory = record(inventoryRow?.payload);
      if (!architectureRow || !inventory || !HASH.test(String(inventory.inventory_hash))) {
        fail('ORCHESTRATION_V2_FINALIZATION_EVIDENCE_INVALID');
      }
      const architectureArtifact = architectureRow!;
      const inventoryPayload = inventory!;
      const assembly = readOrchestrationV2ArchitectureAssembly(architectureArtifact.payload);
      if (assembly.assembly_hash !== architectureArtifact.artifact_hash
        || assembly.source_snapshot_hash !== lease.source_snapshot_hash
        || Number(inventoryPayload.admitted_fact_count) !== Number(row.admitted_fact_count)
        || inventoryPayload.manifest_hash !== row.manifest_hash) {
        fail('ORCHESTRATION_V2_FINALIZATION_EVIDENCE_INVALID');
      }
      const obligationResult = await tx.query(`SELECT planned_slot_key,plan_revision_hash,unit_path,
          planned_component_index,learning_objective_refs,required_assessment_kind,relevant_scope_ids,
          relevant_evidence_fact_ids,unresolved_reason,status,resolution_kind,resolution_evidence_hash
        FROM lesson_author_workspace_v2_assessment_obligations
        WHERE run_id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4
        ORDER BY planned_slot_key FOR SHARE`,
      [lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id]);
      const assessmentObligations: OrchestrationV2AssessmentObligationEvidence[] = obligationResult.rows.map(item => ({
        planned_slot_key: String(item.planned_slot_key), plan_revision_hash: String(item.plan_revision_hash),
        status: item.status as 'open' | 'resolved',
        resolution_kind: item.resolution_kind === null ? null
          : item.resolution_kind as 'valid_assessment' | 'approved_replan',
        resolution_evidence_hash: item.resolution_evidence_hash === null ? null : String(item.resolution_evidence_hash),
      }));
      const obligationProjection = obligationResult.rows.map(item => ({
        planned_slot_key: String(item.planned_slot_key), unit_path: String(item.unit_path),
        planned_component_index: Number(item.planned_component_index),
        learning_objective_refs: item.learning_objective_refs as string[],
        required_assessment_kind: String(item.required_assessment_kind),
        relevant_scope_ids: item.relevant_scope_ids as string[],
        relevant_evidence_fact_ids: item.relevant_evidence_fact_ids as string[],
        unresolved_reason: String(item.unresolved_reason), status: 'open' as const,
      })).sort((left, right) => left.planned_slot_key.localeCompare(right.planned_slot_key));
      const assemblyObligations = [...(assembly.assessment_obligations ?? [])]
        .sort((left, right) => left.planned_slot_key.localeCompare(right.planned_slot_key));
      if (obligationProjection.length !== (assembly.assessment_obligation_count ?? 0)
        || orchestrationV2Hash(obligationProjection) !== orchestrationV2Hash(assemblyObligations)
        || (assembly.assessment_obligation_hash !== undefined
          && orchestrationV2Hash(assemblyObligations) !== assembly.assessment_obligation_hash)) {
        fail('ORCHESTRATION_V2_FINALIZATION_EVIDENCE_INVALID');
      }
      const tasksResult = await tx.query(`SELECT id::text,ordinal,task_key,kind,chapter_key,node_id::text,
          contract_hash,input_context_hash,priority,max_attempts,input_tokens,embedding_tokens,max_output_tokens,
          provider_max_attempts,execution_budget_ms,status,result_hash,validation_contract
        FROM lesson_author_workspace_v2_tasks WHERE run_id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4
        ORDER BY ordinal FOR SHARE`, [lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id]);
      const dependencies = await tx.query(`SELECT child.task_key AS child_key,parent.task_key AS parent_key,parent.ordinal
        FROM lesson_author_workspace_v2_dependencies d
        JOIN lesson_author_workspace_v2_tasks child ON child.id=d.task_id AND child.run_id=d.run_id
        JOIN lesson_author_workspace_v2_tasks parent ON parent.id=d.depends_on_task_id AND parent.run_id=d.run_id
        WHERE d.run_id=$1 ORDER BY child.ordinal,parent.ordinal`, [lease.run_id]);
      const byChild = new Map<string, string[]>();
      for (const dependency of dependencies.rows) {
        const list = byChild.get(String(dependency.child_key)) ?? [];
        list.push(String(dependency.parent_key)); byChild.set(String(dependency.child_key), list);
      }
      const tasks: OrchestrationV2FinalizationTask[] = tasksResult.rows.map(item => ({
        ordinal: Number(item.ordinal), task_key: String(item.task_key), kind: item.kind as OrchestrationV2TaskKind,
        chapter_key: item.chapter_key === null ? null : String(item.chapter_key),
        node_id: item.node_id === null ? null : String(item.node_id), contract_hash: String(item.contract_hash),
        input_context_hash: item.input_context_hash === null ? null : String(item.input_context_hash),
        priority: Number(item.priority), max_attempts: Number(item.max_attempts),
        depends_on: byChild.get(String(item.task_key)) ?? [], budget: { input_tokens: Number(item.input_tokens),
          embedding_tokens: Number(item.embedding_tokens), max_output_tokens: Number(item.max_output_tokens),
          max_provider_attempts: Number(item.provider_max_attempts), execution_budget_ms: Number(item.execution_budget_ms) },
        status: item.status as 'running' | 'succeeded',
        result_hash: item.result_hash === null ? null : String(item.result_hash),
        validation_contract: item.validation_contract === null ? null : String(item.validation_contract),
      }));
      const chapterTasks = tasks.filter(task => task.kind === 'validate_chapter');
      const expectedInputHash = orchestrationV2Hash({ assembly_hash: assembly.assembly_hash,
        inventory_hash: inventoryPayload.inventory_hash, chapter_validation_keys: chapterTasks.map(task => task.task_key) });
      const budget = { input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0,
        max_provider_attempts: 0, execution_budget_ms: Number(row.execution_budget_ms) };
      const expectedContractHash = orchestrationV2Hash({ contract_version: 2, task_key: 'course:finalize',
        kind: 'finalize_course', input_context_hash: expectedInputHash, budget });
      if (expectedInputHash !== lease.input_context_hash || expectedContractHash !== lease.contract_hash
        || tasks.length !== Number(row.task_count) || chapterTasks.length !== Number(row.chapter_count)) {
        fail('ORCHESTRATION_V2_FINALIZATION_EVIDENCE_INVALID');
      }
      const chapterArtifacts = artifacts.rows.filter(item => item.artifact_kind === 'chapter_receipt');
      if (chapterArtifacts.length !== chapterTasks.length) fail('ORCHESTRATION_V2_FINALIZATION_EVIDENCE_INVALID');
      const receipts = chapterArtifacts.map(item => {
        const payload = record(item.payload);
        if (!payload || item.artifact_hash !== item.result_hash || payload.receipt_hash !== item.artifact_hash
          || payload.contract !== 'orchestration-chapter-receipt-v2'
          || item.validation_contract !== 'orchestration-chapter-receipt-v2') {
          return fail('ORCHESTRATION_V2_FINALIZATION_EVIDENCE_INVALID');
        }
        const { contract_version: _version, ...receipt } = payload;
        return receipt as unknown as OrchestrationV2ChapterReceipt;
      });
      if (assembly.idm === undefined) {
        return finalizeOrchestrationV2Course({ source_snapshot_hash: lease.source_snapshot_hash,
          expected_manifest_hash: String(row.manifest_hash), admitted_fact_count: Number(row.admitted_fact_count),
          assembly_hash: assembly.assembly_hash, inventory_hash: String(inventoryPayload.inventory_hash), tasks,
          chapter_receipts: receipts, assessment_obligations: assessmentObligations });
      }
      // IDM (spec §8.5): every snapshot fact has exactly one disposition in the design
      // (re-verified through the scope view) and the assembly carries the same counts.
      const view = await loadIdmRunScopeView(tx, lease, assembly.idm.design_hash);
      if (view.design.dispositions.length !== Number(row.admitted_fact_count)
        || IDM_DISPOSITIONS.some(name => view.dispositionCounts[name] !== assembly.idm!.disposition_counts[name])) {
        fail('ORCHESTRATION_V2_FINALIZATION_EVIDENCE_INVALID');
      }
      return finalizeOrchestrationV2Course({ source_snapshot_hash: lease.source_snapshot_hash,
        expected_manifest_hash: String(row.manifest_hash), admitted_fact_count: Number(row.admitted_fact_count),
        assembly_hash: assembly.assembly_hash, inventory_hash: String(inventoryPayload.inventory_hash), tasks,
        chapter_receipts: receipts, assessment_obligations: assessmentObligations,
        idm_accounting: { ...view.dispositionCounts } });
    });
  }

  async function complete(lease: OrchestrationV2TaskLease,
    finalization: Readonly<OrchestrationV2CourseFinalization>): Promise<void> {
    if (lease.kind !== 'finalize_course'
      || ![ORCHESTRATION_V2_COURSE_CONTRACT, ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT].includes(finalization.contract)
      || !HASH.test(finalization.course_artifact_hash)) fail('ORCHESTRATION_V2_FINALIZATION_STATE_INVALID');
    await worker.succeed(lease, finalization.course_artifact_hash, finalization.contract, {}, {
      artifact_kind: 'course_receipt', artifact_hash: finalization.course_artifact_hash,
      payload: { contract_version: 2, ...finalization }, validation_contract: finalization.contract,
    }, async () => undefined, {
      beforeSuccess: async tx => {
        const run = await tx.query(`UPDATE lesson_author_workspace_v2_runs SET status='finalizing'
          WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 AND status='executing'
          RETURNING id::text`, [lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id]);
        if (run.rows.length !== 1) fail('ORCHESTRATION_V2_FINALIZATION_WRITE_UNCONFIRMED');
      },
      afterSuccess: async tx => {
        const receiptId = id();
        if (!UUID.test(receiptId)) fail('ORCHESTRATION_V2_FINALIZATION_WRITE_UNCONFIRMED');
        if (finalization.contract === ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT) {
          const review = finalization.review;
          const insertedReview = await tx.query(`INSERT INTO lesson_author_workspace_v2_review_receipts
              (id,run_id,workspace_id,tenant_id,course_id,contract_version,manifest_hash,task_count,
               admitted_fact_count,allocated_fact_count,covered_fact_count,duplicate_fact_count,
               unresolved_fact_count,chapter_receipt_count,open_assessment_obligation_count,
               assessment_obligation_set_hash,checks,receipt_hash)
            VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,0,0,$11,$12,$13,$14::jsonb,$15)
            RETURNING id::text`, [receiptId, lease.run_id, lease.workspace_id, lease.tenant_id,
            lease.course_id, review.manifest_hash, review.task_count, review.admitted_fact_count,
            review.allocated_fact_count, review.covered_fact_count, review.chapter_receipt_count,
            review.open_assessment_obligation_count, review.assessment_obligation_set_hash,
            JSON.stringify(review.checks), review.receipt_hash]);
          const event = await tx.query(`INSERT INTO lesson_author_workspace_events
              (workspace_id,tenant_id,course_id,event_kind,operation_id)
            VALUES($1,$2,$3,'run_needs_action',$4) RETURNING sequence`,
          [lease.workspace_id, lease.tenant_id, lease.course_id, lease.task_id]);
          const run = await tx.query(`UPDATE lesson_author_workspace_v2_runs
            SET status='needs_action',failure_code='ASSESSMENT_REVIEW_REQUIRED',finished_at=clock_timestamp()
            WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 AND status='finalizing'
            RETURNING id::text`, [lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id]);
          const workspace = await tx.query(`UPDATE lesson_author_workspaces
            SET status='needs_action',updated_at=clock_timestamp()
            WHERE id=$1 AND tenant_id=$2 AND course_id=$3 AND status='drafting' AND blueprint_id IS NULL
            RETURNING id::text`, [lease.workspace_id, lease.tenant_id, lease.course_id]);
          if ([insertedReview, event, run, workspace].some(value => value.rows.length !== 1)) {
            fail('ORCHESTRATION_V2_FINALIZATION_WRITE_UNCONFIRMED');
          }
          return;
        }
        const completion = finalization.completion;
        const inserted = await tx.query(`INSERT INTO lesson_author_workspace_v2_completion_receipts
            (id,run_id,workspace_id,tenant_id,course_id,contract_version,manifest_hash,task_count,
             admitted_fact_count,allocated_fact_count,covered_fact_count,duplicate_fact_count,
             unresolved_fact_count,chapter_receipt_count,checks,receipt_hash)
          VALUES($1,$2,$3,$4,$5,2,$6,$7,$8,$9,$10,0,0,$11,$12::jsonb,$13) RETURNING id::text`,
        [receiptId, lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id,
          completion.manifest_hash, completion.task_count, completion.admitted_fact_count,
          completion.allocated_fact_count, completion.covered_fact_count, completion.chapter_receipt_count,
          JSON.stringify(completion.checks), completion.receipt_hash]);
        if (inserted.rows.length !== 1) fail('ORCHESTRATION_V2_FINALIZATION_WRITE_UNCONFIRMED');
        const event = await tx.query(`INSERT INTO lesson_author_workspace_events
            (workspace_id,tenant_id,course_id,event_kind,operation_id)
          VALUES($1,$2,$3,'run_ready',$4) RETURNING sequence`,
        [lease.workspace_id, lease.tenant_id, lease.course_id, lease.task_id]);
        if (event.rows.length !== 1) fail('ORCHESTRATION_V2_FINALIZATION_WRITE_UNCONFIRMED');
        const run = await tx.query(`UPDATE lesson_author_workspace_v2_runs SET status='ready',finished_at=clock_timestamp()
          WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 AND status='finalizing'
          RETURNING id::text`, [lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id]);
        const workspace = await tx.query(`UPDATE lesson_author_workspaces SET status='ready',updated_at=clock_timestamp()
          WHERE id=$1 AND tenant_id=$2 AND course_id=$3 AND status='drafting' AND blueprint_id IS NULL
          RETURNING id::text`, [lease.workspace_id, lease.tenant_id, lease.course_id]);
        if (run.rows.length !== 1 || workspace.rows.length !== 1) {
          fail('ORCHESTRATION_V2_FINALIZATION_WRITE_UNCONFIRMED');
        }
      },
    });
  }

  return { load, complete };
}
