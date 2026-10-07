import { randomUUID } from 'node:crypto';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { readOrchestrationV2ArchitectureAssembly,
  type OrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import { idmUnitDesignAt } from './lesson-author-idm-architecture.logic.js';
import { remapFactsToBlockScopes } from './lesson-author-idm-scope-view.logic.js';
import { idmScopeFactKeys, loadIdmRunScopeView,
  loadIdmSnapshotFacts } from './lesson-author-idm-scope-view.repository.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import { prepareOrchestrationV2UnitGenerationContract, ORCHESTRATION_V2_UNIT_CONTRACT,
  type OrchestrationV2UnitGenerationContract, type OrchestrationV2UnitPublication } from './lesson-author-orchestration-v2-unit.logic.js';
import type { OrchestrationV2AttemptTraceEvent } from './lesson-author-orchestration-v2-attempt.logic.js';
import type {
  OrchestrationV2TaskLease,
  ReleaseUndispatched,
  createOrchestrationV2WorkerRepository,
} from './lesson-author-orchestration-v2-worker.repository.js';

type WorkerRepository = ReturnType<typeof createOrchestrationV2WorkerRepository>;
type SettleProvider = Parameters<WorkerRepository['succeed']>[5];

export interface OrchestrationV2UnitAuthority {
  tenant_id: string;
  kb_id: string;
  conversation_id: string;
  correlation_id: string;
  locale: 'vi' | 'en';
  source_documents: Array<{ document_id: string; kb_id: string; name: string; type: string; status: string }>;
}

export interface OrchestrationV2UnitExecutionInput {
  authority: OrchestrationV2UnitAuthority;
  contract: Readonly<OrchestrationV2UnitGenerationContract>;
}

