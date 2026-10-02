import { withDatabaseTransaction } from '../../config/database.js';
import { finalizeTenantAiTokens, releaseTenantAiTokenReservation } from './ai-token-quota.service.js';
import type { GenerationJobSql } from './lesson-author-generation-job.repository.js';
import type { WorkspaceWorkItemContext, WorkspaceWorkItemAccounting } from './lesson-author-workspace-work-item.repository.js';
import type { WorkspaceUnitUsage } from './lesson-author-workspace-unit-runner.js';
import type { AiUsage } from './ai-engine.types.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';

export class WorkspaceAccountingError extends Error {
  constructor(readonly code: 'WORKSPACE_ACCOUNTING_TRANSACTION_REQUIRED' | 'WORKSPACE_ACCOUNTING_IDENTITY_INVALID'
    | 'WORKSPACE_ACCOUNTING_USAGE_INVALID' | 'WORKSPACE_ACCOUNTING_READBACK_INVALID') { super(code); }
}
function fail(code: WorkspaceAccountingError['code']): never { throw new WorkspaceAccountingError(code); }
type Mode = 'settle_or_hold' | 'release_undispatched' | 'hold_unknown';
type Observed = WorkspaceWorkItemAccounting['observed_usage'];
const fields = ['inputTokens','outputTokens','embeddingTokens','totalTokens'] as const;

/** Validate BEFORE existing quota normalization: its legacy rounding/clamping
 * must not turn malformed or locally estimated usage into actual provider usage. */
export function workspaceUsageObservation(context: Pick<WorkspaceWorkItemContext, 'kind' | 'dispatched'>,
  observation: WorkspaceUnitUsage, mode: Mode): WorkspaceWorkItemAccounting {
  if (!observation || typeof observation.usage_complete !== 'boolean' || !observation.usage
    || typeof observation.usage !== 'object' || Array.isArray(observation.usage)
    || Object.keys(observation.usage).some(k => !fields.includes(k as typeof fields[number]))
    || !['provider','no_generation','mixed_or_unavailable','local_estimate','unavailable'].includes(observation.usage_source))
    fail('WORKSPACE_ACCOUNTING_USAGE_INVALID');
  for (const value of Object.values(observation.usage)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2_000_000)
      fail('WORKSPACE_ACCOUNTING_USAGE_INVALID');
  }
  if (mode === 'release_undispatched') {
    if (context.dispatched || observation.usage_complete || Object.keys(observation.usage).length)
      fail('WORKSPACE_ACCOUNTING_USAGE_INVALID');
    return { state: 'settled', usage_complete: false, observed_usage: { usage_source: 'unavailable' } };
  }
  if (!context.dispatched) fail('WORKSPACE_ACCOUNTING_USAGE_INVALID');
  const complete = observation.usage_complete;
  if (complete && (fields.some(k => observation.usage[k] === undefined)
    || !(observation.usage_source === 'provider' || context.kind === 'validate_chapter'
      && observation.usage_source === 'no_generation' && fields.every(k => observation.usage[k] === 0))))
    fail('WORKSPACE_ACCOUNTING_USAGE_INVALID');
  if (observation.usage_source === 'no_generation' && (!complete || context.kind !== 'validate_chapter'
    || fields.some(k => observation.usage[k] !== 0))) fail('WORKSPACE_ACCOUNTING_USAGE_INVALID');
  const observed: Observed = { ...observation.usage, usage_source: observation.usage_source };
  return { state: mode === 'hold_unknown' || !complete ? 'pending_reconciliation' : 'settled',
    usage_complete: complete, observed_usage: observed };
}

type Dependencies = {
  transaction<T>(work: (tx: GenerationJobSql) => Promise<T>): Promise<T>;
  finalize: typeof finalizeTenantAiTokens;
  release: typeof releaseTenantAiTokenReservation;
};

/** Repository callback bound to ONE immutable response observation. All ledger,
 * held-observation and work-item publication writes share the caller transaction.
 * No callback may settle using an in-memory grant without checking DB ownership. */
