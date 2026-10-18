import { Buffer } from 'node:buffer';
import { orchestrationV2Hash } from './lesson-author-orchestration-v2.logic.js';
import {
  assembleOrchestrationV2Architecture,
  type OrchestrationV2ArchitectureAssembly,
  type OrchestrationV2ChapterShardArtifact,
} from './lesson-author-orchestration-v2-architecture.logic.js';
import type {
  OrchestrationV2ChapterShard,
  OrchestrationV2ChapterShardPlan,
  OrchestrationV2CourseSkeleton,
} from './lesson-author-orchestration-v2-rag-contract.logic.js';
import {
  IDM_EXCLUDED_DISPOSITIONS,
  IdmError,
  idmTextLength,
  readIdmShardDesign,
  type IdmAssemblyExtensionV1,
  type IdmCourseDesignV1,
  type IdmLessonDesignV1,
  type IdmShardDesignV1,
  type IdmUnitDesignV1,
} from './lesson-author-idm.contract.js';
import { idmShardLessonsOf, type IdmScopeView } from './lesson-author-idm-scope-view.logic.js';

const MAX_ASSEMBLY_BYTES = 16 * 1024 * 1024;
const shardInvalid = (): never => { throw new IdmError('IDM_SHARD_DESIGN_INVALID'); };
const sameList = (left: readonly string[], right: readonly string[]) => left.length === right.length
  && left.every((value, index) => value === right[index]);

/**
 * Check `shard.idm_design` against the shard plan and against its own V2
 * projection (spec §8.2): same chapter/shard, exactly the planned lessons and
 * offset, and lesson/unit/component structure that matches the projected
 * `ChapterBlueprintShardV2` one-to-one, so unit briefs can be located by index.
 */
export function assertIdmShardDesign(
  shard: OrchestrationV2ChapterShard & { idm_design?: unknown },
  design: IdmCourseDesignV1,
  plan: Pick<OrchestrationV2ChapterShardPlan, 'chapter_key' | 'order' | 'shard_index' | 'shard_count'
    | 'source_scope_ids' | 'source_fact_count' | 'source_content_chars'>,
): IdmShardDesignV1 {
  let shardDesign: IdmShardDesignV1;
  let lessons: ReturnType<typeof idmShardLessonsOf>;
  try {
    shardDesign = readIdmShardDesign(shard.idm_design);
    lessons = idmShardLessonsOf(design, plan);
  } catch {
    return shardInvalid();
  }
  const scopeOfBlock = new Map(design.block_scopes.map(scope => [scope.block_id, scope.scope_key]));
  const plannedLessons = lessons.lesson_keys.map(key => design.modules[plan.order]?.lessons
    .find(lesson => lesson.lesson_key === key) ?? shardInvalid());
  if (shardDesign.chapter_key !== plan.chapter_key || shardDesign.shard_index !== plan.shard_index
    || shardDesign.lesson_index_offset !== lessons.lesson_index_offset
    || !sameList(shardDesign.lessons.map(lesson => lesson.lesson_key), lessons.lesson_keys)
    || shard.lessons.length !== shardDesign.lessons.length) shardInvalid();
  for (const [lessonIndex, lessonDesign] of shardDesign.lessons.entries()) {
    const projected = shard.lessons[lessonIndex]!;
    const planned = plannedLessons[lessonIndex]!;
    const unitBlocks = lessonDesign.units.flatMap(unit => unit.block_ids);
    if (projected.title !== lessonDesign.title || projected.units.length !== lessonDesign.units.length
      || new Set(unitBlocks).size !== unitBlocks.length || unitBlocks.length !== planned.block_ids.length
      || unitBlocks.some(blockId => !planned.block_ids.includes(blockId))) shardInvalid();
    for (const [unitIndex, unitDesign] of lessonDesign.units.entries()) {
      const unit = projected.units[unitIndex]!;
      const scopes = unitDesign.block_ids.map(blockId => scopeOfBlock.get(blockId) ?? shardInvalid());
      if (unit.title !== unitDesign.title || !sameList(unit.source_scope_ids, scopes)
        || unit.component_plan.length !== unitDesign.components.length
        || unit.component_plan.some((component, index) => component.type !== unitDesign.components[index]!.type
          || !sameList(component.source_scope_ids, unitDesign.components[index]!.block_ids
            .map(blockId => scopeOfBlock.get(blockId) ?? shardInvalid())))) shardInvalid();
    }
  }
  return shardDesign;
}

