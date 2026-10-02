import { randomUUID } from 'node:crypto';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { readOrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import {
  ORCHESTRATION_V2_CHAPTER_CONTRACT,
  validateOrchestrationV2Chapter,
  type OrchestrationV2ChapterReceipt,
} from './lesson-author-orchestration-v2-chapter.logic.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import type { OrchestrationV2TaskLease, createOrchestrationV2WorkerRepository } from './lesson-author-orchestration-v2-worker.repository.js';

type WorkerRepository = ReturnType<typeof createOrchestrationV2WorkerRepository>;

export class OrchestrationV2ChapterRepositoryError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_CHAPTER_AUTHORITY_INVALID'
    | 'ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID'
    | 'ORCHESTRATION_V2_CHAPTER_STATE_INVALID'
    | 'ORCHESTRATION_V2_CHAPTER_WRITE_UNCONFIRMED') {
    super(code);
    this.name = 'OrchestrationV2ChapterRepositoryError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const fail = (code: OrchestrationV2ChapterRepositoryError['code']): never => {
  throw new OrchestrationV2ChapterRepositoryError(code);
};
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;
const liveLeaseSql = (alias = 't') => `${alias}.id=$1 AND ${alias}.run_id=$2 AND ${alias}.workspace_id=$3
  AND ${alias}.tenant_id=$4 AND ${alias}.status='running' AND ${alias}.lease_token=$5::uuid
  AND ${alias}.lease_expires_at>clock_timestamp() AND ${alias}.deadline_at>clock_timestamp()`;

