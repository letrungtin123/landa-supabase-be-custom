import { randomUUID } from 'node:crypto';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { lessonAuthorSourceSnapshotHash, type LessonAuthorSnapshotDocument } from './lesson-author-source-snapshot.logic.js';
import {
  prepareOrchestrationV2Admission,
  type OrchestrationV2AdmissionConfig,
} from './lesson-author-orchestration-v2-admission.logic.js';

export interface OrchestrationV2AdmissionTarget {
  workspaceId: string;
  tenantId: string;
  courseId: string;
  conversationId: string;
  userId: string;
}

export interface OrchestrationV2AdmissionReceipt {
  created: boolean;
  run_id: string;
  snapshot_id: string;
  task_id: string;
  outbox_id: string;
  bootstrap_hash: string;
  source_snapshot_hash: string;
}

export class OrchestrationV2AdmissionError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_ADMISSION_FORBIDDEN'
    | 'ORCHESTRATION_V2_ADMISSION_STATE_INVALID'
    | 'ORCHESTRATION_V2_ADMISSION_SOURCE_CHANGED'
    | 'ORCHESTRATION_V2_ADMISSION_CONFLICT'
    | 'ORCHESTRATION_V2_ADMISSION_WRITE_UNCONFIRMED') {
    super(code);
    this.name = 'OrchestrationV2AdmissionError';
  }
}

