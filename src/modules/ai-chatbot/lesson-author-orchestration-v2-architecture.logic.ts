import { Buffer } from 'node:buffer';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import type {
  OrchestrationV2ChapterShard,
  OrchestrationV2CourseSkeleton,
  OrchestrationV2LessonArchitecture,
  OrchestrationV2SourceScope,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';
import { readIdmAssemblyExtension, type IdmAssemblyExtensionV1 } from './lesson-author-idm.contract.js';

export interface OrchestrationV2ChapterShardArtifact {
  artifact_hash: string;
  shard: OrchestrationV2ChapterShard;
}

export interface OrchestrationV2ArchitectureChapter {
  chapter_key: string;
  order: number;
  title: string;
  objective: string;
  learning_outcomes?: string[];
  source_scope_ids: string[];
  lessons: OrchestrationV2LessonArchitecture[];
}

export interface OrchestrationV2ArchitectureAssessmentObligation {
  planned_slot_key: string;
  unit_path: string;
  planned_component_index: number;
  learning_objective_refs: string[];
  required_assessment_kind: 'single_choice';
  relevant_scope_ids: string[];
  relevant_evidence_fact_ids: string[];
  unresolved_reason: 'ASSESSMENT_SOURCE_CHECK_REQUIRED';
  status: 'open';
}

export interface OrchestrationV2ArchitectureAssembly {
  contract_version: 2;
  source_snapshot_hash: string;
  skeleton_hash: string;
  shard_hashes: string[];
  admitted_fact_count: number;
  allocated_fact_count: number;
  duplicate_scope_count: 0;
  unresolved_scope_count: 0;
  chapter_count: number;
  lesson_count: number;
  unit_count: number;
  component_plan_count: number;
  assessment_obligation_count?: number;
  assessment_obligation_hash?: string;
  assessment_obligations?: OrchestrationV2ArchitectureAssessmentObligation[];
  architecture: {
    locale: 'vi' | 'en';
    title: string;
    summary: string;
    target_audience: string;
    prerequisites: string[];
    learning_outcomes: string[];
    assessment_strategy: string;
    assumptions: string[];
    chapters: OrchestrationV2ArchitectureChapter[];
  };
  /** IDM runs only (spec §12.3); legacy assemblies never carry the key. */
  idm?: IdmAssemblyExtensionV1;
  assembly_hash: string;
}

export class OrchestrationV2ArchitectureError extends Error {
  constructor(readonly code: 'ORCHESTRATION_V2_ARCHITECTURE_INVALID' | 'ORCHESTRATION_V2_ARCHITECTURE_TOO_LARGE') {
    super(code);
    this.name = 'OrchestrationV2ArchitectureError';
  }
}

const HASH = /^[0-9a-f]{64}$/;
const MAX_CHAPTERS = 512;
const MAX_SHARDS = 4_096;
const MAX_UNITS = 32_768;
const MAX_COMPONENT_PLANS = 98_304;
const MAX_ASSEMBLY_BYTES = 16 * 1024 * 1024;
const fail = (code: OrchestrationV2ArchitectureError['code']): never => {
  throw new OrchestrationV2ArchitectureError(code);
};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function readOrchestrationV2ArchitectureAssembly(value: unknown): OrchestrationV2ArchitectureAssembly {
  const candidateItem = record(value);
  if (!candidateItem) throw new OrchestrationV2ArchitectureError('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
  const item: Record<string, unknown> = candidateItem;
  const candidateArchitecture = record(item.architecture);
  if (!candidateArchitecture) throw new OrchestrationV2ArchitectureError('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
  const architecture: Record<string, unknown> = candidateArchitecture;
  if (item.contract_version !== 2 || !HASH.test(String(item.source_snapshot_hash))
    || !HASH.test(String(item.skeleton_hash)) || !HASH.test(String(item.assembly_hash))
    || !Array.isArray(item.shard_hashes) || item.shard_hashes.length < 1 || item.shard_hashes.length > MAX_SHARDS
    || item.shard_hashes.some(hash => typeof hash !== 'string' || !HASH.test(hash))
    || !Array.isArray(architecture.chapters) || architecture.chapters.length < 1
    || architecture.chapters.length > MAX_CHAPTERS) fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
  for (const field of ['admitted_fact_count', 'allocated_fact_count', 'chapter_count', 'lesson_count',
    'unit_count', 'component_plan_count'] as const) {
    const candidate = item[field];
    if (!Number.isSafeInteger(candidate) || Number(candidate) < 1) fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
  }
  const obligationFields = [item.assessment_obligation_count, item.assessment_obligation_hash,
    item.assessment_obligations];
  const hasObligations = obligationFields.some(value => value !== undefined);
  if (hasObligations) {
    if (!Number.isSafeInteger(item.assessment_obligation_count) || Number(item.assessment_obligation_count) < 0
      || Number(item.assessment_obligation_count) > MAX_COMPONENT_PLANS
      || !HASH.test(String(item.assessment_obligation_hash)) || !Array.isArray(item.assessment_obligations)
      || item.assessment_obligation_count !== item.assessment_obligations.length
      || orchestrationV2Hash(item.assessment_obligations) !== item.assessment_obligation_hash) {
      fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
    }
    const obligations = item.assessment_obligations as unknown[];
    const slotKeys = new Set<string>();
    for (const valueObligation of obligations) {
      const obligation = record(valueObligation);
      const keys = obligation ? Object.keys(obligation).sort() : [];
      const expectedKeys = ['learning_objective_refs', 'planned_component_index', 'planned_slot_key',
        'relevant_evidence_fact_ids', 'relevant_scope_ids', 'required_assessment_kind', 'status',
        'unit_path', 'unresolved_reason'].sort();
      if (!obligation || keys.length !== expectedKeys.length
        || keys.some((key, index) => key !== expectedKeys[index])
        || typeof obligation.planned_slot_key !== 'string'
        || !/^ao2_[a-f0-9]{32}$/.test(obligation.planned_slot_key)
        || slotKeys.has(obligation.planned_slot_key)
        || typeof obligation.unit_path !== 'string'
        || !/^chapter_[1-9][0-9]*\.lesson_[1-9][0-9]*\.unit_[1-9][0-9]*$/.test(obligation.unit_path)
        || !Number.isSafeInteger(obligation.planned_component_index)
        || Number(obligation.planned_component_index) < 1 || Number(obligation.planned_component_index) > 3
        || obligation.required_assessment_kind !== 'single_choice'
        || obligation.unresolved_reason !== 'ASSESSMENT_SOURCE_CHECK_REQUIRED' || obligation.status !== 'open'
        || !Array.isArray(obligation.learning_objective_refs) || !obligation.learning_objective_refs.length
        || obligation.learning_objective_refs.some(ref => typeof ref !== 'string' || !/^lo_[1-9][0-9]*$/.test(ref))
        || !Array.isArray(obligation.relevant_scope_ids) || !obligation.relevant_scope_ids.length
        || obligation.relevant_scope_ids.some(scope => typeof scope !== 'string' || !scope.length || scope.length > 255)
        || !Array.isArray(obligation.relevant_evidence_fact_ids) || !obligation.relevant_evidence_fact_ids.length
        || obligation.relevant_evidence_fact_ids.some(fact => typeof fact !== 'string' || !fact.length || fact.length > 255)) {
        fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
      }
      slotKeys.add(String(obligation!.planned_slot_key));
    }
  }
  const chapters = architecture.chapters as unknown[];
  if (item.duplicate_scope_count !== 0 || item.unresolved_scope_count !== 0
    || item.admitted_fact_count !== item.allocated_fact_count
    || item.chapter_count !== chapters.length || bytes(value) > MAX_ASSEMBLY_BYTES) {
    fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
  }
  if (item.idm !== undefined) readIdmArchitectureExtension(item, chapters);
  const { assembly_hash: claimed, ...base } = item;
  if (orchestrationV2Hash(base) !== claimed) fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
  return item as unknown as OrchestrationV2ArchitectureAssembly;
}

function readIdmArchitectureExtension(item: Record<string, unknown>, chapters: unknown[]): void {
  try {
    const keys = chapters.map(chapter => String(record(chapter)?.chapter_key ?? ''));
    const idm = readIdmAssemblyExtension(item.idm, keys);
    const counts = idm.disposition_counts;
    if (item.admitted_fact_count !== counts.course + counts.reference_job_aid
      || chapters.some((chapter, index) => {
        const lessons = record(chapter)?.lessons;
        return !Array.isArray(lessons)
          || lessons.length !== idm.chapters[keys[index]!]!.reduce((sum, shard) => sum + shard.lessons.length, 0);
      })) fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
  } catch {
    fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
  }
}

/**
 * Assemble already contract-validated chapter shards into one immutable course
 * architecture. This is deterministic and deliberately performs no provider,
 * database, queue, or identifier-allocation work.
 */
export function assembleOrchestrationV2Architecture(
  skeleton: OrchestrationV2CourseSkeleton,
  scopes: readonly OrchestrationV2SourceScope[],
  shardArtifacts: readonly OrchestrationV2ChapterShardArtifact[],
): Readonly<OrchestrationV2ArchitectureAssembly> {
  if (!skeleton || skeleton.contract_version !== 2 || !HASH.test(skeleton.source_snapshot_hash)
    || !Array.isArray(skeleton.chapters) || skeleton.chapters.length < 1
    || skeleton.chapters.length > MAX_CHAPTERS || !Array.isArray(scopes) || scopes.length < 1
    || scopes.length > 4_096 || !Array.isArray(shardArtifacts) || shardArtifacts.length < 1
    || shardArtifacts.length > MAX_SHARDS) fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');

  const scopeByKey = new Map(scopes.map(scope => [scope.scope_key, scope]));
  if (scopeByKey.size !== scopes.length || scopes.some(scope => !Number.isSafeInteger(scope.fact_count)
    || scope.fact_count < 1)) fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
  const skeletonScopes = skeleton.chapters.flatMap(chapter => chapter.source_scope_ids);
  if (skeletonScopes.length !== scopes.length || new Set(skeletonScopes).size !== scopes.length
    || skeletonScopes.some(scope => !scopeByKey.has(scope))) fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');

  const artifactHashes = new Set<string>();
  const byChapter = new Map<string, OrchestrationV2ChapterShardArtifact[]>();
  for (const artifact of shardArtifacts) {
    if (!HASH.test(artifact.artifact_hash) || artifactHashes.has(artifact.artifact_hash)
      || artifact.shard.contract_version !== 2
      || artifact.shard.source_snapshot_hash !== skeleton.source_snapshot_hash) {
      fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
    }
    artifactHashes.add(artifact.artifact_hash);
    const list = byChapter.get(artifact.shard.chapter_key) ?? [];
    list.push(artifact);
    byChapter.set(artifact.shard.chapter_key, list);
  }
  if (byChapter.size !== skeleton.chapters.length
    || [...byChapter.keys()].some(key => !skeleton.chapters.some(chapter => chapter.chapter_key === key))) {
    fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
  }

  const allocatedScopes: string[] = [];
  const shardHashes: string[] = [];
  const chapters: OrchestrationV2ArchitectureChapter[] = [];
  let lessonCount = 0, unitCount = 0, componentPlanCount = 0;
  const assessmentObligations: OrchestrationV2ArchitectureAssessmentObligation[] = [];
  for (const expected of [...skeleton.chapters].sort((a, b) => a.order - b.order)) {
    const artifacts = [...(byChapter.get(expected.chapter_key) ?? [])]
      .sort((a, b) => a.shard.shard_index - b.shard.shard_index);
    const shardCount = artifacts[0]?.shard.shard_count;
    if (!Number.isSafeInteger(shardCount) || shardCount !== artifacts.length
      || artifacts.some((artifact, index) => artifact.shard.shard_index !== index
        || artifact.shard.shard_count !== shardCount || artifact.shard.order !== expected.order
        || artifact.shard.title !== expected.title || artifact.shard.objective !== expected.objective)) {
      fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
    }
    const chapterScopes = artifacts.flatMap(artifact => artifact.shard.source_scope_ids);
    if (chapterScopes.length !== expected.source_scope_ids.length
      || chapterScopes.some((scope, index) => scope !== expected.source_scope_ids[index])) {
      fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
    }
    const lessons = artifacts.flatMap(artifact => artifact.shard.lessons);
    const unitScopes = lessons.flatMap(lesson => lesson.units.flatMap(unit => unit.source_scope_ids));
    if (unitScopes.length !== chapterScopes.length || new Set(unitScopes).size !== unitScopes.length
      || unitScopes.some(scope => !chapterScopes.includes(scope))) fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
    let chapterLessonOffset = 0;
    for (const artifact of artifacts) {
      for (const obligation of artifact.shard.assessment_obligations ?? []) {
        const lesson = artifact.shard.lessons[obligation.lesson_index - 1];
        const unit = lesson?.units[obligation.unit_index - 1];
        if (!unit || obligation.relevant_scope_ids.some(scope => !unit.source_scope_ids.includes(scope))
          || obligation.learning_objective_refs.some(ref => !unit.learning_objective_refs.includes(ref))) {
          fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
        }
        assessmentObligations.push({ planned_slot_key: obligation.planned_slot_key,
          unit_path: `chapter_${chapters.length + 1}.lesson_${chapterLessonOffset + obligation.lesson_index}.unit_${obligation.unit_index}`,
          planned_component_index: obligation.component_index,
          learning_objective_refs: [...obligation.learning_objective_refs],
          required_assessment_kind: obligation.required_assessment_kind,
          relevant_scope_ids: [...obligation.relevant_scope_ids],
          relevant_evidence_fact_ids: [...obligation.relevant_evidence_fact_ids],
          unresolved_reason: obligation.unresolved_reason, status: obligation.status });
      }
      chapterLessonOffset += artifact.shard.lessons.length;
    }
    allocatedScopes.push(...unitScopes);
    shardHashes.push(...artifacts.map(artifact => artifact.artifact_hash));
    lessonCount += lessons.length;
    unitCount += lessons.reduce((sum, lesson) => sum + lesson.units.length, 0);
    componentPlanCount += lessons.reduce((sum, lesson) => sum
      + lesson.units.reduce((unitSum, unit) => unitSum + unit.component_plan.length, 0), 0);
    chapters.push({ chapter_key: expected.chapter_key, order: expected.order, title: expected.title,
      objective: expected.objective, learning_outcomes: [...(expected.learning_outcomes ?? [])],
      source_scope_ids: [...expected.source_scope_ids], lessons });
  }
  if (allocatedScopes.length !== scopes.length || new Set(allocatedScopes).size !== scopes.length
    || allocatedScopes.some(scope => !scopeByKey.has(scope))) fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
  if (unitCount < 1 || unitCount > MAX_UNITS || componentPlanCount < unitCount
    || componentPlanCount > MAX_COMPONENT_PLANS) fail('ORCHESTRATION_V2_ARCHITECTURE_TOO_LARGE');

  const admittedFactCount = scopes.reduce((sum, scope) => sum + scope.fact_count, 0);
  if (!Number.isSafeInteger(admittedFactCount) || admittedFactCount < 1 || admittedFactCount > 10_000_000) {
    fail('ORCHESTRATION_V2_ARCHITECTURE_TOO_LARGE');
  }
  if (new Set(assessmentObligations.map(item => item.planned_slot_key)).size !== assessmentObligations.length) {
    fail('ORCHESTRATION_V2_ARCHITECTURE_INVALID');
  }
  assessmentObligations.sort((left, right) => left.planned_slot_key.localeCompare(right.planned_slot_key));
  const architecture = {
    locale: skeleton.locale, title: skeleton.title, summary: skeleton.summary,
    target_audience: skeleton.target_audience, prerequisites: [...skeleton.prerequisites],
    learning_outcomes: [...skeleton.learning_outcomes], assessment_strategy: skeleton.assessment_strategy,
    assumptions: [...skeleton.assumptions], chapters,
  };
  const assessmentObligationHash = orchestrationV2Hash(assessmentObligations);
  const base = { contract_version: 2 as const, source_snapshot_hash: skeleton.source_snapshot_hash,
    skeleton_hash: orchestrationV2Hash(skeleton), shard_hashes: shardHashes,
    admitted_fact_count: admittedFactCount, allocated_fact_count: admittedFactCount,
    duplicate_scope_count: 0 as const, unresolved_scope_count: 0 as const,
    chapter_count: chapters.length, lesson_count: lessonCount, unit_count: unitCount,
    component_plan_count: componentPlanCount, assessment_obligation_count: assessmentObligations.length,
    assessment_obligation_hash: assessmentObligationHash, assessment_obligations: assessmentObligations, architecture };
  if (Buffer.byteLength(JSON.stringify(base), 'utf8') > MAX_ASSEMBLY_BYTES) {
    fail('ORCHESTRATION_V2_ARCHITECTURE_TOO_LARGE');
  }
  return Object.freeze({ ...base, assembly_hash: orchestrationV2Hash(base) });
}