export function createOrchestrationV2ChapterRepository(
  db: GenerationJobDatabase,
  worker: WorkerRepository,
  id: () => string = randomUUID,
) {
  async function load(lease: OrchestrationV2TaskLease): Promise<Readonly<OrchestrationV2ChapterReceipt>> {
    if (lease.kind !== 'validate_chapter' || !lease.chapter_key || !lease.node_id || !lease.input_context_hash) {
      fail('ORCHESTRATION_V2_CHAPTER_STATE_INVALID');
    }
    return db.transaction(async tx => {
      const authority = await tx.query(`SELECT w.status AS workspace_status,w.blueprint_id::text,
          r.status AS run_status,r.manifest_hash,s.status AS snapshot_status,n.canonical_path,n.kind,
          n.content_state,n.current_revision,t.task_key,t.execution_budget_ms
        FROM lesson_author_workspace_v2_tasks t
        JOIN lesson_author_workspace_v2_runs r ON r.id=t.run_id AND r.workspace_id=t.workspace_id
          AND r.tenant_id=t.tenant_id AND r.course_id=t.course_id
        JOIN lesson_author_workspace_source_snapshots s ON s.id=r.source_snapshot_id AND s.workspace_id=r.workspace_id
        JOIN lesson_author_workspaces w ON w.id=t.workspace_id AND w.tenant_id=t.tenant_id AND w.course_id=t.course_id
        JOIN lesson_author_workspace_nodes n ON n.id=t.node_id AND n.workspace_id=t.workspace_id
          AND n.tenant_id=t.tenant_id AND n.course_id=t.course_id AND n.kind='chapter'
        JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.user_id=w.requested_by
          AND c.course_id=w.course_id AND c.bot_id=w.bot_id AND c.target='lesson_author'
        WHERE ${liveLeaseSql()} AND w.status='drafting' AND w.blueprint_id IS NULL
          AND r.status='executing' AND s.status='sealed' FOR SHARE OF w,r,s,n,c`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      const row = authority.rows[0];
      if (authority.rows.length !== 1 || !row || row.kind !== 'chapter' || row.content_state !== 'content_ready'
        || Number(row.current_revision) !== 0 || !HASH.test(String(row.manifest_hash))) {
        fail('ORCHESTRATION_V2_CHAPTER_AUTHORITY_INVALID');
      }
      const artifacts = await tx.query(`SELECT a.artifact_kind,a.artifact_hash,a.payload
        FROM lesson_author_workspace_v2_artifacts a
        JOIN lesson_author_workspace_v2_tasks producer ON producer.id=a.task_id AND producer.run_id=a.run_id
        JOIN lesson_author_workspace_v2_tasks current_task ON current_task.run_id=a.run_id
          AND current_task.workspace_id=a.workspace_id AND current_task.tenant_id=a.tenant_id
          AND current_task.course_id=a.course_id
        WHERE ${liveLeaseSql('current_task')} AND producer.status='succeeded'
          AND a.artifact_kind IN ('architecture_validation','inventory_receipt') ORDER BY a.artifact_kind`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      const architectureRow = artifacts.rows.find(item => item.artifact_kind === 'architecture_validation');
      const inventoryRow = artifacts.rows.find(item => item.artifact_kind === 'inventory_receipt');
      const inventory = record(inventoryRow?.payload);
      if (artifacts.rows.length !== 2 || !architectureRow || !inventory
        || !HASH.test(String(architectureRow.artifact_hash)) || !HASH.test(String(inventory.inventory_hash))) {
        fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
      }
      const architectureArtifact = architectureRow!;
      const inventoryPayload = inventory!;
      const assembly = readOrchestrationV2ArchitectureAssembly(architectureArtifact.payload);
      const chapter = assembly.architecture.chapters.find(item => item.chapter_key === lease.chapter_key);
      if (!chapter || assembly.assembly_hash !== architectureArtifact.artifact_hash
        || assembly.source_snapshot_hash !== lease.source_snapshot_hash) {
        fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
      }
      const acceptedChapter = chapter!;
      const units = await tx.query(`SELECT parent.id::text AS task_id,parent.task_key,parent.node_id::text,
          parent.result_hash AS artifact_hash,a.payload
        FROM lesson_author_workspace_v2_dependencies d
        JOIN lesson_author_workspace_v2_tasks parent ON parent.id=d.depends_on_task_id AND parent.run_id=d.run_id
        JOIN lesson_author_workspace_v2_artifacts a ON a.task_id=parent.id AND a.run_id=parent.run_id
          AND a.artifact_kind='unit_baseline' AND a.artifact_hash=parent.result_hash
        WHERE d.run_id=$1 AND d.task_id=$2 AND parent.kind='generate_unit' AND parent.status='succeeded'
          AND parent.chapter_key=$3 AND parent.validation_contract='orchestration-unit-baseline-v2'
        ORDER BY parent.ordinal`, [lease.run_id, lease.task_id, lease.chapter_key]);
      const unitKeys = units.rows.map(item => String(item.task_key));
      const expectedInputHash = orchestrationV2Hash({ assembly_hash: assembly.assembly_hash,
        inventory_hash: inventoryPayload.inventory_hash, chapter_key: lease.chapter_key, unit_task_keys: unitKeys });
      const budget = { input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0,
        max_provider_attempts: 0, execution_budget_ms: Number(row.execution_budget_ms) };
      const expectedContractHash = orchestrationV2Hash({ contract_version: 2, task_key: lease.task_key,
        kind: 'validate_chapter', chapter_key: lease.chapter_key, node_id: lease.node_id,
        input_context_hash: expectedInputHash, budget });
      if (expectedInputHash !== lease.input_context_hash || expectedContractHash !== lease.contract_hash) {
        fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
      }
      const facts = await tx.query(`SELECT document_id::text,fact_key,scope_key,fact_text,fact_hash,source_ref,
          source_page,source_chunk,locator FROM lesson_author_workspace_source_facts
        WHERE snapshot_id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4
          AND scope_key=ANY($5::text[]) ORDER BY ordinal`,
      [lease.source_snapshot_id, lease.workspace_id, lease.tenant_id, lease.course_id, acceptedChapter.source_scope_ids]);
      const paths = units.rows.flatMap(item => {
        const payload = record(item.payload), nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
        return nodes.map(node => String(record(node)?.path ?? ''));
      });
      if (!paths.length || new Set(paths).size !== paths.length || paths.some(path => !path)) {
        fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID');
      }
      const baselines = await tx.query(`SELECT n.canonical_path,n.kind,r.content_hash,r.revision,r.operation_id::text
        FROM lesson_author_workspace_nodes n
        JOIN lesson_author_workspace_revisions r ON r.workspace_id=n.workspace_id AND r.node_id=n.id
          AND r.revision=n.current_revision
        WHERE n.workspace_id=$1 AND n.tenant_id=$2 AND n.course_id=$3
          AND n.canonical_path=ANY($4::text[]) AND n.kind IN ('unit','component')
          AND n.content_state='content_ready' AND n.current_revision=0 ORDER BY n.canonical_path FOR SHARE OF n,r`,
      [lease.workspace_id, lease.tenant_id, lease.course_id, paths]);
      return validateOrchestrationV2Chapter({ run_id: lease.run_id, assembly,
        inventory_hash: String(inventoryPayload.inventory_hash), chapter_key: lease.chapter_key!,
        chapter_node_id: lease.node_id!,
        source_facts: facts.rows as unknown as Array<OrchestrationV2SourceFact & { fact_hash: string }>,
        units: units.rows.map(item => ({ task_id: String(item.task_id), task_key: String(item.task_key),
          node_id: String(item.node_id), artifact_hash: String(item.artifact_hash),
          payload: record(item.payload) ?? fail('ORCHESTRATION_V2_CHAPTER_EVIDENCE_INVALID') })),
        baselines: baselines.rows.map(item => ({ canonical_path: String(item.canonical_path),
          kind: item.kind as 'unit' | 'component', content_hash: String(item.content_hash),
          revision: Number(item.revision), operation_id: String(item.operation_id) })) });
    });
  }

  async function complete(lease: OrchestrationV2TaskLease, receipt: Readonly<OrchestrationV2ChapterReceipt>) {
    if (lease.kind !== 'validate_chapter' || !lease.chapter_key || !lease.node_id
      || receipt.contract !== ORCHESTRATION_V2_CHAPTER_CONTRACT || receipt.chapter_key !== lease.chapter_key
      || receipt.chapter_node_id !== lease.node_id || receipt.source_snapshot_hash !== lease.source_snapshot_hash) {
      fail('ORCHESTRATION_V2_CHAPTER_STATE_INVALID');
    }
    await worker.succeed(lease, receipt.receipt_hash, ORCHESTRATION_V2_CHAPTER_CONTRACT, {}, {
      artifact_kind: 'chapter_receipt', artifact_hash: receipt.receipt_hash,
      payload: { contract_version: 2, ...receipt }, validation_contract: ORCHESTRATION_V2_CHAPTER_CONTRACT,
    }, async () => undefined, { afterSuccess: async tx => queueFinalizer(tx, lease) });
  }

  async function queueFinalizer(tx: GenerationJobSql, lease: OrchestrationV2TaskLease) {
    const ready = await tx.query(`UPDATE lesson_author_workspace_v2_tasks candidate SET status='queued'
      WHERE candidate.run_id=$1 AND candidate.kind='finalize_course' AND candidate.status='blocked'
        AND NOT EXISTS(SELECT 1 FROM lesson_author_workspace_v2_dependencies d
          JOIN lesson_author_workspace_v2_tasks parent ON parent.id=d.depends_on_task_id AND parent.run_id=d.run_id
          WHERE d.run_id=candidate.run_id AND d.task_id=candidate.id AND parent.status<>'succeeded')
      RETURNING candidate.id::text`, [lease.run_id]);
    if (!ready.rows.length) return;
    if (ready.rows.length !== 1) fail('ORCHESTRATION_V2_CHAPTER_WRITE_UNCONFIRMED');
    const outboxId = id();
    if (!UUID.test(outboxId)) fail('ORCHESTRATION_V2_CHAPTER_WRITE_UNCONFIRMED');
    const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
        (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
      VALUES($1,$2,$3,$4,$5,$6,0,$7) RETURNING id::text`,
    [outboxId, lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id,
      ready.rows[0].id, lease.routing_shard]);
    if (outbox.rows.length !== 1) fail('ORCHESTRATION_V2_CHAPTER_WRITE_UNCONFIRMED');
  }

  return { load, complete };
}
