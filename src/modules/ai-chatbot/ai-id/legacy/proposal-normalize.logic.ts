// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { ComponentCapabilityError } from '../lesson-author-capabilities.logic.js';
import { AppError } from '../../../../middleware/error-handler.js';
import {
  type LessonAuthorChapterProposal,
  type LessonAuthorLessonProposal,
  type LessonAuthorProposal,
  type LessonAuthorUnitProposal,
} from '../../../course-authoring/course-authoring.service.js';
import { type CourseComponentType } from '../../../tenants/tenant-course-components.constants.js';
import {
  normalizeLessonAuthorMediaReview as normalizeMediaReviewArtifact,
  type LessonAuthorBlueprintMediaReview,
} from '../lesson-author-media-review.logic.js';
import {
  completeLessonAuthorContentContract,
  validateLessonAuthorContentContractUnit,
} from '../lesson-author-content-contract.logic.js';
import {
  deriveSemanticLearningBlocksFromLegacyComponentPlan,
  normalizeSemanticLearningBlocks,
  planSemanticLearningBlocks,
  readServerOwnedSourceFactIds,
  type ComponentPlannerDiagnostic,
} from '../lesson-author-component-registry.logic.js';
import {
  MAX_PROPOSAL_CHAPTERS,
  MAX_PROPOSAL_LESSONS,
  MAX_PROPOSAL_UNITS,
  MAX_PROPOSAL_COMPONENTS,
  MAX_COMPACT_BLUEPRINT_TOTAL_COMPONENTS,
} from './constants.js';
import {
  asRecord,
  readString,
  normalizeLessonAuthorTitle,
  readStringArray,
  normalizeLessonAuthorComponentPlan,
  readCanonicalBlueprintIds,
  componentTypeLabel,
} from './component-normalize.logic.js';
import type {
  LessonAuthorBlueprintUnit,
  LessonAuthorBlueprint,
  LessonAuthorSourceFactAllocation,
  LessonAuthorSourceFactAllocationV3,
  LessonAuthorSourceEvidenceScopeAllocation,
  LessonAuthorBlueprintChapter,
  LessonAuthorBlueprintComponentPlan,
} from './types.js';
import { normalizeLessonAuthorUnitComponents } from './component-blocks.logic.js';

// ── Convert system prompt's `changes`-based format to `chapters`-based format ──
// System prompt (34fe8e8a) returns: {changes: [{action, block_type, display_name, content:{...nested...}}]}
// Backend normalize expects: {chapters: [{title, lessons:[{title, units:[{title, components:[...]}]}]}]}
function convertChangesToChapters(changes: unknown[]): unknown[] {
  const chapters: unknown[] = [];

  for (const changeValue of changes) {
    const change = asRecord(changeValue);
    const blockType = readString(change.block_type, '', 50);
    const displayName = readString(change.display_name ?? change.title, '', 180);
    const content = asRecord(change.content);

    if (blockType === 'chapter') {
      // Chapter-level change → extract nested lessons from content
      const rawLessons = Array.isArray(content.lessons) ? content.lessons : [];
      const lessons = rawLessons.map((lessonValue: unknown) => {
        const lesson = asRecord(lessonValue);
        const lessonName = readString(lesson.display_name ?? lesson.title, '', 180);
        const lessonContent = asRecord(lesson.content ?? lesson);
        const rawUnits = Array.isArray(lessonContent.units) ? lessonContent.units : [];
        const units = rawUnits.map((unitValue: unknown) => {
          const unit = asRecord(unitValue);
          const unitName = readString(unit.display_name ?? unit.title, '', 180);
          const unitContent = asRecord(unit.content ?? unit);
          // Components can be in unit.content.components, unit.components, or unit.content directly
          const rawComponents = Array.isArray(unitContent.components)
            ? unitContent.components
            : Array.isArray(unit.components)
              ? unit.components
              : [];
          return {
            title: unitName,
            components: rawComponents.map((compValue: unknown) => {
              const comp = asRecord(compValue);
              const compContent = asRecord(comp.content ?? comp);
              return {
                type: readString(comp.type ?? comp.block_type, 'html', 40),
                title: readString(comp.display_name ?? comp.title, '', 180),
                // Spread content fields (html, items, words, nodes, edges, etc.)
                ...compContent,
              };
            }),
          };
        });
        return { title: lessonName, units };
      });
      chapters.push({ title: displayName, lessons });
    }
  }

  return chapters;
}

