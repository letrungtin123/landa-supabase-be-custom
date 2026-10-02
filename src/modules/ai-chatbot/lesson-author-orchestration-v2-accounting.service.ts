import type { AiUsage } from './ai-engine.types.js';
import {
  finalizeTenantAiTokens,
  releaseTenantAiTokenReservation,
  reserveTenantAiTokens,
} from './ai-token-quota.service.js';
import { getTenantAiRuntimeSettings } from './ai-settings.service.js';
import { resolveOrchestrationV2LessonAuthorModel } from './lesson-author-orchestration-v2-execution.config.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { orchestrationV2ObservedUsage } from './lesson-author-orchestration-v2-worker.logic.js';
import type {
  OrchestrationV2ProviderUsageSource,
  OrchestrationV2TaskLease,
} from './lesson-author-orchestration-v2-worker.repository.js';

type TaskRow = Record<string, unknown>;
type RuntimeSettings = Awaited<ReturnType<typeof getTenantAiRuntimeSettings>>;

interface AccountingDependencies {
  settings(tenantId: string): Promise<RuntimeSettings>;
  reserve: typeof reserveTenantAiTokens;
  finalize: typeof finalizeTenantAiTokens;
  release: typeof releaseTenantAiTokenReservation;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integer = (value: unknown, minimum = 0, maximum = 2_000_000): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

export class OrchestrationV2AccountingError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID'
    | 'ORCHESTRATION_V2_ACCOUNTING_BUDGET_INVALID'
    | 'ORCHESTRATION_V2_ACCOUNTING_USAGE_INCOMPLETE'
    | 'ORCHESTRATION_V2_ACCOUNTING_READBACK_INVALID') {
    super(code);
    this.name = 'OrchestrationV2AccountingError';
  }
}

const fail = (code: OrchestrationV2AccountingError['code']): never => {
  throw new OrchestrationV2AccountingError(code);
};

function identity(task: TaskRow) {
  const output = {
    taskId: String(task.id), runId: String(task.run_id), workspaceId: String(task.workspace_id),
    tenantId: String(task.tenant_id), model: String(task.model), kind: String(task.kind),
  };
  if (![output.taskId, output.runId, output.workspaceId, output.tenantId].every(value => UUID.test(value))
    || !output.model || !['course_skeleton', 'chapter_blueprint', 'generate_unit'].includes(output.kind)) {
    fail('ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID');
  }
  return output;
}

function budget(task: TaskRow) {
  const input = Number(task.input_tokens), embedding = Number(task.embedding_tokens),
    output = Number(task.max_output_tokens), attempts = Number(task.provider_max_attempts);
  if (!integer(input, 1) || !integer(embedding) || !integer(output, 1, 65_536)
    || !integer(attempts, 1, 2)) fail('ORCHESTRATION_V2_ACCOUNTING_BUDGET_INVALID');
  const outputCeiling = output * attempts;
  const total = input + embedding + outputCeiling;
  if (!Number.isSafeInteger(total) || total < 1 || total > 2_000_000) {
    fail('ORCHESTRATION_V2_ACCOUNTING_BUDGET_INVALID');
  }
  return { input, embedding, output, outputCeiling, total };
}

function completeUsage(value: unknown): AiUsage {
  const usage = orchestrationV2ObservedUsage(value);
  const keys = ['inputTokens', 'outputTokens', 'embeddingTokens', 'totalTokens'] as const;
  if (keys.some(key => !Object.hasOwn(usage, key))) fail('ORCHESTRATION_V2_ACCOUNTING_USAGE_INCOMPLETE');
  return usage as unknown as AiUsage;
}

