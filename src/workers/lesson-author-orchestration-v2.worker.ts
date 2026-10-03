import { pool, query } from '../config/database.js';
import { env } from '../config/env.js';
import {
  assertQueue,
  closeRabbitMQ,
  connectRabbitMQ,
  createRabbitChannel,
  getChannel,
} from '../config/rabbitmq/index.js';
import { createOrchestrationV2OutboxRepository } from '../modules/ai-chatbot/lesson-author-orchestration-v2-outbox.repository.js';
import { assertOrchestrationV2ProductionProcessFence } from '../modules/ai-chatbot/lesson-author-orchestration-v2-process-fence.js';
import {
  runOrchestrationV2DispatcherLoop,
  runOrchestrationV2WorkerRecoveryLoop,
  startOrchestrationV2RabbitConsumer,
  type OrchestrationV2RabbitConsumer,
} from '../modules/ai-chatbot/lesson-author-orchestration-v2-rabbit.service.js';
import { readOrchestrationV2RuntimeConfig } from '../modules/ai-chatbot/lesson-author-orchestration-v2-runtime.config.js';
import {
  createOrchestrationV2WorkerRuntimeDependencies,
  orchestrationV2Database,
  orchestrationV2RuntimeReporter,
} from '../modules/ai-chatbot/lesson-author-orchestration-v2-runtime.service.js';
import { verifyOrchestrationV2Schema } from '../modules/ai-chatbot/lesson-author-orchestration-v2-schema.repository.js';

const shutdown = new AbortController();
let consumer: OrchestrationV2RabbitConsumer | null = null;

function reportLifecycle(event: 'runtime_ready' | 'runtime_draining' | 'runtime_stopped', metadata: Record<string, unknown> = {}): void {
  orchestrationV2RuntimeReporter({ event, pid: process.pid, ...metadata });
}

/** PM2 wait_ready is an operator-visible startup fence. It is emitted only
 * after schema verification, Rabbit connection and role-specific setup pass. */
function signalReady(role: 'dispatcher' | 'worker', queue: string): void {
  reportLifecycle('runtime_ready', { role, queue });
  if (typeof process.send === 'function') process.send('ready');
}

function requestShutdown(signal: string): void {
  if (shutdown.signal.aborted) return;
  console.log(`[LessonAuthorOrchestrationV2] ${signal} received; draining current work...`);
  reportLifecycle('runtime_draining', { signal });
  shutdown.abort(new Error(signal));
}

async function waitForShutdown(): Promise<void> {
  if (shutdown.signal.aborted) return;
  await new Promise<void>(resolve => shutdown.signal.addEventListener('abort', () => resolve(), { once: true }));
}

async function bootstrap(): Promise<void> {
  assertOrchestrationV2ProductionProcessFence({ node_env: env.NODE_ENV });
  const config = readOrchestrationV2RuntimeConfig();
  if (!config.enabled || config.role === 'disabled') {
    console.log('[LessonAuthorOrchestrationV2] Disabled; no queue or database runtime was started.');
    return;
  }
  const schema = await verifyOrchestrationV2Schema({ query });
  orchestrationV2RuntimeReporter({ event: 'schema_verified', ...schema, role: config.role });
  await connectRabbitMQ(env.RABBITMQ_URL);
  await assertQueue(config.queue);

  if (config.role === 'dispatcher') {
    const repository = createOrchestrationV2OutboxRepository(orchestrationV2Database);
    signalReady('dispatcher', config.queue);
    await runOrchestrationV2DispatcherLoop({
      repository,
      channel: getChannel(),
      config: { queue: config.queue, dispatch_batch_size: config.dispatch_batch_size,
        recovery_batch_size: config.recovery_batch_size, outbox: config.outbox },
      poll_interval_ms: config.poll_interval_ms,
      signal: shutdown.signal,
      report: orchestrationV2RuntimeReporter,
    });
    return;
  }

  const deps = createOrchestrationV2WorkerRuntimeDependencies(config);
  const channel = await createRabbitChannel();
  consumer = await startOrchestrationV2RabbitConsumer(channel, config.queue,
    Math.min(config.worker.global_concurrency_limit, 1_024), config.poll_interval_ms, deps, shutdown.signal);
  orchestrationV2RuntimeReporter({ event: 'worker_ready', queue: config.queue,
    prefetch: Math.min(config.worker.global_concurrency_limit, 1_024) });
  const recovery = runOrchestrationV2WorkerRecoveryLoop({ deps,
    batch_size: config.worker.recovery_batch_size, poll_interval_ms: config.poll_interval_ms,
    signal: shutdown.signal });
  signalReady('worker', config.queue);
  await Promise.race([waitForShutdown(), recovery]);
  await consumer.stop();
  await recovery;
}

process.once('SIGINT', () => requestShutdown('SIGINT'));
process.once('SIGTERM', () => requestShutdown('SIGTERM'));

bootstrap().then(async () => {
  await consumer?.stop();
  await closeRabbitMQ();
  await pool.end();
  reportLifecycle('runtime_stopped');
}).catch(async error => {
  console.error('[LessonAuthorOrchestrationV2] Fatal error:', error);
  requestShutdown('FATAL');
  await consumer?.stop().catch(() => undefined);
  await closeRabbitMQ();
  await pool.end();
  process.exit(1);
});
