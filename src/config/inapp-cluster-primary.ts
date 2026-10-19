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
// - Rolling restart (the ROLLING_RESTART_TOPIC message that
//   scripts/pm2-rolling-restart.mjs sends through PM2): one slot after the
//   other, a new worker is forked (a new process: it loads dist/ from disk
//   again); once it is ready, the old worker of the slot gets "shutdown" and
//   the primary waits for its exit (killed at the shutdown deadline) before
//   the next slot. So n ready workers serve the whole time, n + 1 for a
//   moment. The new worker keeps the slot's NODE_APP_INSTANCE, as PM2's
//   cluster reload does: one `instance` label per slot, which the draining
//   old worker also carries until it exits.
//   A new worker that exits, or is not ready within
//   ROLLING_RESTART_READY_TIMEOUT_MS, is stopped; the old one keeps serving
//   and the roll stops (failed). A request during a roll, or before every
//   slot is ready, is rejected. The answers go back on PM2's bus.
//   The primary itself (index.ts, this file, the logic file, its env) is
//   not reloaded by a roll: a change there needs `pm2 restart` of the app.
// - The primary does no app work: no database, Redis, RabbitMQ or HTTP
//   handler. Importing this file starts nothing.
// ═══════════════════════════════════════════════════════════════

import cluster, { type Worker } from 'node:cluster';
import { SHUTDOWN_FORCE_EXIT_MS } from './graceful-shutdown.js';
import { createJsonLogger, type JsonLogger } from '../utils/json-logger.js';
import {
  INAPP_CLUSTER_SLOT_ENV,
  nextWorkerRestartDelayMs,
  parseRollingRestartRequest,
  ROLLING_RESTART_READY_TIMEOUT_MS,
  ROLLING_RESTART_REPLY_TOPIC,
  rollingRestartMessage,
  rollingRestartTimeoutMs,
  workerInstanceLabel,
  type RollingRestartFailReason,
  type RollingRestartRejectReason,
  type RollingRestartReply,
  type RollingRestartSlotResult,
} from './inapp-cluster.logic.js';

/** Workers end their graceful shutdown by SHUTDOWN_FORCE_EXIT_MS; PM2 force-kills at kill_timeout (15 s). */
export const INAPP_CLUSTER_SHUTDOWN_DEADLINE_MS = SHUTDOWN_FORCE_EXIT_MS + 1_000;
/** After a deadline kill, the longest wait for the killed workers' exit events. */
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
  /** Rolling restart: the longest wait for a new worker's "ready" (ROLLING_RESTART_READY_TIMEOUT_MS). */
  readyTimeoutMs?: number;
  /** Sends a message to PM2 (process.send while the IPC channel is open); resolves once it is sent. */
  sendToParent?: (message: unknown) => Promise<void>;
  logger?: JsonLogger;
  exit?: (code: number) => void;
}

export interface InAppClusterPrimary {
  /** Stops every worker (graceful, then killed at the deadline), then exits. */
  shutdown(reason: string): Promise<void>;
  /** Replaces the workers one slot after the other; resolves with the last answer sent to PM2. */
  rollingRestart(requestId: string): Promise<RollingRestartReply>;
}

interface Slot {
  slot: number;
  instance: string;
  /** The worker serving the slot (a replacement joins only once it is ready). */
  worker: Worker | null;
  startedAt: number;
  ready: boolean;
  restartDelayMs: number | null;
  restartTimer: NodeJS.Timeout | null;
}

type ReadyOutcome = { ok: true } | { ok: false; reason: 'exited_before_ready' | 'ready_timeout' };
type SlotOutcome = { ok: true; result: RollingRestartSlotResult } | { ok: false; reason: RollingRestartFailReason };

export function runInAppClusterPrimary(options: InAppClusterPrimaryOptions): InAppClusterPrimary {
  const logger = options.logger ?? createJsonLogger({ tag: 'InAppCluster', fields: { primary_pid: process.pid } });

  // Read once, at setupPrimary or the first fork, whichever comes first.
  cluster.schedulingPolicy = cluster.SCHED_RR;
  cluster.setupPrimary({ exec: options.exec, windowsHide: true });
  const primary = new ClusterPrimary(options, logger);

  process.on('SIGINT', () => {
    void primary.shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void primary.shutdown('SIGTERM');
  });
  process.on('message', (message: unknown) => {
    // PM2 on Windows cannot deliver signals; with shutdown_with_message it sends this instead.
    if (message === 'shutdown') {
      void primary.shutdown('PM2 shutdown message');
      return;
    }
    const request = parseRollingRestartRequest(message);
    if (request) void primary.rollingRestart(request.requestId);
  });

  primary.start();
  return {
    shutdown: reason => primary.shutdown(reason),
    rollingRestart: requestId => primary.rollingRestart(requestId),
  };
}

