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