type Dependencies = {
  db: GenerationJobDatabase;
  canEdit(tx: GenerationJobSql, target: OrchestrationV2AdmissionTarget): Promise<boolean>;
  id?: () => string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const validId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const fail = (code: OrchestrationV2AdmissionError['code']): never => { throw new OrchestrationV2AdmissionError(code); };

/**
 * Admit exactly one planning run. Snapshot, run, first task and outbox identity
 * commit together. Broker publication is deliberately outside this repository.
 */
export function createOrchestrationV2AdmissionRepository(deps: Dependencies) {
  const id = deps.id ?? randomUUID;
  async function admit(
    target: OrchestrationV2AdmissionTarget,
    config: OrchestrationV2AdmissionConfig,
  ): Promise<OrchestrationV2AdmissionReceipt> {
    return deps.db.transaction(async tx => {
      if (!await deps.canEdit(tx, target)) fail('ORCHESTRATION_V2_ADMISSION_FORBIDDEN');
      const workspace = await tx.query(`SELECT w.id,w.status,w.kb_id,w.source_snapshot_hash,w.source_document_ids
        FROM lesson_author_workspaces w
        JOIN chat_conversations c ON c.id=w.conversation_id AND c.tenant_id=w.tenant_id AND c.user_id=w.requested_by
          AND c.course_id=w.course_id AND c.bot_id=w.bot_id AND c.target='lesson_author'
        JOIN courses course ON course.id=w.course_id AND course.tenant_id=w.tenant_id AND course.deleted_at IS NULL
        WHERE w.id=$1 AND w.tenant_id=$2 AND w.course_id=$3 AND w.conversation_id=$4 AND w.requested_by=$5
          AND w.contract_version=1 AND w.engine='self_built_rag' FOR UPDATE OF w`,
      [target.workspaceId, target.tenantId, target.courseId, target.conversationId, target.userId]);
      const w = workspace.rows[0];
      if (workspace.rows.length !== 1 || !w || !validId(w.kb_id) || !HASH.test(String(w.source_snapshot_hash))
        || !Array.isArray(w.source_document_ids) || w.source_document_ids.some((value: unknown) => !validId(value))
        || w.source_document_ids.length < 1 || w.source_document_ids.length > 5
        || !['designing', 'needs_action'].includes(String(w.status))) fail('ORCHESTRATION_V2_ADMISSION_STATE_INVALID');
      const kbId = w.kb_id as string;
      const sourceDocumentIds = w.source_document_ids as string[];

      const documents = await tx.query(`SELECT d.id::text AS document_id,d.name,d.status,d.type,d.updated_at,d.source_info
        FROM kb_documents d WHERE d.tenant_id=$1 AND d.kb_id=$2 AND d.id=ANY($3::uuid[])
        ORDER BY d.id FOR SHARE OF d`, [target.tenantId, kbId, sourceDocumentIds]);
      const expected = new Set<string>(sourceDocumentIds);
      if (documents.rows.length !== expected.size || new Set(documents.rows.map(row => row.document_id)).size !== expected.size) {
        fail('ORCHESTRATION_V2_ADMISSION_SOURCE_CHANGED');
      }
      const sources: LessonAuthorSnapshotDocument[] = documents.rows.map(row => {
        const date = row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at));
        if (!validId(row.document_id) || !expected.has(row.document_id) || row.type !== 'file' || row.status !== 'learned'
          || typeof row.name !== 'string' || !row.name || !Number.isFinite(date.getTime())
          || (row.source_info !== null && (typeof row.source_info !== 'object' || Array.isArray(row.source_info)))) {
          return fail('ORCHESTRATION_V2_ADMISSION_SOURCE_CHANGED');
        }
        return { document_id: row.document_id, name: row.name, status: row.status,
          updated_at: date.toISOString(), source_info: row.source_info as Record<string, unknown> | null };
      });
      const sourceHash = lessonAuthorSourceSnapshotHash({ tenantId: target.tenantId, courseId: target.courseId }, kbId, sources);
      if (sourceHash !== w.source_snapshot_hash) fail('ORCHESTRATION_V2_ADMISSION_SOURCE_CHANGED');
      const prepared = prepareOrchestrationV2Admission({
        workspace_id: target.workspaceId, tenant_id: target.tenantId, course_id: target.courseId,
        source_snapshot_hash: sourceHash, source_document_ids: sourceDocumentIds,
      }, config);

      const existing = await tx.query(`SELECT id::text,source_snapshot_id::text,bootstrap_hash,runtime_config_hash,model,
          tenant_concurrency_limit,workspace_concurrency_limit
        FROM lesson_author_workspace_v2_runs WHERE workspace_id=$1 AND tenant_id=$2 AND course_id=$3 FOR UPDATE`,
      [target.workspaceId, target.tenantId, target.courseId]);
      if (existing.rows.length) {
        const run = existing.rows[0];
        if (existing.rows.length !== 1 || run.bootstrap_hash !== prepared.bootstrap_hash
          || run.runtime_config_hash !== config.runtime_config_hash || run.model !== config.model
          || Number(run.tenant_concurrency_limit) !== config.tenant_concurrency_limit
          || Number(run.workspace_concurrency_limit) !== config.workspace_concurrency_limit
          || !validId(run.id) || !validId(run.source_snapshot_id)) fail('ORCHESTRATION_V2_ADMISSION_CONFLICT');
        const evidence = await tx.query(`SELECT s.id::text AS snapshot_id,t.id::text AS task_id,o.id::text AS outbox_id
          FROM lesson_author_workspace_source_snapshots s
          JOIN lesson_author_workspace_v2_tasks t ON t.run_id=$2 AND t.workspace_id=s.workspace_id
            AND t.tenant_id=s.tenant_id AND t.course_id=s.course_id AND t.task_key='source:snapshot'
          JOIN lesson_author_workspace_v2_dispatch_outbox o ON o.task_id=t.id AND o.run_id=t.run_id
            AND o.dispatch_epoch=0 AND o.workspace_id=t.workspace_id AND o.tenant_id=t.tenant_id AND o.course_id=t.course_id
          WHERE s.id=$1 AND s.workspace_id=$3 AND s.tenant_id=$4 AND s.course_id=$5`,
        [run.source_snapshot_id, run.id, target.workspaceId, target.tenantId, target.courseId]);
        const row = evidence.rows[0];
        if (evidence.rows.length !== 1 || !validId(row?.snapshot_id) || !validId(row?.task_id) || !validId(row?.outbox_id)) {
          fail('ORCHESTRATION_V2_ADMISSION_CONFLICT');
        }
        return { created: false, run_id: run.id as string, snapshot_id: row.snapshot_id as string,
          task_id: row.task_id as string, outbox_id: row.outbox_id as string,
          bootstrap_hash: prepared.bootstrap_hash, source_snapshot_hash: sourceHash };
      }

      const snapshotId = id(), runId = id(), taskId = id(), outboxId = id();
      if (![snapshotId, runId, taskId, outboxId].every(validId)) fail('ORCHESTRATION_V2_ADMISSION_WRITE_UNCONFIRMED');
      const snapshot = await tx.query(`INSERT INTO lesson_author_workspace_source_snapshots
          (id,workspace_id,tenant_id,course_id,source_snapshot_hash,source_document_ids)
        VALUES($1,$2,$3,$4,$5,$6::uuid[]) RETURNING id::text`,
      [snapshotId, target.workspaceId, target.tenantId, target.courseId, sourceHash, prepared.source_document_ids]);
      const run = await tx.query(`INSERT INTO lesson_author_workspace_v2_runs
          (id,workspace_id,tenant_id,course_id,source_snapshot_id,bootstrap_hash,runtime_config_hash,model,
           tenant_concurrency_limit,workspace_concurrency_limit)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text`,
      [runId, target.workspaceId, target.tenantId, target.courseId, snapshotId, prepared.bootstrap_hash,
        config.runtime_config_hash, config.model, config.tenant_concurrency_limit, config.workspace_concurrency_limit]);
      const task = await tx.query(`INSERT INTO lesson_author_workspace_v2_tasks
          (id,run_id,workspace_id,tenant_id,course_id,ordinal,task_key,kind,contract_hash,input_context_hash,
           priority,status,max_attempts,provider_max_attempts,input_tokens,embedding_tokens,max_output_tokens,execution_budget_ms)
        VALUES($1,$2,$3,$4,$5,0,'source:snapshot','source_snapshot',$6,$7,0,'queued',2,0,0,0,0,$8)
        RETURNING id::text`, [taskId, runId, target.workspaceId, target.tenantId, target.courseId,
        prepared.source_task_contract_hash, sourceHash, config.source_snapshot_budget_ms]);
      const outbox = await tx.query(`INSERT INTO lesson_author_workspace_v2_dispatch_outbox
          (id,run_id,workspace_id,tenant_id,course_id,task_id,dispatch_epoch,routing_shard)
        VALUES($1,$2,$3,$4,$5,$6,0,$7) RETURNING id::text`,
      [outboxId, runId, target.workspaceId, target.tenantId, target.courseId, taskId, prepared.routing_shard]);
      if (snapshot.rows[0]?.id !== snapshotId || run.rows[0]?.id !== runId
        || task.rows[0]?.id !== taskId || outbox.rows[0]?.id !== outboxId) {
        fail('ORCHESTRATION_V2_ADMISSION_WRITE_UNCONFIRMED');
      }
      return { created: true, run_id: runId, snapshot_id: snapshotId, task_id: taskId,
        outbox_id: outboxId, bootstrap_hash: prepared.bootstrap_hash, source_snapshot_hash: sourceHash };
    });
  }
  return { admit };
}