export function createWorkspaceQuotaAccounting(deps: Dependencies, input: WorkspaceUnitUsage, embeddingModel?: string) {
  const observation = structuredClone(input);
  return async (tx: GenerationJobSql, context: Readonly<WorkspaceWorkItemContext>, mode: Mode): Promise<WorkspaceWorkItemAccounting> => {
    const account = workspaceUsageObservation(context, observation, mode);
    return deps.transaction(async active => {
      if (active !== tx) fail('WORKSPACE_ACCOUNTING_TRANSACTION_REQUIRED');
      const t = context.target;
      const result = await tx.query(`SELECT r.id,r.status,r.estimated_tokens,r.budget_metadata,r.actual_input_tokens,
          r.actual_output_tokens,r.actual_embedding_tokens,r.actual_total_tokens
        FROM ai_token_reservations r JOIN lesson_author_workspace_runs run ON run.workspace_id=$3::uuid
          AND run.tenant_id=r.tenant_id AND run.course_id=$6 AND run.model=r.model
        WHERE r.id=$1 AND r.tenant_id=$2 AND r.user_id=$4 AND r.conversation_id=$5
          AND r.target='lesson_author' AND r.operation='lesson_author' AND r.engine='self_built_rag'
          AND r.budget_metadata->>'durable_generation'='true'
          AND r.budget_metadata->>'workspace_id'=$3::text AND r.budget_metadata->>'workspace_work_item_id'=$7::text
        FOR UPDATE OF r`, [context.ai_reservation_id,t.tenantId,t.workspaceId,t.userId,t.conversationId,t.courseId,t.workItemId]);
      const row = result.rows[0];
      if (result.rows.length !== 1 || row.id !== context.ai_reservation_id || row.status !== 'reserved'
        || Number(row.estimated_tokens) !== context.reserved_tokens) fail('WORKSPACE_ACCOUNTING_IDENTITY_INVALID');
      if (account.state === 'pending_reconciliation') {
        const held = await tx.query(`UPDATE ai_token_reservations SET budget_metadata=budget_metadata || $3::jsonb
          WHERE id=$1 AND tenant_id=$2 AND status='reserved' RETURNING id`,
        [context.ai_reservation_id,t.tenantId,JSON.stringify({ workspace_accounting: {
          state: 'pending_reconciliation', observed_usage: account.observed_usage,
          correlation_id: context.correlation_id, workspace_work_item_id: t.workItemId,
        } })]);
        if (held.rows.length !== 1 || held.rows[0].id !== context.ai_reservation_id) fail('WORKSPACE_ACCOUNTING_READBACK_INVALID');
      } else if (mode === 'release_undispatched') {
        await deps.release(context.ai_reservation_id,t.tenantId);
      } else {
        await deps.finalize({ reservationId: context.ai_reservation_id, tenantId: t.tenantId,
          usage: observation.usage as AiUsage, embeddingModel,
          source: { service: 'self_built_rag', usage_source: observation.usage_source },
          metadata: { workspace_id: t.workspaceId, workspace_work_item_id: t.workItemId, correlation_id: context.correlation_id } });
      }
      const saved = await tx.query(`SELECT r.id,r.status,r.estimated_tokens,r.budget_metadata,r.actual_input_tokens,
          r.actual_output_tokens,r.actual_embedding_tokens,r.actual_total_tokens,
          (SELECT count(*) FROM ai_token_usage_ledger l WHERE l.reservation_id=r.id AND l.tenant_id=r.tenant_id
            AND l.input_tokens=r.actual_input_tokens AND l.output_tokens=r.actual_output_tokens
            AND l.embedding_tokens=r.actual_embedding_tokens AND l.total_tokens=r.actual_total_tokens)::text AS ledger_count
        FROM ai_token_reservations r WHERE r.id=$1 AND r.tenant_id=$2`, [context.ai_reservation_id,t.tenantId]);
      const actual = saved.rows[0];
      if (saved.rows.length !== 1 || actual.id !== context.ai_reservation_id || Number(actual.estimated_tokens) !== context.reserved_tokens)
        fail('WORKSPACE_ACCOUNTING_READBACK_INVALID');
      if (account.state === 'pending_reconciliation') {
        const meta = actual.budget_metadata as Record<string, any> | null;
        if (actual.status !== 'reserved' || meta?.workspace_accounting?.state !== 'pending_reconciliation'
          || hash(meta.workspace_accounting.observed_usage) !== hash(account.observed_usage)) fail('WORKSPACE_ACCOUNTING_READBACK_INVALID');
      } else if (mode === 'release_undispatched') {
        if (actual.status !== 'released' || Number(actual.ledger_count) !== 0) fail('WORKSPACE_ACCOUNTING_READBACK_INVALID');
      } else if (actual.status !== 'finalized' || Number(actual.ledger_count) !== 1
        || fields.some((f,i) => Number(actual[['actual_input_tokens','actual_output_tokens','actual_embedding_tokens','actual_total_tokens'][i]]) !== observation.usage[f])) {
        fail('WORKSPACE_ACCOUNTING_READBACK_INVALID');
      }
      return account;
    });
  };
}

/** Production adapter: nested withDatabaseTransaction reuses the exact outer
 * client via existing AsyncLocalStorage. Importing does not open a connection. */
export const workspaceQuotaAccounting = (usage: WorkspaceUnitUsage, embeddingModel?: string) => createWorkspaceQuotaAccounting({
  transaction: work => withDatabaseTransaction(work), finalize: finalizeTenantAiTokens, release: releaseTenantAiTokenReservation,
}, usage, embeddingModel);
