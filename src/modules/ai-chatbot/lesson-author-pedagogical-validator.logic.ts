import type {
  LessonAuthorComponentPlan,
  LessonAuthorComponentProposal,
  LessonAuthorProposal,
} from '../course-authoring/course-authoring.service.js';
import { readServerOwnedSourceFactIds } from './lesson-author-component-registry.logic.js';

/**
 * Deterministic quality checks for a generated Lesson Author proposal.
 *
 * This deliberately consumes the normalized proposal that Node is about to
 * persist. It is not an LLM judge and it does not replace source, tenant,
 * registry, or schema validation. The optional blueprint chapter makes the
 * Phase-3 learning architecture the authority for objective/assessment
 * checks; legacy/File Search proposals still receive bounded local checks.
 */
export type LessonAuthorPedagogicalSeverity = 'error' | 'warning' | 'info';
export type LessonAuthorPedagogicalStatus = 'PASS' | 'PASS_WITH_WARNINGS' | 'FAIL';

export interface LessonAuthorPedagogicalFinding {
  code: string;
  severity: LessonAuthorPedagogicalSeverity;
  path: string;
  message: string;
  related_paths?: string[];
  objective_ids?: string[];
  learning_block_ids?: string[];
  component_ids?: string[];
  source_fact_ids?: string[];
  repairable: boolean;
}

export interface LessonAuthorPedagogicalQualityReport {
  status: LessonAuthorPedagogicalStatus;
  scores: {
    objective_coverage: number | null;
    source_coverage: number | null;
    assessment_alignment: number | null;
    instructional_depth: number | null;
    component_purpose: number | null;
  };
  findings: LessonAuthorPedagogicalFinding[];
  duplicate_count: number;
}

export interface LessonAuthorPedagogicalBlueprintUnit {
  title: string;
  purpose?: string;
  concept_ids?: string[];
  learning_objective_refs?: string[];
  source_fact_ids?: string[];
  learning_blocks?: Array<{
    id: string;
    intent: string;
    source_fact_ids?: string[];
    learning_objective_refs?: string[];
  }>;
  component_plan?: LessonAuthorComponentPlan[];
}

export interface LessonAuthorPedagogicalBlueprintLesson {
  title: string;
  learning_objectives?: string[];
  primary_concept_ids?: string[];
  supporting_concept_ids?: string[];
  assessment_required?: boolean;
  assessment_objective_refs?: string[];
  units: LessonAuthorPedagogicalBlueprintUnit[];
}

export interface LessonAuthorPedagogicalBlueprintChapter {
  lessons: LessonAuthorPedagogicalBlueprintLesson[];
}

type ProposalUnitLocation = {
  chapterIndex: number;
  lessonIndex: number;
  unitIndex: number;
  unit: NonNullable<LessonAuthorProposal['chapters'][number]['lessons'][number]['units'][number]>;
  path: string;
};

type ComponentLocation = ProposalUnitLocation & {
  componentIndex: number;
  component: LessonAuthorComponentProposal;
  componentPath: string;
  sourceFactIds: string[];
  text: string;
};

const EXPLANATORY_COMPONENTS = new Set(['html', 'la_faq']);
const PRACTICE_OR_CHECK_COMPONENTS = new Set(['problem', 'la_sortable', 'la_crossword']);
const ACTION_OBJECTIVE = /\b(?:apply|analyse|analyze|evaluate|perform|demonstrate|use|áp\s+dụng|phân\s+tích|đánh\s+giá|thực\s+hiện|vận\s+dụng)\b/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseEmbeddedData(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return asRecord(JSON.parse(value)); } catch { return {}; }
  }
  return asRecord(value);
}

function textList(value: unknown, maxItems = 160, maxLength = 2_000): string[] {
  if (!Array.isArray(value)) return [];
  const values = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim().slice(0, maxLength);
    if (text) values.add(text);
    if (values.size >= maxItems) break;
  }
  return Array.from(values);
}