function sendToPm2(message: unknown, logger: JsonLogger): Promise<void> {
  return new Promise(resolve => {
    if (!process.send || !process.connected) {
      resolve();
      return;
    }
    process.send(message, undefined, undefined, (error: Error | null) => {
      if (error) logger.warn('pm2_message_failed', { error });
      resolve();
    });
  });
}

class ClusterPrimary {
  private readonly slots: Slot[];
  /** Every worker process that has not exited (serving, starting as a replacement, or replaced and draining). */
  private readonly live = new Map<Worker, Slot>();
  private readonly toldToStop = new WeakSet<Worker>();
  private readonly options: InAppClusterPrimaryOptions;
  private readonly logger: JsonLogger;
  private readonly deadlineMs: number;
  private readonly readyTimeoutMs: number;
  private allReadySignalled = false;
  private stopping: Promise<void> | null = null;
  private onAllStopped: (() => void) | null = null;
  private rolling = false;
  /** The rolling restart in progress (null when none) and the last answer sent to PM2. */
  private rollDone: Promise<unknown> | null = null;
  private lastReplySent: Promise<void> = Promise.resolve();

  constructor(options: InAppClusterPrimaryOptions, logger: JsonLogger) {
    this.options = options;
    this.logger = logger;
    this.deadlineMs = options.shutdownDeadlineMs ?? INAPP_CLUSTER_SHUTDOWN_DEADLINE_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? ROLLING_RESTART_READY_TIMEOUT_MS;
    this.slots = Array.from({ length: options.workers }, (_, slot) => ({
      slot,
      instance: workerInstanceLabel(options.primaryInstance, options.workers, slot),
      worker: null,
      startedAt: 0,
      ready: false,
      restartDelayMs: null,
      restartTimer: null,
    }));
  }

  start(): void {
    this.logger.info('inapp_cluster_started', {
      workers: this.slots.length,
      scheduling: 'round-robin',
      exec: this.options.exec,
    });
    for (const state of this.slots) this.startInSlot(state);
  }

  private fields(state: Slot, worker: Worker) {
    return { slot: state.slot, instance: state.instance, pid: worker.process.pid };
  }

  /** A new worker process for `state` (the same env as every worker of the slot); it serves only once assigned to the slot. */
  private fork(state: Slot, event: 'worker_started' | 'replacement_started'): Worker {
    const worker = cluster.fork({ NODE_APP_INSTANCE: state.instance, [INAPP_CLUSTER_SLOT_ENV]: String(state.slot) });
    this.live.set(worker, state);
    this.logger.info(event, this.fields(state, worker));
    worker.on('message', (message: unknown) => {
      if (message === 'ready') this.onReady(state, worker);
    });
    worker.on('error', (error: Error) => this.logger.error('worker_ipc_error', { ...this.fields(state, worker), error }));
    worker.on('exit', (code: number | null, signal: string | null) => this.onExit(state, worker, code, signal));
    return worker;
  }

  private startInSlot(state: Slot): void {
    state.worker = this.fork(state, 'worker_started');
    state.startedAt = Date.now();
    state.ready = false;
  }

  private onReady(state: Slot, worker: Worker): void {
    // A replacement: rollingRestart waits for its "ready" itself.
    if (state.worker !== worker) return;
    state.ready = true;
    this.logger.info('worker_ready', this.fields(state, worker));
    if (!this.allReadySignalled && this.slots.every(other => other.ready)) {
      this.allReadySignalled = true;
      this.logger.info('all_workers_ready', { workers: this.slots.length, scheduling: 'round-robin' });
      this.options.signalReady();
    }
  }