export function normalizeLessonAuthorProposal(rawValue: unknown): LessonAuthorProposal {
  const raw = asRecord(rawValue);

  // ── Convert system prompt's `changes` format to `chapters` format ──
  // System prompt (34fe8e8a) teaches Gemini to return: {changes: [{action, block_type, display_name, content:{lessons:[...]}}]}
  // But this function expects: {chapters: [{title, lessons:[{title, units:[{title, components:[...]}]}]}]}
  let rawChapters = Array.isArray(raw.chapters) ? raw.chapters : [];
  if (rawChapters.length === 0 && Array.isArray(raw.changes)) {
    rawChapters = convertChangesToChapters(raw.changes);
  }

  if (rawChapters.length === 0) throw new Error('AI proposal must contain at least one chapter');
  if (rawChapters.length > MAX_PROPOSAL_CHAPTERS) {
    throw new AppError(`AI proposal vượt quá giới hạn ${MAX_PROPOSAL_CHAPTERS} section/chapter. Chỉ được tạo nội dung đầy đủ trong một section cho mỗi lần approve.`, 400);
  }

  let lessonCount = 0;
  let unitCount = 0;
  let componentCount = 0;

  const chapters: LessonAuthorChapterProposal[] = rawChapters.map((chapterValue, chapterIndex) => {
    const chapter = asRecord(chapterValue);
    const rawLessons = Array.isArray(chapter.lessons) ? chapter.lessons : [];
    if (rawLessons.length === 0) throw new Error(`Chapter ${chapterIndex + 1} must contain lessons`);

    const lessons: LessonAuthorLessonProposal[] = rawLessons.map((lessonValue, lessonIndex) => {
      lessonCount += 1;
      if (lessonCount > MAX_PROPOSAL_LESSONS) {
        throw new Error(`AI proposal exceeds ${MAX_PROPOSAL_LESSONS} lessons`);
      }

      const lesson = asRecord(lessonValue);
      const rawUnits = Array.isArray(lesson.units) ? lesson.units : [];
      if (rawUnits.length === 0) throw new Error(`Lesson ${lessonIndex + 1} must contain units`);

      const units: LessonAuthorUnitProposal[] = rawUnits.map((unitValue, unitIndex) => {
        unitCount += 1;
        if (unitCount > MAX_PROPOSAL_UNITS) {
          throw new Error(`AI proposal exceeds ${MAX_PROPOSAL_UNITS} units`);
        }

        const unit = asRecord(unitValue);
        const unitTitle = normalizeLessonAuthorTitle(unit.title, 'unit', `Nội dung bài học ${unitIndex + 1}`);
        const components = normalizeLessonAuthorUnitComponents(unit, unitTitle);
        componentCount += components.length;
        if (componentCount > MAX_PROPOSAL_COMPONENTS) {
          throw new Error(`AI proposal exceeds ${MAX_PROPOSAL_COMPONENTS} components`);
        }

        return {
          title: unitTitle,
          components,
          source_refs: readStringArray(unit.source_refs, 8, 32),
          source_fact_ids: readServerOwnedSourceFactIds(unit.source_fact_ids),
          component_plan: normalizeLessonAuthorComponentPlan(unit.component_plan),
        };
      });

      return {
        title: normalizeLessonAuthorTitle(lesson.title, 'lesson', `Nội dung mục ${lessonIndex + 1}`),
        units,
        source_refs: readStringArray(lesson.source_refs, 8, 32),
      };
    });

    return {
      title: normalizeLessonAuthorTitle(chapter.title, 'chapter', `Chapter ${chapterIndex + 1}`),
      lessons,
      source_refs: readStringArray(chapter.source_refs, 8, 32),
    };
  });

  return {
    summary: readString(raw.summary, '', 1000),
    chapters,
    ...(asRecord(raw.source_evidence) && Object.keys(asRecord(raw.source_evidence)).length > 0
      ? { source_evidence: asRecord(raw.source_evidence) }
      : {}),
  };
}

