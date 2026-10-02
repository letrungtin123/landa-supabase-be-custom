import type { OrchestrationV2CourseFinalization } from './lesson-author-orchestration-v2-finalization.logic.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';

export interface OrchestrationV2FinalizationRepository {
  load(lease: OrchestrationV2TaskLease): Promise<Readonly<OrchestrationV2CourseFinalization>>;
  complete(lease: OrchestrationV2TaskLease,
    finalization: Readonly<OrchestrationV2CourseFinalization>): Promise<void>;
}

/** Execute exactly one already-claimed deterministic course finalizer. */
export async function runOrchestrationV2Finalization(
  lease: OrchestrationV2TaskLease,
  repository: OrchestrationV2FinalizationRepository,
): Promise<void> {
  const finalization = await repository.load(lease);
  await repository.complete(lease, finalization);
}
