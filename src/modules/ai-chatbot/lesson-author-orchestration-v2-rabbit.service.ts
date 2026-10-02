import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { createOrchestrationV2OutboxRepository } from './lesson-author-orchestration-v2-outbox.repository.js';
import {
  runOrchestrationV2DispatcherCycle,
  type OrchestrationV2DispatcherCycleConfig,
} from './lesson-author-orchestration-v2-dispatch.service.js';
import {
  handleOrchestrationV2Delivery,
  runOrchestrationV2WorkerRecoveryCycle,
  type OrchestrationV2WorkerRuntimeDependencies,
} from './lesson-author-orchestration-v2-worker.service.js';

type OutboxRepository = ReturnType<typeof createOrchestrationV2OutboxRepository>;

export interface OrchestrationV2RabbitConsumer {
  stop(): Promise<void>;
  inFlight(): number;
}

function reportSafely(report: OrchestrationV2WorkerRuntimeDependencies['report'], event: Record<string, unknown>): void {
  try {
    report(event);
  } catch {
    // Observability must not take ownership of delivery settlement.
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

const TRANSIENT_POSTGRES_CODES = new Set(['40P01', '40001', '55P03']);
const SQL_CYCLE_ATTEMPTS = 3;

export function isOrchestrationV2TransientPostgresError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '') : '';
  return TRANSIENT_POSTGRES_CODES.has(code);
}

/** Retry only transaction-level PostgreSQL contention. Broker/task leases remain
 * authoritative, so retrying a cycle cannot create a new paid-work identity. */
export async function runOrchestrationV2TransientSqlCycle<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  report: OrchestrationV2WorkerRuntimeDependencies['report'],
  scope: 'dispatcher' | 'worker_recovery',
  random: () => number = Math.random,
): Promise<T | undefined> {
  for (let attempt = 1; attempt <= SQL_CYCLE_ATTEMPTS; attempt += 1) {
    if (signal.aborted) return undefined;
    try {
      return await operation();
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? '') : '';
      if (!isOrchestrationV2TransientPostgresError(error) || attempt === SQL_CYCLE_ATTEMPTS) throw error;
      const baseDelayMs = 25 * (2 ** (attempt - 1));
      const jitterRatio = Math.max(0, Math.min(0.999, random()));
      const delayMs = baseDelayMs + Math.floor(baseDelayMs * jitterRatio);
      reportSafely(report, { event: `${scope}_transient_sql_retry`, code, attempt, delay_ms: delayMs });
      await wait(delayMs, signal);
    }
  }
  return undefined;
}

export async function publishOrchestrationV2Confirmed(
  channel: ConfirmChannel,
  queue: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = Buffer.from(JSON.stringify(payload));
  if (!queue.trim() || body.byteLength > 4_096) throw new Error('ORCHESTRATION_V2_BROKER_PAYLOAD_INVALID');
  await new Promise<void>((resolve, reject) => {
    channel.sendToQueue(queue, body, {
      persistent: true,
      contentType: 'application/json',
      type: 'lesson_author_orchestration_v2',
    }, error => error ? reject(error) : resolve());
  });
}

/**
 * A V2-only consumer. It intentionally does not use the generic x-retries
 * middleware because PostgreSQL outbox/task leases own every retry decision.
 */
