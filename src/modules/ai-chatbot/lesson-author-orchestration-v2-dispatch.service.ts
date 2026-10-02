import { orchestrationV2DispatchEnvelope } from './lesson-author-orchestration-v2-dispatch.logic.js';
import type { OrchestrationV2OutboxConfig, createOrchestrationV2OutboxRepository } from './lesson-author-orchestration-v2-outbox.repository.js';

type OutboxRepository = ReturnType<typeof createOrchestrationV2OutboxRepository>;
type ConfirmedPublisher = (queue: string, payload: Record<string, unknown>) => Promise<void>;

export interface OrchestrationV2DispatcherCycleConfig {
  queue: string;
  dispatch_batch_size: number;
  recovery_batch_size: number;
  outbox: OrchestrationV2OutboxConfig;
}

export interface OrchestrationV2DispatcherCycleResult {
  recovered: number;
  recovery_dead: number;
  published: number;
  retry_scheduled: number;
  publish_dead: number;
}

/** Publish outside the DB transaction; broker confirm precedes the published CAS. */
export async function dispatchOneOrchestrationV2Outbox(
  repository: OutboxRepository,
  config: OrchestrationV2OutboxConfig,
  queue: string,
  publishConfirmed: ConfirmedPublisher,
): Promise<'idle' | 'published' | 'retry_scheduled' | 'dead'> {
  const claim = await repository.claimNext(config);
  if (!claim) return 'idle';
  const envelope = orchestrationV2DispatchEnvelope(claim);
  try {
    await publishConfirmed(queue, envelope);
  } catch {
    const state = await repository.releaseAfterPublishFailure(claim, config);
    return state === 'dead' ? 'dead' : 'retry_scheduled';
  }
  await repository.markPublished(claim);
  return 'published';
}

/** One bounded tick: recovery first, then new dispatch. No internal polling. */
export async function runOrchestrationV2DispatcherCycle(
  repository: OutboxRepository,
  config: OrchestrationV2DispatcherCycleConfig,
  publishConfirmed: ConfirmedPublisher,
): Promise<Readonly<OrchestrationV2DispatcherCycleResult>> {
  if (!config.queue.trim() || !Number.isSafeInteger(config.dispatch_batch_size)
    || config.dispatch_batch_size < 1 || config.dispatch_batch_size > 500
    || !Number.isSafeInteger(config.recovery_batch_size)
    || config.recovery_batch_size < 1 || config.recovery_batch_size > 500) {
    throw new Error('ORCHESTRATION_V2_DISPATCHER_CONFIG_INVALID');
  }
  const result: OrchestrationV2DispatcherCycleResult = {
    recovered: 0, recovery_dead: 0, published: 0, retry_scheduled: 0, publish_dead: 0,
  };
  for (let index = 0; index < config.recovery_batch_size; index += 1) {
    const state = await repository.recoverOne(config.outbox);
    if (!state) break;
    if (state === 'dead') result.recovery_dead += 1;
    else result.recovered += 1;
  }
  for (let index = 0; index < config.dispatch_batch_size; index += 1) {
    const state = await dispatchOneOrchestrationV2Outbox(repository, config.outbox, config.queue, publishConfirmed);
    if (state === 'idle') break;
    if (state === 'published') result.published += 1;
    else if (state === 'dead') result.publish_dead += 1;
    else result.retry_scheduled += 1;
  }
  return Object.freeze(result);
}
