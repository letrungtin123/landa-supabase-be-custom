import { ChapterCheckpointError, assertChapterUnitPayload, type ChapterUnitPayload } from './lesson-author-chapter-checkpoint.logic.js';
import { hasCompleteGenerationUsage } from './lesson-author-generation-job.logic.js';
import type { AiUsage } from './ai-engine.types.js';
import type { RagLessonAuthorRequest, RagRetrievalDiagnostics, RagWorkflowDiagnostics } from './ai-rag-client.service.js';

export type RagChapterCheckpointRequest = RagLessonAuthorRequest & {
  checkpoint_version: 1;
  correlation_id: string;
  remaining_workflow_budget_ms: number;
} & ({ checkpoint_action: 'generate_unit'; checkpoint_unit_index: number; checkpoint_units?: never }
  | { checkpoint_action: 'validate_chapter'; checkpoint_units: Array<{ unit_index: number; unit: ChapterUnitPayload }>; checkpoint_unit_index?: never });

interface CheckpointResponseBase {
  checkpoint_version: 1;
  correlation_id: string;
  usage: Partial<AiUsage>;
  usage_complete: boolean;
  usage_source: 'provider' | 'no_generation' | 'mixed_or_unavailable' | 'local_estimate';
  retrieval: RagRetrievalDiagnostics;
}
export interface RagChapterUnitResponse extends CheckpointResponseBase {
  status: 'unit_ready';
  unit_index: number;
  unit_path: string;
  unit: ChapterUnitPayload;
}
export interface RagChapterFinalResponse extends CheckpointResponseBase {
  status: 'ready';
  proposal: Record<string, unknown>;
  workflow: RagWorkflowDiagnostics;
}
export type RagChapterCheckpointResponse = RagChapterUnitResponse | RagChapterFinalResponse;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(): never { throw new ChapterCheckpointError('CHAPTER_CHECKPOINT_CONTRACT_INVALID'); }

export function assertRagChapterCheckpointRequest(request: RagChapterCheckpointRequest): void {
  if (request.checkpoint_version !== 1 || request.blueprint_architecture?.architecture_contract_version !== 5
    || request.target !== 'lesson_author' || request.operation !== 'create' || request.target_type !== 'chapter'
    || request.generation_mode !== 'staged' || !request.correlation_id || !request.source_documents?.length
    || !Number.isSafeInteger(request.remaining_workflow_budget_ms) || request.remaining_workflow_budget_ms <= 0
    || request.remaining_workflow_budget_ms > 480_000) invalid();
  const units = request.blueprint_architecture!.lessons.flatMap(lesson => lesson.units);
  if (!units.length || units.length > 512) invalid();
  if (request.checkpoint_action === 'generate_unit') {
    if (!Number.isSafeInteger(request.checkpoint_unit_index) || request.checkpoint_unit_index < 0
      || request.checkpoint_unit_index >= units.length || request.checkpoint_units !== undefined) invalid();
  } else if (request.checkpoint_action === 'validate_chapter') {
    if (request.checkpoint_unit_index !== undefined || !Array.isArray(request.checkpoint_units)
      || request.checkpoint_units.length !== units.length) invalid();
    const seen = new Set<number>();
    for (const item of request.checkpoint_units) {
      if (!Number.isSafeInteger(item.unit_index) || item.unit_index < 0 || item.unit_index >= units.length || seen.has(item.unit_index)) invalid();
      assertChapterUnitPayload(item.unit);
      seen.add(item.unit_index);
    }
  } else invalid();
}

/** Envelope/identity only. Existing Node registry/source/pedagogy acceptance still required. */
export function readRagChapterCheckpointResponse(value: unknown, request: RagChapterCheckpointRequest): RagChapterCheckpointResponse {
  assertRagChapterCheckpointRequest(request);
  if (!record(value) || value.checkpoint_version !== 1 || value.correlation_id !== request.correlation_id
    || typeof value.usage_complete !== 'boolean' || !record(value.usage) || !record(value.retrieval)
    || !['provider', 'no_generation', 'mixed_or_unavailable', 'local_estimate'].includes(String(value.usage_source))) invalid();
  if (value.usage_complete && (!hasCompleteGenerationUsage(value.usage)
    || !['provider', 'no_generation'].includes(String(value.usage_source)))) invalid();
  if (value.usage_source === 'no_generation' && (!hasCompleteGenerationUsage(value.usage) || value.usage.totalTokens !== 0)) invalid();
  if (request.checkpoint_action === 'generate_unit') {
    if (value.status !== 'unit_ready' || value.usage_source === 'no_generation' || value.unit_index !== request.checkpoint_unit_index
      || !record(value.unit) || value.proposal !== undefined) invalid();
    let ordinal = 0;
    let expectedPath = '';
    let expectedTitle = '';
    request.blueprint_architecture!.lessons.forEach((lesson, lessonIndex) => lesson.units.forEach((unit, unitIndex) => {
      if (ordinal++ === request.checkpoint_unit_index) {
        expectedPath = `chapter_1.lesson_${lessonIndex + 1}.unit_${unitIndex + 1}`;
        expectedTitle = unit.title;
      }
    }));
    if (value.unit_path !== expectedPath || value.unit.title !== expectedTitle) invalid();
    assertChapterUnitPayload(value.unit as ChapterUnitPayload);
  } else if (value.status !== 'ready' || !record(value.proposal) || !record(value.workflow)
    || value.workflow.status !== 'ready' || value.workflow.workflow !== 'lesson_generation'
    || value.workflow.workflow_version !== 'chapter-checkpoint-1' || value.workflow.repair_count !== 0
    || value.unit !== undefined || value.unit_index !== undefined) invalid();
  return value as unknown as RagChapterCheckpointResponse;
}
