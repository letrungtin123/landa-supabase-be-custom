import { createHash } from 'node:crypto';
import type { AiUsage } from './ai-engine.types.js';

/** Missing/partial usage is unknown, never an implicit zero-token settlement. */
export function hasCompleteGenerationUsage(value: unknown): value is AiUsage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const fields = ['inputTokens', 'outputTokens', 'embeddingTokens', 'totalTokens'] as const;
  if (!fields.every(key => typeof v[key] === 'number' && Number.isSafeInteger(v[key]) && Number(v[key]) >= 0)) return false;
  return Number(v.totalTokens) >= Number(v.inputTokens) + Number(v.outputTokens) + Number(v.embeddingTokens);
}

/** Stable across JSONB key reordering; only the digest is logged/persisted. */
export function generationSnapshotHash(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => [key, canonical(child)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Request-scoped generation bookkeeping, not a new provider retry policy. */
export const GENERATION_JOB_DEADLINE_MS = 600_000;
export const GENERATION_JOB_LEASE_MS = 45_000;
export const GENERATION_JOB_HEARTBEAT_MS = 15_000;
export const GENERATION_JOB_COMPLETION_MARGIN_MS = 5_000;

export type GenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type GenerationJobErrorCode =
  | 'GENERATION_JOB_NOT_FOUND'
  | 'GENERATION_IDEMPOTENCY_CONFLICT'
  | 'GENERATION_ALREADY_ACTIVE'
  | 'GENERATION_LEASE_LOST'
  | 'GENERATION_ALREADY_DISPATCHED'
  | 'GENERATION_SNAPSHOT_CHANGED'
  | 'GENERATION_BUDGET_CHANGED'
  | 'GENERATION_WORKFLOW_TIMEOUT'
  | 'GENERATION_OUTCOME_UNKNOWN'
  | 'GENERATION_JOB_CONTRACT_INVALID';

export class GenerationJobError extends Error {
  constructor(readonly code: GenerationJobErrorCode) {
    super(code);
    this.name = 'GenerationJobError';
  }
}

export interface GenerationJobRow {
  [key: string]: unknown;
  id: string;
  tenant_id: string;
  conversation_id: string;
  requested_by: string;
  course_id: string;
  bot_id: string;
  kb_id: string;
  user_message_id: string;
  idempotency_key: string;
  correlation_id: string;
  request_hash: string;
  source_snapshot_hash: string;
  course_outline_hash: string;
  runtime_config_hash: string;
  contract_version: 1;
  operation: 'course_blueprint';
  engine: 'self_built_rag';
  locale: 'vi' | 'en';
  model: string;
  max_output_tokens: number;
  max_attempts: number;
  source_document_ids: string[];
  editor_context: Record<string, unknown>;
  status: GenerationJobStatus;
  claim_count: number;
  lease_token: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  started_at: Date | null;
  dispatch_started_at: Date | null;
  ai_reservation_id: string | null;
  result_blueprint_id: string | null;
  assistant_message_id: string | null;
  progress_code: string | null;
  failure_stage: string | null;
  internal_failure_code: string | null;
  external_failure_code: string | null;
  created_at: Date;
  updated_at: Date;
  deadline_at: Date;
  finished_at: Date | null;
}

export interface GenerationJobOwner {
  tenantId: string;
  conversationId: string;
  userId: string;
}

export interface GenerationJobLease {
  jobId: string;
  tenantId: string;
  leaseToken: string;
}

/** Safe public projection only. Authorization must happen before calling this. */
export function generationJobStatusView(job: GenerationJobRow) {
  return {
    job_id: job.id,
    correlation_id: job.correlation_id,
    status: job.status,
    progress_code: job.progress_code,
    deadline_at: job.deadline_at.toISOString(),
    finished_at: job.finished_at?.toISOString() ?? null,
    blueprint_id: job.status === 'succeeded' ? job.result_blueprint_id : null,
    assistant_message_id: ['succeeded', 'failed', 'canceled'].includes(job.status)
      ? job.assistant_message_id : null,
    external_failure_code: ['failed', 'canceled'].includes(job.status) ? job.external_failure_code : null,
  };
}

export type GenerationRecoveryAction = 'none' | 'requeue' | 'timeout' | 'outcome_unknown';

/** Use PostgreSQL clock_timestamp(), not the browser/process clock, in recovery. */
export function generationRecoveryAction(job: GenerationJobRow, databaseNow: Date): GenerationRecoveryAction {
  if (!['queued', 'running'].includes(job.status)) return 'none';
  const expired = job.deadline_at.getTime() <= databaseNow.getTime()
    || (job.status === 'running' && job.lease_expires_at !== null
      && job.lease_expires_at.getTime() <= databaseNow.getTime());
  if (!expired) return 'none';
  // A dispatch marker is irreversible. No attempt to replay or guess paid usage.
  if (job.dispatch_started_at !== null) return 'outcome_unknown';
  return job.deadline_at.getTime() <= databaseNow.getTime() ? 'timeout' : 'requeue';
}

/** Clamp the outer HTTP wait only; leave provider model/token/retry policy alone. */
export function generationDispatchBudgetMs(deadline: Date, nowMs: number): number {
  const remaining = Math.floor(deadline.getTime() - nowMs - GENERATION_JOB_COMPLETION_MARGIN_MS);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new GenerationJobError('GENERATION_WORKFLOW_TIMEOUT');
  }
  return Math.min(remaining, GENERATION_JOB_DEADLINE_MS - GENERATION_JOB_COMPLETION_MARGIN_MS);
}
