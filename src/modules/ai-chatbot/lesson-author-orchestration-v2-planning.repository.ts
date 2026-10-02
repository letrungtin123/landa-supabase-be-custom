import { randomUUID } from 'node:crypto';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type {
  OrchestrationV2ArchitectureAssembly,
  OrchestrationV2ChapterShardArtifact,
} from './lesson-author-orchestration-v2-architecture.logic.js';
import {
  buildOrchestrationV2InventoryTask,
  buildOrchestrationV2SkeletonTask,
  planOrchestrationV2ChapterShards,
  type OrchestrationV2PlanningBudgets,
} from './lesson-author-orchestration-v2-planning.logic.js';
import type {
  OrchestrationV2ChapterShardResponse,
  OrchestrationV2CourseSkeleton,
  OrchestrationV2CourseSkeletonResponse,
  OrchestrationV2SourceFact,
  OrchestrationV2SourceScope,
  OrchestrationV2SourceSnapshotPageResponse,
  OrchestrationV2SourceAuthority,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';
import {
  readOrchestrationV2ChapterShardResponse,
  readOrchestrationV2CourseSkeletonResponse,
  readOrchestrationV2SourceAuthority,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';
import { createSourceSnapshotRepositoryV2 } from './lesson-author-orchestration-v2-source.repository.js';
import type {
  OrchestrationV2TaskLease,
  createOrchestrationV2WorkerRepository,
} from './lesson-author-orchestration-v2-worker.repository.js';

type WorkerRepository = ReturnType<typeof createOrchestrationV2WorkerRepository>;
type SettleProvider = Parameters<WorkerRepository['succeed']>[5];

export interface OrchestrationV2PlanningAuthority {
  tenant_id: string;
  kb_id: string;
  conversation_id: string;
  correlation_id: string;
  locale: 'vi' | 'en';
  source_documents: Array<{ document_id: string; kb_id: string; name: string; type: string; status: string }>;
}

export interface OrchestrationV2ChapterExecutionInput {
  skeleton: OrchestrationV2CourseSkeleton;
  shard_plan: NonNullable<ReturnType<typeof planOrchestrationV2ChapterShards>['chapter_tasks'][number]['shard_plan']>;
  source_facts: OrchestrationV2SourceFact[];
}

export interface OrchestrationV2ArchitectureExecutionInput {
  skeleton: OrchestrationV2CourseSkeleton;
  scopes: OrchestrationV2SourceScope[];
  shard_artifacts: OrchestrationV2ChapterShardArtifact[];
}

export class OrchestrationV2PlanningRepositoryError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_PLANNING_AUTHORITY_INVALID'
    | 'ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID'
    | 'ORCHESTRATION_V2_PLANNING_WRITE_UNCONFIRMED') {
    super(code);
    this.name = 'OrchestrationV2PlanningRepositoryError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const fail = (code: OrchestrationV2PlanningRepositoryError['code']): never => {
  throw new OrchestrationV2PlanningRepositoryError(code);
};
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;

function liveLeaseSql(alias?: string) {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}id=$1 AND ${prefix}run_id=$2 AND ${prefix}workspace_id=$3 AND ${prefix}tenant_id=$4
    AND ${prefix}status='running' AND ${prefix}lease_token=$5::uuid
    AND ${prefix}lease_expires_at>clock_timestamp() AND ${prefix}deadline_at>clock_timestamp()`;
}

export function createOrchestrationV2PlanningRepository(
  db: GenerationJobDatabase,
  worker: WorkerRepository,
  id: () => string = randomUUID,
) {
  const source = createSourceSnapshotRepositoryV2();

  async function loadAuthority(lease: OrchestrationV2TaskLease): Promise<OrchestrationV2PlanningAuthority> {
    return db.transaction(async tx => {
      const found = await tx.query(`SELECT w.kb_id::text,w.conversation_id::text,w.correlation_id::text,w.content_locale,
          w.source_document_ids,t.id::text AS live_task
        FROM lesson_author_workspaces w
        JOIN lesson_author_workspace_v2_tasks t ON t.workspace_id=w.id AND t.tenant_id=w.tenant_id AND t.course_id=w.course_id
        JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.user_id=w.requested_by
          AND c.course_id=w.course_id AND c.bot_id=w.bot_id AND c.target='lesson_author'
        JOIN tenant_kb_assignments ka ON ka.tenant_id=w.tenant_id AND ka.kb_id=w.kb_id AND ka.target='lesson_author'
        WHERE ${liveLeaseSql('t')} FOR SHARE OF w,c,ka`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      const row = found.rows[0];
      if (found.rows.length !== 1 || !row || !UUID.test(String(row.kb_id)) || !UUID.test(String(row.conversation_id))
        || !UUID.test(String(row.correlation_id)) || !['vi', 'en'].includes(String(row.content_locale))
        || !Array.isArray(row.source_document_ids) || row.source_document_ids.length < 1
        || row.source_document_ids.length > 5 || row.source_document_ids.some(value => !UUID.test(String(value)))) {
        fail('ORCHESTRATION_V2_PLANNING_AUTHORITY_INVALID');
      }
      const documents = await tx.query(`SELECT id::text AS document_id,kb_id::text,name,type,status
        FROM kb_documents WHERE tenant_id=$1 AND kb_id=$2 AND id=ANY($3::uuid[]) AND status='learned'
        ORDER BY id FOR SHARE`, [lease.tenant_id, row.kb_id, row.source_document_ids]);
      if (documents.rows.length !== new Set(row.source_document_ids as string[]).size) {
        fail('ORCHESTRATION_V2_PLANNING_AUTHORITY_INVALID');
      }
      return Object.freeze({
        tenant_id: lease.tenant_id, kb_id: String(row.kb_id), conversation_id: String(row.conversation_id),
        correlation_id: String(row.correlation_id), locale: row.content_locale as 'vi' | 'en',
        source_documents: documents.rows.map(document => ({
          document_id: String(document.document_id), kb_id: String(document.kb_id), name: String(document.name),
          type: String(document.type), status: String(document.status),
        })),
      });
    });
  }

  async function persistSourcePage(
    lease: OrchestrationV2TaskLease,
    page: OrchestrationV2SourceSnapshotPageResponse,
    startOrdinal: number,
  ): Promise<void> {
    if (lease.kind !== 'source_snapshot' || page.source_snapshot_hash !== lease.source_snapshot_hash
      || !Number.isSafeInteger(startOrdinal) || startOrdinal < 0 || page.facts.length < 1) {
      fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
    }
    await db.transaction(async tx => {
      const live = await tx.query(`SELECT id FROM lesson_author_workspace_v2_tasks
        WHERE ${liveLeaseSql()} FOR UPDATE`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      if (live.rows.length !== 1) fail('ORCHESTRATION_V2_PLANNING_WRITE_UNCONFIRMED');
      await source.appendPage(tx, {
        snapshotId: lease.source_snapshot_id, workspaceId: lease.workspace_id,
        tenantId: lease.tenant_id, courseId: lease.course_id,
      }, startOrdinal, page.facts.map(fact => ({
        document_id: fact.document_id, fact_key: fact.fact_key, scope_key: fact.scope_key,
        source_ref: fact.source_ref, source_page: fact.source_page, source_chunk: fact.source_chunk,
        fact_text: fact.fact_text, locator: fact.locator,
      })));
    });
  }

  async function loadPersistedSourceCatalog(lease: OrchestrationV2TaskLease): Promise<OrchestrationV2SourceScope[]> {
    if (lease.kind !== 'source_snapshot') fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
    return db.transaction(async tx => {
      const live = await tx.query(`SELECT id FROM lesson_author_workspace_v2_tasks
        WHERE ${liveLeaseSql()} FOR UPDATE`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      if (live.rows.length !== 1) fail('ORCHESTRATION_V2_PLANNING_WRITE_UNCONFIRMED');
      return source.loadCatalog(tx, { snapshotId: lease.source_snapshot_id, workspaceId: lease.workspace_id,
        tenantId: lease.tenant_id, courseId: lease.course_id });
    });
  }

  async function completeSource(
    lease: OrchestrationV2TaskLease,
    response: { contract_version: 2; source_snapshot_hash: string; source_authority: OrchestrationV2SourceAuthority },
    scopes: readonly OrchestrationV2SourceScope[],
    skeletonBudget: OrchestrationV2PlanningBudgets['skeleton'],
  ): Promise<void> {
    if (lease.kind !== 'source_snapshot' || response.source_snapshot_hash !== lease.source_snapshot_hash) {
      fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
    }
    const sourceAuthority = (() => {
      try {
        return readOrchestrationV2SourceAuthority(response.source_authority);
      } catch {
        return fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
      }
    })();
    const payload = { contract_version: 2, source_snapshot_hash: response.source_snapshot_hash,
      source_authority: sourceAuthority, scopes };
    const catalogHash = orchestrationV2Hash(payload);
    const skeleton = buildOrchestrationV2SkeletonTask(lease.source_snapshot_hash, catalogHash, skeletonBudget);
    await worker.succeed(lease, catalogHash, 'source-catalog-v2', {}, {
      artifact_kind: 'source_catalog', artifact_hash: catalogHash, payload, validation_contract: 'source-catalog-v2',
    }, async () => undefined, {
      beforeSuccess: async tx => {
        await source.seal(tx, { snapshotId: lease.source_snapshot_id, workspaceId: lease.workspace_id,
          tenantId: lease.tenant_id, courseId: lease.course_id });
      },
      afterSuccess: async tx => {
        const taskId = id(), outboxId = id();
        const inserted = await tx.query(`INSERT INTO lesson_author_workspace_v2_tasks
            (id,run_id,workspace_id,tenant_id,course_id,ordinal,task_key,kind,contract_hash,input_context_hash,
             priority,status,max_attempts,provider_max_attempts,input_tokens,embedding_tokens,max_output_tokens,execution_budget_ms)
          VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,10,'blocked',2,$10,$11,$12,$13,$14) RETURNING id`,
        [taskId, lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id, skeleton.task_key, skeleton.kind,
          skeleton.contract_hash, skeleton.input_context_hash, skeleton.budget.max_provider_attempts,
          skeleton.budget.input_tokens, skeleton.budget.embedding_tokens, skeleton.budget.max_output_tokens,
          skeleton.budget.execution_budget_ms]);
        const dependency = await tx.query(`INSERT INTO lesson_author_workspace_v2_dependencies
            (workspace_id,tenant_id,course_id,run_id,task_id,depends_on_task_id)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING task_id`,
        [lease.workspace_id, lease.tenant_id, lease.course_id, lease.run_id, taskId, lease.task_id]);
        const queued = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='queued'
          WHERE id=$1 AND run_id=$2 AND status='blocked' RETURNING id`, [taskId, lease.run_id]);
        const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
            (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
          VALUES($1,$2,$3,$4,$5,$6,0,$7) RETURNING id`,
        [outboxId, lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id, taskId, lease.routing_shard]);
        if ([inserted, dependency, queued, outbox].some(result => result.rows.length !== 1)) {
          fail('ORCHESTRATION_V2_PLANNING_WRITE_UNCONFIRMED');
        }
      },
    });
  }

  async function loadSourceCatalog(lease: OrchestrationV2TaskLease): Promise<OrchestrationV2SourceScope[]> {
    return db.transaction(async tx => {
      const result = await tx.query(`SELECT a.payload,a.artifact_hash
        FROM lesson_author_workspace_v2_artifacts a
        JOIN lesson_author_workspace_v2_tasks source_task ON source_task.id=a.task_id AND source_task.run_id=a.run_id
        JOIN lesson_author_workspace_v2_tasks current_task ON current_task.run_id=a.run_id
        WHERE ${liveLeaseSql('current_task')} AND a.artifact_kind='source_catalog'
          AND source_task.kind='source_snapshot' AND source_task.status='succeeded'`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      const payload = record(result.rows[0]?.payload);
      const scopes = payload?.scopes;
      if (result.rows.length !== 1 || !payload || !HASH.test(String(result.rows[0].artifact_hash))
        || payload.source_snapshot_hash !== lease.source_snapshot_hash || !Array.isArray(scopes) || !scopes.length) {
        fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
      }
      return scopes as OrchestrationV2SourceScope[];
    });
  }

  async function loadSourceAuthority(lease: OrchestrationV2TaskLease): Promise<OrchestrationV2SourceAuthority> {
    return db.transaction(async tx => {
      const result = await tx.query(`SELECT a.payload,a.artifact_hash
        FROM lesson_author_workspace_v2_artifacts a
        JOIN lesson_author_workspace_v2_tasks source_task ON source_task.id=a.task_id AND source_task.run_id=a.run_id
        JOIN lesson_author_workspace_v2_tasks current_task ON current_task.run_id=a.run_id
        WHERE ${liveLeaseSql('current_task')} AND a.artifact_kind='source_catalog'
          AND source_task.kind='source_snapshot' AND source_task.status='succeeded'`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      const payload = record(result.rows[0]?.payload);
      const authority = payload?.source_authority;
      if (result.rows.length !== 1 || !payload || !authority || !HASH.test(String(result.rows[0].artifact_hash))
        || payload.source_snapshot_hash !== lease.source_snapshot_hash) {
        fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
      }
      try {
        return readOrchestrationV2SourceAuthority(authority);
      } catch {
        return fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
      }
    });
  }

  async function completeSkeleton(
    lease: OrchestrationV2TaskLease,
    response: OrchestrationV2CourseSkeletonResponse,
    scopes: OrchestrationV2SourceScope[],
    budgets: OrchestrationV2PlanningBudgets,
    settleProvider: SettleProvider,
  ): Promise<void> {
    if (lease.kind !== 'course_skeleton' || response.skeleton.source_snapshot_hash !== lease.source_snapshot_hash) {
      fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
    }
    const skeletonHash = orchestrationV2Hash(response.skeleton);
    const plan = planOrchestrationV2ChapterShards(response.skeleton, scopes, budgets, skeletonHash);
    const payload = { contract_version: 2, skeleton: response.skeleton, scopes,
      shard_plans: plan.chapter_tasks.map(task => task.shard_plan) };
    const artifactHash = orchestrationV2Hash(payload);
    await worker.succeed(lease, artifactHash, 'course-skeleton-v2', response.usage ?? {}, {
      artifact_kind: 'course_skeleton', artifact_hash: artifactHash, payload, validation_contract: 'course-skeleton-v2',
    }, settleProvider, {
      afterSuccess: async tx => {
        const ordinal = await tx.query(`SELECT coalesce(max(ordinal),-1)::integer AS value
          FROM lesson_author_workspace_v2_tasks WHERE run_id=$1`, [lease.run_id]);
        let next = Number(ordinal.rows[0]?.value) + 1;
        const validationId = id();
        const validation = plan.validation_task;
        const chapterRows = plan.chapter_tasks.map(spec => ({
          id: id(), ordinal: next++, task_key: spec.task_key, kind: spec.kind, chapter_key: spec.chapter_key,
          contract_hash: spec.contract_hash, input_context_hash: spec.input_context_hash, priority: 20,
          provider_max_attempts: spec.budget.max_provider_attempts, input_tokens: spec.budget.input_tokens,
          embedding_tokens: spec.budget.embedding_tokens, max_output_tokens: spec.budget.max_output_tokens,
          execution_budget_ms: spec.budget.execution_budget_ms,
        }));
        const taskRows = [...chapterRows, {
          id: validationId, ordinal: next, task_key: validation.task_key, kind: validation.kind, chapter_key: null,
          contract_hash: validation.contract_hash, input_context_hash: validation.input_context_hash, priority: 30,
          provider_max_attempts: 0, input_tokens: 0, embedding_tokens: 0, max_output_tokens: 0,
          execution_budget_ms: validation.budget.execution_budget_ms,
        }];
        const inserted = await tx.query(`INSERT INTO lesson_author_workspace_v2_tasks
            (id,run_id,workspace_id,tenant_id,course_id,ordinal,task_key,kind,chapter_key,contract_hash,input_context_hash,
             priority,status,max_attempts,provider_max_attempts,input_tokens,embedding_tokens,max_output_tokens,execution_budget_ms)
          SELECT x.id::uuid,$2::uuid,$3::uuid,$4::uuid,$5,x.ordinal,x.task_key,x.kind,x.chapter_key,
            x.contract_hash,x.input_context_hash,x.priority,'blocked',2,x.provider_max_attempts,x.input_tokens,
            x.embedding_tokens,x.max_output_tokens,x.execution_budget_ms
          FROM jsonb_to_recordset($1::jsonb) AS x(id text,ordinal integer,task_key text,kind text,chapter_key text,
            contract_hash text,input_context_hash text,priority integer,provider_max_attempts integer,input_tokens integer,
            embedding_tokens integer,max_output_tokens integer,execution_budget_ms integer)
          RETURNING id`, [JSON.stringify(taskRows), lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id]);
        const dependencies = [
          ...chapterRows.map(task => ({ task_id: task.id, depends_on_task_id: lease.task_id })),
          ...chapterRows.map(task => ({ task_id: validationId, depends_on_task_id: task.id })),
        ];
        const dependency = await tx.query(`INSERT INTO lesson_author_workspace_v2_dependencies
            (workspace_id,tenant_id,course_id,run_id,task_id,depends_on_task_id)
          SELECT $2::uuid,$3::uuid,$4,$5::uuid,x.task_id::uuid,x.depends_on_task_id::uuid
          FROM jsonb_to_recordset($1::jsonb) AS x(task_id text,depends_on_task_id text)
          RETURNING task_id`, [JSON.stringify(dependencies), lease.workspace_id, lease.tenant_id,
          lease.course_id, lease.run_id]);
        const taskIds = chapterRows.map(task => task.id);
        const queued = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='queued'
          WHERE run_id=$1 AND id=ANY($2::uuid[]) AND status='blocked' RETURNING id`, [lease.run_id, taskIds]);
        const outboxRows = taskIds.map(taskId => ({ id: id(), task_id: taskId }));
        const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
            (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
          SELECT x.id::uuid,$2::uuid,$3::uuid,$4::uuid,$5,x.task_id::uuid,0,$6
          FROM jsonb_to_recordset($1::jsonb) AS x(id text,task_id text) RETURNING id`,
        [JSON.stringify(outboxRows), lease.run_id, lease.workspace_id, lease.tenant_id,
          lease.course_id, lease.routing_shard]);
        if (inserted.rows.length !== taskRows.length || dependency.rows.length !== dependencies.length
          || queued.rows.length !== taskIds.length || outbox.rows.length !== outboxRows.length) {
          fail('ORCHESTRATION_V2_PLANNING_WRITE_UNCONFIRMED');
        }
      },
    });
  }

  async function loadChapterInput(lease: OrchestrationV2TaskLease): Promise<OrchestrationV2ChapterExecutionInput> {
    return db.transaction(async tx => {
      const result = await tx.query(`SELECT a.payload
        FROM lesson_author_workspace_v2_artifacts a
        JOIN lesson_author_workspace_v2_tasks current_task ON current_task.run_id=a.run_id
        WHERE ${liveLeaseSql('current_task')} AND a.artifact_kind='course_skeleton'`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      const payload = record(result.rows[0]?.payload);
      const skeleton = record(payload?.skeleton) as unknown as OrchestrationV2CourseSkeleton | null;
      const plans = payload?.shard_plans;
      if (result.rows.length !== 1 || !skeleton || !Array.isArray(plans)) {
        throw new OrchestrationV2PlanningRepositoryError('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
      }
      const rawPlans = plans as unknown[];
      const plan = rawPlans.find((candidate: unknown) => {
        const item = record(candidate);
        return item?.chapter_key === lease.chapter_key
          && `architecture:chapter:${item.chapter_key}:shard:${Number(item.shard_index) + 1}` === lease.task_key;
      });
      const shardPlan = record(plan) as unknown as OrchestrationV2ChapterExecutionInput['shard_plan'] | null;
      if (!shardPlan || !Array.isArray(shardPlan.source_scope_ids)) {
        throw new OrchestrationV2PlanningRepositoryError('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
      }
      const verifiedPlan = shardPlan;
      const facts = await tx.query(`SELECT document_id::text,fact_key,scope_key,fact_text,source_ref,source_page,source_chunk,locator
        FROM lesson_author_workspace_source_facts WHERE snapshot_id=$1 AND scope_key=ANY($2::text[]) ORDER BY ordinal`,
      [lease.source_snapshot_id, verifiedPlan.source_scope_ids]);
      if (facts.rows.length !== verifiedPlan.source_fact_count
        || facts.rows.reduce((sum, fact) => sum + String(fact.fact_text).length, 0) !== verifiedPlan.source_content_chars) {
        fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
      }
      return { skeleton, shard_plan: verifiedPlan, source_facts: facts.rows as unknown as OrchestrationV2SourceFact[] };
    });
  }

  async function completeChapter(
    lease: OrchestrationV2TaskLease,
    response: OrchestrationV2ChapterShardResponse,
    settleProvider: SettleProvider,
  ): Promise<void> {
    if (lease.kind !== 'chapter_blueprint' || response.shard.source_snapshot_hash !== lease.source_snapshot_hash
      || response.shard.chapter_key !== lease.chapter_key) fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
    const payload = { contract_version: 2, shard: response.shard };
    const artifactHash = orchestrationV2Hash(payload);
    await worker.succeed(lease, artifactHash, 'chapter-blueprint-shard-v2', response.usage ?? {}, {
      artifact_kind: 'chapter_blueprint', artifact_hash: artifactHash, payload,
      validation_contract: 'chapter-blueprint-shard-v2',
    }, settleProvider, {
      afterSuccess: async tx => {
        const ready = await tx.query(`UPDATE lesson_author_workspace_v2_tasks candidate SET status='queued'
          WHERE candidate.run_id=$1 AND candidate.task_key='architecture:validate' AND candidate.status='blocked'
            AND NOT EXISTS(SELECT 1 FROM lesson_author_workspace_v2_dependencies d
              JOIN lesson_author_workspace_v2_tasks parent ON parent.id=d.depends_on_task_id AND parent.run_id=d.run_id
              WHERE d.run_id=candidate.run_id AND d.task_id=candidate.id AND parent.status<>'succeeded')
          RETURNING candidate.id::text`, [lease.run_id]);
        if (!ready.rows.length) return;
        if (ready.rows.length !== 1) fail('ORCHESTRATION_V2_PLANNING_WRITE_UNCONFIRMED');
        const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
            (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
          VALUES($1,$2,$3,$4,$5,$6,0,$7) RETURNING id`,
        [id(), lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id, ready.rows[0].id, lease.routing_shard]);
        if (outbox.rows.length !== 1) fail('ORCHESTRATION_V2_PLANNING_WRITE_UNCONFIRMED');
      },
    });
  }

  async function loadArchitectureInput(
    lease: OrchestrationV2TaskLease,
  ): Promise<OrchestrationV2ArchitectureExecutionInput> {
    if (lease.kind !== 'validate_architecture') fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
    return db.transaction(async tx => {
      const result = await tx.query(`SELECT a.artifact_kind,a.artifact_hash,a.payload,t.task_key,t.kind
        FROM lesson_author_workspace_v2_artifacts a
        JOIN lesson_author_workspace_v2_tasks t ON t.id=a.task_id AND t.run_id=a.run_id
          AND t.workspace_id=a.workspace_id AND t.tenant_id=a.tenant_id AND t.course_id=a.course_id
        JOIN lesson_author_workspace_v2_tasks current_task ON current_task.run_id=a.run_id
          AND current_task.workspace_id=a.workspace_id AND current_task.tenant_id=a.tenant_id
          AND current_task.course_id=a.course_id
        WHERE ${liveLeaseSql('current_task')} AND t.status='succeeded'
          AND a.artifact_kind IN ('course_skeleton','chapter_blueprint')
        ORDER BY CASE a.artifact_kind WHEN 'course_skeleton' THEN 0 ELSE 1 END,t.ordinal,a.id`,
      [lease.task_id, lease.run_id, lease.workspace_id, lease.tenant_id, lease.lease_token]);
      const skeletonRows = result.rows.filter(row => row.artifact_kind === 'course_skeleton');
      const shardRows = result.rows.filter(row => row.artifact_kind === 'chapter_blueprint');
      if (skeletonRows.length !== 1 || shardRows.length < 1 || shardRows.length > 4_096) {
        fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
      }
      const skeletonPayload = record(skeletonRows[0]?.payload);
      const scopes = skeletonPayload?.scopes;
      const plans = skeletonPayload?.shard_plans;
      if (!skeletonPayload || !Array.isArray(scopes) || !Array.isArray(plans)
        || plans.length !== shardRows.length || skeletonRows[0]?.kind !== 'course_skeleton'
        || !HASH.test(String(skeletonRows[0]?.artifact_hash))
        || String(skeletonRows[0]?.artifact_hash) !== orchestrationV2Hash(skeletonPayload)) {
        fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
      }
      const safeSkeletonPayload = skeletonPayload as Record<string, unknown>;
      const parsedSkeleton = readOrchestrationV2CourseSkeletonResponse({ contract_version: 2,
        skeleton: safeSkeletonPayload.skeleton }, lease.source_snapshot_hash).skeleton;
      const shardArtifacts: OrchestrationV2ChapterShardArtifact[] = shardRows.map(row => {
        const payload = record(row.payload);
        if (!payload || !HASH.test(String(row.artifact_hash)) || row.kind !== 'chapter_blueprint'
          || String(row.artifact_hash) !== orchestrationV2Hash(payload)) {
          fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
        }
        const rawShard = record(payload?.shard);
        const plan = (plans as unknown[]).find(candidate => {
          const item = record(candidate);
          return item?.chapter_key === rawShard?.chapter_key && item?.shard_index === rawShard?.shard_index;
        });
        if (!plan) fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
        const safePayload = payload as Record<string, unknown>;
        const parsed = readOrchestrationV2ChapterShardResponse({ contract_version: 2, shard: safePayload.shard },
          parsedSkeleton, plan as Parameters<typeof readOrchestrationV2ChapterShardResponse>[2]);
        return { artifact_hash: String(row.artifact_hash), shard: parsed.shard };
      });
      if (new Set(shardArtifacts.map(value => `${value.shard.chapter_key}:${value.shard.shard_index}`)).size
        !== shardArtifacts.length) fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
      return { skeleton: parsedSkeleton, scopes: scopes as OrchestrationV2SourceScope[],
        shard_artifacts: shardArtifacts };
    });
  }

  async function completeArchitecture(
    lease: OrchestrationV2TaskLease,
    assembly: Readonly<OrchestrationV2ArchitectureAssembly>,
    inventoryPublishBudgetMs: number,
  ): Promise<void> {
    if (lease.kind !== 'validate_architecture' || assembly.source_snapshot_hash !== lease.source_snapshot_hash
      || assembly.assembly_hash !== orchestrationV2Hash({
        contract_version: assembly.contract_version, source_snapshot_hash: assembly.source_snapshot_hash,
        skeleton_hash: assembly.skeleton_hash, shard_hashes: assembly.shard_hashes,
        admitted_fact_count: assembly.admitted_fact_count, allocated_fact_count: assembly.allocated_fact_count,
        duplicate_scope_count: assembly.duplicate_scope_count, unresolved_scope_count: assembly.unresolved_scope_count,
        chapter_count: assembly.chapter_count, lesson_count: assembly.lesson_count, unit_count: assembly.unit_count,
        component_plan_count: assembly.component_plan_count, architecture: assembly.architecture,
      })) fail('ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID');
    const inventory = buildOrchestrationV2InventoryTask(assembly.assembly_hash, inventoryPublishBudgetMs);
    await worker.succeed(lease, assembly.assembly_hash, 'architecture-validation-v2', {}, {
      artifact_kind: 'architecture_validation', artifact_hash: assembly.assembly_hash,
      payload: assembly as unknown as Record<string, unknown>, validation_contract: 'architecture-validation-v2',
    }, async () => undefined, {
      afterSuccess: async tx => {
        const ordinal = await tx.query(`SELECT coalesce(max(ordinal),-1)::integer AS value
          FROM lesson_author_workspace_v2_tasks WHERE run_id=$1`, [lease.run_id]);
        const previousOrdinal = Number(ordinal.rows[0]?.value);
        if (!Number.isSafeInteger(previousOrdinal) || previousOrdinal < 0 || previousOrdinal >= 32_767) {
          fail('ORCHESTRATION_V2_PLANNING_WRITE_UNCONFIRMED');
        }
        const taskId = id();
        const inserted = await tx.query(`INSERT INTO lesson_author_workspace_v2_tasks
            (id,run_id,workspace_id,tenant_id,course_id,ordinal,task_key,kind,contract_hash,input_context_hash,
             priority,status,max_attempts,provider_max_attempts,input_tokens,embedding_tokens,max_output_tokens,execution_budget_ms)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,40,'blocked',2,0,0,0,0,$11) RETURNING id`,
        [taskId, lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id,
          previousOrdinal + 1, inventory.task_key, inventory.kind, inventory.contract_hash,
          inventory.input_context_hash, inventory.budget.execution_budget_ms]);
        const dependency = await tx.query(`INSERT INTO lesson_author_workspace_v2_dependencies
            (workspace_id,tenant_id,course_id,run_id,task_id,depends_on_task_id)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING task_id`,
        [lease.workspace_id, lease.tenant_id, lease.course_id, lease.run_id, taskId, lease.task_id]);
        const queued = await tx.query(`UPDATE lesson_author_workspace_v2_tasks SET status='queued'
          WHERE id=$1 AND run_id=$2 AND status='blocked' RETURNING id`, [taskId, lease.run_id]);
        const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
            (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
          VALUES($1,$2,$3,$4,$5,$6,0,$7) RETURNING id`,
        [id(), lease.run_id, lease.workspace_id, lease.tenant_id, lease.course_id, taskId, lease.routing_shard]);
        if ([inserted, dependency, queued, outbox].some(value => value.rows.length !== 1)) {
          fail('ORCHESTRATION_V2_PLANNING_WRITE_UNCONFIRMED');
        }
      },
    });
  }

  return { loadAuthority, persistSourcePage, loadPersistedSourceCatalog, completeSource, loadSourceCatalog,
    loadSourceAuthority,
    completeSkeleton, loadChapterInput, completeChapter, loadArchitectureInput, completeArchitecture };
}
