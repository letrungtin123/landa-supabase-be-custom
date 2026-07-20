import { pool } from '../config/database.js';
import { env } from '../config/env.js';
import { assertQueue, closeRabbitMQ, connectRabbitMQ, QUEUES } from '../config/rabbitmq/index.js';
import { closeRedis, connectRedis } from '../config/redis.js';
import {
  startEmailOutboxRabbitConsumer,
  startEmailOutboxWorker,
  stopEmailOutboxWorker,
  triggerEmailOutboxWorker,
} from '../modules/assignments/email-outbox.service.js';

async function bootstrap(): Promise<void> {
  await connectRedis();
  await connectRabbitMQ(env.RABBITMQ_URL);
  await assertQueue(QUEUES.EMAIL_OUTBOX);
  startEmailOutboxWorker({ keepAlive: true, source: 'dedicated' });
  await startEmailOutboxRabbitConsumer();
  triggerEmailOutboxWorker('dedicated-startup');
  console.log(`[EmailOutboxWorker] Running environment=${env.NODE_ENV}`);
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[EmailOutboxWorker] ${signal} received, shutting down...`);
  stopEmailOutboxWorker();
  await closeRedis();
  await closeRabbitMQ();
  await pool.end();
  process.exit(0);
}

process.once('SIGINT', () => {
  shutdown('SIGINT').catch((err) => {
    console.error('[EmailOutboxWorker] Shutdown error:', err);
    process.exit(1);
  });
});

process.once('SIGTERM', () => {
  shutdown('SIGTERM').catch((err) => {
    console.error('[EmailOutboxWorker] Shutdown error:', err);
    process.exit(1);
  });
});

bootstrap().catch((err) => {
  console.error('[EmailOutboxWorker] Fatal error:', err);
  process.exit(1);
});