export function readLocalLearningObjectiveRefs(value: unknown, maxItems: number): string[] {
  const refs = readCanonicalBlueprintIds(value, maxItems, 16);
  if (refs.some(ref => !/^lo_([1-9][0-9]*)$/.test(ref))) {
    throw new Error('Blueprint learning objective reference must be a local lo_N identifier.');
  }
  return refs;
}

export function assertLocalLearningObjectiveRefs(
  refs: readonly string[],
  objectiveCount: number,
  label: string,
): void {
  for (const ref of refs) {
    const match = /^lo_([1-9][0-9]*)$/.exec(ref);
    if (!match || Number(match[1]) > objectiveCount) {
      throw new Error(`${label} does not resolve to a local lesson learning objective.`);
    }
  }
}

export function isV4SupportingFactlessUnit(
  architectureContractVersion: number | undefined,
  unit: Pick<LessonAuthorBlueprintUnit, 'primary_concept_ids' | 'learning_blocks' | 'source_fact_ids'>,
): boolean {
  const blocks = unit.learning_blocks ?? [];
  if (architectureContractVersion === 5) {
    return (unit.source_fact_ids?.length ?? 0) === 0
      && blocks.length > 0
      && blocks.every(block => (block.primary_evidence_scope_ids?.length ?? 0) === 0);
  }
  return architectureContractVersion === 4
    && (unit.source_fact_ids?.length ?? 0) === 0
    && blocks.length > 0
    && (unit.primary_concept_ids?.length ?? 0) === 0
    && blocks.every(block => (block.primary_concept_ids?.length ?? 0) === 0);
}

export function resolveV5SupportingEvidenceFactIds(
  blueprint: LessonAuthorBlueprint,
  unit: Pick<LessonAuthorBlueprintUnit, 'supporting_evidence_scope_ids' | 'learning_blocks'>,
): string[] {
  const allocation = blueprint.source_fact_allocation;
  if (blueprint.architecture_contract_version !== 5 || allocation?.version !== 'source-fact-allocation-v3') return [];
  const supportingScopeIds = new Set([
    ...(unit.supporting_evidence_scope_ids ?? []),
    ...(unit.learning_blocks ?? []).flatMap(block => block.supporting_evidence_scope_ids ?? []),
  ]);
  if (supportingScopeIds.size === 0) return [];
  return Array.from(new Set(
    allocation.allocations
      .filter(item => supportingScopeIds.has(item.evidence_scope_id))
      .map(item => item.fact_id),
  ));
}

