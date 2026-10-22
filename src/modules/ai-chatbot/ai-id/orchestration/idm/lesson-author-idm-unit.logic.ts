import { flattenOrderedLearningContent } from '../../content/lesson-author-component-registry.logic.js';
import type { OrchestrationV2ArchitectureAssembly } from '../lesson-author-orchestration-v2-architecture.logic.js';
import type { OrchestrationV2SourceFact } from '../../contracts/lesson-author-orchestration-v2-rag-contract.logic.js';
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
  type IdmFaqMaterialV1,
  type IdmLessonDesignV1,
  type IdmUnitBriefV1,
  type IdmUnitDesignV1,
  type IdmUnitSegment,
} from '../../contracts/lesson-author-idm.contract.js';
import { idmUnitDesignAt } from './lesson-author-idm-architecture.logic.js';

/** Python `app/idm/policy.py` W5 output budget (spec §7.7.3). */
export const IDM_SEGMENT_WORD_BUDGET: Readonly<Record<IdmUnitSegment, number>> = Object.freeze({
  context_explain: 450, example: 350, practice_feedback: 400, summary_apply: 250, job_aid: 600,
});
export const IDM_EXTRA_WORDS_PER_BLOCK = 120;
export const IDM_MIN_GENERATED_WORDS = 250;
export const IDM_MAX_GENERATED_WORDS = 1_600;
export const IDM_VISIBLE_CHARS_PER_WORD = 7;
/** Python `EXPLAIN_BUDGET_PERCENT` (QLT-5 C): an explained unit's word budget, in percent, job aids excepted. */
export const IDM_EXPLAIN_BUDGET_PERCENT = 135;
export const IDM_CONTEXT_FACTS_MAX = 80;
export const IDM_CONTEXT_FACTS_MAX_CHARS = 24_000;
const MAX_PRACTICE_SENTENCES = 3;
/** Python `IdmFaqMaterialV1.practices` bound. */
const MAX_FAQ_PRACTICES = 3;
/** Python `IdmFaqMaterialV1.open_questions` bound (QLT-7). */
const MAX_FAQ_OPEN_QUESTIONS = 8;

const contractInvalid = (): never => { throw new IdmError('IDM_SHARD_DESIGN_INVALID'); };

/**
 * Words = clamp(segment + 120 × (distinct treatment blocks − 1), 250, 1600); an explained unit (`fidelity_mode`
 * "explain", not a job aid) gets floor(words × 135 / 100), exactly as Python `budget_words`; chars = words × 7.
 */
