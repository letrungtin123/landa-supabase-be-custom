import {
  prepareOrchestrationV2InventoryPublication,
  type OrchestrationV2InventoryBudgets,
} from './lesson-author-orchestration-v2-inventory.logic.js';
import type { createOrchestrationV2InventoryRepository } from './lesson-author-orchestration-v2-inventory.repository.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';
import { withOrchestrationV2TransientRetry } from './lesson-author-orchestration-v2-lock-order.js';

type InventoryRepository = ReturnType<typeof createOrchestrationV2InventoryRepository>;

/** Execute exactly one claimed deterministic inventory task; no provider or polling.
 * Both lease-fenced transactions are re-run with bounded backoff when
 * PostgreSQL rolls them back as deadlock/serialization victims. */
export async function executeOrchestrationV2InventoryTask(
  lease: OrchestrationV2TaskLease,
  repository: InventoryRepository,
  budgets: OrchestrationV2InventoryBudgets,
  signal?: AbortSignal,
): Promise<'publish_inventory'> {
  const input = await withOrchestrationV2TransientRetry(() => repository.load(lease), { signal });
  const publication = prepareOrchestrationV2InventoryPublication({ run_id: lease.run_id,
    assembly: input.assembly, existing_tasks: input.existing_tasks, budgets });
  await withOrchestrationV2TransientRetry(() => repository.complete(lease, publication), { signal });
  return 'publish_inventory';
}