export function normalizeLessonAuthorSourceFactAllocation(value: unknown): LessonAuthorSourceFactAllocation | null {
  const raw = asRecord(value);
  const requiredCount = raw.required_count;
  const allocatedCount = raw.allocated_count;
  if (raw.version === 'source-fact-allocation-v3') {
    if (typeof requiredCount !== 'number' || typeof allocatedCount !== 'number'
      || !Number.isSafeInteger(requiredCount) || !Number.isSafeInteger(allocatedCount)
      || requiredCount < 0 || allocatedCount < 0 || allocatedCount > requiredCount
      || typeof raw.complete !== 'boolean' || !Array.isArray(raw.allocations) || !Array.isArray(raw.unallocated)
      || raw.authority !== 'server' || raw.architecture_contract_version !== 5) return null;
    const allocations: LessonAuthorSourceFactAllocationV3['allocations'] = [];
    const unallocated: LessonAuthorSourceFactAllocationV3['unallocated'] = [];
    for (const item of raw.allocations) {
      const allocation = asRecord(item);
      const factId = readCanonicalBlueprintIds([allocation.fact_id], 1)[0] ?? '';
      const unitPath = readCanonicalBlueprintIds([allocation.unit_path], 1, 160)[0] ?? '';
      const blockId = readCanonicalBlueprintIds([allocation.learning_block_id], 1)[0] ?? '';
      const scopeId = readCanonicalBlueprintIds([allocation.evidence_scope_id], 1)[0] ?? '';
      if (!factId || !unitPath || !blockId || !scopeId || allocation.basis !== 'PRIMARY_EVIDENCE_SCOPE') return null;
      allocations.push({ fact_id: factId, unit_path: unitPath, learning_block_id: blockId, evidence_scope_id: scopeId, basis: 'PRIMARY_EVIDENCE_SCOPE' });
    }
    for (const item of raw.unallocated) {
      const finding = asRecord(item);
      const factId = readCanonicalBlueprintIds([finding.fact_id], 1)[0] ?? '';
      const code = readString(finding.code, '', 80);
      const path = readCanonicalBlueprintIds([finding.path], 1, 160)[0] ?? '';
      if (!factId || !code || !path) return null;
      unallocated.push({ fact_id: factId, code, path });
    }
    if (allocations.length !== allocatedCount || allocations.length + unallocated.length > requiredCount
      || raw.complete !== (allocations.length === requiredCount && unallocated.length === 0)) return null;
    return { version: 'source-fact-allocation-v3', authority: 'server', architecture_contract_version: 5,
      required_count: requiredCount, allocated_count: allocatedCount, complete: raw.complete, allocations, unallocated };
  }
  if ((raw.version !== 'source-fact-allocation-v1' && raw.version !== 'source-fact-allocation-v2')
    || typeof requiredCount !== 'number' || typeof allocatedCount !== 'number'
    || !Number.isSafeInteger(requiredCount) || !Number.isSafeInteger(allocatedCount)
    || requiredCount < 0 || allocatedCount < 0 || allocatedCount > requiredCount
    || typeof raw.complete !== 'boolean' || !Array.isArray(raw.allocations)
    || !Array.isArray(raw.unallocated)) return null;
  const allocations: Array<{
    fact_id: string; unit_path: string; learning_block_id: string;
    basis: 'SECTION_MATCH' | 'CONCEPT_MATCH' | 'SOURCE_REF_MATCH' | 'OWNERSHIP_MATCH';
  }> = [];
  const unallocated: Array<{ fact_id: string; code: string; path: string }> = [];
  const bases = new Set(['SECTION_MATCH', 'CONCEPT_MATCH', 'SOURCE_REF_MATCH', 'OWNERSHIP_MATCH']);
  for (const item of raw.allocations) {
    const allocation = asRecord(item);
    const basis = readString(allocation.basis, '', 32);
    const factId = readCanonicalBlueprintIds([allocation.fact_id], 1)[0] ?? '';
    const unitPath = readCanonicalBlueprintIds([allocation.unit_path], 1, 160)[0] ?? '';
    const blockId = readCanonicalBlueprintIds([allocation.learning_block_id], 1)[0] ?? '';
    if (!factId || !unitPath || !blockId || !bases.has(basis)) return null;
    allocations.push({ fact_id: factId, unit_path: unitPath, learning_block_id: blockId, basis: basis as 'SECTION_MATCH' | 'CONCEPT_MATCH' | 'SOURCE_REF_MATCH' | 'OWNERSHIP_MATCH' });
  }
  for (const item of raw.unallocated) {
    const finding = asRecord(item);
    const factId = readCanonicalBlueprintIds([finding.fact_id], 1)[0] ?? '';
    const code = readString(finding.code, '', 80);
    const path = readCanonicalBlueprintIds([finding.path], 1, 160)[0] ?? '';
    if (!factId || !code || !path) return null;
    unallocated.push({ fact_id: factId, code, path });
  }
  const isV2 = raw.version === 'source-fact-allocation-v2';
  const invalidClaimedFactIds = isV2 ? [] : readCanonicalBlueprintIds(raw.invalid_claimed_fact_ids, 20_000);
  if (!isV2 && !Array.isArray(raw.invalid_claimed_fact_ids)) return null;
  if (allocations.length !== allocatedCount || allocations.length + unallocated.length > requiredCount) return null;
  if (raw.complete !== (allocations.length === requiredCount && unallocated.length === 0 && invalidClaimedFactIds.length === 0)) return null;
  if (isV2) {
    if (raw.authority !== 'server' || raw.architecture_contract_version !== 4) return null;
    return {
      version: 'source-fact-allocation-v2', authority: 'server', architecture_contract_version: 4,
      required_count: requiredCount, allocated_count: allocatedCount,
      complete: raw.complete, allocations, unallocated,
    };
  }
  return {
    version: 'source-fact-allocation-v1', required_count: requiredCount, allocated_count: allocatedCount,
    complete: raw.complete, allocations, unallocated, invalid_claimed_fact_ids: invalidClaimedFactIds,
  };
}

