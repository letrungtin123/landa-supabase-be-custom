// Types and the error of the orchestration V2 planning repository: the planning authority and
// the chapter/architecture execution inputs. Split out of
// lesson-author-orchestration-v2-planning.repository.ts (move only), which re-exports them.

import type { OrchestrationV2ChapterShardArtifact } from '../lesson-author-orchestration-v2-architecture.logic.js';
import { planOrchestrationV2ChapterShards } from '../lesson-author-orchestration-v2-planning.logic.js';
import type {
  OrchestrationV2CourseSkeleton, OrchestrationV2SourceFact, OrchestrationV2SourceScope,
} from '../../contracts/lesson-author-orchestration-v2-rag-contract.logic.js';
import type { IdmCourseDesignV1 } from '../../contracts/lesson-author-idm.contract.js';
import type { IdmScopeView, IdmShardLessons } from '../idm/lesson-author-idm-scope-view.logic.js';

export interface OrchestrationV2PlanningAuthority {
  tenant_id: string;
  kb_id: string;
  conversation_id: string;
  correlation_id: string;
  locale: 'vi' | 'en';
  source_documents: Array<{ document_id: string; kb_id: string; name: string; type: string; status: string }>;
}

export interface OrchestrationV2ChapterExecutionInput {
  skeleton: OrchestrationV2CourseSkeleton;
  shard_plan: NonNullable<ReturnType<typeof planOrchestrationV2ChapterShards>['chapter_tasks'][number]['shard_plan']>;
  source_facts: OrchestrationV2SourceFact[];
  /** IDM runs only: design, the shard's whole lessons and the live task budget (spec §7.6.1). */
  idm?: { design: IdmCourseDesignV1; lessons: IdmShardLessons; input_tokens: number; remaining_ms: number };
}

export interface OrchestrationV2ArchitectureExecutionInput {
  skeleton: OrchestrationV2CourseSkeleton;
  scopes: OrchestrationV2SourceScope[];
  shard_artifacts: OrchestrationV2ChapterShardArtifact[];
  /** IDM runs only: the scope view re-checked against the persisted snapshot. */
  idm_view?: IdmScopeView;
}

export class OrchestrationV2PlanningRepositoryError extends Error {
  constructor(readonly code:
    | 'ORCHESTRATION_V2_PLANNING_AUTHORITY_INVALID'
    | 'ORCHESTRATION_V2_PLANNING_ARTIFACT_INVALID'
    | 'ORCHESTRATION_V2_PLANNING_WRITE_UNCONFIRMED') {
    super(code);
    this.name = 'OrchestrationV2PlanningRepositoryError';
  }
}
