// ═══════════════════════════════════════════════════════════════
// Graceful shutdown of the API process (SIGINT/SIGTERM, PM2 "shutdown")
//
// 1. Stop intake: pollers/sweepers stop, background workers are told to
//    stop, long-lived streams end politely, the server stops accepting.
// 2. Drain: in-flight requests finish, up to SHUTDOWN_DRAIN_TIMEOUT_MS;
//    connections still open after that are closed.
// 3. Tracked work (e.g. metering of an AI answer the drain cut) settles.
// 4. Shared resources close in order (RabbitMQ, Redis, database pool), then
//    exit 0. A second signal or the hard deadline exits at once with 1.
// The hard deadline stays below PM2 kill_timeout (ecosystem.config.cjs), so
// PM2 never has to kill a half-closed process.
// ═══════════════════════════════════════════════════════════════

import type { Server } from 'node:http';
import type { ProcessLifecycle } from './process-lifecycle.js';

export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
export const SHUTDOWN_WORK_GRACE_MS = 1_500;
export const SHUTDOWN_FORCE_EXIT_MS = 13_500;
/** Each resource gets at most this long to close (a pool with a stuck client never ends). */
const SHUTDOWN_STEP_TIMEOUT_MS = 2_000;
/** Time kept for closing resources when workers are slow to stop. */
const SHUTDOWN_CLOSE_RESERVE_MS = 3_000;
const IDLE_SWEEP_INTERVAL_MS = 200;

export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown> | unknown;
}

export interface GracefulShutdownOptions {
  /** The HTTP server, or null while the process is still starting. */
  getServer: () => (Pick<Server, 'close'> & Partial<Pick<Server, 'closeIdleConnections' | 'closeAllConnections'>>) | null;
  lifecycle: Pick<ProcessLifecycle, 'begin' | 'settleWork'>;
  /** Started together with the drain (workers that stop taking work); awaited after it. */
  stopIntake: ShutdownStep[];
  /** Run one after the other once the drain and the tracked work are done. */
  closeResources: ShutdownStep[];
  exit: (code: number) => void;
  log?: (message: string) => void;
  drainTimeoutMs?: number;
  workGraceMs?: number;
  forceExitMs?: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function within<T>(work: Promise<T>, timeoutMs: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), timeoutMs);
    timer.unref();
  });
  return Promise.race([work.then((value) => ({ done: true as const, value })), timeout]).finally(() => clearTimeout(timer));
}

export function createGracefulShutdown(options: GracefulShutdownOptions): (reason: string) => Promise<void> {
  const log = options.log ?? ((message) => console.log(message));
  const drainTimeoutMs = options.drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS;
  const workGraceMs = options.workGraceMs ?? SHUTDOWN_WORK_GRACE_MS;
  const forceExitMs = options.forceExitMs ?? SHUTDOWN_FORCE_EXIT_MS;
  let started = false;

  const runStep = async (step: ShutdownStep, timeoutMs: number) => {
    try {
      if (!(await within(Promise.resolve().then(step.run), timeoutMs)).done) log(`[Shutdown] ${step.name} did not finish in ${timeoutMs} ms`);
    } catch (error) {
      log(`[Shutdown] ${step.name} failed: ${errorText(error)}`);
    }
  };

  return async function shutdown(reason: string): Promise<void> {
    if (started) {
      log(`[Shutdown] ${reason} received again; exiting now`);
      options.exit(1);
      return;
    }
    started = true;
    const startedAt = Date.now();
    log(`[Shutdown] ${reason} received; draining requests for up to ${drainTimeoutMs} ms`);
    const forceExit = setTimeout(() => {
      log(`[Shutdown] Not finished after ${forceExitMs} ms; exiting now`);
      options.exit(1);
    }, forceExitMs);
    forceExit.unref();

    options.lifecycle.begin();
    const intake = Promise.all(options.stopIntake.map((step) => runStep(step, forceExitMs)));

    const server = options.getServer();
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Keep-alive connections without a request in flight end now; a
      // connection whose request finishes later is closed on the next pass.
      server.closeIdleConnections?.();
      const idleSweep = setInterval(() => server.closeIdleConnections?.(), IDLE_SWEEP_INTERVAL_MS);
      idleSweep.unref();
      const drained = (await within(closed, drainTimeoutMs)).done;
      clearInterval(idleSweep);
      if (!drained) {
        log('[Shutdown] Requests still open after the drain; closing their connections');
        server.closeAllConnections?.();
      }
    }

    if (!(await options.lifecycle.settleWork(workGraceMs))) {
      log('[Shutdown] Some tracked work did not settle in time');
    }
    await within(intake, Math.max(0, startedAt + forceExitMs - SHUTDOWN_CLOSE_RESERVE_MS - Date.now()));
    for (const step of options.closeResources) await runStep(step, SHUTDOWN_STEP_TIMEOUT_MS);

    clearTimeout(forceExit);
    log(`[Shutdown] Complete after ${Date.now() - startedAt} ms`);
    options.exit(0);
  };
}