export function normalizeLessonAuthorSourceEvidenceScopeAllocation(value: unknown): LessonAuthorSourceEvidenceScopeAllocation | null {
  const raw = asRecord(value);
  if (raw.version !== 'source-evidence-scope-allocation-v1' || raw.authority !== 'server'
    || raw.architecture_contract_version !== 5 || typeof raw.required_count !== 'number'
    || typeof raw.allocated_count !== 'number' || !Number.isSafeInteger(raw.required_count)
    || !Number.isSafeInteger(raw.allocated_count) || raw.required_count < 0 || raw.allocated_count < 0
    || raw.allocated_count > raw.required_count || typeof raw.complete !== 'boolean'
    || !Array.isArray(raw.allocations) || !Array.isArray(raw.unallocated)) return null;
  const allocations: LessonAuthorSourceEvidenceScopeAllocation['allocations'] = [];
  const unallocated: LessonAuthorSourceEvidenceScopeAllocation['unallocated'] = [];
  for (const item of raw.allocations) {
    const allocation = asRecord(item);
    const scopeId = readCanonicalBlueprintIds([allocation.evidence_scope_id], 1)[0] ?? '';
    const unitPath = readCanonicalBlueprintIds([allocation.unit_path], 1, 160)[0] ?? '';
    const blockId = readCanonicalBlueprintIds([allocation.learning_block_id], 1)[0] ?? '';
    if (!scopeId || !unitPath || !blockId || allocation.basis !== 'PRIMARY_EVIDENCE_SCOPE') return null;
    allocations.push({ evidence_scope_id: scopeId, unit_path: unitPath, learning_block_id: blockId, basis: 'PRIMARY_EVIDENCE_SCOPE' });
  }
  for (const item of raw.unallocated) {
    const finding = asRecord(item);
    const scopeId = readCanonicalBlueprintIds([finding.evidence_scope_id], 1)[0] ?? '';
    const code = readString(finding.code, '', 80);
    const path = readCanonicalBlueprintIds([finding.path], 1, 160)[0] ?? '';
    if (!scopeId || !code || !path) return null;
    unallocated.push({ evidence_scope_id: scopeId, code, path });
  }
  if (allocations.length !== raw.allocated_count || allocations.length + unallocated.length > raw.required_count
    || raw.complete !== (allocations.length === raw.required_count && unallocated.length === 0)) return null;
  return { version: 'source-evidence-scope-allocation-v1', authority: 'server', architecture_contract_version: 5,
    required_count: raw.required_count, allocated_count: raw.allocated_count, complete: raw.complete, allocations, unallocated };
}

export function normalizeLessonAuthorMediaReview(
  value: unknown,
  chapters: readonly LessonAuthorBlueprintChapter[],
): LessonAuthorBlueprintMediaReview | null {
  const placements: Array<{ unit_path: string; has_media_plan: boolean }> = [];
  for (const [chapterIndex, chapter] of chapters.entries()) {
    for (const [lessonIndex, lesson] of chapter.lessons.entries()) {
      for (const [unitIndex, unit] of lesson.units.entries()) {
        const path = `chapter_${chapterIndex + 1}.lesson_${lessonIndex + 1}.unit_${unitIndex + 1}`;
        placements.push({ unit_path: path, has_media_plan: Boolean(unit.media_plan) });
      }
    }
  }
  return normalizeMediaReviewArtifact(value, placements);
}