/**
 * IDM `validate_architecture` (spec §12.3): the unchanged V2 assembly over the
 * block-scope catalogue, plus `idm` with the design hash, the facts accounted
 * for outside the course, author notes and the validated shard designs.
 */
export function assembleIdmOrchestrationArchitecture(
  skeleton: OrchestrationV2CourseSkeleton,
  view: IdmScopeView,
  shardArtifacts: readonly OrchestrationV2ChapterShardArtifact[],
): Readonly<OrchestrationV2ArchitectureAssembly> {
  const legacy = assembleOrchestrationV2Architecture(skeleton, view.scopeCatalog, shardArtifacts);
  const design = view.design;
  const chapters: Record<string, IdmShardDesignV1[]> = {};
  for (const chapter of legacy.architecture.chapters) {
    const artifacts = shardArtifacts.filter(artifact => artifact.shard.chapter_key === chapter.chapter_key)
      .sort((left, right) => left.shard.shard_index - right.shard.shard_index);
    chapters[chapter.chapter_key] = artifacts.map(artifact => assertIdmShardDesign(
      artifact.shard as OrchestrationV2ChapterShard & { idm_design?: unknown }, design, {
        chapter_key: artifact.shard.chapter_key, order: artifact.shard.order, shard_index: artifact.shard.shard_index,
        shard_count: artifact.shard.shard_count, source_scope_ids: artifact.shard.source_scope_ids,
        source_fact_count: 0, source_content_chars: 0,
      }));
  }
  const counts = view.dispositionCounts;
  if (legacy.admitted_fact_count !== counts.course + counts.reference_job_aid
    || legacy.architecture.chapters.length !== design.modules.length) {
    throw new IdmError('IDM_COURSE_DESIGN_INVALID');
  }
  const idm: IdmAssemblyExtensionV1 = {
    design_hash: design.design_hash,
    excluded_fact_count: IDM_EXCLUDED_DISPOSITIONS.reduce((sum, name) => sum + counts[name], 0),
    disposition_counts: { ...counts },
    module_keys: design.modules.map(module => module.module_key),
    notes: design.notes,
    chapters,
  };
  const { assembly_hash: _legacyHash, ...base } = legacy;
  const withIdm = { ...base, idm };
  if (Buffer.byteLength(JSON.stringify(withIdm), 'utf8') > MAX_ASSEMBLY_BYTES) {
    throw new IdmError('IDM_SHARD_DESIGN_INVALID');
  }
  return Object.freeze({ ...withIdm, assembly_hash: orchestrationV2Hash(withIdm) });
}

/** Lesson designs of one chapter in chapter order (shards concatenated). */
export function idmChapterLessonDesigns(idm: IdmAssemblyExtensionV1, chapterKey: string): IdmLessonDesignV1[] {
  return (idm.chapters[chapterKey] ?? shardInvalid()).flatMap(shard => shard.lessons);
}

/** The IDM unit design behind architecture path chapter_{c}.lesson_{l}.unit_{u} (0-based indexes). */
export function idmUnitDesignAt(
  assembly: Readonly<OrchestrationV2ArchitectureAssembly>,
  chapterIndex: number,
  lessonIndex: number,
  unitIndex: number,
): { lesson: IdmLessonDesignV1; unit: IdmUnitDesignV1; module_key: string } {
  const idm = assembly.idm ?? shardInvalid();
  const chapter = assembly.architecture.chapters[chapterIndex] ?? shardInvalid();
  const lesson = idmChapterLessonDesigns(idm, chapter.chapter_key)[lessonIndex] ?? shardInvalid();
  const unit = lesson.units[unitIndex] ?? shardInvalid();
  return { lesson, unit, module_key: idm.module_keys[chapterIndex] ?? shardInvalid() };
}

/**
 * Author-facing note for `implementation_notes` (spec §8.4): never `<`/`>` (the
 * workspace editor rejects them, R10), trimmed, cut at `maximum` code points,
 * `null` when empty.
 */
export function idmAuthorNote(parts: ReadonlyArray<string | null | undefined>, maximum: number): string | null {
  const joined = parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map(part => part.trim()).join('\n').replace(/</g, '‹').replace(/>/g, '›');
  if (!joined) return null;
  const cut = idmTextLength(joined) > maximum ? Array.from(joined).slice(0, maximum).join('').trimEnd() : joined;
  return cut || null;
}
