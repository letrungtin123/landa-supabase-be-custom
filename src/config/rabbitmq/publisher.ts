// ═══════════════════════════════════════════════════════════════
// RabbitMQ Publisher — Publish persistent messages to queue
// ═══════════════════════════════════════════════════════════════

import { getChannel } from './connection.js';

/**
 * Publish a JSON message to a durable queue.
 * Message is persistent (survives RabbitMQ restart).
 */
export async function publish(queue: string, payload: Record<string, unknown>): Promise<void> {
  const channel = getChannel();
  const buffer = Buffer.from(JSON.stringify(payload));
  await new Promise<void>((resolve, reject) => {
    channel.sendToQueue(queue, buffer, { persistent: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