export async function startOrchestrationV2RabbitConsumer(
  channel: ConfirmChannel,
  queue: string,
  prefetch: number,
  requeueDelayMs: number,
  deps: OrchestrationV2WorkerRuntimeDependencies,
  shutdownSignal: AbortSignal,
): Promise<OrchestrationV2RabbitConsumer> {
  if (!queue.trim() || !Number.isSafeInteger(prefetch) || prefetch < 1 || prefetch > 1_024) {
    throw new Error('ORCHESTRATION_V2_CONSUMER_CONFIG_INVALID');
  }
  if (!Number.isSafeInteger(requeueDelayMs) || requeueDelayMs < 100 || requeueDelayMs > 300_000) {
    throw new Error('ORCHESTRATION_V2_CONSUMER_CONFIG_INVALID');
  }
  await channel.prefetch(prefetch);
  let accepting = true;
  let stopPromise: Promise<void> | null = null;
  const active = new Set<Promise<void>>();
  const settle = (msg: ConsumeMessage, settlement: 'ack' | 'requeue') => {
    if (settlement === 'ack') channel.ack(msg);
    else channel.nack(msg, false, true);
  };
  const consume = await channel.consume(queue, msg => {
    if (!msg) return;
    if (!accepting) {
      channel.nack(msg, false, true);
      return;
    }
    const operation = (async () => {
      let result: Awaited<ReturnType<typeof handleOrchestrationV2Delivery>>;
      try {
        result = await handleOrchestrationV2Delivery(msg.content, deps, shutdownSignal);
      } catch (error) {
        reportSafely(deps.report, { event: 'worker_delivery_unhandled',
          error: error instanceof Error ? error.message : String(error) });
        await wait(requeueDelayMs, shutdownSignal);
        settle(msg, 'requeue');
        return;
      }
      if (result.settlement === 'requeue') await wait(requeueDelayMs, shutdownSignal);
      settle(msg, result.settlement);
    })()
      .catch(error => {
        // If ACK/NACK itself fails (for example, a closed channel), do not
        // attempt a second settlement. RabbitMQ will recover the unacked
        // delivery with the channel/connection lifecycle.
        reportSafely(deps.report, { event: 'worker_delivery_settlement_failed',
          error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => { active.delete(operation); });
    active.add(operation);
  }, { noAck: false });

  return {
    inFlight: () => active.size,
    async stop() {
      if (stopPromise) return stopPromise;
      accepting = false;
      stopPromise = (async () => {
        await channel.cancel(consume.consumerTag).catch(() => undefined);
        await Promise.allSettled([...active]);
      })();
      return stopPromise;
    },
  };
}

export async function runOrchestrationV2DispatcherLoop(input: {
  repository: OutboxRepository;
  channel: ConfirmChannel;
  config: OrchestrationV2DispatcherCycleConfig;
  poll_interval_ms: number;
  signal: AbortSignal;
  report(event: Record<string, unknown>): void;
}): Promise<void> {
  while (!input.signal.aborted) {
    let result: Awaited<ReturnType<typeof runOrchestrationV2DispatcherCycle>> | undefined;
    try {
      result = await runOrchestrationV2TransientSqlCycle(
        () => runOrchestrationV2DispatcherCycle(input.repository, input.config,
          (queue, payload) => publishOrchestrationV2Confirmed(input.channel, queue, payload)),
        input.signal, input.report, 'dispatcher');
    } catch (error) {
      if (!isOrchestrationV2TransientPostgresError(error)) throw error;
      reportSafely(input.report, {
        event: 'dispatcher_transient_sql_cycle_deferred',
        code: String((error as { code?: unknown }).code ?? ''),
        recovery: 'continue_polling',
      });
      await wait(input.poll_interval_ms, input.signal);
      continue;
    }
    if (!result) break;
    if (Object.values(result).some(value => value > 0)) {
      input.report({ event: 'dispatcher_cycle', ...result });
    }
    const active = result.published + result.retry_scheduled + result.publish_dead
      + result.recovered + result.recovery_dead;
    await wait(active > 0 ? Math.min(25, input.poll_interval_ms) : input.poll_interval_ms, input.signal);
  }
}

export async function runOrchestrationV2WorkerRecoveryLoop(input: {
  deps: OrchestrationV2WorkerRuntimeDependencies;
  batch_size: number;
  poll_interval_ms: number;
  signal: AbortSignal;
}): Promise<void> {
  while (!input.signal.aborted) {
    const result = await runOrchestrationV2TransientSqlCycle(
      () => runOrchestrationV2WorkerRecoveryCycle(input.deps, input.batch_size),
      input.signal, input.deps.report, 'worker_recovery');
    if (!result) break;
    if (Object.values(result).some(value => value > 0)) input.deps.report({ event: 'worker_recovery_cycle', ...result });
    await wait(input.poll_interval_ms, input.signal);
  }
}
