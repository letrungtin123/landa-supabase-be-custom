import { withDatabaseTransaction } from '../../config/database.js';
import {
  createRagLessonAuthorSourceSnapshotV2,
  generateRagLessonAuthorChapterShardV2,
  generateRagLessonAuthorCourseSkeletonV2,
  generateRagLessonAuthorUnitV2,
} from './ai-rag-client.service.js';
import { normalizeLessonAuthorProposal } from './chat.service.js';
import type { GenerationJobDatabase, GenerationJobSql } from './lesson-author-generation-job.repository.js';
import { orchestrationV2QuotaAccounting } from './lesson-author-orchestration-v2-accounting.service.js';
import { createOrchestrationV2ChapterRepository } from './lesson-author-orchestration-v2-chapter.repository.js';
import { runOrchestrationV2ChapterValidation } from './lesson-author-orchestration-v2-chapter.service.js';
import { loadOrchestrationV2ExecutionRuntime } from './lesson-author-orchestration-v2-execution.config.js';
import { createOrchestrationV2FinalizationRepository } from './lesson-author-orchestration-v2-finalization.repository.js';
import { runOrchestrationV2Finalization } from './lesson-author-orchestration-v2-finalization.service.js';
import { createOrchestrationV2InventoryRepository } from './lesson-author-orchestration-v2-inventory.repository.js';
import { executeOrchestrationV2InventoryTask } from './lesson-author-orchestration-v2-inventory.service.js';
import { createOrchestrationV2PlanningRepository } from './lesson-author-orchestration-v2-planning.repository.js';
import { executeOrchestrationV2PlanningTask } from './lesson-author-orchestration-v2-planning.service.js';
import type { OrchestrationV2RuntimeConfig } from './lesson-author-orchestration-v2-runtime.config.js';
import { createOrchestrationV2UnitRepository } from './lesson-author-orchestration-v2-unit.repository.js';
import { executeOrchestrationV2UnitTask } from './lesson-author-orchestration-v2-unit.service.js';
import type { OrchestrationV2WorkerRuntimeDependencies } from './lesson-author-orchestration-v2-worker.service.js';
import { createOrchestrationV2WorkerRepository } from './lesson-author-orchestration-v2-worker.repository.js';

export const orchestrationV2Database: GenerationJobDatabase = {
  transaction: work => withDatabaseTransaction(client => work(client as unknown as GenerationJobSql)),
};

export function orchestrationV2RuntimeReporter(event: Record<string, unknown>): void {
  console.log('[LessonAuthorOrchestrationV2]', JSON.stringify(event));
}

/**
 * Compose every already-claimed task kind. This function has no startup side
 * effect; the dedicated entry point is the only caller allowed to consume.
 */
export function createOrchestrationV2WorkerRuntimeDependencies(
  config: OrchestrationV2RuntimeConfig,
  db: GenerationJobDatabase = orchestrationV2Database,
  report: OrchestrationV2WorkerRuntimeDependencies['report'] = orchestrationV2RuntimeReporter,
): OrchestrationV2WorkerRuntimeDependencies {
  const worker = createOrchestrationV2WorkerRepository(db);
  const planning = createOrchestrationV2PlanningRepository(db, worker);
  const inventory = createOrchestrationV2InventoryRepository(db, worker);
  const unit = createOrchestrationV2UnitRepository(db, worker);
  const chapter = createOrchestrationV2ChapterRepository(db, worker);
  const finalization = createOrchestrationV2FinalizationRepository(db, worker);

  return {
    repository: worker,
    limits: config.worker,
    reserveProvider: orchestrationV2QuotaAccounting.reserveProvider,
    releaseUndispatched: orchestrationV2QuotaAccounting.releaseUndispatched,
    releaseRejected: orchestrationV2QuotaAccounting.releaseRejected,
    holdUnknown: orchestrationV2QuotaAccounting.holdUnknown,
    reconcileUnknown: orchestrationV2QuotaAccounting.reconcileUnknownAsBudget,
    report,
    async execute(lease, signal) {
      const runtime = await loadOrchestrationV2ExecutionRuntime(lease);
      if (['source_snapshot', 'course_skeleton', 'chapter_blueprint', 'validate_architecture'].includes(lease.kind)) {
        return executeOrchestrationV2PlanningTask(lease, planning, worker, {
          source: createRagLessonAuthorSourceSnapshotV2,
          skeleton: generateRagLessonAuthorCourseSkeletonV2,
          chapter: generateRagLessonAuthorChapterShardV2,
        }, {
          embedding_model: runtime.settings.embeddingModel,
          embedding_dimensions: runtime.settings.embeddingDimensions,
          budgets: runtime.planning_budgets,
          pipeline: runtime.pipeline,
          allowed_component_types: runtime.allowed_component_types,
        }, orchestrationV2QuotaAccounting.settleProvider, signal);
      }
      if (lease.kind === 'publish_inventory') {
        return executeOrchestrationV2InventoryTask(lease, inventory, runtime.inventory_budgets);
      }
      if (lease.kind === 'generate_unit') {
        return executeOrchestrationV2UnitTask(lease, unit, worker, { generate: generateRagLessonAuthorUnitV2 }, {
          embedding_model: runtime.settings.embeddingModel,
          embedding_dimensions: runtime.settings.embeddingDimensions,
          allowed_component_types: runtime.allowed_component_types,
          unit_soft_deadline_ms: config.unit_soft_deadline_ms,
          pipeline: runtime.pipeline,
          idm_unit_soft_deadline_ms: config.idm_unit_soft_deadline_ms,
        }, normalizeLessonAuthorProposal, orchestrationV2QuotaAccounting.settleProvider,
        orchestrationV2QuotaAccounting.releaseUndispatched, signal);
      }
      if (lease.kind === 'validate_chapter') return runOrchestrationV2ChapterValidation(lease, chapter);
      if (lease.kind === 'finalize_course') return runOrchestrationV2Finalization(lease, finalization);
      throw new Error('ORCHESTRATION_V2_TASK_KIND_UNSUPPORTED');
    },
  };
}
