import { randomUUID } from 'node:crypto';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { readOrchestrationV2ArchitectureAssembly,
  type OrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import type {
  OrchestrationV2InventoryPublication,
  OrchestrationV2StoredTask,
} from './lesson-author-orchestration-v2-inventory.logic.js';
import { orchestrationV2Hash, type OrchestrationV2TaskKind } from './lesson-author-orchestration-v2.logic.js';
import type {
  OrchestrationV2TaskLease,
  createOrchestrationV2WorkerRepository,
} from './lesson-author-orchestration-v2-worker.repository.js';

type WorkerRepository = ReturnType<typeof createOrchestrationV2WorkerRepository>;

export interface OrchestrationV2InventoryInput {
  assembly: OrchestrationV2ArchitectureAssembly;
  existing_tasks: OrchestrationV2StoredTask[];
}

export class OrchestrationV2InventoryRepositoryError extends Error {
  constructor(readonly code: 'ORCHESTRATION_V2_INVENTORY_EVIDENCE_INVALID'
    | 'ORCHESTRATION_V2_INVENTORY_STATE_INVALID' | 'ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED') {
    super(code);
    this.name = 'OrchestrationV2InventoryRepositoryError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const fail = (code: OrchestrationV2InventoryRepositoryError['code']): never => {
  throw new OrchestrationV2InventoryRepositoryError(code);
};
const integer = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
    ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('ORCHESTRATION_V2_INVENTORY_EVIDENCE_INVALID');
  }
  return parsed;
};
function liveLeaseSql(alias: string) {
  return `${alias}.id=$1 AND ${alias}.run_id=$2 AND ${alias}.workspace_id=$3 AND ${alias}.tenant_id=$4
    AND ${alias}.status='running' AND ${alias}.lease_token=$5::uuid
    AND ${alias}.lease_expires_at>clock_timestamp() AND ${alias}.deadline_at>clock_timestamp()`;
}
function batches<T>(rows: readonly T[], maximumRows = 500): T[][] {
  const output: T[][] = []; let page: T[] = [], size = 2;
  for (const row of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (bytes > 1024 * 1024) fail('ORCHESTRATION_V2_INVENTORY_STATE_INVALID');
    if (page.length && (page.length >= maximumRows || size + bytes > 1024 * 1024)) {
      output.push(page); page = []; size = 2;
    }
    page.push(row); size += bytes;
  }
  if (page.length) output.push(page);
  return output;
}

