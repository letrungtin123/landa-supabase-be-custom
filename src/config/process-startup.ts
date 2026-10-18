// ═══════════════════════════════════════════════════════════════
// Process startup and shutdown order per role (config/process-role.ts)
//
// index.ts supplies the real steps; tests supply stand-ins. Every role keeps
// the owner's rule: the process exits when the first RabbitMQ connection
// fails (the rabbitmq step does that), and a connection lost later still ends
// the process (config/rabbitmq/connection.ts, unchanged).
//
//   step                       all   api   background
//   in-memory cache sweepers    x     x     x
//   inline email outbox        run   log   run
//   heartbeat log (60 s)        x           x
//   RabbitMQ + queues           x     x     x
//   RabbitMQ consumers          x           x
//   Redis                       x     x     x
//   cluster bus                       x     x
//   access revocation check     x     x
//   lesson-author workers      loop  accept loop
//   sweepers, maintenance       x           x
//   HTTP listen                 x     x
//   PM2 ready                   x     x     x
//   Storage bucket              x     x
//   startup cleanups            x           x
// ═══════════════════════════════════════════════════════════════

import type { ShutdownStep } from './graceful-shutdown.js';
import type { ProcessRolePlan } from './process-role.js';

export interface ProcessStarters {
  /** Sweepers of the per-process in-memory caches (sign-out blacklist, one-time sign-in tokens, chat). */
  inMemorySweepers(): void;
  /**
   * The inline email outbox worker (when enabled): `run: false` (API process)
   * only says where it runs. First, as when it started on importing app.ts.
   */
  inlineEmailOutbox(options: { run: boolean }): void;
  /** The [Heartbeat] log line every 60 s (modules/metrics/heartbeat.service.ts); an API process serves /internal/metrics instead. */
  heartbeat(): void;
  /** Connects and asserts the queues; with `consumers` it also starts them. Exits when the first connection fails. */
  rabbitmq(options: { consumers: boolean }): Promise<void>;
  redis(): Promise<void>;
  clusterBus(): Promise<void>;
  /** The production Redis requirement for access revocation, then the first copy of the revocations. */
  authRevocation(): Promise<void>;
  /** Durable Blueprint, workspace and chapter checkpoint runtimes: `loop: false` only accepts work. */
  lessonAuthor(options: { loop: boolean }): Promise<void>;
  /** Sweepers and maintenance timers (AI token reservations, retention, temp residue). */
  backgroundTimers(): void;
  tempDirectories(): Promise<void>;
  /** Resolves once the HTTP server listens. */
  listen(): Promise<void>;
  ready(): void;
  storageBucket(): Promise<void>;
  /** One-off cleanups at start (retention, temp residue): once per deployment, never per API process. */
  startupCleanups(): Promise<void>;
}

export async function startProcess(plan: ProcessRolePlan, starters: ProcessStarters): Promise<void> {
  starters.inMemorySweepers();
  starters.inlineEmailOutbox({ run: plan.runsBackgroundWork });
  if (plan.runsBackgroundWork) starters.heartbeat();
  await starters.rabbitmq({ consumers: plan.runsBackgroundWork });
  await starters.redis();
  if (plan.sharesStateAcrossProcesses) await starters.clusterBus();
  if (plan.servesHttp) await starters.authRevocation();
  await starters.lessonAuthor({ loop: plan.runsBackgroundWork });
  if (plan.runsBackgroundWork) starters.backgroundTimers();
  await starters.tempDirectories();
  if (plan.servesHttp) await starters.listen();
  starters.ready();
  if (plan.servesHttp) await starters.storageBucket();
  if (plan.runsBackgroundWork) await starters.startupCleanups();
}

export interface ShutdownResources {
  /** Lesson-author loops and the inline email outbox (also stop the "accepting" state of an API process). */
  workers: ShutdownStep[];
  /** No new RabbitMQ deliveries to this process. */
  consumers: ShutdownStep;
  /** The cluster bus and the SSE LISTEN connections (the pool cannot end while they are checked out). */
  listenConnections: ShutdownStep;
  pdfRenderer: ShutdownStep;
  rabbitmq: ShutdownStep;
  redis: ShutdownStep;
  /** Opened on the first report read (any role); ends before the main pool, whose connection cancels its statements. */
  reportsPool: ShutdownStep;
  pool: ShutdownStep;
}

export function shutdownStepsFor(plan: ProcessRolePlan, resources: ShutdownResources): { stopIntake: ShutdownStep[]; closeResources: ShutdownStep[] } {
  return {
    stopIntake: [...resources.workers, ...(plan.runsBackgroundWork ? [resources.consumers] : [])],
    closeResources: [
      resources.listenConnections,
      ...(plan.servesHttp ? [resources.pdfRenderer] : []),
      resources.rabbitmq,
      resources.redis,
      resources.reportsPool,
      resources.pool,
    ],
  };
}
