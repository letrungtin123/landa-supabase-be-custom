// ═══════════════════════════════════════════════════════════════
// In-app cluster (LANDA_INAPP_CLUSTER_WORKERS): the pure rules
//
// Off by default (0): dist/index.js runs the startup of its role, as before.
// With n > 0 in an API process (LANDA_PROCESS_ROLE=api) that is not itself a
// cluster worker (PM2 fork mode), dist/index.js becomes a cluster primary
// (inapp-cluster-primary.ts): it forks n workers that run the normal API
// startup and hands them the connections round-robin (cluster.SCHED_RR).
// Node's default on Windows lets the OS pick the process, and nearly every
// connection reaches the first one. The primary does no app work.
//
// The background process and the dedicated workers are never clustered.
// ═══════════════════════════════════════════════════════════════

import type { ProcessRole } from './process-role.js';

/** Env variable the primary sets on each worker it forks: the worker's slot (0..n-1). */
export const INAPP_CLUSTER_SLOT_ENV = 'LANDA_INAPP_CLUSTER_SLOT';

// Restarts of a crashed worker follow the restart policy of
// ecosystem.config.cjs: exp_backoff_restart_delay 1 s, x1.5 per restart up to
// 15 s; a worker that ran min_uptime (30 s) starts again from 1 s.
export const WORKER_RESTART_INITIAL_DELAY_MS = 1_000;
export const WORKER_RESTART_MAX_DELAY_MS = 15_000;
export const WORKER_RESTART_FACTOR = 1.5;
export const WORKER_STABLE_UPTIME_MS = 30_000;

export type InAppClusterPlan =
  /** The flag is off: run the role (today's behavior). */
  | { mode: 'off' }
  /** Become the primary of `workers` workers. */
  | { mode: 'primary'; workers: number }
  /** A worker forked by the in-app primary: run the API startup. */
  | { mode: 'worker'; slot: number }
  /** The flag is set, but this process is a worker of another cluster (PM2 cluster mode): run the role. */
  | { mode: 'ignored'; reason: string };

export interface InAppClusterInput {
  role: ProcessRole;
  /** LANDA_INAPP_CLUSTER_WORKERS. */
  workers: number;
  /** LANDA_API_INSTANCES. */
  apiInstances: number;
  /** cluster.isPrimary of this process. */
  isPrimary: boolean;
  /** LANDA_INAPP_CLUSTER_SLOT ('' unless the in-app primary forked this process). */
  slot: string;
}

/** What dist/index.js does in this process. Throws on a configuration that must not start. */
export function planInAppCluster(input: InAppClusterInput): InAppClusterPlan {
  const { role, workers, apiInstances } = input;
  if (!Number.isSafeInteger(workers) || workers < 0) {
    throw new Error(`[InAppCluster] LANDA_INAPP_CLUSTER_WORKERS must be a non-negative integer, received: ${workers}`);
  }
  if (workers === 0) return { mode: 'off' };
  if (role !== 'api') {
    throw new Error(
      `[InAppCluster] LANDA_INAPP_CLUSTER_WORKERS=${workers} needs LANDA_PROCESS_ROLE=api (received "${role}"): the background process and the workers are never clustered.`,
    );
  }
  // The workers share request limits and short-lived request state through
  // Redis only when LANDA_API_INSTANCES counts all of them (process-role.ts).
  if (workers > apiInstances) {
    throw new Error(
      `[InAppCluster] LANDA_INAPP_CLUSTER_WORKERS=${workers} is more than LANDA_API_INSTANCES=${apiInstances}; LANDA_API_INSTANCES must count every API process.`,
    );
  }
  if (input.isPrimary) return { mode: 'primary', workers };
  const slot = parseSlot(input.slot, workers);
  if (slot === null) {
    return {
      mode: 'ignored',
      reason: 'this process is already a cluster worker (PM2 cluster mode); the in-app cluster needs exec_mode "fork" with instances 1.',
    };
  }
  return { mode: 'worker', slot };
}

function parseSlot(raw: string, workers: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const slot = Number(raw);
  return slot < workers ? slot : null;
}

/**
 * The NODE_APP_INSTANCE of the worker in `slot` (the `instance` label of its
 * metrics and heartbeat). Stable across restarts of that slot. Under a
 * numbered parent (PM2 sets NODE_APP_INSTANCE, 0 for one fork-mode instance)
 * the numbers of several primaries cannot overlap: parent x workers + slot.
 */
export function workerInstanceLabel(primaryInstance: string, workers: number, slot: number): string {
  const trimmed = primaryInstance.trim();
  const base = /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
  return String(base * workers + slot);
}

/** The wait before restarting a worker that exited after `uptimeMs` (`previousDelayMs`: the last wait of its slot). */
export function nextWorkerRestartDelayMs(previousDelayMs: number | null, uptimeMs: number): number {
  if (previousDelayMs === null || uptimeMs >= WORKER_STABLE_UPTIME_MS) return WORKER_RESTART_INITIAL_DELAY_MS;
  return Math.min(WORKER_RESTART_MAX_DELAY_MS, Math.round(previousDelayMs * WORKER_RESTART_FACTOR));
}