export function createOrchestrationV2InventoryRepository(
  db: GenerationJobDatabase,
  worker: WorkerRepository,
  id: () => string = randomUUID,
) {
  async function load(lease: OrchestrationV2TaskLease): Promise<OrchestrationV2InventoryInput> {
    if (lease.kind !== 'publish_inventory') fail('ORCHESTRATION_V2_INVENTORY_STATE_INVALID');
    return db.transaction(async tx => {
      const evidence = await tx.query(`SELECT a.payload,a.artifact_hash
        FROM lesson_author_workspace_v2_artifacts a
        JOIN lesson_author_workspace_v2_tasks producer ON producer.id=a.task_id AND producer.run_id=a.run_id
          AND producer.workspace_id=a.workspace_id AND producer.tenant_id=a.tenant_id AND producer.course_id=a.course_id
        JOIN lesson_author_workspace_v2_tasks current_task ON current_task.run_id=a.run_id
          AND current_task.workspace_id=a.workspace_id AND current_task.tenant_id=a.tenant_id
          AND current_task.course_id=a.course_id
        WHERE ${liveLeaseSql('current_task')} AND a.artifact_kind='architecture_validation'
          AND producer.kind='validate_architecture' AND producer.status='succeeded'`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      if (evidence.rows.length !== 1 || !HASH.test(String(evidence.rows[0]?.artifact_hash))) {
        fail('ORCHESTRATION_V2_INVENTORY_EVIDENCE_INVALID');
      }
      const assembly = readOrchestrationV2ArchitectureAssembly(evidence.rows[0].payload);
      if (assembly.assembly_hash !== evidence.rows[0].artifact_hash
        || assembly.source_snapshot_hash !== lease.source_snapshot_hash) {
        fail('ORCHESTRATION_V2_INVENTORY_EVIDENCE_INVALID');
      }
      const tasks = await tx.query(`SELECT t.id::text,t.ordinal,t.task_key,t.kind,t.chapter_key,t.node_id::text,
          t.contract_hash,t.input_context_hash,t.priority,t.max_attempts,t.input_tokens,t.embedding_tokens,
          t.max_output_tokens,t.provider_max_attempts,t.execution_budget_ms,t.status
        FROM lesson_author_workspace_v2_tasks t
        JOIN lesson_author_workspace_v2_tasks current_task ON current_task.run_id=t.run_id
          AND current_task.workspace_id=t.workspace_id AND current_task.tenant_id=t.tenant_id
          AND current_task.course_id=t.course_id
        WHERE ${liveLeaseSql('current_task')} ORDER BY t.ordinal`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      const dependencies = await tx.query(`SELECT child.task_key,parent.task_key AS depends_on,parent.ordinal
        FROM lesson_author_workspace_v2_dependencies d
        JOIN lesson_author_workspace_v2_tasks child ON child.id=d.task_id AND child.run_id=d.run_id
        JOIN lesson_author_workspace_v2_tasks parent ON parent.id=d.depends_on_task_id AND parent.run_id=d.run_id
        JOIN lesson_author_workspace_v2_tasks current_task ON current_task.run_id=d.run_id
          AND current_task.workspace_id=d.workspace_id AND current_task.tenant_id=d.tenant_id
          AND current_task.course_id=d.course_id
        WHERE ${liveLeaseSql('current_task')} ORDER BY child.ordinal,parent.ordinal`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      const byChild = new Map<string, string[]>();
      for (const row of dependencies.rows) {
        const list = byChild.get(String(row.task_key)) ?? [];
        list.push(String(row.depends_on)); byChild.set(String(row.task_key), list);
      }
      const existingTasks: OrchestrationV2StoredTask[] = tasks.rows.map(row => {
        const task: OrchestrationV2StoredTask = {
          id: String(row.id), ordinal: integer(row.ordinal, 0, 32_767), task_key: String(row.task_key),
          kind: String(row.kind) as OrchestrationV2TaskKind,
          chapter_key: row.chapter_key === null ? null : String(row.chapter_key),
          node_id: row.node_id === null ? null : String(row.node_id), contract_hash: String(row.contract_hash),
          input_context_hash: row.input_context_hash === null ? null : String(row.input_context_hash),
          priority: integer(row.priority, 0, 1_000), max_attempts: integer(row.max_attempts, 1, 2),
          depends_on: byChild.get(String(row.task_key)) ?? [], budget: {
            input_tokens: integer(row.input_tokens, 0, 2_000_000),
            embedding_tokens: integer(row.embedding_tokens, 0, 2_000_000),
            max_output_tokens: integer(row.max_output_tokens, 0, 65_536),
            max_provider_attempts: integer(row.provider_max_attempts, 0, 2),
            execution_budget_ms: integer(row.execution_budget_ms, 1, 600_000),
          },
        };
        const current = task.id === lease.task_id;
        if (!UUID.test(task.id) || !HASH.test(task.contract_hash)
          || (task.input_context_hash !== null && !HASH.test(task.input_context_hash))
          || (current ? row.status !== 'running' : row.status !== 'succeeded')) {
          fail('ORCHESTRATION_V2_INVENTORY_EVIDENCE_INVALID');
        }
        return task;
      });
      if (existingTasks.length < 5 || existingTasks.at(-1)?.id !== lease.task_id
        || dependencies.rows.length !== existingTasks.reduce((sum, task) => sum + task.depends_on.length, 0)) {
        fail('ORCHESTRATION_V2_INVENTORY_EVIDENCE_INVALID');
      }
      return { assembly, existing_tasks: existingTasks };
    });
  }

  async function insertNodes(tx: GenerationJobSql, lease: OrchestrationV2TaskLease,
    publication: Readonly<OrchestrationV2InventoryPublication>) {
    for (let depth = 0; depth <= 4; depth++) {
      const level = publication.nodes.filter(node => (node.kind === 'course' ? 0 : node.canonical_path.split('.').length) === depth);
      for (const page of batches(level)) {
        const rows = page.map((node, ordinal) => ({ id: node.id, workspace_id: lease.workspace_id,
          tenant_id: lease.tenant_id, course_id: lease.course_id, parent_id: node.parent_id, kind: node.kind,
          canonical_path: node.canonical_path, sort_order: node.sort_order,
          protected_contract: node.protected_contract, contract_hash: node.contract_hash, ordinal }));
        const inserted = await tx.query(`INSERT INTO lesson_author_workspace_nodes
            (id,workspace_id,tenant_id,course_id,parent_id,kind,canonical_path,sort_order,protected_contract,contract_hash)
          SELECT x.id,x.workspace_id,x.tenant_id,x.course_id,x.parent_id,x.kind,x.canonical_path,x.sort_order,
            x.protected_contract,x.contract_hash
          FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,workspace_id uuid,tenant_id uuid,course_id varchar,
            parent_id uuid,kind varchar,canonical_path varchar,sort_order integer,protected_contract jsonb,
            contract_hash varchar,ordinal integer) ORDER BY x.ordinal RETURNING id::text`, [JSON.stringify(rows)]);
        const actual = new Set(inserted.rows.map(row => String(row.id)));
        if (inserted.rows.length !== rows.length || rows.some(row => !actual.has(row.id))) {
          fail('ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED');
        }
      }
    }
  }

  async function complete(
    lease: OrchestrationV2TaskLease,
    publication: Readonly<OrchestrationV2InventoryPublication>,
  ): Promise<void> {
    if (lease.kind !== 'publish_inventory' || publication.assembly_hash !== lease.input_context_hash
      || publication.manifest.source_snapshot_hash !== lease.source_snapshot_hash
      || publication.manifest.tasks.length < publication.new_tasks.length) {
      fail('ORCHESTRATION_V2_INVENTORY_STATE_INVALID');
    }
    const receipt = { contract_version: 2, contract: publication.contract,
      assembly_hash: publication.assembly_hash, inventory_hash: publication.inventory_hash,
      manifest_hash: publication.manifest.manifest_hash, receipt_hash: publication.receipt_hash,
      admitted_fact_count: publication.admitted_fact_count,
      node_count: publication.node_count, unit_count: publication.unit_count,
      component_count: publication.component_count, media_brief_count: publication.media_brief_count,
      task_count: publication.manifest.tasks.length };
    await worker.succeed(lease, publication.receipt_hash, 'inventory-publication-v2', {}, {
      artifact_kind: 'inventory_receipt', artifact_hash: publication.receipt_hash, payload: receipt,
      validation_contract: 'inventory-publication-v2',
    }, async () => undefined, {
      afterSuccess: async tx => {
        const authority = await tx.query(`SELECT w.status,w.blueprint_id::text,r.status AS run_status,
            r.manifest_hash,s.status AS snapshot_status,s.fact_count,s.source_snapshot_hash,
            (SELECT count(*)::integer FROM lesson_author_workspace_nodes n WHERE n.workspace_id=w.id) AS node_count,
            (SELECT count(*)::integer FROM lesson_author_workspace_events e WHERE e.workspace_id=w.id
              AND e.event_kind IN ('overview_ready','structure_ready')) AS structure_event_count
          FROM lesson_author_workspaces w
          JOIN lesson_author_workspace_v2_runs r ON r.workspace_id=w.id AND r.tenant_id=w.tenant_id AND r.course_id=w.course_id
          JOIN lesson_author_workspace_source_snapshots s ON s.id=r.source_snapshot_id AND s.workspace_id=r.workspace_id
          JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.user_id=w.requested_by
            AND c.course_id=w.course_id AND c.bot_id=w.bot_id AND c.target='lesson_author'
          WHERE r.id=$1 AND w.id=$2 AND w.tenant_id=$3 AND w.course_id=$4 FOR UPDATE OF w,r`,
        [lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id]);
        const row = authority.rows[0];
        if (authority.rows.length !== 1 || !['designing', 'needs_action'].includes(String(row.status))
          || row.blueprint_id !== null || row.run_status !== 'planning' || row.manifest_hash !== null
          || row.snapshot_status !== 'sealed' || row.source_snapshot_hash !== lease.source_snapshot_hash
          || integer(row.fact_count, 1, 10_000_000) !== publication.admitted_fact_count
          || integer(row.node_count) !== 0 || integer(row.structure_event_count) !== 0) {
          fail('ORCHESTRATION_V2_INVENTORY_STATE_INVALID');
        }
        await insertNodes(tx, lease, publication);
        const baselines = publication.nodes.filter(node => node.baseline !== null).map(node => ({
          workspace_id: lease.workspace_id, node_id: node.id, tenant_id: lease.tenant_id, course_id: lease.course_id,
          operation_id: lease.task_id, content: node.baseline,
          content_hash: orchestrationV2Hash(node.baseline), validation_contract: publication.contract,
        }));
        for (const page of batches(baselines)) {
          const inserted = await tx.query(`INSERT INTO lesson_author_workspace_revisions
              (workspace_id,node_id,tenant_id,course_id,revision,parent_revision,origin,actor_id,operation_id,
               content,content_hash,validation_contract,user_modified)
            SELECT x.workspace_id,x.node_id,x.tenant_id,x.course_id,0,NULL,'ai_baseline',NULL,x.operation_id,
              x.content,x.content_hash,x.validation_contract,false
            FROM jsonb_to_recordset($1::jsonb) AS x(workspace_id uuid,node_id uuid,tenant_id uuid,course_id varchar,
              operation_id uuid,content jsonb,content_hash varchar,validation_contract varchar)
            RETURNING node_id::text,revision`, [JSON.stringify(page)]);
          const actual = new Set(inserted.rows.map(item => String(item.node_id)));
          if (inserted.rows.length !== page.length || page.some(item => !actual.has(item.node_id))
            || inserted.rows.some(item => integer(item.revision) !== 0)) {
            fail('ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED');
          }
        }
        const workspace = await tx.query(`UPDATE lesson_author_workspaces SET status='drafting',updated_at=clock_timestamp()
          WHERE id=$1 AND tenant_id=$2 AND course_id=$3 AND status IN ('designing','needs_action')
            AND blueprint_id IS NULL RETURNING id`, [lease.workspace_id, lease.tenant_id, lease.course_id]);
        if (workspace.rows.length !== 1) fail('ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED');
        for (const kind of ['overview_ready', 'structure_ready']) {
          const event = await tx.query(`INSERT INTO lesson_author_workspace_events
              (workspace_id,tenant_id,course_id,event_kind,operation_id)
            VALUES($1,$2,$3,$4,$5) RETURNING sequence`,
          [lease.workspace_id, lease.tenant_id, lease.course_id, kind, lease.task_id]);
          if (event.rows.length !== 1) fail('ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED');
        }
        for (const page of batches(publication.new_tasks)) {
          const inserted = await tx.query(`INSERT INTO lesson_author_workspace_v2_tasks
              (id,run_id,workspace_id,tenant_id,course_id,ordinal,task_key,kind,chapter_key,node_id,
               contract_hash,input_context_hash,priority,status,max_attempts,provider_max_attempts,input_tokens,
               embedding_tokens,max_output_tokens,execution_budget_ms)
            SELECT x.id,$2::uuid,$3::uuid,$4::uuid,$5,x.ordinal,x.task_key,x.kind,x.chapter_key,x.node_id,
              x.contract_hash,x.input_context_hash,x.priority,'blocked',x.max_attempts,x.provider_max_attempts,
              x.input_tokens,x.embedding_tokens,x.max_output_tokens,x.execution_budget_ms
            FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,ordinal integer,task_key varchar,kind varchar,
              chapter_key varchar,node_id uuid,contract_hash varchar,input_context_hash varchar,priority smallint,
              max_attempts smallint,provider_max_attempts smallint,input_tokens integer,embedding_tokens integer,
              max_output_tokens integer,execution_budget_ms integer) RETURNING id::text`,
          [JSON.stringify(page.map(task => ({ ...task, ...task.budget,
            provider_max_attempts: task.budget.max_provider_attempts }))), lease.run_id, lease.workspace_id,
            lease.tenant_id, lease.course_id]);
          const actual = new Set(inserted.rows.map(item => String(item.id)));
          if (inserted.rows.length !== page.length || page.some(item => !actual.has(item.id))) {
            fail('ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED');
          }
        }
        const taskIds = new Map<string, string>();
        for (const task of publication.manifest.tasks) {
          const existing = publication.new_tasks.find(candidate => candidate.task_key === task.task_key);
          if (existing) taskIds.set(task.task_key, existing.id);
        }
        const stored = await tx.query(`SELECT id::text,task_key FROM lesson_author_workspace_v2_tasks
          WHERE run_id=$1 ORDER BY ordinal`, [lease.run_id]);
        for (const task of stored.rows) taskIds.set(String(task.task_key), String(task.id));
        if (taskIds.size !== publication.manifest.tasks.length) fail('ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED');
        const dependencies = publication.new_tasks.flatMap(task => task.depends_on.map(parent => ({
          task_id: task.id, depends_on_task_id: taskIds.get(parent) ?? fail('ORCHESTRATION_V2_INVENTORY_STATE_INVALID'),
        })));
        for (const page of batches(dependencies)) {
          const inserted = await tx.query(`INSERT INTO lesson_author_workspace_v2_dependencies
              (workspace_id,tenant_id,course_id,run_id,task_id,depends_on_task_id)
            SELECT $2::uuid,$3::uuid,$4,$5::uuid,x.task_id,x.depends_on_task_id
            FROM jsonb_to_recordset($1::jsonb) AS x(task_id uuid,depends_on_task_id uuid) RETURNING task_id::text`,
          [JSON.stringify(page), lease.workspace_id, lease.tenant_id, lease.course_id, lease.run_id]);
          if (inserted.rows.length !== page.length) fail('ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED');
        }
        const unitTasks = publication.new_tasks.filter(task => task.kind === 'generate_unit');
        const queued = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='queued'
          WHERE run_id=$1 AND id=ANY($2::uuid[]) AND status='blocked' RETURNING id::text`,
        [lease.run_id, unitTasks.map(task => task.id)]);
        if (queued.rows.length !== unitTasks.length) fail('ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED');
        for (const page of batches(unitTasks)) {
          const outboxRows = page.map(task => {
            const outboxId = id();
            if (!UUID.test(outboxId)) fail('ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED');
            return { id: outboxId, task_id: task.id };
          });
          const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
              (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
            SELECT x.id,$2::uuid,$3::uuid,$4::uuid,$5,x.task_id,0,$6
            FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,task_id uuid) RETURNING id::text`,
          [JSON.stringify(outboxRows), lease.run_id, lease.workspace_id, lease.tenant_id,
            lease.course_id, lease.routing_shard]);
          if (outbox.rows.length !== outboxRows.length) fail('ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED');
        }
        const run = await tx.query(`UPDATE lesson_author_workspace_v2_runs SET status='executing',
            manifest_hash=$5,task_count=$6,chapter_count=$7,admitted_fact_count=$8,
            token_ceiling=$9,execution_budget_ms=$10,started_at=clock_timestamp()
          WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND course_id=$4 AND status='planning'
            AND manifest_hash IS NULL RETURNING id::text`,
        [lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id,
          publication.manifest.manifest_hash, publication.manifest.tasks.length,
          publication.manifest.tasks.filter(task => task.kind === 'validate_chapter').length,
          integer(row.fact_count, 1, 10_000_000), publication.manifest.token_ceiling,
          publication.manifest.execution_budget_ms]);
        if (run.rows.length !== 1) fail('ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED');
        const readback = await tx.query(`SELECT
            (SELECT count(*)::integer FROM lesson_author_workspace_nodes WHERE workspace_id=$1) AS node_count,
            (SELECT count(*)::integer FROM lesson_author_workspace_v2_tasks WHERE run_id=$2) AS task_count,
            (SELECT count(*)::integer FROM lesson_author_workspace_v2_dispatch_outbox o
              JOIN lesson_author_workspace_v2_tasks t ON t.id=o.task_id AND t.run_id=o.run_id
              WHERE o.run_id=$2 AND t.kind='generate_unit' AND o.dispatch_epoch=0) AS unit_outbox_count`,
        [lease.workspace_id, lease.run_id]);
        if (readback.rows.length !== 1 || integer(readback.rows[0].node_count) !== publication.node_count
          || integer(readback.rows[0].task_count) !== publication.manifest.tasks.length
          || integer(readback.rows[0].unit_outbox_count) !== unitTasks.length) {
          fail('ORCHESTRATION_V2_INVENTORY_WRITE_UNCONFIRMED');
        }
      },
    });
  }

  return { load, complete };
}
