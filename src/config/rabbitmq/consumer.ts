// ═══════════════════════════════════════════════════════════════
// RabbitMQ Consumer — Consume messages with retry logic
// prefetch(1): process 1 message at a time
// Retry up to 3 times via x-retries header
// ═══════════════════════════════════════════════════════════════

import { getChannel } from './connection.js';

const MAX_RETRIES = 3;

type ConsumeCallback = (data: Record<string, any>) => Promise<void>;
type FailCallback = (queue: string, rawMessage: string) => Promise<void>;

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
): Promise<void> {
  const channel = getChannel();
  await channel.prefetch(1); // Process 1 message at a time

  await channel.consume(queue, async function onMessage(msg) {
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
        // 🔁 Re-publish with incremented retry count
        channel.sendToQueue(queue, msg.content, {
          persistent: true,
          headers: { 'x-retries': retryCount + 1 },
        });
        channel.ack(msg); // ACK the old message
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

  console.log(`[RabbitMQ] Consumer started on queue: ${queue}`);
}
