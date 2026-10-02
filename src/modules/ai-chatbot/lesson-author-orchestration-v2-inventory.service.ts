import {
  prepareOrchestrationV2InventoryPublication,
  type OrchestrationV2InventoryBudgets,
} from './lesson-author-orchestration-v2-inventory.logic.js';
import type { createOrchestrationV2InventoryRepository } from './lesson-author-orchestration-v2-inventory.repository.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';

type InventoryRepository = ReturnType<typeof createOrchestrationV2InventoryRepository>;

/** Execute exactly one claimed deterministic inventory task; no provider or polling. */
export async function executeOrchestrationV2InventoryTask(
  lease: OrchestrationV2TaskLease,
  repository: InventoryRepository,
  budgets: OrchestrationV2InventoryBudgets,
): Promise<'publish_inventory'> {
  const input = await repository.load(lease);
  const publication = prepareOrchestrationV2InventoryPublication({ run_id: lease.run_id,
    assembly: input.assembly, existing_tasks: input.existing_tasks, budgets });
  await repository.complete(lease, publication);
  return 'publish_inventory';
}
