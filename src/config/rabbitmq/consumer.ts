// ═══════════════════════════════════════════════════════════════
// RabbitMQ Consumer — Consume messages with retry logic
// prefetch(1): process 1 message at a time
// Retry up to 3 times via x-retries header
//
// A failed message is published again with x-retries + 1 and the old one
// acknowledged. Consumers that opt in (retryBackoff) wait before that
// republish — about RABBITMQ_RETRY_BASE_DELAY_MS doubling per attempt,
// jittered, capped at RABBITMQ_RETRY_MAX_DELAY_MS — so a short provider or
// database outage does not burn every attempt within milliseconds.
// Consumers whose database job rows carry their own retry backoff keep the
// immediate republish (their early redelivery finds the job not due yet).
// When the republish itself is not confirmed, the message is requeued
// after a short wait instead of at once, so a refusing broker is not hit in
// a tight loop. The wait ends early when the process starts shutting down.
// At shutdown cancelConsumers() also stops new deliveries; a message whose
// wait ended is still republished and acknowledged on its open channel.
// ═══════════════════════════════════════════════════════════════

import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { createRabbitChannel, getChannel } from './connection.js';
import { env } from '../env.js';
import { onShutdownStart } from '../process-lifecycle.js';

const MAX_RETRIES = 3;

/** Consumers started by this process, so a shutdown can stop new deliveries. */
const activeConsumers: Array<{ queue: string; channel: ConfirmChannel; consumerTag: string }> = [];

type ConsumeCallback = (data: Record<string, any>) => Promise<void>;
type FailCallback = (queue: string, rawMessage: string) => Promise<void>;

interface ConsumeOptions {
  prefetch?: number;
  isolatedChannel?: boolean;
  /** Wait before a failed message is retried (see the header). Off by default. */
  retryBackoff?: boolean;
}

/** Delay before retry `attempt` (1-based): base doubling per attempt, ±25 % jitter, capped. */
export function rabbitRetryDelayMs(
  attempt: number,
  baseMs: number = env.RABBITMQ_RETRY_BASE_DELAY_MS,
  maxMs: number = env.RABBITMQ_RETRY_MAX_DELAY_MS,
  random: () => number = Math.random,
): number {
  if (baseMs <= 0 || maxMs <= 0) return 0;
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(0, attempt - 1), 16));
  return Math.min(maxMs, Math.round(ceiling * (0.75 + random() * 0.5)));
}

/** Resolves after `ms`, or at once when the process starts shutting down. */
function waitUnlessShuttingDown(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let unsubscribe: () => void = () => undefined;
    const timer = setTimeout(finish, ms);
    unsubscribe = onShutdownStart(finish);
    function finish() {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    }
  });
}

type ConsumerChannel = Pick<ConfirmChannel, 'ack' | 'nack' | 'sendToQueue'>;

export interface MessageHandlerDeps {
  channel: ConsumerChannel;
  queue: string;
  callback: ConsumeCallback;
  onFail?: FailCallback;
  retryBackoff?: boolean;
  /** Injected in tests. */
  wait?: (ms: number) => Promise<void>;
  retryDelayMs?: (attempt: number) => number;
}

/** The per-message handler of consume(); exported for tests. */
export function createMessageHandler(deps: MessageHandlerDeps): (msg: ConsumeMessage | null) => Promise<void> {
  const { channel, queue, callback, onFail } = deps;
  const wait = deps.wait ?? waitUnlessShuttingDown;
  const retryDelayMs = deps.retryDelayMs ?? ((attempt: number) => rabbitRetryDelayMs(attempt));

  return async function onMessage(msg) {
    if (!msg) return;

    const rawContent = msg.content.toString();
    let data: Record<string, any>;

    try {
      data = JSON.parse(rawContent);
    } catch {
      console.error(`[Consumer:${queue}] Invalid JSON, discarding:`, rawContent.substring(0, 200));
      channel.ack(msg);
      return;
    }

    const retryCount: number = (msg.properties.headers?.['x-retries'] as number) ?? 0;

    try {
      await callback(data);
      channel.ack(msg); // ✅ Success
    } catch (err: any) {
      console.error(`[Consumer:${queue}] Error (attempt ${retryCount + 1}/${MAX_RETRIES + 1}):`, err.message);

      if (retryCount < MAX_RETRIES) {
        if (deps.retryBackoff) await wait(retryDelayMs(retryCount + 1));
        // Re-publish with a broker confirm before acknowledging the old
        // message. Otherwise a process/channel crash can silently lose it.
        try {
          await new Promise<void>((resolve, reject) => {
            channel.sendToQueue(queue, msg.content, {
              persistent: true,
              headers: { 'x-retries': retryCount + 1 },
            }, (publishError) => {
              if (publishError) reject(publishError);
              else resolve();
            });
          });
          channel.ack(msg);
        } catch (publishError: any) {
          console.error(`[Consumer:${queue}] Retry publish was not confirmed:`, publishError?.message || String(publishError));
          await wait(retryDelayMs(1));
          channel.nack(msg, false, true);
        }
      } else {
        // ❌ Max retries reached → call onFail and discard
        console.error(`[Consumer:${queue}] Max retries reached, discarding message`);
        try {
          await onFail?.(queue, rawContent);
        } catch (failErr: any) {
          console.error(`[Consumer:${queue}] onFail error:`, failErr.message);
        }
        channel.ack(msg);
      }
    }
  };
}

/**
 * Start consuming messages from a durable queue.
 *
 * @param queue - Queue name
 * @param callback - Async handler for each message
 * @param onFail - Optional handler when max retries exceeded (e.g. mark document as error)
 */
export async function consume(
  queue: string,
  callback: ConsumeCallback,
  onFail?: FailCallback,
  options: ConsumeOptions = {},
): Promise<void> {
  const channel = options.isolatedChannel === false ? getChannel() : await createRabbitChannel();
  const prefetch = Math.max(1, options.prefetch ?? 1);
  await channel.prefetch(prefetch);

  const { consumerTag } = await channel.consume(queue, createMessageHandler({
    channel,
    queue,
    callback,
    onFail,
    retryBackoff: options.retryBackoff === true,
  }));

  activeConsumers.push({ queue, channel, consumerTag });
  console.log(`[RabbitMQ] Consumer started on queue: ${queue} prefetch=${prefetch}${options.retryBackoff ? ' retry_backoff=on' : ''}`);
}

/**
 * Shutdown: RabbitMQ stops delivering new messages to this process. A
 * message being handled finishes, or is delivered again once the connection
 * closes unacknowledged (the handlers are idempotent).
 */
export async function cancelConsumers(): Promise<void> {
  const current = activeConsumers.splice(0);
  await Promise.all(current.map(async ({ queue, channel, consumerTag }) => {
    try {
      await channel.cancel(consumerTag);
    } catch (error) {
      console.warn(`[RabbitMQ] Could not cancel the consumer on ${queue}:`, error instanceof Error ? error.message : String(error));
    }
  }));
}
