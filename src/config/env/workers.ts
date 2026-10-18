// Env: background workers — deletion, course progress recalculation, tenant
// data quota and course outline transfer (part of `env`, see ../env.ts).

import './load.js';
import {
  optionalBoolean,
  optionalBoundedInt,
  optionalInt,
  optionalNonNegativeInt,
  optionalPositiveInt,
} from './helpers.js';

export const workersEnv = {
  // Durable user/course deletion workers. Polling is mandatory delivery recovery
  // when a RabbitMQ publish succeeds only partially or a worker crashes. Jobs
  // are due-based; do not reduce the retry delays to a hot polling loop.
  DELETION_REQUEUE_INTERVAL_MS: optionalPositiveInt('DELETION_REQUEUE_INTERVAL_MS', 30_000),
  DELETION_MAX_ATTEMPTS: optionalPositiveInt('DELETION_MAX_ATTEMPTS', 12),
  DELETION_RETRY_BASE_MS: optionalPositiveInt('DELETION_RETRY_BASE_MS', 30_000),
  DELETION_RETRY_MAX_MS: optionalPositiveInt('DELETION_RETRY_MAX_MS', 3_600_000),
  DELETION_JOB_RETENTION_DAYS: optionalPositiveInt('DELETION_JOB_RETENTION_DAYS', 30),

  // Course progress recalculation worker
  COURSE_PROGRESS_RECALC_WORKER_ENABLED: optionalBoolean('COURSE_PROGRESS_RECALC_WORKER_ENABLED', true),
  COURSE_PROGRESS_RECALC_BATCH_SIZE: optionalInt('COURSE_PROGRESS_RECALC_BATCH_SIZE', 1000),
  COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK: optionalInt('COURSE_PROGRESS_RECALC_MAX_BATCHES_PER_TICK', 5),
  COURSE_PROGRESS_RECALC_RABBIT_PREFETCH: optionalInt('COURSE_PROGRESS_RECALC_RABBIT_PREFETCH', 1),
  COURSE_PROGRESS_RECALC_POLL_INTERVAL_MS: optionalNonNegativeInt('COURSE_PROGRESS_RECALC_POLL_INTERVAL_MS', 60000),

  // Tenant data quota reconciliation is deliberately a dedicated PM2 worker.
  // It must never run inside every HTTP API replica on startup.
  TENANT_DATA_QUOTA_WORKER_ENABLED: optionalBoolean('TENANT_DATA_QUOTA_WORKER_ENABLED', false),
  TENANT_DATA_QUOTA_WORKER_HEARTBEAT_INTERVAL_MS: optionalBoundedInt(
    'TENANT_DATA_QUOTA_WORKER_HEARTBEAT_INTERVAL_MS',
    30_000,
    5_000,
    60_000,
  ),
  TENANT_DATA_QUOTA_WORKER_POLL_INTERVAL_MS: optionalBoundedInt(
    'TENANT_DATA_QUOTA_WORKER_POLL_INTERVAL_MS',
    15_000,
    1_000,
    300_000,
  ),
  TENANT_DATA_QUOTA_WORKER_STANDBY_RETRY_MS: optionalBoundedInt(
    'TENANT_DATA_QUOTA_WORKER_STANDBY_RETRY_MS',
    30_000,
    1_000,
    300_000,
  ),
  TENANT_DATA_QUOTA_WORKER_PAGE_SIZE: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_PAGE_SIZE', 500, 1, 1_000),
  TENANT_DATA_QUOTA_WORKER_MAX_TENANTS_PER_CYCLE: optionalBoundedInt(
    'TENANT_DATA_QUOTA_WORKER_MAX_TENANTS_PER_CYCLE',
    1,
    1,
    10,
  ),
  TENANT_DATA_QUOTA_WORKER_MAX_PAGES_PER_CLAIM: optionalBoundedInt(
    'TENANT_DATA_QUOTA_WORKER_MAX_PAGES_PER_CLAIM',
    100,
    1,
    10_000,
  ),
  // At least 90 seconds leaves room for a bounded Storage read, ledger write,
  // and a 30-second lease guard before a resumable slice yields.
  TENANT_DATA_QUOTA_WORKER_LEASE_SECONDS: optionalBoundedInt('TENANT_DATA_QUOTA_WORKER_LEASE_SECONDS', 120, 90, 900),
  TENANT_DATA_QUOTA_WORKER_MAX_SLICE_MS: optionalBoundedInt(
    'TENANT_DATA_QUOTA_WORKER_MAX_SLICE_MS',
    60_000,
    5_000,
    870_000,
  ),
  TENANT_DATA_QUOTA_WORKER_DATABASE_SNAPSHOT_TIMEOUT_MS: optionalBoundedInt(
    'TENANT_DATA_QUOTA_WORKER_DATABASE_SNAPSHOT_TIMEOUT_MS',
    600_000,
    30_000,
    600_000,
  ),
  TENANT_DATA_QUOTA_WORKER_RETRY_BASE_SECONDS: optionalBoundedInt(
    'TENANT_DATA_QUOTA_WORKER_RETRY_BASE_SECONDS',
    30,
    1,
    3_600,
  ),
  TENANT_DATA_QUOTA_WORKER_RETRY_MAX_SECONDS: optionalBoundedInt(
    'TENANT_DATA_QUOTA_WORKER_RETRY_MAX_SECONDS',
    3_600,
    30,
    86_400,
  ),
  // Folding of the lock-free database deltas (SQL 20261018_1100) by the quota
  // worker leader. Inactive until that SQL exists. Unfolded deltas are always
  // counted by the limit check; the interval only bounds how long they wait.
  TENANT_DATA_QUOTA_FOLD_INTERVAL_MS: optionalBoundedInt('TENANT_DATA_QUOTA_FOLD_INTERVAL_MS', 2_000, 500, 60_000),
  TENANT_DATA_QUOTA_FOLD_BATCH_SIZE: optionalBoundedInt('TENANT_DATA_QUOTA_FOLD_BATCH_SIZE', 5_000, 100, 100_000),
  TENANT_DATA_QUOTA_FOLD_MAX_BATCHES_PER_TICK: optionalBoundedInt(
    'TENANT_DATA_QUOTA_FOLD_MAX_BATCHES_PER_TICK',
    20,
    1,
    1_000,
  ),

  // Course outline transfer is a dedicated, resumable worker. It is separate
  // from HTTP so a large media copy never monopolises API request capacity.
  COURSE_OUTLINE_TRANSFER_WORKER_ENABLED: optionalBoolean('COURSE_OUTLINE_TRANSFER_WORKER_ENABLED', false),
  COURSE_OUTLINE_TRANSFER_WORKER_POLL_INTERVAL_MS: optionalBoundedInt(
    'COURSE_OUTLINE_TRANSFER_WORKER_POLL_INTERVAL_MS',
    10_000,
    1_000,
    300_000,
  ),
} as const;
