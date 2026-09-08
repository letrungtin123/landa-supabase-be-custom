// ═══════════════════════════════════════════════════════════════
// Dedicated tenant data quota reconciliation worker.
//
// PM2 starts this alongside the API, but PostgreSQL elects exactly one active
// process across restarts and hosts. The API server must never perform this
// work during its own startup path.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { getClient, pool } from '../config/database.js';
import { env } from '../config/env.js';
import {
  assertTenantDataQuotaReconciliationOptions,
  isTenantDataQuotaReconciliationSchemaReady,
  recordTenantDataQuotaWorkerHeartbeat,
  runTenantDataQuotaReconciliationCycle,
  type TenantDataQuotaCycleResult,
  type TenantDataQuotaWorkerHeartbeatState,
  type TenantDataQuotaReconciliationOptions,
} from '../modules/tenants/tenant-data-quota-reconciliation.service.js';

const WORKER_LOCK_NAME = 'landa:tenant-data-quota-worker:v1';
const WORKER_NAME = 'landa-tenant-data-quota-worker';
const WORKER_INSTANCE_ID = randomUUID();

let stopping = false;
let lockLost = false;
let lockClient: PoolClient | null = null;
let schemaMissingLogged = false;
let wakeSleepingLoop: (() => void) | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatState: TenantDataQuotaWorkerHeartbeatState = 'starting';
let latestCycle: TenantDataQuotaCycleResult = {
  candidates: 0,
  completed: 0,
  yielded: 0,
  skipped: 0,
  failed: 0,
};
let heartbeatSchemaMissingLogged = false;
let lastHeartbeatFailureLoggedAt = 0;
let heartbeatWriteInFlight = false;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      if (wakeSleepingLoop === finish) wakeSleepingLoop = null;
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    wakeSleepingLoop = finish;
  });
}

function workerOptions(): TenantDataQuotaReconciliationOptions {
  const options: TenantDataQuotaReconciliationOptions = {
    pageSize: env.TENANT_DATA_QUOTA_WORKER_PAGE_SIZE,
    leaseSeconds: env.TENANT_DATA_QUOTA_WORKER_LEASE_SECONDS,
    databaseSnapshotTimeoutMs: env.TENANT_DATA_QUOTA_WORKER_DATABASE_SNAPSHOT_TIMEOUT_MS,
    maxPagesPerClaim: env.TENANT_DATA_QUOTA_WORKER_MAX_PAGES_PER_CLAIM,
    maxSliceMs: env.TENANT_DATA_QUOTA_WORKER_MAX_SLICE_MS,
    retryBaseSeconds: env.TENANT_DATA_QUOTA_WORKER_RETRY_BASE_SECONDS,
    retryMaxSeconds: env.TENANT_DATA_QUOTA_WORKER_RETRY_MAX_SECONDS,
  };
  assertTenantDataQuotaReconciliationOptions(options);
  return options;
}

function heartbeatErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

function setHeartbeatState(state: TenantDataQuotaWorkerHeartbeatState): void {
  heartbeatState = state;
}

/**
 * A heartbeat is observability only. It must never terminate a correct quota
 * worker or make the worker wait for a separately deployed additive schema.
 */
async function writeHeartbeat(lastError?: unknown): Promise<void> {
  if (heartbeatWriteInFlight || !lockClient) return;
  heartbeatWriteInFlight = true;
  try {
    await recordTenantDataQuotaWorkerHeartbeat({
      workerName: WORKER_NAME,
      instanceId: WORKER_INSTANCE_ID,
      state: heartbeatState,
      candidates: latestCycle.candidates,
      completed: latestCycle.completed,
      yielded: latestCycle.yielded,
      failed: latestCycle.failed,
      lastError: lastError ? heartbeatErrorMessage(lastError) : null,
    });
    heartbeatSchemaMissingLogged = false;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === '42883') {
      if (!heartbeatSchemaMissingLogged) {
        console.warn('[TenantDataQuotaWorker] Worker heartbeat SQL is not available yet; quota reconciliation continues without liveness telemetry.');
        heartbeatSchemaMissingLogged = true;
      }
      return;
    }

    const now = Date.now();
    if (now - lastHeartbeatFailureLoggedAt >= 300_000) {
      console.warn(`[TenantDataQuotaWorker] Could not record worker heartbeat: ${heartbeatErrorMessage(error)}`);
      lastHeartbeatFailureLoggedAt = now;
    }
  } finally {
    heartbeatWriteInFlight = false;
  }
}