function applySemanticLearningBlockPlanner(
  blueprint: LessonAuthorBlueprint,
  allowedComponentTypes?: ReadonlySet<CourseComponentType>,
  onComponentDecision?: (diagnostics: ComponentPlannerDiagnostic) => void,
): LessonAuthorBlueprint {
  const chapters = blueprint.chapters.map((chapter, chapterIndex) => ({
    ...chapter,
    lessons: chapter.lessons.map((lesson, lessonIndex) => ({
      ...lesson,
      units: lesson.units.map((unit, unitIndex) => {
        const instanceContext = { component_capabilities: blueprint.component_capabilities, unit_path: `chapter_${chapterIndex + 1}.lesson_${lessonIndex + 1}.unit_${unitIndex + 1}`, on_diagnostics: onComponentDecision };
        const sourceFactIds = unit.source_fact_ids ?? [];
        const semanticBlocks = unit.learning_blocks && unit.learning_blocks.length > 0
          ? normalizeSemanticLearningBlocks(unit.learning_blocks, sourceFactIds, {
            strictLocalObjectiveRefs: blueprint.architecture_contract_version === 4 || blueprint.architecture_contract_version === 5,
          })
          : deriveSemanticLearningBlocksFromLegacyComponentPlan(unit.component_plan);
        const blocks = semanticBlocks.length > 0
          ? semanticBlocks
          : [{
            id: 'fallback_lb_1',
            intent: 'concept_explanation' as const,
            importance: 'core' as const,
            content: {},
            source_fact_ids: sourceFactIds,
            metadata: { adapter: 'empty_legacy_component_plan' },
          }];
        const supportingEvidenceFactIds = resolveV5SupportingEvidenceFactIds(blueprint, {
          supporting_evidence_scope_ids: unit.supporting_evidence_scope_ids,
          learning_blocks: blocks,
        });
        // A v4 supporting/reinforcement unit deliberately owns no canonical
        // fact. Do not turn it into a source-claiming component merely to
        // satisfy a legacy content-plan shape.
        if (isV4SupportingFactlessUnit(blueprint.architecture_contract_version, {
          ...unit,
          learning_blocks: blocks,
        })) {
          if (blueprint.architecture_contract_version !== 5 || supportingEvidenceFactIds.length === 0) {
            return { ...unit, learning_blocks: blocks, component_plan: [] };
          }
          const supportingPlans = planSemanticLearningBlocks({
            ...instanceContext,
            blocks,
            unit_source_fact_ids: [],
            allowed_component_types: allowedComponentTypes,
          }).map((plan): LessonAuthorBlueprintComponentPlan => ({
            ...plan,
            title: readString(plan.title, componentTypeLabel(plan.type, 'vi'), 180),
            rationale: readString(plan.rationale, `Học liệu củng cố mục tiêu của ${unit.title}.`, 240),
            source_fact_ids: [],
            supporting_evidence_fact_ids: blueprint.component_capabilities
              ? resolveV5SupportingEvidenceFactIds(blueprint, { learning_blocks: blocks.filter(block => plan.learning_block_ids?.includes(block.id)) })
              : supportingEvidenceFactIds,
          }));
          return {
            ...unit,
            learning_blocks: blocks,
            supporting_evidence_fact_ids: supportingEvidenceFactIds,
            component_plan: [...supportingPlans.filter(plan => plan.type !== 'la_faq'), ...supportingPlans.filter(plan => plan.type === 'la_faq')],
          };
        }
        const planned = planSemanticLearningBlocks({
          ...instanceContext,
          blocks,
          unit_source_fact_ids: sourceFactIds,
          allowed_component_types: allowedComponentTypes,
        });
        if (blueprint.component_capabilities) {
          for (const plan of planned) {
            plan.supporting_evidence_fact_ids = [...new Set([
              ...(plan.supporting_evidence_fact_ids ?? []),
              ...resolveV5SupportingEvidenceFactIds(blueprint, {
                learning_blocks: blocks.filter(block => plan.learning_block_ids?.includes(block.id)),
              }),
            ])];
          }
        }
        return {
          ...unit,
          learning_blocks: blocks,
          ...(blueprint.component_capabilities ? { supporting_evidence_fact_ids: supportingEvidenceFactIds } : {}),
          component_plan: [...planned.filter(plan => plan.type !== 'la_faq'), ...planned.filter(plan => plan.type === 'la_faq')].map((plan): LessonAuthorBlueprintComponentPlan => ({
            ...plan,
            title: readString(plan.title, componentTypeLabel(plan.type, 'vi'), 180),
            rationale: readString(plan.rationale, `Học liệu hỗ trợ mục tiêu của ${unit.title}.`, 240),
          })),
        };
      }),
    })),
  }));
  return { ...blueprint, chapters };
}