export class OrchestrationV2UnitRepositoryError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_UNIT_AUTHORITY_INVALID'
    | 'ORCHESTRATION_V2_UNIT_EVIDENCE_INVALID'
    | 'ORCHESTRATION_V2_UNIT_STATE_INVALID'
    | 'ORCHESTRATION_V2_UNIT_WRITE_UNCONFIRMED') {
    super(code);
    this.name = 'OrchestrationV2UnitRepositoryError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const PATH = /^chapter_([1-9][0-9]*)\.lesson_([1-9][0-9]*)\.unit_([1-9][0-9]*)$/;
const fail = (code: OrchestrationV2UnitRepositoryError['code']): never => {
  throw new OrchestrationV2UnitRepositoryError(code);
};
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;
const liveLeaseSql = (alias = 't') => `${alias}.id=$1 AND ${alias}.run_id=$2 AND ${alias}.workspace_id=$3
  AND ${alias}.tenant_id=$4 AND ${alias}.status='running' AND ${alias}.lease_token=$5::uuid
  AND ${alias}.lease_expires_at>clock_timestamp() AND ${alias}.deadline_at>clock_timestamp()`;

export function createOrchestrationV2UnitRepository(
  db: GenerationJobDatabase,
  worker: WorkerRepository,
  id: () => string = randomUUID,
) {
  async function load(lease: OrchestrationV2TaskLease): Promise<OrchestrationV2UnitExecutionInput> {
    if (lease.kind !== 'generate_unit' || !lease.node_id || !lease.chapter_key || !lease.input_context_hash) {
      fail('ORCHESTRATION_V2_UNIT_STATE_INVALID');
    }
    return db.transaction(async tx => {
      const authorityResult = await tx.query(`SELECT w.kb_id::text,w.conversation_id::text,w.correlation_id::text,
          w.content_locale,w.source_document_ids,n.canonical_path,n.contract_hash AS node_contract_hash,
          n.content_state,n.current_revision,t.task_key
        FROM lesson_author_workspace_v2_tasks t
        JOIN lesson_author_workspaces w ON w.id=t.workspace_id AND w.tenant_id=t.tenant_id AND w.course_id=t.course_id
        JOIN lesson_author_workspace_nodes n ON n.id=t.node_id AND n.workspace_id=t.workspace_id
          AND n.tenant_id=t.tenant_id AND n.course_id=t.course_id AND n.kind='unit'
        JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.user_id=w.requested_by
          AND c.course_id=w.course_id AND c.bot_id=w.bot_id AND c.target='lesson_author'
        JOIN tenant_kb_assignments ka ON ka.tenant_id=w.tenant_id AND ka.kb_id=w.kb_id AND ka.target='lesson_author'
        WHERE ${liveLeaseSql()} AND w.status='drafting' AND w.blueprint_id IS NULL FOR SHARE OF w,c,ka,n`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      const row = authorityResult.rows[0];
      const match = typeof row?.canonical_path === 'string' ? PATH.exec(row.canonical_path) : null;
      if (authorityResult.rows.length !== 1 || !row || Number(match?.[1]) < 1
        || row.content_state !== 'planned' || row.current_revision !== null
        || !UUID.test(String(row.kb_id)) || !UUID.test(String(row.conversation_id))
        || !UUID.test(String(row.correlation_id)) || !HASH.test(String(row.node_contract_hash))
        || !['vi', 'en'].includes(String(row.content_locale)) || !Array.isArray(row.source_document_ids)
        || row.source_document_ids.length < 1 || row.source_document_ids.length > 5
        || row.source_document_ids.some((value: unknown) => !UUID.test(String(value)))) {
        fail('ORCHESTRATION_V2_UNIT_AUTHORITY_INVALID');
      }
      if (!match) fail('ORCHESTRATION_V2_UNIT_AUTHORITY_INVALID');
      const pathMatch = match as RegExpExecArray;
      const unitPath = String(row.canonical_path);
      const documents = await tx.query(`SELECT id::text AS document_id,kb_id::text,name,type,status
        FROM kb_documents WHERE tenant_id=$1 AND kb_id=$2 AND id=ANY($3::uuid[]) AND status='learned'
        ORDER BY id FOR SHARE`, [lease.tenant_id, row.kb_id, row.source_document_ids]);
      if (documents.rows.length !== new Set(row.source_document_ids as string[]).size) {
        fail('ORCHESTRATION_V2_UNIT_AUTHORITY_INVALID');
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
      const inventoryPayload = record(inventoryRow?.payload);
      if (artifacts.rows.length !== 2 || !architectureRow || !inventoryPayload
        || !HASH.test(String(architectureRow?.artifact_hash)) || !HASH.test(String(inventoryPayload?.inventory_hash))) {
        fail('ORCHESTRATION_V2_UNIT_EVIDENCE_INVALID');
      }
      const architectureArtifact = architectureRow!;
      const inventoryHash = String(inventoryPayload!.inventory_hash);
      const assembly = readOrchestrationV2ArchitectureAssembly(architectureArtifact.payload);
      if (assembly.assembly_hash !== architectureArtifact.artifact_hash
        || assembly.source_snapshot_hash !== lease.source_snapshot_hash) fail('ORCHESTRATION_V2_UNIT_EVIDENCE_INVALID');
      const chapter = assembly.architecture.chapters[Number(pathMatch[1]) - 1];
      const lesson = chapter?.lessons[Number(pathMatch[2]) - 1];
      const unit = lesson?.units[Number(pathMatch[3]) - 1];
      if (!chapter || !unit || chapter.chapter_key !== lease.chapter_key) fail('ORCHESTRATION_V2_UNIT_EVIDENCE_INVALID');
      const contract = assembly.idm === undefined ? prepareOrchestrationV2UnitGenerationContract({ assembly,
        unit_path: unitPath, source_facts: (await tx.query(`SELECT document_id::text,fact_key,scope_key,fact_text,source_ref,
          source_page,source_chunk,locator FROM lesson_author_workspace_source_facts
        WHERE snapshot_id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4
          AND scope_key=ANY($5::text[]) ORDER BY ordinal`,
      [lease.source_snapshot_id, lease.workspace_id, lease.tenant_id, lease.course_id, unit.source_scope_ids]))
        .rows as unknown as OrchestrationV2SourceFact[] })
        : await idmUnitContract(tx, lease, assembly, unitPath, pathMatch, unit.source_scope_ids);
      const expectedInputHash = orchestrationV2Hash({ assembly_hash: assembly.assembly_hash,
        inventory_hash: inventoryHash, node_id: lease.node_id,
        contract_hash: row.node_contract_hash, source_scope_ids: unit.source_scope_ids });
      if (expectedInputHash !== lease.input_context_hash) fail('ORCHESTRATION_V2_UNIT_EVIDENCE_INVALID');
      const componentNodes = await tx.query(`SELECT id::text,canonical_path,sort_order,protected_contract,contract_hash,
          content_state,current_revision FROM lesson_author_workspace_nodes
        WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 AND parent_id=$4 AND kind='component'
        ORDER BY sort_order FOR SHARE`, [lease.workspace_id, lease.tenant_id, lease.course_id, lease.node_id]);
      if (componentNodes.rows.length !== contract.component_plan.length) fail('ORCHESTRATION_V2_UNIT_EVIDENCE_INVALID');
      for (const [index, node] of componentNodes.rows.entries()) {
        const protectedContract = record(node.protected_contract), metadata = record(protectedContract?.metadata);
        const plan = contract.component_plan[index]!;
        if (node.canonical_path !== `${contract.unit_path}.component_${index + 1}` || Number(node.sort_order) !== index
          || node.content_state !== 'planned' || node.current_revision !== null
          || orchestrationV2Hash(protectedContract) !== node.contract_hash || protectedContract?.component_type !== plan.type
          || metadata?.component_plan_id !== plan.component_plan_id
          || orchestrationV2Hash(metadata?.source_scope_ids) !== orchestrationV2Hash(plan.source_scope_ids)) {
          fail('ORCHESTRATION_V2_UNIT_EVIDENCE_INVALID');
        }
      }
      return { authority: Object.freeze({ tenant_id: lease.tenant_id, kb_id: String(row.kb_id),
        conversation_id: String(row.conversation_id), correlation_id: String(row.correlation_id),
        locale: row.content_locale as 'vi' | 'en', source_documents: documents.rows.map(document => ({
          document_id: String(document.document_id), kb_id: String(document.kb_id), name: String(document.name),
          type: String(document.type), status: String(document.status),
        })) }), contract };
    });
  }

  /**
   * IDM unit contract (spec §8.3): facts come from the unit's block scopes through
   * the run's scope view; the brief also needs the facts of the whole lesson.
   */
  async function idmUnitContract(tx: GenerationJobSql, lease: OrchestrationV2TaskLease,
    assembly: OrchestrationV2ArchitectureAssembly, unitPath: string, pathMatch: RegExpExecArray,
    unitScopes: readonly string[]): Promise<Readonly<OrchestrationV2UnitGenerationContract>> {
    const view = await loadIdmRunScopeView(tx, lease, assembly.idm!.design_hash);
    const { lesson } = idmUnitDesignAt(assembly, Number(pathMatch[1]) - 1, Number(pathMatch[2]) - 1,
      Number(pathMatch[3]) - 1);
    const lessonScopes = lesson.units.flatMap(item => item.block_ids).map(blockId =>
      view.design.block_scopes.find(scope => scope.block_id === blockId)?.scope_key
        ?? fail('ORCHESTRATION_V2_UNIT_EVIDENCE_INVALID'));
    if (unitScopes.some(scope => !lessonScopes.includes(scope))) fail('ORCHESTRATION_V2_UNIT_EVIDENCE_INVALID');
    const lessonFacts = await loadIdmSnapshotFacts(tx, lease, idmScopeFactKeys(view, lessonScopes));
    const unitKeys = new Set(idmScopeFactKeys(view, unitScopes));
    return prepareOrchestrationV2UnitGenerationContract({ assembly, unit_path: unitPath,
      source_facts: remapFactsToBlockScopes(lessonFacts.filter(fact => unitKeys.has(fact.fact_key)), view),
      idm: { design: view.design, lesson_facts: lessonFacts } });
  }

  async function complete(lease: OrchestrationV2TaskLease, publication: Readonly<OrchestrationV2UnitPublication>,
    usage: unknown, settleProvider: SettleProvider, releaseUndispatched: ReleaseUndispatched,
    usageSource: 'provider' | 'reserved_upper_bound' | 'deterministic_fallback',
    attemptTrace: readonly OrchestrationV2AttemptTraceEvent[] = []): Promise<void> {
    if (lease.kind !== 'generate_unit' || !lease.node_id || !PATH.test(publication.unit_path)
      || publication.source_snapshot_hash !== lease.source_snapshot_hash
      || publication.validation_contract !== ORCHESTRATION_V2_UNIT_CONTRACT) {
      fail('ORCHESTRATION_V2_UNIT_STATE_INVALID');
    }
    const artifactPayload = { contract_version: 2, unit_path: publication.unit_path,
      source_snapshot_hash: publication.source_snapshot_hash, contract_hash: publication.contract_hash,
      nodes: publication.nodes, generated_unit: publication.generated_unit,
      content_origin: publication.content_origin, quality_state: publication.quality_state,
      ...(publication.semantic_review ? { semantic_review: publication.semantic_review } : {}) };
    await worker.succeed(lease, publication.result_hash, ORCHESTRATION_V2_UNIT_CONTRACT, usage, {
      artifact_kind: 'unit_baseline', artifact_hash: publication.result_hash, payload: artifactPayload,
      validation_contract: ORCHESTRATION_V2_UNIT_CONTRACT,
    }, settleProvider, {
      beforeSuccess: async tx => {
        const paths = publication.nodes.map(node => node.path);
        const found = await tx.query(`SELECT id::text,canonical_path,kind,content_state,current_revision
          FROM lesson_author_workspace_nodes WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3
            AND canonical_path=ANY($4::text[]) ORDER BY canonical_path FOR UPDATE`,
        [lease.workspace_id, lease.tenant_id, lease.course_id, paths]);
        const byPath = new Map(found.rows.map(node => [String(node.canonical_path), node]));
        if (found.rows.length !== publication.nodes.length || publication.nodes.some(node => {
          const stored = byPath.get(node.path);
          return !stored || stored.content_state !== 'planned' || stored.current_revision !== null
            || (node.path === publication.unit_path ? stored.id !== lease.node_id || stored.kind !== 'unit' : stored.kind !== 'component');
        })) fail('ORCHESTRATION_V2_UNIT_STATE_INVALID');
        const revisionRows = publication.nodes.map(node => ({ node_id: String(byPath.get(node.path)!.id),
          content: node.content, content_hash: node.content_hash }));
        const inserted = await tx.query(`INSERT INTO lesson_author_workspace_revisions
            (workspace_id,node_id,tenant_id,course_id,revision,parent_revision,origin,actor_id,operation_id,
             content,content_hash,validation_contract,user_modified)
          SELECT $2::uuid,x.node_id,$3::uuid,$4,0,NULL,'ai_baseline',NULL,$5::uuid,
            x.content,x.content_hash,$6,false
          FROM jsonb_to_recordset($1::jsonb) AS x(node_id uuid,content jsonb,content_hash varchar)
          RETURNING node_id::text,revision`, [JSON.stringify(revisionRows), lease.workspace_id, lease.tenant_id,
          lease.course_id, lease.task_id, ORCHESTRATION_V2_UNIT_CONTRACT]);
        if (inserted.rows.length !== revisionRows.length || inserted.rows.some(item => Number(item.revision) !== 0)) {
          fail('ORCHESTRATION_V2_UNIT_WRITE_UNCONFIRMED');
        }
        const event = await tx.query(`INSERT INTO lesson_author_workspace_events
            (workspace_id,tenant_id,course_id,event_kind,node_id,node_revision,operation_id)
          VALUES($1,$2,$3,'unit_ready',$4,0,$5) RETURNING sequence`,
        [lease.workspace_id, lease.tenant_id, lease.course_id, lease.node_id, lease.task_id]);
        if (event.rows.length !== 1) fail('ORCHESTRATION_V2_UNIT_WRITE_UNCONFIRMED');
      },
      afterSuccess: async tx => queueChapterValidation(tx, lease),
    }, usageSource === 'deterministic_fallback'
      ? { mode: 'deterministic_fallback', releaseUndispatched }
      : { mode: usageSource }, attemptTrace);
  }

  async function queueChapterValidation(tx: GenerationJobSql, lease: OrchestrationV2TaskLease) {
    const ready = await tx.query(`UPDATE lesson_author_workspace_v2_tasks candidate SET status='queued'
      WHERE candidate.run_id=$1 AND candidate.kind='validate_chapter' AND candidate.chapter_key=$2
        AND candidate.status='blocked' AND NOT EXISTS(SELECT 1 FROM lesson_author_workspace_v2_dependencies d
          JOIN lesson_author_workspace_v2_tasks parent ON parent.id=d.depends_on_task_id AND parent.run_id=d.run_id
          WHERE d.run_id=candidate.run_id AND d.task_id=candidate.id AND parent.status<>'succeeded')
      RETURNING candidate.id::text`, [lease.run_id, lease.chapter_key]);
    if (!ready.rows.length) return;
    if (ready.rows.length !== 1) fail('ORCHESTRATION_V2_UNIT_WRITE_UNCONFIRMED');
    const outboxId = id();
    if (!UUID.test(outboxId)) fail('ORCHESTRATION_V2_UNIT_WRITE_UNCONFIRMED');
    const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
        (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
      VALUES($1,$2,$3,$4,$5,$6,0,$7) RETURNING id::text`,
    [outboxId, lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id,
      ready.rows[0].id, lease.routing_shard]);
    if (outbox.rows.length !== 1) fail('ORCHESTRATION_V2_UNIT_WRITE_UNCONFIRMED');
  }

  return { load, complete };
}
