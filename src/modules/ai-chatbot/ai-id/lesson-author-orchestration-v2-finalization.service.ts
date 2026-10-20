import { ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT,
  type OrchestrationV2CourseFinalization } from './lesson-author-orchestration-v2-finalization.logic.js';
import type { OrchestrationV2RunOutcome } from './lesson-author-orchestration-v2-diagnostics.logic.js';
import type { OrchestrationV2TaskLease } from './lesson-author-orchestration-v2-worker.repository.js';
import { withOrchestrationV2TransientRetry } from './lesson-author-orchestration-v2-lock-order.js';

export interface OrchestrationV2FinalizationRepository {
  load(lease: OrchestrationV2TaskLease): Promise<Readonly<OrchestrationV2CourseFinalization>>;
  complete(lease: OrchestrationV2TaskLease,
    finalization: Readonly<OrchestrationV2CourseFinalization>): Promise<void>;
}

/** Execute exactly one already-claimed deterministic course finalizer. Both
 * transactions are lease-fenced and side-effect free outside PostgreSQL, so a
 * deadlock/serialization victim is re-run with bounded backoff. Resolves with
 * the run outcome it committed (a review-required finish is still a completed run). */
export async function runOrchestrationV2Finalization(
  lease: OrchestrationV2TaskLease,
  repository: OrchestrationV2FinalizationRepository,
  signal?: AbortSignal,
): Promise<OrchestrationV2RunOutcome> {
  const finalization = await withOrchestrationV2TransientRetry(() => repository.load(lease), { signal });
  await withOrchestrationV2TransientRetry(() => repository.complete(lease, finalization), { signal });
  return finalization.contract === ORCHESTRATION_V2_COURSE_REVIEW_CONTRACT ? 'completed_with_review' : 'completed';
}
