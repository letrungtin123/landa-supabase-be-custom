// ═══════════════════════════════════════════════════════════════
// RabbitMQ Connection — Singleton + auto-reconnect
// CRASH app if cannot connect (mandatory infrastructure)
// ═══════════════════════════════════════════════════════════════

import amqp from 'amqplib';
import type { Channel } from 'amqplib';

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;

const RECONNECT_DELAY = 5_000;  // 5 seconds
const MAX_RECONNECT_ATTEMPTS = 10;

let connection: AmqpConnection | null = null;
let channel: Channel | null = null;
let reconnectAttempts = 0;
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
    reconnectAttempts = 0;
    console.log('[RabbitMQ] Connected successfully');

    // Auto-reconnect on unexpected close
    conn.on('close', function onClose() {
      if (isShuttingDown) return;
      console.error('[RabbitMQ] Connection closed unexpectedly');
      channel = null;
      connection = null;
      scheduleReconnect(url);
    });

    conn.on('error', function onError(err: Error) {
      console.error('[RabbitMQ] Connection error:', err.message);
    });
  } catch (err: any) {
    console.error(`[RabbitMQ] FATAL: Cannot connect: ${err.message}`);
    throw err; // Caller (index.ts) will catch and process.exit(1)
  }
}

function scheduleReconnect(url: string): void {
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error(`[RabbitMQ] FATAL: Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Exiting.`);
    process.exit(1);
  }
  console.log(`[RabbitMQ] Reconnecting in ${RECONNECT_DELAY / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  setTimeout(async () => {
    try {
      await connectRabbitMQ(url);
    } catch {
      // connectRabbitMQ already logs
    }
  }, RECONNECT_DELAY);
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