// ── Rolling restart ──────────────────────────────────────────────
// `node scripts/pm2-rolling-restart.mjs <app>` sends the primary a message
// with topic ROLLING_RESTART_TOPIC through PM2 (sendDataToProcessId; no
// signal, so it works on Windows). The primary replaces its workers one slot
// after the other and answers on PM2's bus (process.send({ type:
// 'process:msg', data })) with topic ROLLING_RESTART_REPLY_TOPIC. Both
// topics are repeated in the script; scripts/pm2-rolling-restart.test.mjs
// checks they match.

export const ROLLING_RESTART_TOPIC = 'landa:rolling-restart';
export const ROLLING_RESTART_REPLY_TOPIC = 'landa:rolling-restart:reply';
/**
 * The longest wait for a new worker's "ready" during a rolling restart: the
 * listen_timeout of the API in ecosystem.config.cjs, PM2's own wait for
 * "ready" when it starts the app (src/config/pm2-ecosystem.test.ts).
 */
export const ROLLING_RESTART_READY_TIMEOUT_MS = 60_000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/;

export type RollingRestartRejectReason = 'in_progress' | 'shutting_down' | 'not_ready';
export type RollingRestartFailReason =
  | 'exited_before_ready'
  | 'ready_timeout'
  | 'replacement_exited'
  | 'slot_not_ready'
  | 'shutting_down';

export interface RollingRestartSlotResult {
  slot: number;
  instance: string;
  old_pid: number | null;
  new_pid: number | null;
  /** From the fork of the new worker to its "ready". */
  ready_ms: number;
  /** From "shutdown" to the exit of the old worker. */
  stop_ms: number;
  /** The old worker did not exit by the shutdown deadline and was killed. */
  forced_stop: boolean;
}

/** What the primary answers to a rolling restart request, in order: accepted|rejected, slot_replaced per slot, succeeded|failed. */
export type RollingRestartReply =
  | { status: 'accepted'; request_id: string; workers: number; timeout_ms: number }
  | { status: 'rejected'; request_id: string; reason: RollingRestartRejectReason; message: string }
  | ({ status: 'slot_replaced'; request_id: string } & RollingRestartSlotResult)
  | { status: 'succeeded'; request_id: string; workers: number; duration_ms: number; slots: RollingRestartSlotResult[] }
  | {
      status: 'failed';
      request_id: string;
      reason: RollingRestartFailReason;
      slot: number;
      /** Slots replaced before the failure (they keep their new worker). */
      replaced: number;
      duration_ms: number;
      message: string;
    };

/** The request id of a rolling restart message from PM2 ('' when it has none or an invalid one), or null for any other message. */
export function parseRollingRestartRequest(message: unknown): { requestId: string } | null {
  if (typeof message !== 'object' || message === null) return null;
  const { topic, data } = message as { topic?: unknown; data?: unknown };
  if (topic !== ROLLING_RESTART_TOPIC) return null;
  const raw = typeof data === 'object' && data !== null ? (data as { request_id?: unknown }).request_id : undefined;
  return { requestId: typeof raw === 'string' && REQUEST_ID.test(raw) ? raw : '' };
}

/** The longest a rolling restart of `workers` slots can take: per slot, the wait for "ready" and the stop of the old worker. */
export function rollingRestartTimeoutMs(workers: number, readyTimeoutMs: number, stopTimeoutMs: number): number {
  return workers * (readyTimeoutMs + stopTimeoutMs);
}

/** The message of a rejected or failed rolling restart, for the operator. */
export function rollingRestartMessage(
  reason: RollingRestartRejectReason | RollingRestartFailReason,
  readyTimeoutMs: number,
): string {
  switch (reason) {
    case 'in_progress':
      return 'A rolling restart is already in progress; this one was not started.';
    case 'shutting_down':
      return 'The API is shutting down; the rolling restart stopped.';
    case 'not_ready':
      return 'Not every worker is ready yet (starting, or restarting after a crash); nothing was restarted. Try again in a moment.';
    case 'exited_before_ready':
      return 'The new worker exited before it was ready (see the PM2 log); the old worker of this slot keeps serving and the rolling restart stopped.';
    case 'ready_timeout':
      return `The new worker was not ready within ${Math.round(readyTimeoutMs / 1000)} s; it was stopped, the old worker of this slot keeps serving and the rolling restart stopped.`;
    case 'replacement_exited':
      return 'The new worker exited right after it took over the slot (see the PM2 log); the slot restarts as after a crash and the rolling restart stopped.';
    case 'slot_not_ready':
      return 'The worker of this slot is not ready (restarting after a crash); the rolling restart stopped before replacing it.';
  }
}