function localObjectiveRefs(value: unknown, maxItems = 12): string[] {
  if (!Array.isArray(value) || value.length > maxItems) return [];
  const refs = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return [];
    const ref = item.trim();
    if (!/^lo_([1-9][0-9]*)$/.test(ref)) return [];
    refs.add(ref);
  }
  return [...refs];
}

function stripMarkup(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value: unknown): string {
  return stripMarkup(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value: unknown): string[] {
  return normalizeText(value).split(' ').filter(token => token.length >= 2).slice(0, 600);
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (!leftSet.size || !rightSet.size) return 0;
  let intersection = 0;
  for (const token of leftSet) if (rightSet.has(token)) intersection += 1;
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function componentSourceFactIds(component: LessonAuthorComponentProposal): string[] {
  const metadata = asRecord(component.metadata);
  const data = asRecord(component.data);
  return readServerOwnedSourceFactIds(metadata.source_fact_ids ?? data.source_fact_ids);
}

function nestedComponentData(component: LessonAuthorComponentProposal, key: string): Record<string, unknown> {
  const metadata = asRecord(component.metadata);
  const data = asRecord(component.data);
  return parseEmbeddedData(metadata[key] ?? data[key]);
}

function extractProblemQuestion(value: unknown): string {
  const xml = String(value ?? '');
  const label = xml.match(/<label>([\s\S]*?)<\/label>/i);
  return stripMarkup(label?.[1] ?? '');
}

function extractProblemChoices(value: unknown): string[] {
  const xml = String(value ?? '');
  return [...xml.matchAll(/<(?:choice|option)\b[^>]*>([\s\S]*?)<\/(?:choice|option)>/gi)]
    .map(match => stripMarkup(match[1]))
    .filter(Boolean);
}

function componentLearnerText(component: LessonAuthorComponentProposal): string {
  if (component.type === 'html') return stripMarkup(component.data);
  if (component.type === 'problem') return extractProblemQuestion(component.data);
  if (component.type === 'la_faq') {
    const items = nestedComponentData(component, 'faq_data').items;
    return Array.isArray(items)
      ? items.map(item => {
        const row = asRecord(item);
        return `${String(row.question ?? '')} ${String(row.answer ?? '')}`;
      }).join(' ')
      : '';
  }
  if (component.type === 'la_crossword') {
    const words = nestedComponentData(component, 'crossword_data').words;
    return Array.isArray(words)
      ? words.map(item => {
        const row = asRecord(item);
        return `${String(row.answer ?? '')} ${String(row.clue ?? '')}`;
      }).join(' ')
      : '';
  }
  if (component.type === 'la_sortable') {
    const data = nestedComponentData(component, 'sortable_data');
    const items = Array.isArray(data.items) ? data.items : [];
    return items.map(item => String(asRecord(item).text ?? '')).join(' ');
  }
  const diagram = nestedComponentData(component, 'diagram_data');
  const diagrams: unknown[] = Array.isArray(diagram.diagrams) ? diagram.diagrams : [];
  return diagrams.flatMap(diagramValue => {
    const rawNodes = asRecord(diagramValue).nodes;
    const nodes: unknown[] = Array.isArray(rawNodes) ? rawNodes : [];
    return nodes.map(node => String(asRecord(asRecord(node).data).label ?? ''));
  }).join(' ');
}

function proposalUnits(proposal: LessonAuthorProposal): ProposalUnitLocation[] {
  const result: ProposalUnitLocation[] = [];
  proposal.chapters.forEach((chapter, chapterIndex) => {
    chapter.lessons.forEach((lesson, lessonIndex) => {
      lesson.units.forEach((unit, unitIndex) => {
        result.push({
          chapterIndex,
          lessonIndex,
          unitIndex,
          unit,
          path: `chapter_${chapterIndex + 1}.lesson_${lessonIndex + 1}.unit_${unitIndex + 1}`,
        });
      });
    });
  });
  return result;
}

function proposalComponents(proposal: LessonAuthorProposal): ComponentLocation[] {
  return proposalUnits(proposal).flatMap(location => (location.unit.components ?? []).map((component, componentIndex) => ({
    ...location,
    componentIndex,
    component,
    componentPath: `${location.path}.component_${componentIndex + 1}`,
    sourceFactIds: componentSourceFactIds(component),
    text: componentLearnerText(component),
  })));
}

function finding(
  code: string,
  path: string,
  message: string,
  options: Partial<Omit<LessonAuthorPedagogicalFinding, 'code' | 'path' | 'message' | 'repairable'>> & { repairable?: boolean } = {},
): LessonAuthorPedagogicalFinding {
  return {
    code,
    severity: options.severity ?? 'error',
    path,
    message,
    repairable: options.repairable ?? true,
    ...(options.related_paths?.length ? { related_paths: options.related_paths } : {}),
    ...(options.objective_ids?.length ? { objective_ids: options.objective_ids } : {}),
    ...(options.learning_block_ids?.length ? { learning_block_ids: options.learning_block_ids } : {}),
    ...(options.component_ids?.length ? { component_ids: options.component_ids } : {}),
    ...(options.source_fact_ids?.length ? { source_fact_ids: options.source_fact_ids } : {}),
  };
}

function boundedScore(passed: number, total: number): number | null {
  return total > 0 ? Math.max(0, Math.min(1, Number((passed / total).toFixed(4)))) : null;
}

function expectedPlanFor(unit: LessonAuthorPedagogicalBlueprintUnit | undefined): LessonAuthorComponentPlan[] {
  return Array.isArray(unit?.component_plan) ? unit.component_plan : [];
}

function expectedBlocksFor(unit: LessonAuthorPedagogicalBlueprintUnit | undefined) {
  return Array.isArray(unit?.learning_blocks) ? unit.learning_blocks : [];
}

function unitExpectedFacts(unit: LessonAuthorPedagogicalBlueprintUnit | undefined): string[] {
  return readServerOwnedSourceFactIds(unit?.source_fact_ids);
}

function assessmentHasTeaching(components: ComponentLocation[]): boolean {
  const explainedFacts = new Set(components
    .filter(item => item.component.type === 'html')
    .flatMap(item => item.sourceFactIds));
  return components.some(item => item.component.type === 'problem'
    && item.sourceFactIds.some(factId => explainedFacts.has(factId)));
}

function validateComponentPayloadQuality(components: ComponentLocation[]): LessonAuthorPedagogicalFinding[] {
  const findings: LessonAuthorPedagogicalFinding[] = [];
  for (const item of components) {
    if (item.component.type === 'problem') {
      const question = extractProblemQuestion(item.component.data);
      const options = extractProblemChoices(item.component.data).map(normalizeText).filter(Boolean);
      if (!question) findings.push(finding('ASSESSMENT_QUESTION_EMPTY', item.componentPath, 'A knowledge-check component has no learner-facing question.'));
      if (new Set(options).size !== options.length) {
        findings.push(finding('ASSESSMENT_DISTRACTORS_DUPLICATED', item.componentPath, 'A knowledge-check component repeats an answer option.'));
      }
    }
    if (item.component.type === 'la_faq') {
      const items = nestedComponentData(item.component, 'faq_data').items;
      const questions = Array.isArray(items)
        ? items.map(row => normalizeText(asRecord(row).question)).filter(Boolean)
        : [];
      if (new Set(questions).size !== questions.length) {
        findings.push(finding('FAQ_QUESTION_DUPLICATED', item.componentPath, 'FAQ contains the same learner question more than once.'));
      }
    }
    if (item.component.type === 'la_crossword') {
      const words = nestedComponentData(item.component, 'crossword_data').words;
      const terms = Array.isArray(words)
        ? words.map(row => normalizeText(asRecord(row).answer)).filter(Boolean)
        : [];
      if (new Set(terms).size !== terms.length) {
        findings.push(finding('CROSSWORD_TERM_DUPLICATED', item.componentPath, 'Crossword repeats a terminology answer.'));
      }
    }
    if (item.component.type === 'la_sortable') {
      const sortable = nestedComponentData(item.component, 'sortable_data');
      const items = Array.isArray(sortable.items)
        ? sortable.items.map(row => normalizeText(asRecord(row).text)).filter(Boolean)
        : [];
      if (new Set(items).size !== items.length) {
        findings.push(finding('SORTABLE_ITEM_DUPLICATED', item.componentPath, 'Ordering practice repeats an item and cannot assess order clearly.'));
      }
    }
  }
  return findings;
}

/**
 * Compare only within a unit or sibling units of a single chapter. It is
 * intentionally conservative: teach -> practice/check is reinforcement, not
 * duplicate prose, and short/common text is ignored.
 */
export function detectLessonAuthorGeneratedContentDuplicates(
  proposal: LessonAuthorProposal,
): LessonAuthorPedagogicalFinding[] {
  const components = proposalComponents(proposal);
  const findings: LessonAuthorPedagogicalFinding[] = [];
  const seenPairs = new Set<string>();
  let comparisons = 0;

  for (let leftIndex = 0; leftIndex < components.length; leftIndex += 1) {
    const left = components[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex += 1) {
      if (comparisons >= 96) return findings;
      const right = components[rightIndex]!;
      if (left.chapterIndex !== right.chapterIndex) continue;
      comparisons += 1;

      const pairKey = `${left.componentPath}|${right.componentPath}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const leftType = left.component.type;
      const rightType = right.component.type;
      const leftQuestion = leftType === 'problem' ? normalizeText(extractProblemQuestion(left.component.data)) : '';
      const rightQuestion = rightType === 'problem' ? normalizeText(extractProblemQuestion(right.component.data)) : '';
      if (leftType === 'problem' && rightType === 'problem' && leftQuestion && leftQuestion === rightQuestion) {
        findings.push(finding('DUPLICATE_QUIZ_QUESTION', right.componentPath, 'A sibling lesson/unit repeats the same knowledge-check question.', {
          related_paths: [left.componentPath], component_ids: [right.componentPath], source_fact_ids: right.sourceFactIds,
        }));
        continue;
      }

      // A check/practice after instruction is intentional reinforcement. Do
      // not compare it as explanatory duplication.
      if (!EXPLANATORY_COMPONENTS.has(leftType) || !EXPLANATORY_COMPONENTS.has(rightType)
        || PRACTICE_OR_CHECK_COMPONENTS.has(leftType) || PRACTICE_OR_CHECK_COMPONENTS.has(rightType)) continue;
      const leftTokens = tokens(left.text);
      const rightTokens = tokens(right.text);
      if (leftTokens.length < 10 || rightTokens.length < 10) continue;
      const sourceOverlap = left.sourceFactIds.some(factId => right.sourceFactIds.includes(factId));
      const similarity = jaccard(leftTokens, rightTokens);
      if ((sourceOverlap && similarity >= 0.86) || normalizeText(left.text) === normalizeText(right.text)) {
        findings.push(finding('DUPLICATE_EXPLANATION', right.componentPath, 'A sibling unit repeats substantially the same explanatory content.', {
          related_paths: [left.componentPath], component_ids: [right.componentPath], source_fact_ids: right.sourceFactIds,
        }));
      }
    }
  }
  return findings;
}

export function validateLessonAuthorPedagogicalQuality(input: {
  proposal: LessonAuthorProposal;
  blueprint_chapter?: LessonAuthorPedagogicalBlueprintChapter;
}): LessonAuthorPedagogicalQualityReport {
  const { proposal, blueprint_chapter: blueprintChapter } = input;
  const components = proposalComponents(proposal);
  const findings = validateComponentPayloadQuality(components);
  let objectiveTotal = 0;
  let objectiveCovered = 0;
  let sourceTotal = 0;
  let sourceCovered = 0;
  let assessmentTotal = 0;
  let assessmentCovered = 0;
  let depthTotal = 0;
  let depthCovered = 0;
  let purposeTotal = 0;
  let purposeCovered = 0;

  if (blueprintChapter) {
    blueprintChapter.lessons.forEach((expectedLesson, lessonIndex) => {
      const proposalLesson = proposal.chapters[0]?.lessons[lessonIndex];
      const lessonPath = `chapter_1.lesson_${lessonIndex + 1}`;
      const expectedObjectives = textList(expectedLesson.learning_objectives, 12, 300);
      const expectedUnits = expectedLesson.units ?? [];
      const lessonComponents = components.filter(item => item.chapterIndex === 0 && item.lessonIndex === lessonIndex);

      expectedObjectives.forEach((_objective, objectiveIndex) => {
        const ref = `lo_${objectiveIndex + 1}`;
        objectiveTotal += 1;
        const mappedUnitIndexes = expectedUnits.flatMap((unit, unitIndex) =>
          localObjectiveRefs(unit.learning_objective_refs).includes(ref) ? [unitIndex] : []);
        const teaching = mappedUnitIndexes.some(unitIndex => lessonComponents.some(item => item.unitIndex === unitIndex && item.component.type === 'html' && tokens(item.text).length >= 12));
        if (teaching) objectiveCovered += 1;
        else findings.push(finding('OBJECTIVE_NOT_TAUGHT', mappedUnitIndexes.length === 1 ? `${lessonPath}.unit_${mappedUnitIndexes[0]! + 1}` : lessonPath, 'An approved learning objective has no substantive explanatory treatment.', {
          objective_ids: [ref],
          learning_block_ids: mappedUnitIndexes.flatMap(unitIndex => expectedBlocksFor(expectedUnits[unitIndex]).filter(block => localObjectiveRefs(block.learning_objective_refs).includes(ref)).map(block => block.id)),
        }));
      });

      expectedUnits.forEach((expectedUnit, unitIndex) => {
        const unitPath = `${lessonPath}.unit_${unitIndex + 1}`;
        const actualComponents = lessonComponents.filter(item => item.unitIndex === unitIndex);
        const expectedFacts = unitExpectedFacts(expectedUnit);
        if (expectedFacts.length > 0) {
          sourceTotal += expectedFacts.length;
          const declared = new Set(actualComponents.flatMap(item => item.sourceFactIds));
          for (const factId of expectedFacts) {
            if (declared.has(factId)) sourceCovered += 1;
            else findings.push(finding('SOURCE_FACT_NOT_TAUGHT', unitPath, 'A source fact assigned to the approved unit is absent from generated component coverage.', { source_fact_ids: [factId] }));
          }
        }

        const plan = expectedPlanFor(expectedUnit);
        const actualTypes = actualComponents.map(item => item.component.type);
        for (const planItem of plan) {
          purposeTotal += 1;
          const expectedTypePresent = actualTypes.includes(planItem.type);
          if (expectedTypePresent) purposeCovered += 1;
          else findings.push(finding('COMPONENT_PURPOSE_INVALID', unitPath, `The generated unit omitted the approved ${planItem.type} learning treatment.`, {
            learning_block_ids: planItem.learning_block_ids,
          }));
          if (planItem.type === 'la_sortable' && planItem.reason_code !== 'ORDERING_PRACTICE') {
            findings.push(finding('COMPONENT_PURPOSE_INVALID', unitPath, 'Sortable is allowed only for approved ordering practice.', { learning_block_ids: planItem.learning_block_ids }));
          }
          if (planItem.type === 'la_crossword' && planItem.reason_code !== 'TERMINOLOGY_REINFORCEMENT') {
            findings.push(finding('COMPONENT_PURPOSE_INVALID', unitPath, 'Crossword is allowed only for approved terminology reinforcement.', { learning_block_ids: planItem.learning_block_ids }));
          }
          if (planItem.type === 'la_diagram' && planItem.reason_code !== 'RELATIONSHIP_VISUALIZATION') {
            findings.push(finding('COMPONENT_PURPOSE_INVALID', unitPath, 'Diagram is allowed only for an approved relationship visualization.', { learning_block_ids: planItem.learning_block_ids }));
          }
          if (planItem.type === 'la_faq' && planItem.reason_code !== 'FAQ_ANTICIPATED_QUESTIONS') {
            findings.push(finding('COMPONENT_PURPOSE_INVALID', unitPath, 'FAQ is allowed only for approved anticipated questions.', { learning_block_ids: planItem.learning_block_ids }));
          }
        }

        const complexity = expectedFacts.length + textList(expectedUnit.concept_ids, 12, 96).length
          + localObjectiveRefs(expectedUnit.learning_objective_refs).length;
        if (complexity >= 3) {
          depthTotal += 1;
          const explanatoryWords = actualComponents
            .filter(item => item.component.type === 'html')
            .reduce((total, item) => total + tokens(item.text).length, 0);
          const blockCount = expectedBlocksFor(expectedUnit).length;
          if (explanatoryWords >= 45 || (blockCount <= 1 && explanatoryWords >= 28)) depthCovered += 1;
          else findings.push(finding('INSUFFICIENT_INSTRUCTIONAL_DEPTH', unitPath, 'A complex unit has too little explanatory treatment for its approved concepts/facts/objectives.', {
            learning_block_ids: expectedBlocksFor(expectedUnit).map(block => block.id),
            source_fact_ids: expectedFacts,
          }));
        }
      });

      if (expectedLesson.assessment_required) {
        assessmentTotal += 1;
        if (assessmentHasTeaching(lessonComponents)) assessmentCovered += 1;
        else findings.push(finding('ASSESSMENT_NOT_ALIGNED', lessonPath, 'An assessment-required lesson needs a source-linked problem after explanatory teaching.', {
          objective_ids: textList(expectedLesson.assessment_objective_refs, 12, 80),
        }));
      }

      if (expectedObjectives.some(objective => ACTION_OBJECTIVE.test(objective))) {
        const onlyPassiveExplanation = lessonComponents.length > 0
          && lessonComponents.every(item => item.component.type === 'html');
        if (onlyPassiveExplanation) {
          findings.push(finding('COGNITIVE_TREATMENT_WEAK', lessonPath, 'An apply/analyze objective currently has explanation only; review whether a supported learner action is needed.', {
            severity: 'warning', repairable: true,
          }));
        }
      }
      // An absent proposal lesson is already caught by structural validation;
      // retain this variable to make the expected/current association explicit.
      void proposalLesson;
    });
  } else {
    // Legacy/File Search compatibility: do not pretend we know objectives or
    // source-map scope. Still detect obviously thin local HTML components.
    for (const unit of proposalUnits(proposal)) {
      const htmlWords = (unit.unit.components ?? [])
        .filter(component => component.type === 'html')
        .reduce((total, component) => total + tokens(componentLearnerText(component)).length, 0);
      if ((unit.unit.source_fact_ids?.length ?? 0) >= 3 && htmlWords < 24) {
        findings.push(finding('INSUFFICIENT_INSTRUCTIONAL_DEPTH', unit.path, 'A source-dense unit has only a very short explanatory treatment.'));
      }
    }
  }

  const duplicates = detectLessonAuthorGeneratedContentDuplicates(proposal);
  findings.push(...duplicates);
  const hasErrors = findings.some(item => item.severity === 'error');
  const hasWarnings = findings.some(item => item.severity === 'warning');
  return {
    status: hasErrors ? 'FAIL' : hasWarnings ? 'PASS_WITH_WARNINGS' : 'PASS',
    scores: {
      objective_coverage: boundedScore(objectiveCovered, objectiveTotal),
      source_coverage: boundedScore(sourceCovered, sourceTotal),
      assessment_alignment: boundedScore(assessmentCovered, assessmentTotal),
      instructional_depth: boundedScore(depthCovered, depthTotal),
      component_purpose: boundedScore(purposeCovered, purposeTotal),
    },
    findings,
    duplicate_count: duplicates.length,
  };
}

/** Node remains the proposal acceptance gate after Python generation. */
export function assertLessonAuthorPedagogicalQuality(input: {
  proposal: LessonAuthorProposal;
  blueprint_chapter?: LessonAuthorPedagogicalBlueprintChapter;
}): LessonAuthorPedagogicalQualityReport {
  const report = validateLessonAuthorPedagogicalQuality(input);
  const errors = report.findings.filter(item => item.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`Lesson proposal failed pedagogical validation: ${errors.slice(0, 3).map(item => item.code).join(', ')}.`);
  }
  return report;
}
