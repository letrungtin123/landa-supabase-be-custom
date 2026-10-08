import { flattenOrderedLearningContent } from './lesson-author-component-registry.logic.js';
import type { OrchestrationV2ArchitectureAssembly } from './lesson-author-orchestration-v2-architecture.logic.js';
import type { OrchestrationV2SourceFact } from './lesson-author-orchestration-v2-rag-contract.logic.js';
import {
  IDM_PIPELINE_VERSION,
  IdmError,
  idmPythonCollapseWhitespace,
  idmPythonStrip,
  idmPythonWordCount,
  idmStripWhitespace,
  idmTextLength,
  sealIdmUnitBrief,
  type IdmContextFactV1,
  type IdmCourseDesignV1,
  type IdmUnitBriefV1,
  type IdmUnitSegment,
} from './lesson-author-idm.contract.js';
import { idmUnitDesignAt } from './lesson-author-idm-architecture.logic.js';

/** Python `app/idm/policy.py` W5 output budget (spec §7.7.3). */
export const IDM_SEGMENT_WORD_BUDGET: Readonly<Record<IdmUnitSegment, number>> = Object.freeze({
  context_explain: 450, example: 350, practice_feedback: 400, summary_apply: 250, job_aid: 600,
});
export const IDM_EXTRA_WORDS_PER_BLOCK = 120;
export const IDM_MIN_GENERATED_WORDS = 250;
export const IDM_MAX_GENERATED_WORDS = 1_600;
export const IDM_VISIBLE_CHARS_PER_WORD = 7;
export const IDM_CONTEXT_FACTS_MAX = 80;
export const IDM_CONTEXT_FACTS_MAX_CHARS = 24_000;
const MAX_PRACTICE_SENTENCES = 3;

const contractInvalid = (): never => { throw new IdmError('IDM_SHARD_DESIGN_INVALID'); };

/** Words = clamp(segment + 120 × (distinct treatment blocks − 1), 250, 1600); chars = words × 7. */
export function idmUnitOutputBudget(brief: Pick<IdmUnitBriefV1, 'unit_segment' | 'components'>): Readonly<{
  max_words: number; max_visible_chars: number;
}> {
  const blocks = new Set(brief.components.flatMap(slot => slot.treatments.map(item => item.block_id)));
  const words = Math.max(IDM_MIN_GENERATED_WORDS, Math.min(IDM_MAX_GENERATED_WORDS,
    IDM_SEGMENT_WORD_BUDGET[brief.unit_segment] + IDM_EXTRA_WORDS_PER_BLOCK * Math.max(0, blocks.size - 1)));
  return Object.freeze({ max_words: words, max_visible_chars: words * IDM_VISIBLE_CHARS_PER_WORD });
}

/**
 * The text Python's `staged_instructional_finding` measures for one provider
 * html component: `semantic_learning_visible_text(semantic_content)` (section
 * headings are not part of it; items Python-stripped and joined by one space)
 * or, without semantic content, the raw html with tags replaced by a space and
 * whitespace runs collapsed (entities kept). Null when the semantic payload is
 * invalid, which Python rejects too.
 */
export function idmPythonHtmlVisibleText(component: Readonly<Record<string, unknown>>): string | null {
  const semantic = component.semantic_content;
  if (semantic === undefined || semantic === null) {
    const raw = [component.html, component.data, component.content].find(value => !!value);
    const html = typeof raw === 'string' ? raw : '';
    return idmPythonStrip(idmPythonCollapseWhitespace(html.replace(/<[^>]+>/g, ' ')));
  }
  if (typeof semantic !== 'object' || Array.isArray(semantic) || !Object.keys(semantic).length) return null;
  let flat: Record<string, unknown>;
  try { flat = flattenOrderedLearningContent(semantic); } catch { return null; }
  const pick = (key: string, alias: string) => (key in flat ? flat[key] : flat[alias]);
  const visible: string[] = [];
  if (flat.heading !== undefined && flat.heading !== null) {
    if (typeof flat.heading !== 'string' || !idmPythonStrip(flat.heading)) return null;
    visible.push(idmPythonStrip(flat.heading));
  }
  for (const items of [pick('paragraphs', 'paragraphs'), pick('bullet_points', 'bullets'),
    pick('ordered_steps', 'steps'), pick('warnings', 'warning')]) {
    if (items === undefined || items === null) continue;
    if (!Array.isArray(items)) return null;
    for (const item of items) {
      if (typeof item !== 'string' || !idmPythonStrip(item)) return null;
      visible.push(idmPythonStrip(item));
    }
  }
  const rows = pick('comparison_rows', 'table_rows');
  if (rows !== undefined && rows !== null) {
    if (!Array.isArray(rows)) return null;
    for (const row of rows) {
      const label = (row as Record<string, unknown> | null)?.label, value = (row as Record<string, unknown> | null)?.value;
      if (typeof label !== 'string' || typeof value !== 'string' || !idmPythonStrip(label) || !idmPythonStrip(value)) {
        return null;
      }
      visible.push(idmPythonStrip(label), idmPythonStrip(value));
    }
  }
  return visible.length ? visible.join(' ') : null;
}

/**
 * IDM W5 budget (spec §7.7.3) exactly as Python applies it: to every provider
 * html component on its own, with code-point length (`len`) and `\w+` words, so
 * a unit Python accepted is never rejected here near the budget.
 */
export function exceedsIdmOutputBudget(brief: Pick<IdmUnitBriefV1, 'unit_segment' | 'components'>,
  htmlComponents: ReadonlyArray<Readonly<Record<string, unknown>>>): boolean {
  return idmOutputBudgetFinding(brief, htmlComponents) !== null;
}