export function applyPhaseOneContentContract(
  blueprint: LessonAuthorBlueprint,
  allowedComponentTypes?: ReadonlySet<CourseComponentType>,
  onComponentDecision?: (diagnostics: ComponentPlannerDiagnostic) => void,
): LessonAuthorBlueprint {
  const plannedBlueprint = applySemanticLearningBlockPlanner(blueprint, allowedComponentTypes, onComponentDecision);
  const chapters = plannedBlueprint.chapters.map(chapter => ({
    ...chapter,
    lessons: chapter.lessons.map(lesson => ({
      ...lesson,
      units: lesson.units.map(unit => {
        if (isV4SupportingFactlessUnit(plannedBlueprint.architecture_contract_version, unit)) {
          if ((unit.supporting_evidence_fact_ids?.length ?? 0) === 0) {
            return { ...unit, component_plan: [] };
          }
          const supportingFailure = validateLessonAuthorContentContractUnit({
            source_fact_ids: [],
            supporting_evidence_fact_ids: unit.supporting_evidence_fact_ids,
            component_plan: unit.component_plan,
          });
          if (supportingFailure) throw new Error(`Supporting Blueprint unit "${unit.title}" violates the content contract: ${supportingFailure}`);
          return unit;
        }
        const componentPlan = completeLessonAuthorContentContract({
          source_fact_ids: unit.source_fact_ids,
          supporting_evidence_fact_ids: unit.supporting_evidence_fact_ids,
          component_plan: unit.component_plan,
        }).map((plan): LessonAuthorBlueprintComponentPlan => ({
          component_plan_id: plan.component_plan_id,
          learning_objective_refs: plan.learning_objective_refs,
          type: plan.type,
          title: readString(plan.title, componentTypeLabel(plan.type, 'vi'), 180),
          rationale: readString(plan.rationale, `Học liệu hỗ trợ mục tiêu của ${unit.title}.`, 240),
          purpose: plan.purpose,
          source_fact_ids: plan.source_fact_ids,
          ...(plan.supporting_evidence_fact_ids?.length ? { supporting_evidence_fact_ids: plan.supporting_evidence_fact_ids } : {}),
          content_requirements: plan.content_requirements,
          ...(plan.reason_code ? { reason_code: plan.reason_code } : {}),
          ...(plan.learning_block_ids?.length ? { learning_block_ids: plan.learning_block_ids } : {}),
          ...(plan.required_artifacts?.length ? { required_artifacts: plan.required_artifacts } : {}),
        }));
        const failure = validateLessonAuthorContentContractUnit({
          source_fact_ids: unit.source_fact_ids,
          supporting_evidence_fact_ids: unit.supporting_evidence_fact_ids,
          component_plan: componentPlan,
        });
        if (failure) throw new Error(`Blueprint unit "${unit.title}" violates the Phase-1 content contract: ${failure}`);
        return { ...unit, component_plan: componentPlan };
      }),
    })),
  }));
  if (plannedBlueprint.component_capabilities && chapters.reduce((sum, c) => sum + c.lessons.reduce((n, l) => n + l.units.reduce((m, u) => m + u.component_plan.length, 0), 0), 0) > MAX_COMPACT_BLUEPRINT_TOTAL_COMPONENTS) {
    throw new ComponentCapabilityError('COMPONENT_PLAN_COURSE_CAPACITY_EXCEEDED');
  }
  return { ...plannedBlueprint, content_contract_version: 1, chapters };
}
