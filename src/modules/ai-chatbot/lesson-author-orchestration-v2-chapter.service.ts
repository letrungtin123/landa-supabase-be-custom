import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';
import type { OrchestrationV2ChapterReceipt } from './lesson-author-orchestration-v2-chapter.logic.js';

export interface OrchestrationV2ChapterRepository {
  load(lease: OrchestrationV2TaskLease): Promise<Readonly<OrchestrationV2ChapterReceipt>>;
  complete(lease: OrchestrationV2TaskLease, receipt: Readonly<OrchestrationV2ChapterReceipt>): Promise<void>;
}

/** Execute exactly one already-claimed deterministic chapter validation task. */
export async function runOrchestrationV2ChapterValidation(
  lease: OrchestrationV2TaskLease,
  repository: OrchestrationV2ChapterRepository,
): Promise<void> {
  const receipt = await repository.load(lease);
  await repository.complete(lease, receipt);
}
