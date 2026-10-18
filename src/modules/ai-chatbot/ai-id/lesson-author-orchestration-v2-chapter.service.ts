import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';
import type { OrchestrationV2ChapterReceipt } from './lesson-author-orchestration-v2-chapter.logic.js';
import { withOrchestrationV2TransientRetry } from './lesson-author-orchestration-v2-lock-order.js';

export interface OrchestrationV2ChapterRepository {
  load(lease: OrchestrationV2TaskLease): Promise<Readonly<OrchestrationV2ChapterReceipt>>;
  complete(lease: OrchestrationV2TaskLease, receipt: Readonly<OrchestrationV2ChapterReceipt>): Promise<void>;
}

/** Execute exactly one already-claimed deterministic chapter validation task.
 * Load and completion are separate lease-fenced transactions; a deadlock or
 * serialization victim is re-run with bounded backoff instead of failing the task. */
export async function runOrchestrationV2ChapterValidation(
  lease: OrchestrationV2TaskLease,
  repository: OrchestrationV2ChapterRepository,
  signal?: AbortSignal,
): Promise<void> {
  const receipt = await withOrchestrationV2TransientRetry(() => repository.load(lease), { signal });
  await withOrchestrationV2TransientRetry(() => repository.complete(lease, receipt), { signal });
}
