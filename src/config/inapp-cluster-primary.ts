// ═══════════════════════════════════════════════════════════════
// In-app cluster primary (LANDA_INAPP_CLUSTER_WORKERS; rules in
// inapp-cluster.logic.ts). Started by index.ts instead of the API startup.
//
// - Connections: cluster.SCHED_RR, set before the first fork. The primary
//   accepts them and hands them to the workers in turn (one keep-alive
//   connection stays with the worker that got it).
// - Workers: n, each in a fixed slot with a stable NODE_APP_INSTANCE
//   (workerInstanceLabel), so metrics and heartbeat keep one `instance` label
//   per slot. A worker runs the same script (index.ts) and the normal API
//   startup; its "ready" (wait_ready) comes to this primary.
// - Ready: "ready" goes to PM2 once every slot has been ready (after listen).
// - Crash: the slot restarts with the PM2 backoff (1 s, x1.5, at most 15 s;
//   from 1 s again after 30 s up).
// - Shutdown: the PM2 "shutdown" message, SIGINT or SIGTERM is passed to the
//   workers as the "shutdown" message (their graceful shutdown; signals do
//   not reach a process on Windows). The primary waits for them up to
//   SHUTDOWN_FORCE_EXIT_MS + 1 s (before PM2's kill_timeout of 15 s), kills
//   the ones left, then exits (0, or 1 when it had to kill).
// - The primary does no app work: no database, Redis, RabbitMQ or HTTP
//   handler. Importing this file starts nothing.
// ═══════════════════════════════════════════════════════════════

import cluster, { type Worker } from 'node:cluster';
import { SHUTDOWN_FORCE_EXIT_MS } from './graceful-shutdown.js';
import { createJsonLogger, type JsonLogger } from '../utils/json-logger.js';
import { INAPP_CLUSTER_SLOT_ENV, nextWorkerRestartDelayMs, workerInstanceLabel } from './inapp-cluster.logic.js';

/** Workers end their graceful shutdown by SHUTDOWN_FORCE_EXIT_MS; PM2 force-kills at kill_timeout (15 s). */
export const INAPP_CLUSTER_SHUTDOWN_DEADLINE_MS = SHUTDOWN_FORCE_EXIT_MS + 1_000;
/** After the deadline kill, the longest wait for the killed workers' exit events. */
const KILL_SETTLE_MS = 1_000;

export interface InAppClusterPrimaryOptions {
  workers: number;
  /** The script every worker runs (index.ts / dist/index.js itself). */
  exec: string;
  /** NODE_APP_INSTANCE of this process ('' when PM2 did not set one). */
  primaryInstance: string;
  /** Tells PM2 this process is ready (signalProcessReady). */
  signalReady: () => void;
  shutdownDeadlineMs?: number;
  logger?: JsonLogger;
  exit?: (code: number) => void;
}

export interface InAppClusterPrimary {
  /** Stops every worker (graceful, then killed at the deadline), then exits. */
  shutdown(reason: string): Promise<void>;
}

interface Slot {
  slot: number;
  instance: string;
  worker: Worker | null;
  startedAt: number;
  ready: boolean;
  restartDelayMs: number | null;
  restartTimer: NodeJS.Timeout | null;
}