export function createOrchestrationV2QuotaAccounting(deps: AccountingDependencies) {
  async function reserveProvider(tx: GenerationJobSql, task: TaskRow): Promise<string> {
    const target = identity(task), limits = budget(task);
    const authority = await tx.query(`SELECT w.requested_by::text,w.conversation_id::text,w.correlation_id::text
      FROM lesson_author_workspaces w
      JOIN lesson_author_workspace_v2_runs r ON r.workspace_id=w.id AND r.tenant_id=w.tenant_id
        AND r.course_id=w.course_id AND r.id=$2
      JOIN lesson_author_workspace_v2_tasks t ON t.run_id=r.id AND t.id=$1 AND t.workspace_id=w.id
        AND t.tenant_id=w.tenant_id AND t.course_id=w.course_id
      WHERE w.id=$3 AND w.tenant_id=$4 AND r.model=$5 FOR SHARE OF w,r,t`,
    [target.taskId, target.runId, target.workspaceId, target.tenantId, target.model]);
    const owner = authority.rows[0];
    if (authority.rows.length !== 1 || !UUID.test(String(owner?.requested_by))
      || !UUID.test(String(owner?.conversation_id)) || !UUID.test(String(owner?.correlation_id))) {
      fail('ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID');
    }
    const settings = await deps.settings(target.tenantId);
    if (settings.activeEngine !== 'self_built_rag'
      || resolveOrchestrationV2LessonAuthorModel(settings.lessonAuthorModel) !== target.model
      || !settings.hasGoogleAiStudioKey) fail('ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID');
    const grant = await deps.reserve({
      tenantId: target.tenantId,
      userId: String(owner.requested_by),
      conversationId: String(owner.conversation_id),
      target: 'lesson_author',
      engine: 'self_built_rag',
      provider: settings.provider,
      model: target.model,
      operation: 'lesson_author',
      minimumTokens: limits.total,
      maximumTokens: limits.total,
      budget: {
        inputTokens: limits.input,
        outputTokens: limits.outputCeiling,
        embeddingTokens: limits.embedding,
        maxOutputTokens: limits.output,
        metadata: {
          durable_generation: true,
          orchestration_version: 2,
          orchestration_run_id: target.runId,
          orchestration_task_id: target.taskId,
          workspace_id: target.workspaceId,
          correlation_id: String(owner.correlation_id),
        },
      },
    });
    if (grant.isPartialGrant || grant.reservedTokens !== limits.total || !UUID.test(grant.id)) {
      fail('ORCHESTRATION_V2_ACCOUNTING_BUDGET_INVALID');
    }
    const readback = await tx.query(`SELECT id::text,status,estimated_tokens::text,budget_metadata
      FROM ai_token_reservations WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [grant.id, target.tenantId]);
    const row = readback.rows[0], metadata = row?.budget_metadata as Record<string, unknown> | undefined;
    if (readback.rows.length !== 1 || row?.status !== 'reserved' || Number(row.estimated_tokens) !== limits.total
      || metadata?.orchestration_task_id !== target.taskId || metadata?.orchestration_run_id !== target.runId) {
      fail('ORCHESTRATION_V2_ACCOUNTING_READBACK_INVALID');
    }
    return grant.id;
  }

  async function settleProvider(
    tx: GenerationJobSql,
    lease: OrchestrationV2TaskLease,
    observed: Readonly<Record<string, number>>,
    usageSource: OrchestrationV2ProviderUsageSource = 'provider',
  ): Promise<void> {
    const reservationId = lease.ai_reservation_id
      ?? fail('ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID');
    if (!UUID.test(reservationId)) fail('ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID');
    // Reject malformed exact usage before touching the locked reservation. The
    // upper-bound path deliberately derives usage from server-owned DB budgets.
    const observedUsage = usageSource === 'provider' ? completeUsage(observed) : null;
    const settings = await deps.settings(lease.tenant_id);
    if (settings.activeEngine !== 'self_built_rag'
      || resolveOrchestrationV2LessonAuthorModel(settings.lessonAuthorModel) !== lease.model) {
      fail('ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID');
    }
    const authority = await tx.query(`SELECT r.id::text,r.status,r.estimated_tokens::text,r.budget_metadata,
        r.budget_input_tokens::text,r.budget_output_tokens::text,r.budget_embedding_tokens::text
      FROM ai_token_reservations r
      JOIN lesson_author_workspace_v2_tasks t ON t.ai_reservation_id=r.id AND t.id=$3 AND t.run_id=$4
        AND t.workspace_id=$5 AND t.tenant_id=r.tenant_id
      WHERE r.id=$1 AND r.tenant_id=$2 AND r.status='reserved' AND t.lease_token=$6::uuid
      FOR UPDATE OF r,t`, [reservationId, lease.tenant_id, lease.task_id, lease.run_id,
      lease.workspace_id, lease.lease_token]);
    if (authority.rows.length !== 1) fail('ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID');
    const row = authority.rows[0]!;
    const usage = observedUsage ?? (() => {
      const inputTokens = Number(row.budget_input_tokens), outputTokens = Number(row.budget_output_tokens),
        embeddingTokens = Number(row.budget_embedding_tokens), totalTokens = Number(row.estimated_tokens);
      if (!integer(inputTokens) || !integer(outputTokens) || !integer(embeddingTokens)
        || !integer(totalTokens) || inputTokens + outputTokens + embeddingTokens !== totalTokens) {
        return fail('ORCHESTRATION_V2_ACCOUNTING_BUDGET_INVALID');
      }
      return { inputTokens, outputTokens, embeddingTokens, totalTokens };
    })();
    await deps.finalize({ reservationId, tenantId: lease.tenant_id, usage,
      embeddingModel: settings.embeddingModel,
      source: { service: 'self_built_rag', usage_source: usageSource, orchestration_version: 2 },
      metadata: { orchestration_run_id: lease.run_id, orchestration_task_id: lease.task_id,
        workspace_id: lease.workspace_id,
        ...(usageSource === 'reserved_upper_bound' ? { reconciliation: 'pessimistic_upper_bound' } : {}) },
    });
    const saved = await tx.query(`SELECT r.status,
        (SELECT count(*)::integer FROM ai_token_usage_ledger l
          WHERE l.reservation_id=r.id AND l.tenant_id=r.tenant_id) AS ledger_count
      FROM ai_token_reservations r WHERE r.id=$1 AND r.tenant_id=$2`,
    [reservationId, lease.tenant_id]);
    if (saved.rows.length !== 1 || saved.rows[0]?.status !== 'finalized'
      || Number(saved.rows[0]?.ledger_count) !== 1) fail('ORCHESTRATION_V2_ACCOUNTING_READBACK_INVALID');
  }

  async function releaseUndispatched(tx: GenerationJobSql, task: TaskRow): Promise<void> {
    const target = identity(task), reservationId = String(task.ai_reservation_id);
    if (!UUID.test(reservationId)) fail('ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID');
    const locked = await tx.query(`SELECT id::text FROM ai_token_reservations
      WHERE id=$1 AND tenant_id=$2 AND status='reserved' FOR UPDATE`, [reservationId, target.tenantId]);
    if (locked.rows.length !== 1) fail('ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID');
    await deps.release(reservationId, target.tenantId);
    const saved = await tx.query(`SELECT status FROM ai_token_reservations WHERE id=$1 AND tenant_id=$2`,
      [reservationId, target.tenantId]);
    if (saved.rows.length !== 1 || saved.rows[0]?.status !== 'released') {
      fail('ORCHESTRATION_V2_ACCOUNTING_READBACK_INVALID');
    }
  }

  async function releaseRejected(tx: GenerationJobSql, task: TaskRow): Promise<void> {
    await releaseUndispatched(tx, task);
  }

  async function holdUnknown(tx: GenerationJobSql, task: TaskRow): Promise<void> {
    const target = identity(task), reservationId = String(task.ai_reservation_id);
    if (!UUID.test(reservationId)) fail('ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID');
    const held = await tx.query(`UPDATE ai_token_reservations SET budget_metadata=budget_metadata||$3::jsonb
      WHERE id=$1 AND tenant_id=$2 AND status='reserved'
      RETURNING id::text,status,budget_metadata`, [reservationId, target.tenantId, JSON.stringify({
      orchestration_v2_accounting: { state: 'pending_reconciliation', run_id: target.runId,
        task_id: target.taskId, workspace_id: target.workspaceId },
    })]);
    const metadata = held.rows[0]?.budget_metadata as Record<string, any> | undefined;
    if (held.rows.length !== 1 || held.rows[0]?.status !== 'reserved'
      || metadata?.orchestration_v2_accounting?.state !== 'pending_reconciliation'
      || metadata.orchestration_v2_accounting.task_id !== target.taskId) {
      fail('ORCHESTRATION_V2_ACCOUNTING_READBACK_INVALID');
    }
  }

  async function reconcileUnknownAsBudget(tx: GenerationJobSql, task: TaskRow): Promise<void> {
    const target = identity(task), limits = budget(task), reservationId = String(task.ai_reservation_id);
    if (!UUID.test(reservationId) || task.status !== 'outcome_unknown'
      || task.accounting_state !== 'pending_reconciliation') {
      fail('ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID');
    }
    const locked = await tx.query(`SELECT r.id::text,r.status,r.estimated_tokens::text,r.budget_metadata
      FROM ai_token_reservations r
      JOIN lesson_author_workspace_v2_tasks t ON t.ai_reservation_id=r.id AND t.id=$3 AND t.run_id=$4
        AND t.workspace_id=$5 AND t.tenant_id=r.tenant_id
      WHERE r.id=$1 AND r.tenant_id=$2 AND r.status='reserved'
        AND t.status='outcome_unknown' AND t.accounting_state='pending_reconciliation'
      FOR UPDATE OF r,t`, [reservationId, target.tenantId, target.taskId, target.runId, target.workspaceId]);
    if (locked.rows.length !== 1 || Number(locked.rows[0]?.estimated_tokens) !== limits.total) {
      fail('ORCHESTRATION_V2_ACCOUNTING_AUTHORITY_INVALID');
    }
    const settings = await deps.settings(target.tenantId);
    await deps.finalize({ reservationId, tenantId: target.tenantId, usage: {
      inputTokens: limits.input, outputTokens: limits.outputCeiling,
      embeddingTokens: limits.embedding, totalTokens: limits.total,
    }, embeddingModel: settings.embeddingModel,
    source: { service: 'self_built_rag', usage_source: 'reserved_upper_bound', orchestration_version: 2 },
    metadata: { orchestration_run_id: target.runId, orchestration_task_id: target.taskId,
      workspace_id: target.workspaceId, reconciliation: 'pessimistic_upper_bound' } });
    const saved = await tx.query(`SELECT r.status,
        (SELECT count(*)::integer FROM ai_token_usage_ledger l
          WHERE l.reservation_id=r.id AND l.tenant_id=r.tenant_id) AS ledger_count
      FROM ai_token_reservations r WHERE r.id=$1 AND r.tenant_id=$2`,
    [reservationId, target.tenantId]);
    if (saved.rows.length !== 1 || saved.rows[0]?.status !== 'finalized'
      || Number(saved.rows[0]?.ledger_count) !== 1) fail('ORCHESTRATION_V2_ACCOUNTING_READBACK_INVALID');
  }

  return { reserveProvider, settleProvider, releaseUndispatched, releaseRejected, holdUnknown,
    reconcileUnknownAsBudget };
}

export const orchestrationV2QuotaAccounting = createOrchestrationV2QuotaAccounting({
  settings: tenantId => getTenantAiRuntimeSettings(tenantId, { requireExisting: true }),
  reserve: reserveTenantAiTokens,
  finalize: finalizeTenantAiTokens,
  release: releaseTenantAiTokenReservation,
});