/**
 * The first html component (position in `htmlComponents`) that breaks the IDM
 * W5 budget, with a safe reason code: `IDM_HTML_VISIBLE_TEXT_INVALID` when its
 * semantic payload cannot be measured, else `IDM_HTML_DENSITY_EXCEEDED`.
 */
export function idmOutputBudgetFinding(brief: Pick<IdmUnitBriefV1, 'unit_segment' | 'components'>,
  htmlComponents: ReadonlyArray<Readonly<Record<string, unknown>>>): { position: number; code: string } | null {
  const budget = idmUnitOutputBudget(brief);
  for (const [position, component] of htmlComponents.entries()) {
    const text = idmPythonHtmlVisibleText(component);
    if (text === null) return { position, code: 'IDM_HTML_VISIBLE_TEXT_INVALID' };
    if (idmTextLength(text) > budget.max_visible_chars || idmPythonWordCount(text) > budget.max_words) {
      return { position, code: 'IDM_HTML_DENSITY_EXCEEDED' };
    }
  }
  return null;
}

/**
 * Build the W5 brief of one unit (spec §6.8, §8.3). The unit and lesson design are
 * located through `assembly.idm` by architecture index; component slots are the
 * contract's own plans so owned/supporting facts match the contract exactly.
 */
export function buildIdmUnitBrief(input: {
  assembly: Readonly<OrchestrationV2ArchitectureAssembly>;
  design: IdmCourseDesignV1;
  chapter_index: number;
  lesson_index: number;
  unit_index: number;
  component_plans: ReadonlyArray<{ component_plan_id: string; type: string; source_fact_ids: string[];
    supporting_evidence_fact_ids: string[] }>;
  unit_fact_keys: readonly string[];
  /** Facts of the lesson's blocks (any order); facts of the unit itself are ignored. */
  lesson_facts: readonly OrchestrationV2SourceFact[];
}): IdmUnitBriefV1 {
  const { assembly, design } = input;
  const located = idmUnitDesignAt(assembly, input.chapter_index, input.lesson_index, input.unit_index);
  const chapter = assembly.architecture.chapters[input.chapter_index] ?? contractInvalid();
  const lessons = chapter.lessons;
  const lesson = lessons[input.lesson_index] ?? contractInvalid();
  const { unit, lesson: lessonDesign } = located;
  if (unit.components.length !== input.component_plans.length
    || unit.components.some((component, index) => component.type !== input.component_plans[index]!.type)) {
    contractInvalid();
  }
  const rows = new Map(design.blueprint.map(row => [row.block_id, row]));
  const blockFacts = new Map(design.blocks.map(block => [block.block_id, block.fact_keys]));
  const practices = new Map(lessonDesign.practice_tasks.map(practice => [practice.practice_id, practice]));
  const components = unit.components.map((component, index) => {
    const plan = input.component_plans[index]!;
    return {
      component_plan_id: plan.component_plan_id, type: component.type, role: component.role, title: component.title,
      support_items: component.support_items,
      practice: component.practice_id === null ? null : practices.get(component.practice_id) ?? contractInvalid(),
      treatments: component.block_ids.map(blockId => {
        const row = rows.get(blockId) ?? contractInvalid();
        return { block_id: blockId, treatment: row.treatment, detail_level: row.detail_level };
      }),
      owned_fact_keys: [...plan.source_fact_ids],
      supporting_fact_keys: [...plan.supporting_evidence_fact_ids],
    };
  });
  // Lesson context: facts of the lesson's other units, the criteria facts of this
  // unit's practices first, bounded to 80 facts / 24,000 characters.
  const unitKeys = new Set(input.unit_fact_keys);
  const textByKey = new Map(input.lesson_facts.map(fact => [fact.fact_key, fact.fact_text]));
  const lessonKeys = lessonDesign.units.flatMap(item => item.block_ids)
    .flatMap(blockId => blockFacts.get(blockId) ?? contractInvalid())
    .filter(key => !unitKeys.has(key));
  const criteria = new Set(components.flatMap(slot => slot.practice?.criteria_fact_keys ?? []));
  const ordered = [...lessonKeys.filter(key => criteria.has(key)), ...lessonKeys.filter(key => !criteria.has(key))];
  const contextFacts: IdmContextFactV1[] = [];
  let contextChars = 0;
  for (const key of ordered) {
    const text = idmStripWhitespace(textByKey.get(key) ?? contractInvalid());
    if (!text) continue;
    const length = idmTextLength(text);
    if (contextFacts.length >= IDM_CONTEXT_FACTS_MAX || contextChars + length > IDM_CONTEXT_FACTS_MAX_CHARS) break;
    contextFacts.push({ fact_key: key, fact_text: text });
    contextChars += length;
  }
  return sealIdmUnitBrief({
    pipeline_version: IDM_PIPELINE_VERSION,
    course_title: idmStripWhitespace(assembly.architecture.title),
    target_audience: design.target_audience.description,
    module_title: idmStripWhitespace(chapter.title),
    lesson_title: idmStripWhitespace(lesson.title),
    lesson_objective: idmStripWhitespace(lesson.objective),
    lesson_practice_sentences: lessonDesign.practice_tasks.map(practice => practice.sentence)
      .slice(0, MAX_PRACTICE_SENTENCES),
    previous_lesson_title: input.lesson_index > 0 ? idmStripWhitespace(lessons[input.lesson_index - 1]!.title) : null,
    next_lesson_title: input.lesson_index + 1 < lessons.length
      ? idmStripWhitespace(lessons[input.lesson_index + 1]!.title) : null,
    unit_segment: unit.segment,
    unit_purpose: unit.purpose,
    components,
    lesson_context_facts: contextFacts,
    job_aid_signpost: null,
  });
}
