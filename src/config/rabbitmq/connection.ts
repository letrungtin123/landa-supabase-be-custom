// ═══════════════════════════════════════════════════════════════
// RabbitMQ Connection — Singleton + auto-reconnect
// CRASH app if cannot connect (mandatory infrastructure)
// ═══════════════════════════════════════════════════════════════

import amqp from 'amqplib';
import type { Channel } from 'amqplib';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;

let connection: AmqpConnection | null = null;
let channel: Channel | null = null;
let isShuttingDown = false;

/**
 * Kết nối RabbitMQ — singleton.
 * Gọi 1 lần khi app start. Crash nếu không connect được.
 */
export async function connectRabbitMQ(url: string): Promise<void> {
  try {
    console.log('[RabbitMQ] Connecting...');
    const conn = await amqp.connect(url);
    connection = conn;
    channel = await conn.createChannel();
    console.log('[RabbitMQ] Connected successfully');

    // Crash on unexpected close so the process manager restarts the full
    // bootstrap and re-registers every consumer. Reconnecting only the AMQP
    // socket would leave worker queues without consumers.
    conn.on('close', function onClose() {
      if (isShuttingDown) return;
      console.error('[RabbitMQ] Connection closed unexpectedly');
      channel = null;
      connection = null;
      process.exit(1);
    });

    conn.on('error', function onError(err: Error) {
      console.error('[RabbitMQ] Connection error:', err.message);
    });
  } catch (err: any) {
    console.error(`[RabbitMQ] FATAL: Cannot connect: ${err.message}`);
    throw err; // Caller (index.ts) will catch and process.exit(1)
  }
}

/**
 * Lấy channel hiện tại. Throw nếu chưa connected.
 */
export function getChannel(): Channel {
  if (!channel) {
    throw new Error('[RabbitMQ] Channel not available — not connected');
  }
  return channel;
}

export async function createRabbitChannel(): Promise<Channel> {
  if (!connection) {
    throw new Error('[RabbitMQ] Connection not available - not connected');
  }
  return connection.createChannel();
}

/**
 * Assert (tạo nếu chưa có) một durable queue.
 */
export async function assertQueue(queueName: string): Promise<void> {
  const ch = getChannel();
  await ch.assertQueue(queueName, { durable: true });
}

/**
 * Graceful shutdown — đóng channel + connection.
 */
export async function closeRabbitMQ(): Promise<void> {
  isShuttingDown = true;
  try {
    if (channel) { await channel.close(); channel = null; }
    if (connection) { await connection.close(); connection = null; }
    console.log('[RabbitMQ] Closed gracefully');
  } catch (err: any) {
    console.error('[RabbitMQ] Close error:', err.message);
  }
}