export function idmUnitOutputBudget(brief: Pick<IdmUnitBriefV1, 'unit_segment' | 'components' | 'fidelity_mode'>):
Readonly<{ max_words: number; max_visible_chars: number }> {
  const blocks = new Set(brief.components.flatMap(slot => slot.treatments.map(item => item.block_id)));
  const base = Math.max(IDM_MIN_GENERATED_WORDS, Math.min(IDM_MAX_GENERATED_WORDS,
    IDM_SEGMENT_WORD_BUDGET[brief.unit_segment] + IDM_EXTRA_WORDS_PER_BLOCK * Math.max(0, blocks.size - 1)));
  const words = brief.fidelity_mode === 'explain' && brief.unit_segment !== 'job_aid'
    ? Math.floor(base * IDM_EXPLAIN_BUDGET_PERCENT / 100) : base;
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
export function exceedsIdmOutputBudget(brief: Pick<IdmUnitBriefV1, 'unit_segment' | 'components' | 'fidelity_mode'>,
  htmlComponents: ReadonlyArray<Readonly<Record<string, unknown>>>): boolean {
  return idmOutputBudgetFinding(brief, htmlComponents) !== null;
}

/**
 * The first html component (position in `htmlComponents`) that breaks the IDM
 * W5 budget, with a safe reason code: `IDM_HTML_VISIBLE_TEXT_INVALID` when its
 * semantic payload cannot be measured, else `IDM_HTML_DENSITY_EXCEEDED`.
 */
export function idmOutputBudgetFinding(brief: Pick<IdmUnitBriefV1, 'unit_segment' | 'components' | 'fidelity_mode'>,
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

/** Python `source_flags.FLAG_ISSUE_TYPES`: the W1 issues the author checks in the source ("Cần xem"). */
export const IDM_SOURCE_FLAG_ISSUE_TYPES: ReadonlySet<string> = Object.freeze(new Set(['conflict', 'unclear', 'outdated']));

/**
 * QLT-5 D (Python `IdmFaqMaterialV1`): the raw material of a unit's FAQ, for a unit with an la_faq slot: what W1
 * found about each block of the unit (its role, the source issues and gaps, the open SME questions) and the
 * feedback focus of the lesson's practices, the "why wrong" basis of the misconceptions behind their wrong options.
 * Copied as stored, so the Python bounds hold. QLT-7: `open_questions` adds the SME questions still open for the
 * lesson (its held practices and the Hold items of its Must Dos), which the FAQ must leave unanswered; the key is
 * left out when there is none.
 *
 * Owner decision 2026-10-22 (taught and flagged "Cần xem"): a unit without an la_faq slot whose blocks carry a
 * contradictory, unclear or outdated issue gets the same key with only those blocks and their issues (no gaps, no
 * questions, no practices). Python reads only their issues (`app.idm.source_flags.unit_flags`) and never gives this
 * material to the writer. Any other unit gets null, and the brief then has no `faq_material` key, as before.
 */
export function idmFaqMaterial(design: IdmCourseDesignV1, lesson: IdmLessonDesignV1,
  unit: IdmUnitDesignV1): IdmFaqMaterialV1 | null {
  if (!unit.components.some(component => component.type === 'la_faq')) return idmSourceFlagMaterial(design, unit);
  const blocks = new Map(design.blocks.map(block => [block.block_id, block]));
  return {
    blocks: unit.block_ids.map(blockId => {
      const block = blocks.get(blockId) ?? contractInvalid();
      return { block_id: blockId, name: block.name, intent: block.intent, content_kind: block.content_kind,
        support_role: block.support_role, issues: block.issues.map(item => ({ ...item, fact_keys: [...item.fact_keys] })),
        gaps: block.gaps.map(item => ({ ...item })), sme_questions: [...block.sme_questions] };
    }),
    practices: lesson.practice_tasks.filter(practice => !practice.hold).slice(0, MAX_FAQ_PRACTICES)
      .map(practice => ({ practice_id: practice.practice_id, sentence: practice.sentence,
        feedback_focus: { ...practice.feedback_focus } })),
    ...idmOpenQuestions(design, lesson),
  };
}

/** The blocks of a unit without an FAQ that carry a source point to check, with their issues; null when none. */
function idmSourceFlagMaterial(design: IdmCourseDesignV1, unit: IdmUnitDesignV1): IdmFaqMaterialV1 | null {
  const blocks = new Map(design.blocks.map(block => [block.block_id, block]));
  const flagged = unit.block_ids.map(blockId => blocks.get(blockId) ?? contractInvalid())
    .filter(block => block.issues.some(issue => IDM_SOURCE_FLAG_ISSUE_TYPES.has(issue.type)));
  if (flagged.length === 0) return null;
  return {
    blocks: flagged.map(block => ({ block_id: block.block_id, name: block.name, intent: block.intent,
      content_kind: block.content_kind, support_role: block.support_role,
      issues: block.issues.map(item => ({ ...item, fact_keys: [...item.fact_keys] })), gaps: [], sme_questions: [] })),
    practices: [],
  };
}

/** The open SME questions of a lesson (QLT-7): its held practices' questions, then the Hold items whose block serves
 * one of the lesson's Must Dos or blocks it; without repeats, at most 8 (Python `IdmFaqMaterialV1.open_questions`). */
function idmOpenQuestions(design: IdmCourseDesignV1, lesson: IdmLessonDesignV1): { open_questions?: string[] } {
  const plan = design.modules.flatMap(module => module.lessons).find(item => item.lesson_key === lesson.lesson_key);
  const mustDos = new Set(plan ? [plan.primary_must_do_id, ...plan.secondary_must_do_ids]
    .filter((id): id is string => typeof id === 'string') : []);
  const rows = new Map(design.blueprint.map(row => [row.block_id, row]));
  const questions = [
    ...lesson.practice_tasks.filter(practice => practice.hold).map(practice => practice.hold_question),
    ...design.hold_items.filter(item => [...item.blocked_must_do_ids, ...(rows.get(item.block_id)?.must_do_ids ?? [])]
      .some(id => mustDos.has(id))).map(item => item.sme_question),
  ].map(question => idmStripWhitespace(question ?? '')).filter(question => question.length > 0);
  const unique = [...new Set(questions)].slice(0, MAX_FAQ_OPEN_QUESTIONS);
  return unique.length ? { open_questions: unique } : {};
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
      // QLT-5 D: the server's plan of an la_faq slot (absent on every other slot, as in Python).
      ...(component.faq_items?.length ? { faq_items: component.faq_items.map(item => ({ ...item,
        anchor_fact_keys: [...item.anchor_fact_keys] })) } : {}),
      // QLT-9: the W4 letter of a single-choice key (absent on other slots and in older designs).
      ...(component.key_letter !== undefined ? { key_letter: component.key_letter } : {}),
    };
  });
  const faqMaterial = idmFaqMaterial(design, lessonDesign, unit);
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
    // QLT-5: the writer and the judge keep the unit on the course purpose (null for a contract-1 design).
    purpose_profile: design.purpose?.profile ?? null,
    purpose_summary: design.purpose?.summary ?? null,
    // QLT-5 C: the content mode the writer, its checks and the W5 budget follow (null: today's rules).
    fidelity_mode: design.purpose?.fidelity_mode ?? null,
    // QLT-6 (contract 3): how the author started AI ID reaches the writer; absent for an older design.
    ...(Object.hasOwn(design.project_context, 'design_mode')
      ? { design_mode: design.project_context.design_mode ?? null } : {}),
    // The run's frozen organization context (background for the writer and the judge); absent without one.
    ...(design.project_context.organization_context
      ? { organization_context: design.project_context.organization_context } : {}),
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
    ...(faqMaterial ? { faq_material: faqMaterial } : {}),
  });
}
