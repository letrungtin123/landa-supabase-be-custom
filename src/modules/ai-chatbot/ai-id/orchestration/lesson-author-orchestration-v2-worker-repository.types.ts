// Types and the error of the orchestration V2 worker repository: the task lease, claim and
// deferral results, provider settlement hooks. Split out of
// lesson-author-orchestration-v2-worker.repository.ts (move only), which re-exports the public names.

import type { GenerationJobSql } from '../shared/lesson-author-generation-job.repository.js';
import type { OrchestrationV2TaskKind } from '../shared/lesson-author-orchestration-v2.logic.js';

export interface OrchestrationV2TaskLease {
  task_id: string;
  run_id: string;
  workspace_id: string;
  tenant_id: string;
  course_id: string;
  task_key: string;
  kind: OrchestrationV2TaskKind;
  chapter_key: string | null;
  node_id: string | null;
  contract_hash: string;
  input_context_hash: string | null;
  source_snapshot_id: string;
  source_snapshot_hash: string;
  runtime_config_hash: string;
  model: string;
  locale: 'vi' | 'en';
  max_output_tokens: number;
  provider_max_attempts: number;
  execution_budget_ms: number;
  lease_token: string;
  dispatch_epoch: number;
  /** Durable evidence that an earlier claim crossed the provider boundary.
   * A retry epoch alone is not sufficient: DB failures can happen before any
   * paid call and must remain eligible for the first provider dispatch. */
  provider_replay_required: boolean;
  routing_shard: number;
  ai_reservation_id: string | null;
}

export type OrchestrationV2ClaimResult =
  | { disposition: 'claimed'; lease: OrchestrationV2TaskLease }
  | { disposition: 'duplicate' | 'stale' }
  | { disposition: 'deferred'; reason: OrchestrationV2DeferralReason };

export type OrchestrationV2DeferralReason =
  | 'publication_race'
  | 'global_capacity'
  | 'provider_capacity'
  | 'tenant_capacity'
  | 'workspace_capacity';

export interface OrchestrationV2CapacityWake {
  outbox_id: string;
  run_id: string;
  task_id: string;
  tenant_id: string;
  workspace_id: string;
  task_kind: OrchestrationV2TaskKind;
}

export interface OrchestrationV2ArtifactCommit {
  artifact_kind: 'source_catalog' | 'course_skeleton' | 'chapter_blueprint' | 'architecture_validation'
    | 'inventory_receipt' | 'unit_baseline' | 'chapter_receipt' | 'course_receipt';
  artifact_hash: string;
  payload: Record<string, unknown>;
  validation_contract: string;
}

export class OrchestrationV2WorkerRepositoryError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_TASK_LEASE_LOST'
    | 'ORCHESTRATION_V2_TASK_STATE_INVALID'
    | 'ORCHESTRATION_V2_TASK_WRITE_UNCONFIRMED'
    /** The artifact's stored JSON would not re-hash to its artifact hash (nothing is written). */
    | 'ORCHESTRATION_V2_ARTIFACT_HASH_MISMATCH'
    // The run was stopped (needs_action/canceled) before this claim crossed the
    // provider boundary: no paid call is made and the claim releases its credit.
    | 'ORCHESTRATION_V2_RUN_NOT_ACTIVE') {
    super(code);
    this.name = 'OrchestrationV2WorkerRepositoryError';
  }
}

export type ReserveProvider = (tx: GenerationJobSql, task: Record<string, unknown>) => Promise<string>;
export type OrchestrationV2ProviderUsageSource = 'provider' | 'reserved_upper_bound';
export type SettleProvider = (tx: GenerationJobSql, lease: OrchestrationV2TaskLease,
  usage: Readonly<Record<string, number>>, usageSource?: OrchestrationV2ProviderUsageSource) => Promise<void>;
export type HoldUnknown = (tx: GenerationJobSql, task: Record<string, unknown>) => Promise<void>;
export type ReconcileUnknown = (tx: GenerationJobSql, task: Record<string, unknown>) => Promise<void>;
export type ReleaseUndispatched = (tx: GenerationJobSql, task: Record<string, unknown>) => Promise<void>;
export type ReleaseRejected = (tx: GenerationJobSql, task: Record<string, unknown>) => Promise<void>;
export type OrchestrationV2ClaimFailureDisposition = 'requeued' | 'failed' | 'outcome_unknown' | 'stale';
export interface OrchestrationV2SuccessHooks {
  beforeSuccess?(tx: GenerationJobSql, task: Record<string, unknown>): Promise<void>;
  afterSuccess?(tx: GenerationJobSql, task: Record<string, unknown>): Promise<void>;
}
export type OrchestrationV2ProviderCompletion =
  | Readonly<{ mode: OrchestrationV2ProviderUsageSource }>
  | Readonly<{ mode: 'deterministic_fallback'; releaseUndispatched: ReleaseUndispatched }>;