export function runInAppClusterPrimary(options: InAppClusterPrimaryOptions): InAppClusterPrimary {
  const logger = options.logger ?? createJsonLogger({ tag: 'InAppCluster', fields: { primary_pid: process.pid } });
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const deadlineMs = options.shutdownDeadlineMs ?? INAPP_CLUSTER_SHUTDOWN_DEADLINE_MS;

  // Read once, at setupPrimary or the first fork, whichever comes first.
  cluster.schedulingPolicy = cluster.SCHED_RR;
  cluster.setupPrimary({ exec: options.exec, windowsHide: true });

  const slots: Slot[] = Array.from({ length: options.workers }, (_, slot) => ({
    slot,
    instance: workerInstanceLabel(options.primaryInstance, options.workers, slot),
    worker: null,
    startedAt: 0,
    ready: false,
    restartDelayMs: null,
    restartTimer: null,
  }));
  let allReadySignalled = false;
  let stopping: Promise<void> | null = null;
  let onAllStopped: (() => void) | null = null;

  const fields = (state: Slot, worker: Worker) => ({ slot: state.slot, instance: state.instance, pid: worker.process.pid });

  function fork(state: Slot): void {
    const worker = cluster.fork({ NODE_APP_INSTANCE: state.instance, [INAPP_CLUSTER_SLOT_ENV]: String(state.slot) });
    state.worker = worker;
    state.startedAt = Date.now();
    state.ready = false;
    logger.info('worker_started', fields(state, worker));
    worker.on('message', (message: unknown) => {
      if (message !== 'ready' || state.worker !== worker) return;
      state.ready = true;
      logger.info('worker_ready', fields(state, worker));
      if (!allReadySignalled && slots.every((other) => other.ready)) {
        allReadySignalled = true;
        logger.info('all_workers_ready', { workers: slots.length, scheduling: 'round-robin' });
        options.signalReady();
      }
    });
    worker.on('error', (error: Error) => logger.error('worker_ipc_error', { ...fields(state, worker), error }));
    worker.on('exit', (code: number | null, signal: string | null) => onExit(state, worker, code, signal));
  }

  function onExit(state: Slot, worker: Worker, code: number | null, signal: string | null): void {
    if (state.worker !== worker) return;
    state.worker = null;
    state.ready = false;
    if (stopping) {
      logger.info('worker_stopped', { ...fields(state, worker), code, signal });
      if (slots.every((other) => other.worker === null)) onAllStopped?.();
      return;
    }
    const uptimeMs = Date.now() - state.startedAt;
    const delayMs = nextWorkerRestartDelayMs(state.restartDelayMs, uptimeMs);
    state.restartDelayMs = delayMs;
    logger.error('worker_exited', { ...fields(state, worker), code, signal, uptime_ms: uptimeMs, restart_in_ms: delayMs });
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      if (!stopping) fork(state);
    }, delayMs);
  }

  function shutdown(reason: string): Promise<void> {
    if (stopping) return stopping;
    let forced = false;
    let deadline: NodeJS.Timeout | undefined;
    stopping = new Promise<void>((resolve) => {
      onAllStopped = () => {
        clearTimeout(deadline);
        resolve();
      };
      for (const state of slots) {
        if (state.restartTimer) clearTimeout(state.restartTimer);
        state.restartTimer = null;
      }
      const running = slots.filter((state) => state.worker !== null);
      logger.info('shutdown_started', { reason, workers: running.length, deadline_ms: deadlineMs });
      if (running.length === 0) {
        resolve();
        return;
      }
      for (const state of running) {
        const worker = state.worker!;
        if (!worker.isConnected()) continue;
        worker.send('shutdown', (error: Error | null) => {
          if (error) logger.warn('shutdown_message_failed', { ...fields(state, worker), error });
        });
      }
      deadline = setTimeout(() => {
        forced = true;
        for (const state of slots) {
          if (!state.worker) continue;
          logger.warn('worker_killed_at_deadline', fields(state, state.worker));
          state.worker.process.kill();
        }
        setTimeout(resolve, KILL_SETTLE_MS);
      }, deadlineMs);
    }).then(() => {
      logger.info('shutdown_finished', { reason, forced });
      exit(forced ? 1 : 0);
    });
    return stopping;
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  // PM2 on Windows cannot deliver signals; with shutdown_with_message it sends this instead.
  process.on('message', (message: unknown) => {
    if (message === 'shutdown') void shutdown('PM2 shutdown message');
  });

  logger.info('inapp_cluster_started', { workers: slots.length, scheduling: 'round-robin', exec: options.exec });
  for (const state of slots) fork(state);
  return { shutdown };
}
