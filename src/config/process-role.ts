// ═══════════════════════════════════════════════════════════════
// Process role — what one process of dist/index.js runs
//
// - all: HTTP and every background job in one process (the default; the
//   behavior before the split).
// - api: HTTP, SSE streams and their LISTEN hubs, publishing to RabbitMQ.
//   PM2 runs it in cluster mode, LANDA_API_INSTANCES times.
// - background: RabbitMQ consumers, pollers, sweepers, maintenance timers and
//   the startup cleanups, in exactly one process.
// With more than one process, in-process caches hear invalidations from the
// other processes (config/cluster-bus.ts). With more than one API process,
// request limits and short-lived request state (AI chat slots, one-time
// sign-in tokens, report PDF jobs) live in Redis.
// ═══════════════════════════════════════════════════════════════

import { env } from './env.js';

export type ProcessRole = 'all' | 'api' | 'background';

export interface ProcessRolePlan {
  role: ProcessRole;
  apiInstances: number;
  /** Listens on the HTTP port. */
  servesHttp: boolean;
  /** Starts the queue consumers, pollers, sweepers, maintenance timers and startup cleanups. */
  runsBackgroundWork: boolean;
  /** Other processes of this deployment hold the same in-process caches. */
  sharesStateAcrossProcesses: boolean;
  /** Several API processes answer requests (shared limits through Redis). */
  severalApiInstances: boolean;
}

export function planProcessRole(role: ProcessRole, apiInstances: number): ProcessRolePlan {
  if (!Number.isSafeInteger(apiInstances) || apiInstances < 1) {
    throw new Error(`[ProcessRole] LANDA_API_INSTANCES must be a positive integer, received: ${apiInstances}`);
  }
  // Several 'all' processes would each run every consumer, poller and
  // startup cleanup: refuse instead of running the background work N times.
  if (role === 'all' && apiInstances > 1) {
    throw new Error('[ProcessRole] LANDA_API_INSTANCES > 1 needs LANDA_PROCESS_ROLE=api for the API processes and one LANDA_PROCESS_ROLE=background process.');
  }
  return {
    role,
    apiInstances,
    servesHttp: role !== 'background',
    runsBackgroundWork: role !== 'api',
    sharesStateAcrossProcesses: role !== 'all',
    severalApiInstances: role === 'api' && apiInstances > 1,
  };
}

/** The plan of this process. */
export const processRolePlan: ProcessRolePlan = planProcessRole(env.LANDA_PROCESS_ROLE, env.LANDA_API_INSTANCES);

/**
 * Tells PM2 the process is ready (wait_ready). Without an IPC channel (not
 * started by PM2) there is nobody to tell.
 */
export function signalProcessReady(send: ((message: 'ready') => unknown) | undefined = process.send?.bind(process)): boolean {
  if (!send) return false;
  send('ready');
  return true;
}

/**
 * A per-process share of a limit that must hold for the whole cluster when
 * the shared Redis counter is unavailable (each of `instances` processes
 * enforces this much; the total stays within `limit` + instances - 1).
 */
export function perInstanceShare(limit: number, instances: number): number {
  return Math.max(1, Math.ceil(limit / Math.max(1, instances)));
}
