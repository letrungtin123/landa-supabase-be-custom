import { env } from '../../config/env.js';
import { QUEUES } from '../../config/rabbitmq/index.js';
import {
  assertOrchestrationV2RuntimeIsolation,
  type OrchestrationV2RuntimeRole,
} from './lesson-author-orchestration-v2-dispatch.logic.js';
import {
  assertOrchestrationV2OutboxConfig,
  type OrchestrationV2OutboxConfig,
} from './lesson-author-orchestration-v2-outbox.repository.js';
import {
  assertOrchestrationV2WorkerLimits,
  type OrchestrationV2WorkerLimits,
} from './lesson-author-orchestration-v2-worker.logic.js';

export interface OrchestrationV2RuntimeConfig {
  enabled: boolean;
  role: OrchestrationV2RuntimeRole;
  queue: string;
  poll_interval_ms: number;
  dispatch_batch_size: number;
  recovery_batch_size: number;
  unit_soft_deadline_ms: number;
  outbox: OrchestrationV2OutboxConfig;
  worker: OrchestrationV2WorkerLimits & { recovery_batch_size: number };
}

/** Centralized, fail-closed settings for the default-off dedicated V2 process. */
export function readOrchestrationV2RuntimeConfig(): Readonly<OrchestrationV2RuntimeConfig> {
  const isolation = assertOrchestrationV2RuntimeIsolation({
    enabled: env.LESSON_AUTHOR_ORCHESTRATION_V2_ENABLED,
    role: env.LESSON_AUTHOR_ORCHESTRATION_V2_ROLE,
    lane_count: env.LESSON_AUTHOR_ORCHESTRATION_V2_LANE_COUNT,
    lane_index: env.LESSON_AUTHOR_ORCHESTRATION_V2_LANE_INDEX,
  });
  const outbox = assertOrchestrationV2OutboxConfig({
    lane_count: isolation.lane_count,
    lane_index: isolation.lane_index,
    lease_seconds: env.LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_LEASE_SECONDS,
    max_attempts: env.LESSON_AUTHOR_ORCHESTRATION_V2_OUTBOX_MAX_ATTEMPTS,
    retry_base_ms: env.LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_BASE_MS,
    retry_max_ms: env.LESSON_AUTHOR_ORCHESTRATION_V2_RETRY_MAX_MS,
    published_recovery_seconds: env.LESSON_AUTHOR_ORCHESTRATION_V2_PUBLISHED_RECOVERY_SECONDS,
  });
  const workerLimits = assertOrchestrationV2WorkerLimits({
    global_concurrency_limit: env.LESSON_AUTHOR_ORCHESTRATION_V2_GLOBAL_CONCURRENCY,
    provider_concurrency_limit: env.LESSON_AUTHOR_ORCHESTRATION_V2_PROVIDER_CONCURRENCY,
    lease_seconds: env.LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_LEASE_SECONDS,
  });
  return Object.freeze({
    enabled: isolation.enabled,
    role: isolation.role,
    queue: QUEUES.LESSON_AUTHOR_ORCHESTRATION_V2,
    poll_interval_ms: env.LESSON_AUTHOR_ORCHESTRATION_V2_POLL_INTERVAL_MS,
    dispatch_batch_size: env.LESSON_AUTHOR_ORCHESTRATION_V2_DISPATCH_BATCH_SIZE,
    recovery_batch_size: env.LESSON_AUTHOR_ORCHESTRATION_V2_RECOVERY_BATCH_SIZE,
    unit_soft_deadline_ms: env.LESSON_AUTHOR_ORCHESTRATION_V2_UNIT_SOFT_DEADLINE_MS,
    outbox,
    worker: Object.freeze({
      ...workerLimits,
      recovery_batch_size: env.LESSON_AUTHOR_ORCHESTRATION_V2_WORKER_RECOVERY_BATCH_SIZE,
    }),
  });
}