  private onExit(state: Slot, worker: Worker, code: number | null, signal: string | null): void {
    this.live.delete(worker);
    const serving = state.worker === worker;
    if (serving) {
      state.worker = null;
      state.ready = false;
    }
    if (this.stopping) {
      this.logger.info('worker_stopped', { ...this.fields(state, worker), code, signal });
      if (this.live.size === 0) this.onAllStopped?.();
      return;
    }
    if (!serving) {
      // A replaced worker that drained, or a replacement that did not start (rollingRestart reports it).
      this.logger.info('worker_stopped', { ...this.fields(state, worker), code, signal });
      return;
    }
    const uptimeMs = Date.now() - state.startedAt;
    const delayMs = nextWorkerRestartDelayMs(state.restartDelayMs, uptimeMs);
    state.restartDelayMs = delayMs;
    this.logger.error('worker_exited', {
      ...this.fields(state, worker),
      code,
      signal,
      uptime_ms: uptimeMs,
      restart_in_ms: delayMs,
    });
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      if (!this.stopping) this.startInSlot(state);
    }, delayMs);
  }

  /** Sends "shutdown" once per worker (a second one would cut its graceful shutdown short). */
  private tellToStop(worker: Worker): void {
    if (this.toldToStop.has(worker) || !worker.isConnected()) return;
    this.toldToStop.add(worker);
    worker.send('shutdown', (error: Error | null) => {
      const state = this.live.get(worker);
      if (error && state) this.logger.warn('shutdown_message_failed', { ...this.fields(state, worker), error });
    });
  }

  private killAtDeadline(worker: Worker): void {
    const state = this.live.get(worker);
    if (!state) return;
    this.logger.warn('worker_killed_at_deadline', this.fields(state, worker));
    worker.process.kill();
  }

  shutdown(reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    let forced = false;
    let deadline: NodeJS.Timeout | undefined;
    this.stopping = new Promise<void>(resolve => {
      this.onAllStopped = () => {
        clearTimeout(deadline);
        resolve();
      };
      for (const state of this.slots) {
        if (state.restartTimer) clearTimeout(state.restartTimer);
        state.restartTimer = null;
      }
      this.logger.info('shutdown_started', { reason, workers: this.live.size, deadline_ms: this.deadlineMs });
      if (this.live.size === 0) {
        resolve();
        return;
      }
      for (const worker of this.live.keys()) this.tellToStop(worker);
      deadline = setTimeout(() => {
        forced = true;
        for (const worker of [...this.live.keys()]) this.killAtDeadline(worker);
        setTimeout(resolve, KILL_SETTLE_MS);
      }, this.deadlineMs);
    }).then(async () => {
      await this.settleRollingRestart();
      this.logger.info('shutdown_finished', { reason, forced });
      (this.options.exit ?? ((code: number) => process.exit(code)))(forced ? 1 : 0);
    });
    return this.stopping;
  }

  async rollingRestart(requestId: string): Promise<RollingRestartReply> {
    const rejected = this.rejectReason();
    if (rejected) {
      const message = rollingRestartMessage(rejected, this.readyTimeoutMs);
      return this.reply({ status: 'rejected', request_id: requestId, reason: rejected, message });
    }
    this.rolling = true;
    const done = this.roll(requestId);
    this.rollDone = done;
    try {
      return await done;
    } finally {
      this.rolling = false;
      this.rollDone = null;
    }
  }

  /**
   * Before the primary exits: a rolling restart cut by the shutdown ends as
   * soon as its workers are gone; its last answer goes out first (at most
   * KILL_SETTLE_MS), so the script hears "failed" instead of waiting.
   */
  private async settleRollingRestart(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    // The roll's own failure, if any, is reported by its caller; here it only must not keep the primary from exiting.
    const settled = Promise.allSettled([this.rollDone]).then(() => Promise.allSettled([this.lastReplySent]));
    await Promise.race([settled, new Promise(resolve => (timer = setTimeout(resolve, KILL_SETTLE_MS)))]);
    clearTimeout(timer);
  }

  private rejectReason(): RollingRestartRejectReason | null {
    if (this.stopping) return 'shutting_down';
    if (this.rolling) return 'in_progress';
    if (!this.slots.every(state => state.ready)) return 'not_ready';
    return null;
  }

  private async roll(requestId: string): Promise<RollingRestartReply> {
    const startedAt = Date.now();
    const workers = this.slots.length;
    const timeoutMs = rollingRestartTimeoutMs(workers, this.readyTimeoutMs, this.deadlineMs + KILL_SETTLE_MS);
    this.reply({ status: 'accepted', request_id: requestId, workers, timeout_ms: timeoutMs });
    const replaced: RollingRestartSlotResult[] = [];
    for (const state of this.slots) {
      let outcome: SlotOutcome;
      if (this.stopping) outcome = { ok: false, reason: 'shutting_down' };
      else if (!state.ready) outcome = { ok: false, reason: 'slot_not_ready' };
      else outcome = await this.replaceSlot(state);
      if (!outcome.ok) {
        return this.reply({
          status: 'failed',
          request_id: requestId,
          reason: outcome.reason,
          slot: state.slot,
          replaced: replaced.length,
          duration_ms: Date.now() - startedAt,
          message: rollingRestartMessage(outcome.reason, this.readyTimeoutMs),
        });
      }
      replaced.push(outcome.result);
      this.reply({ status: 'slot_replaced', request_id: requestId, ...outcome.result });
    }
    const durationMs = Date.now() - startedAt;
    return this.reply({ status: 'succeeded', request_id: requestId, workers, duration_ms: durationMs, slots: replaced });
  }

  /** New worker ready first, then the old one stops: the slot is never without a ready worker. */
  private async replaceSlot(state: Slot): Promise<SlotOutcome> {
    const startedAt = Date.now();
    const incoming = this.fork(state, 'replacement_started');
    const ready = await this.waitForReady(incoming);
    if (!ready.ok || this.stopping) {
      await this.stopWorker(incoming);
      return { ok: false, reason: this.stopping || ready.ok ? 'shutting_down' : ready.reason };
    }
    const readyMs = Date.now() - startedAt;
    const previous = state.worker;
    if (state.restartTimer) clearTimeout(state.restartTimer);
    state.restartTimer = null;
    state.worker = incoming;
    state.startedAt = startedAt;
    state.ready = true;
    state.restartDelayMs = null;
    const oldPid = previous?.process.pid ?? null;
    this.logger.info('worker_replaced', { ...this.fields(state, incoming), old_pid: oldPid, ready_ms: readyMs });

    const stopStartedAt = Date.now();
    const exitedInTime = previous ? await this.stopWorker(previous) : true;
    if (state.worker !== incoming) return { ok: false, reason: 'replacement_exited' };
    return {
      ok: true,
      result: {
        slot: state.slot,
        instance: state.instance,
        old_pid: oldPid,
        new_pid: incoming.process.pid ?? null,
        ready_ms: readyMs,
        stop_ms: Date.now() - stopStartedAt,
        forced_stop: !exitedInTime,
      },
    };
  }

  private waitForReady(worker: Worker): Promise<ReadyOutcome> {
    return new Promise(resolve => {
      const finish = (outcome: ReadyOutcome) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', onExit);
        resolve(outcome);
      };
      const onMessage = (message: unknown) => {
        if (message === 'ready') finish({ ok: true });
      };
      const onExit = () => finish({ ok: false, reason: 'exited_before_ready' });
      const timer = setTimeout(() => finish({ ok: false, reason: 'ready_timeout' }), this.readyTimeoutMs);
      worker.on('message', onMessage);
      worker.on('exit', onExit);
    });
  }

  /** True when `worker` exits within `ms` (or already has). */
  private waitForExit(worker: Worker, ms: number): Promise<boolean> {
    if (!this.live.has(worker)) return Promise.resolve(true);
    return new Promise(resolve => {
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        worker.off('exit', onExit);
        resolve(false);
      }, ms);
      worker.once('exit', onExit);
    });
  }

  /** Graceful stop of one worker, killed at the shutdown deadline. True when it exited by itself in time. */
  private async stopWorker(worker: Worker): Promise<boolean> {
    this.tellToStop(worker);
    if (await this.waitForExit(worker, this.deadlineMs)) return true;
    this.killAtDeadline(worker);
    await this.waitForExit(worker, KILL_SETTLE_MS);
    return false;
  }

  private reply(reply: RollingRestartReply): RollingRestartReply {
    const { status, ...fields } = reply;
    if (status === 'rejected' || status === 'failed') this.logger.warn(`rolling_restart_${status}`, fields);
    else this.logger.info(`rolling_restart_${status}`, fields);
    const message = { type: 'process:msg', data: { topic: ROLLING_RESTART_REPLY_TOPIC, ...reply } };
    this.lastReplySent = this.options.sendToParent
      ? this.options.sendToParent(message)
      : sendToPm2(message, this.logger);
    return reply;
  }
}
