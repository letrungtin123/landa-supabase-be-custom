// ═══════════════════════════════════════════════════════════════
// RabbitMQ Consumer — Consume messages with retry logic
// prefetch(1): process 1 message at a time
// Retry up to 3 times via x-retries header
// ═══════════════════════════════════════════════════════════════

import type { ConfirmChannel } from 'amqplib';
import { createRabbitChannel, getChannel } from './connection.js';

const MAX_RETRIES = 3;

/** Consumers started by this process, so a shutdown can stop new deliveries. */
const activeConsumers: Array<{ queue: string; channel: ConfirmChannel; consumerTag: string }> = [];

type ConsumeCallback = (data: Record<string, any>) => Promise<void>;
type FailCallback = (queue: string, rawMessage: string) => Promise<void>;

interface ConsumeOptions {
  prefetch?: number;
  isolatedChannel?: boolean;
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

  const { consumerTag } = await channel.consume(queue, async function onMessage(msg) {
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
  });

  activeConsumers.push({ queue, channel, consumerTag });
  console.log(`[RabbitMQ] Consumer started on queue: ${queue} prefetch=${prefetch}`);
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