function startHeartbeatTimer(): void {
  if (heartbeatTimer) return;
  void writeHeartbeat();
  heartbeatTimer = setInterval(() => {
    void writeHeartbeat();
  }, env.TENANT_DATA_QUOTA_WORKER_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

function stopHeartbeatTimer(): void {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function tryAcquireWorkerLock(): Promise<boolean> {
  const client = await getClient();
  try {
    const result = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1::text, 20260907)) AS locked`,
      [WORKER_LOCK_NAME],
    );
    if (!result.rows[0]?.locked) {
      client.release();
      return false;
    }

    client.on('error', (error) => {
      lockLost = true;
      console.error(`[TenantDataQuotaWorker] Lost leader database session: ${error.message}`);
    });
    lockClient = client;
    return true;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function releaseWorkerLock(): Promise<void> {
  const client = lockClient;
  lockClient = null;
  if (!client) return;
  try {
    await client.query(
      'SELECT pg_advisory_unlock(hashtextextended($1::text, 20260907))',
      [WORKER_LOCK_NAME],
    );
  } catch {
    // A disconnected session releases a session advisory lock automatically.
  } finally {
    client.release();
  }
}

async function runLeaderLoop(): Promise<void> {
  console.log(`[TenantDataQuotaWorker] Active leader. environment=${env.NODE_ENV} instance=${WORKER_INSTANCE_ID}`);
  const options = workerOptions();
  setHeartbeatState('starting');
  startHeartbeatTimer();

  while (!stopping) {
    if (lockLost) throw new Error('Tenant data quota worker leader lock was lost.');

    const schemaReady = await isTenantDataQuotaReconciliationSchemaReady();
    if (!schemaReady) {
      setHeartbeatState('waiting_for_quota_schema');
      if (!schemaMissingLogged) {
        console.warn('[TenantDataQuotaWorker] Waiting for the approved quota-worker manual SQL migration. No tenant was changed.');
        schemaMissingLogged = true;
      }
      await sleep(env.TENANT_DATA_QUOTA_WORKER_POLL_INTERVAL_MS);
      continue;
    }
    schemaMissingLogged = false;

    setHeartbeatState('reconciling');
    const result = await runTenantDataQuotaReconciliationCycle(
      env.TENANT_DATA_QUOTA_WORKER_MAX_TENANTS_PER_CYCLE,
      options,
      () => stopping || lockLost,
    );
    latestCycle = result;
    setHeartbeatState('idle');
    await writeHeartbeat();
    if (result.failed > 0) {
      console.warn(`[TenantDataQuotaWorker] cycle candidates=${result.candidates} completed=${result.completed} yielded=${result.yielded} failed=${result.failed}`);
    }

    // A yielded tenant is immediately eligible again. Let I/O and other DB
    // traffic breathe before claiming the next bounded batch.
    await sleep(result.candidates > 0
      ? Math.min(env.TENANT_DATA_QUOTA_WORKER_POLL_INTERVAL_MS, 1_000)
      : env.TENANT_DATA_QUOTA_WORKER_POLL_INTERVAL_MS);
  }

  setHeartbeatState('stopping');
  await writeHeartbeat();
}

async function bootstrap(): Promise<void> {
  if (!env.TENANT_DATA_QUOTA_WORKER_ENABLED) {
    console.log('[TenantDataQuotaWorker] Disabled by TENANT_DATA_QUOTA_WORKER_ENABLED=false.');
    return;
  }

  while (!stopping) {
    const acquired = await tryAcquireWorkerLock();
    if (!acquired) {
      console.log('[TenantDataQuotaWorker] Standby: another worker owns the global reconciliation lock.');
      await sleep(env.TENANT_DATA_QUOTA_WORKER_STANDBY_RETRY_MS);
      continue;
    }

    try {
      await runLeaderLoop();
      return;
    } catch (error) {
      setHeartbeatState('failed');
      await writeHeartbeat(error);
      throw error;
    } finally {
      stopHeartbeatTimer();
      await releaseWorkerLock();
    }
  }
}

function requestShutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[TenantDataQuotaWorker] ${signal} received; yielding after the current database operation...`);
  wakeSleepingLoop?.();
}

process.once('SIGINT', () => {
  requestShutdown('SIGINT');
});

process.once('SIGTERM', () => {
  requestShutdown('SIGTERM');
});

bootstrap().then(async () => {
  stopHeartbeatTimer();
  await pool.end();
}).catch(async (error) => {
  console.error('[TenantDataQuotaWorker] Fatal error:', error);
  stopHeartbeatTimer();
  await releaseWorkerLock();
  await pool.end();
  process.exit(1);
});
