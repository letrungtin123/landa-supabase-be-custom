// AI ID V1 / lesson-author legacy code, moved unchanged out of chat.service.ts.
// chat.service.ts re-exports its public symbols, so existing imports keep working.
import { assertComponentInstancePlan } from '../lesson-author-capabilities.logic.js';
import {
  type LessonAuthorComponentPlan,
  type LessonAuthorComponentProposal,
  type LessonAuthorComponentType,
} from '../../../course-authoring/course-authoring.service.js';
import { stripLessonAuthorSourceRangeSuffix } from '../lesson-author-intent.logic.js';
import {
  sanitizeLessonAuthorHtml,
  validateLessonAuthorHtmlContract,
} from '../lesson-author-content-contract.logic.js';
import { readServerOwnedSourceFactIds } from '../lesson-author-component-registry.logic.js';
import { stripHtml } from '../../chat/chat-turn.logic.js';
import { MIN_UNIT_HTML_TEXT_CHARS, MAX_UNIT_HTML_CHARS } from './constants.js';

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('AI did not return valid JSON');
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readString(value: unknown, fallback: string, maxLength: number): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return (raw || fallback).slice(0, maxLength);
}

export function readOptionalNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number.parseInt(value, 10)
      : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

type LessonAuthorTitleLevel = 'chapter' | 'lesson' | 'unit';

export function normalizeLessonAuthorTitle(value: unknown, level: LessonAuthorTitleLevel, fallback: string): string {
  const safeFallback = stripLessonAuthorSourceRangeSuffix(readString(fallback, fallback, 250)).slice(0, 180);
  const original = stripLessonAuthorSourceRangeSuffix(readString(value, safeFallback, 250)).slice(0, 180);
  const pattern = level === 'chapter'
    ? /^(?:chương|chuong|chapter|phần|phan|part)\s+[0-9ivxlcdm]+(?:\s*[:.)-]\s*|\s+)/i
    : level === 'lesson'
      ? /^(?:mục|muc|section|module|sequential|bài|bai|lesson)\s+\d+(?:\.\d+)*(?:\s*[:.)-]\s*|\s+)/i
      : /^(?:bài\s+học|bai\s+hoc|lesson|unit|vertical|mục|muc)\s+\d+(?:\.\d+)*(?:\s*[:.)-]\s*|\s+)/i;

  let title = original;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = title.replace(pattern, '').trim();
    if (!next || next === title) break;
    title = next;
  }
  return title || safeFallback || original;
}

function readScalarString(value: unknown, fallback: string, maxLength: number): string {
  let raw = '';
  if (typeof value === 'string') raw = value.trim();
  else if (typeof value === 'number' && Number.isFinite(value)) raw = String(value);
  else if (typeof value === 'boolean') raw = String(value);
  return (raw || fallback).slice(0, maxLength);
}

export function sanitizeGeneratedHtml(value: unknown, minimumPlainTextChars = MIN_UNIT_HTML_TEXT_CHARS): string {
  const html = sanitizeLessonAuthorHtml(value);
  const formattingFailure = validateLessonAuthorHtmlContract(html);
  if (formattingFailure) throw new Error(`Unit HTML is invalid: ${formattingFailure}`);
  const plainText = stripHtml(html);
  if (plainText.length < minimumPlainTextChars) {
    throw new Error(`Unit content is too thin. Minimum ${minimumPlainTextChars} plain-text chars required.`);
  }
  if (html.length > MAX_UNIT_HTML_CHARS) {
    throw new Error(`Unit content is too large. Maximum ${MAX_UNIT_HTML_CHARS} HTML chars allowed.`);
  }
  return html;
}

function escapeXml(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function normalizeComponentType(value: unknown): LessonAuthorComponentProposal['type'] | null {
  const type = readString(value, '', 40).toLowerCase();
  if (type === 'html') return 'html';
  if (
    type === 'problem'
    || type === 'quiz'
    || type === 'question'
    || type === 'multiple_choice'
    || type === 'multiple-select'
    || type === 'multiple_select'
    || type === 'multi_choice'
    || type === 'multi_select'
    || type === 'mcq'
    || type === 'dropdown'
    || type === 'select'
    || type === 'numerical'
    || type === 'numeric'
    || type === 'short_text'
    || type === 'short-answer'
    || type === 'short_answer'
    || type === 'la_problem'
  ) return 'problem';
  if (type === 'la_faq' || type === 'faq') return 'la_faq';
  if (type === 'la_sortable' || type === 'sortable' || type === 'ordering') return 'la_sortable';
  if (type === 'la_crossword' || type === 'crossword' || type === 'vocabulary') return 'la_crossword';
  if (type === 'la_diagram' || type === 'diagram' || type === 'flowchart' || type === 'mindmap') return 'la_diagram';
  return null;
}

export function normalizeLessonAuthorComponentPlan(value: unknown): LessonAuthorComponentPlan[] {
  if (!Array.isArray(value)) return [];
  const instances = value.some(item => asRecord(item).component_plan_id != null);
  if (instances) assertComponentInstancePlan(value.map(item => asRecord(item) as { component_plan_id?: string }));
  const plan: LessonAuthorComponentPlan[] = [];
  const seen = new Set<LessonAuthorComponentType>();
  for (const itemValue of value) {
    const item = asRecord(itemValue);
    const type = normalizeComponentType(item.type ?? item.block_type);
    if (instances && !type) throw new Error('COMPONENT_PLAN_TYPE_INVALID');
    if (!type || (!instances && seen.has(type))) continue;
    seen.add(type);
    const title = readString(item.title ?? item.label ?? item.name, '', 180);
    const rationale = readString(item.rationale ?? item.selection_rationale, '', 600);
    const sourceFactIds = readServerOwnedSourceFactIds(item.source_fact_ids);
    const supportingEvidenceFactIds = readServerOwnedSourceFactIds(item.supporting_evidence_fact_ids);
    const purpose = readString(item.purpose ?? item.instructional_purpose, '', 32).toLowerCase();
    const contentRequirements = readStringArray(item.content_requirements, 8, 500);
    const reasonCode = readString(item.reason_code ?? item.reasonCode, '', 80);
    const learningBlockIds = readCanonicalBlueprintIds(item.learning_block_ids ?? item.learningBlockIds, 12);
    const requiredArtifacts = Array.isArray(item.required_artifacts)
      ? item.required_artifacts.flatMap((artifactValue) => {
        const artifact = asRecord(artifactValue);
        const artifactType = readString(artifact.type, '', 32).toLowerCase();
        if (!['ordered_list', 'checklist', 'table', 'warning', 'requirement', 'exception', 'comparison'].includes(artifactType)) {
          return [];
        }
        const minimumItems = readOptionalNonNegativeInteger(artifact.minimum_items);
        return [{
          type: artifactType as NonNullable<LessonAuthorComponentPlan['required_artifacts']>[number]['type'],
          ...(minimumItems && minimumItems > 0 ? { minimum_items: Math.min(minimumItems, 100) } : {}),
        }];
      }).slice(0, 6)
      : [];
    plan.push({
      type,
      ...(instances ? { component_plan_id: item.component_plan_id as string, learning_objective_refs: readCanonicalBlueprintIds(item.learning_objective_refs, 12) } : {}),
      ...(title ? { title } : {}),
      ...(rationale ? { rationale } : {}),
      ...(instances || sourceFactIds.length > 0 ? { source_fact_ids: sourceFactIds } : {}),
      ...(supportingEvidenceFactIds.length > 0 ? { supporting_evidence_fact_ids: supportingEvidenceFactIds } : {}),
      ...(purpose ? { purpose: purpose as NonNullable<LessonAuthorComponentPlan['purpose']> } : {}),
      ...(contentRequirements.length > 0 ? { content_requirements: contentRequirements } : {}),
      ...(reasonCode ? { reason_code: reasonCode } : {}),
      ...(learningBlockIds.length > 0 ? { learning_block_ids: learningBlockIds } : {}),
      ...(requiredArtifacts.length > 0 ? { required_artifacts: requiredArtifacts } : {}),
    });
    if (plan.length >= 6) break;
  }
  return plan;
}

export function getLessonAuthorComponentProvenance(component: Record<string, unknown>): Record<string, unknown> {
  const nestedMetadata = asRecord(component.metadata);
  const sourceFactIds = readServerOwnedSourceFactIds(
    component.source_fact_ids ?? nestedMetadata.source_fact_ids,
  );
  const rationale = readString(
    component.selection_rationale
      ?? component.rationale
      ?? nestedMetadata.component_selection_rationale,
    '',
    600,
  );
  const coveredSourceFactIds = readServerOwnedSourceFactIds(
    component.covered_source_fact_ids ?? nestedMetadata.covered_source_fact_ids,
  );
  const supportingEvidenceFactIds = readServerOwnedSourceFactIds(
    component.supporting_evidence_fact_ids ?? nestedMetadata.supporting_evidence_fact_ids,
  );
  return {
    ...(sourceFactIds.length > 0 ? { source_fact_ids: sourceFactIds } : {}),
    ...(typeof (component.component_plan_id ?? nestedMetadata.component_plan_id) === 'string' ? { component_plan_id: component.component_plan_id ?? nestedMetadata.component_plan_id } : {}),
    ...(coveredSourceFactIds.length > 0 ? { covered_source_fact_ids: coveredSourceFactIds } : {}),
    ...(supportingEvidenceFactIds.length > 0 ? { supporting_evidence_fact_ids: supportingEvidenceFactIds } : {}),
    ...(rationale ? { component_selection_rationale: rationale } : {}),
  };
}

export function normalizeComponentTitle(value: unknown, fallback: string): string {
  return readString(value, fallback, 180);
}

export function mergeNestedLessonAuthorContent(value: Record<string, unknown>): Record<string, unknown> {
  const nestedContent = asRecord(value.content);
  return nestedContent && Object.keys(nestedContent).length > 0
    ? { ...nestedContent, ...value }
    : value;
}

type NormalizedProblemSubtype = 'multiple_choice' | 'multiple_select' | 'dropdown' | 'numerical' | 'short_text';

function normalizeProblemSubtype(value: unknown): NormalizedProblemSubtype {
  const type = readScalarString(value, 'multiple_choice', 60)
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (['multiple_select', 'multi_select', 'checkbox', 'checkboxes', 'choiceresponse'].includes(type)) {
    return 'multiple_select';
  }
  if (['dropdown', 'option', 'select', 'option_response', 'optionresponse'].includes(type)) {
    return 'dropdown';
  }
  if (['numerical', 'numeric', 'number', 'numerical_response', 'numericalresponse'].includes(type)) {
    return 'numerical';
  }
  if (['short_text', 'short_answer', 'text', 'string', 'string_response', 'stringresponse', 'free_text'].includes(type)) {
    return 'short_text';
  }
  return 'multiple_choice';
}

function normalizeComparableText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeScalarList(value: unknown, maxLength: number): string[] {
  const rawValues = Array.isArray(value) ? value : [value];
  const values = rawValues
    .map(item => {
      const itemRecord = asRecord(item);
      return readScalarString(
        itemRecord.answer ?? itemRecord.text ?? itemRecord.label ?? itemRecord.value ?? item,
        '',
        maxLength,
      );
    })
    .filter(Boolean);
  return Array.from(new Set(values));
}

function getProblemAnswers(component: Record<string, unknown>, maxLength = 500): string[] {
  const answerSources = [
    component.answers,
    component.correct_answers,
    component.correctAnswers,
    component.answer,
    component.correct_answer,
    component.correctAnswer,
    component.expected_answer,
    component.expectedAnswer,
    component.value,
  ];

  for (const source of answerSources) {
    const answers = normalizeScalarList(source, maxLength);
    if (answers.length > 0) return answers;
  }
  return [];
}

function normalizeProblemChoices(
  rawChoices: unknown[],
  singleChoice: boolean,
  answers: string[] = [],
): Array<{ text: string; correct: boolean }> {
  const answerSet = new Set(answers.map(normalizeComparableText));
  const choices = rawChoices
    .map((choiceValue, index) => {
      if (typeof choiceValue === 'string' || typeof choiceValue === 'number') {
        const text = readScalarString(choiceValue, '', 500);
        return {
          text,
          correct: answerSet.has(normalizeComparableText(text)),
        };
      }
      const choice = asRecord(choiceValue);
      const correctValue = choice.correct ?? choice.is_correct ?? choice.answer;
      const text = readScalarString(choice.text ?? choice.label ?? choice.value ?? choice.answer, '', 500);
      return {
        text,
        correct: correctValue === true
          || String(correctValue).toLowerCase() === 'true'
          || (answerSet.size > 0 && answerSet.has(normalizeComparableText(text))),
      };
    })
    .filter(choice => choice.text)
    .slice(0, 6);

  if (choices.length < 2) {
    throw new Error('Problem component requires at least 2 answer choices');
  }

  if (new Set(choices.map(choice => normalizeComparableText(choice.text))).size !== choices.length) {
    throw new Error('PROBLEM_DUPLICATE_CHOICES');
  }
  const correctCount = choices.filter(choice => choice.correct).length;
  if (!correctCount || (singleChoice && correctCount !== 1)) {
    throw new Error('PROBLEM_CORRECT_ANSWER_INVALID');
  }
  return choices;
}

function buildProblemSolutionXml(explanation: string): string {
  return explanation
    ? `\n  <solution><div class="detailed-solution"><p>${escapeXml(explanation)}</p></div></solution>`
    : '';
}

function buildChoiceProblemXml(
  problemType: 'multiple_choice' | 'multiple_select',
  question: string,
  choices: Array<{ text: string; correct: boolean }>,
  explanation: string,
): string {
  const solution = buildProblemSolutionXml(explanation);

  if (problemType === 'multiple_select') {
    const choicesXml = choices
      .map(choice => `      <choice correct="${choice.correct ? 'true' : 'false'}">${escapeXml(choice.text)}</choice>`)
      .join('\n');
    return [
      '<problem>',
      '  <choiceresponse>',
      `    <label>${escapeXml(question)}</label>`,
      '    <checkboxgroup>',
      choicesXml,
      '    </checkboxgroup>',
      `  </choiceresponse>${solution}`,
      '</problem>',
    ].join('\n');
  }

  const choicesXml = choices
    .map(choice => `      <choice correct="${choice.correct ? 'true' : 'false'}">${escapeXml(choice.text)}</choice>`)
    .join('\n');
  return [
    '<problem>',
    '  <multiplechoiceresponse>',
    `    <label>${escapeXml(question)}</label>`,
    '    <choicegroup type="MultipleChoice">',
    choicesXml,
    '    </choicegroup>',
    `  </multiplechoiceresponse>${solution}`,
    '</problem>',
  ].join('\n');
}

function normalizeDropdownChoices(component: Record<string, unknown>): Array<{ text: string; correct: boolean }> {
  const rawOptions = Array.isArray(component.options)
    ? component.options
    : Array.isArray(component.choices)
      ? component.choices
      : [];
  const answers = getProblemAnswers(component);
  const answerSet = new Set(answers.map(normalizeComparableText));
  const choices = rawOptions
    .map((optionValue, index) => {
      if (typeof optionValue === 'string' || typeof optionValue === 'number') {
        const text = readScalarString(optionValue, '', 500);
        return {
          text,
          correct: answerSet.has(normalizeComparableText(text)),
        };
      }

      const option = asRecord(optionValue);
      const text = readScalarString(option.text ?? option.label ?? option.value ?? option.answer, '', 500);
      const correctValue = option.correct ?? option.is_correct;
      return {
        text,
        correct: correctValue === true
          || String(correctValue).toLowerCase() === 'true'
          || (answerSet.size > 0 && answerSet.has(normalizeComparableText(text))),
      };
    })
    .filter(choice => choice.text)
    .slice(0, 8);

  if (choices.length < 2) {
    throw new Error('Dropdown problem component requires at least 2 options');
  }

  if (new Set(choices.map(choice => normalizeComparableText(choice.text))).size !== choices.length) {
    throw new Error('PROBLEM_DUPLICATE_CHOICES');
  }
  if (choices.filter(choice => choice.correct).length !== 1) {
    throw new Error('PROBLEM_CORRECT_ANSWER_INVALID');
  }
  return choices;
}

function buildDropdownProblemXml(
  question: string,
  choices: Array<{ text: string; correct: boolean }>,
  explanation: string,
): string {
  const optionsXml = choices
    .map(choice => `      <option correct="${choice.correct ? 'true' : 'false'}">${escapeXml(choice.text)}</option>`)
    .join('\n');
  return [
    '<problem>',
    '  <optionresponse>',
    `    <label>${escapeXml(question)}</label>`,
    '    <optioninput>',
    optionsXml,
    '    </optioninput>',
    `  </optionresponse>${buildProblemSolutionXml(explanation)}`,
    '</problem>',
  ].join('\n');
}

function buildNumericalProblemXml(question: string, answers: string[], tolerance: string, explanation: string): string {
  const primaryAnswer = answers[0];
  const additionalAnswers = answers
    .slice(1, 5)
    .map(answer => `    <additional_answer answer="${escapeXml(answer)}" />`)
    .join('\n');
  const toleranceXml = tolerance
    ? `    <responseparam type="tolerance" default="${escapeXml(tolerance)}" />\n`
    : '';

  return [
    '<problem>',
    `  <numericalresponse answer="${escapeXml(primaryAnswer)}">`,
    `    <label>${escapeXml(question)}</label>`,
    additionalAnswers,
    `${toleranceXml}    <formulaequationinput />`,
    `  </numericalresponse>${buildProblemSolutionXml(explanation)}`,
    '</problem>',
  ].filter(line => line !== '').join('\n');
}

function buildStringProblemXml(question: string, answers: string[], caseSensitive: boolean, explanation: string): string {
  const primaryAnswer = answers[0];
  const additionalAnswers = answers
    .slice(1, 5)
    .map(answer => `    <additional_answer answer="${escapeXml(answer)}" />`)
    .join('\n');

  return [
    '<problem>',
    `  <stringresponse answer="${escapeXml(primaryAnswer)}" type="${caseSensitive ? 'cs' : 'ci'}">`,
    `    <label>${escapeXml(question)}</label>`,
    additionalAnswers,
    '    <textline size="30" />',
    `  </stringresponse>${buildProblemSolutionXml(explanation)}`,
    '</problem>',
  ].filter(line => line !== '').join('\n');
}

export function normalizeProblemComponent(component: Record<string, unknown>, fallbackTitle: string): LessonAuthorComponentProposal {
  const problemType = normalizeProblemSubtype(
    component.problem_type
      ?? component.subtype
      ?? component.response_type
      // Some providers emit the interaction subtype in `type` and omit the
      // wrapper's `problem_type`. Preserve that meaning instead of defaulting
      // every alias to multiple_choice.
      ?? component.type,
  );
  const question = readString(component.question ?? component.prompt ?? component.label, '', 1000);
  if (!question) throw new Error('Problem component requires a question');

  const explanation = readString(component.explanation ?? component.solution, '', 1500);
  let data: string;

  if (problemType === 'numerical') {
    const answers = getProblemAnswers(component, 120);
    if (answers.length === 0) throw new Error('Numerical problem component requires an answer');
    const tolerance = readScalarString(component.tolerance ?? component.error_margin ?? component.margin, '0', 40);
    data = buildNumericalProblemXml(question, answers, tolerance, explanation);
  } else if (problemType === 'short_text') {
    const answers = getProblemAnswers(component);
    if (answers.length === 0) throw new Error('String problem component requires an answer');
    const caseSensitive = component.case_sensitive === true
      || String(component.case_sensitive ?? component.caseSensitive ?? '').toLowerCase() === 'true';
    data = buildStringProblemXml(question, answers, caseSensitive, explanation);
  } else if (problemType === 'dropdown') {
    data = buildDropdownProblemXml(question, normalizeDropdownChoices(component), explanation);
  } else {
    const rawChoices = Array.isArray(component.choices) ? component.choices : [];
    const choices = normalizeProblemChoices(rawChoices, problemType !== 'multiple_select', getProblemAnswers(component));
    data = buildChoiceProblemXml(problemType, question, choices, explanation);
  }

  return {
    type: 'problem',
    title: normalizeComponentTitle(component.title, fallbackTitle),
    data,
    metadata: { weight: 1 },
  };
}

export function readStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const item of value) {
    const text = readString(item, '', maxLength);
    if (text) unique.add(text);
    if (unique.size >= maxItems) break;
  }
  return Array.from(unique);
}

/** Canonical Blueprint identifiers must survive transport exactly or fail. */
export function readCanonicalBlueprintIds(value: unknown, maxItems: number, maxLength = 96): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > maxItems) throw new Error('Blueprint canonical identifier list exceeds its contract limit.');
  const values = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('Blueprint canonical identifier is invalid.');
    const identifier = item.trim();
    if (!identifier || identifier.length > maxLength) throw new Error('Blueprint canonical identifier is invalid.');
    values.add(identifier);
  }
  return [...values];
}

export function componentTypeLabel(type: string, locale: 'vi' | 'en' = 'vi'): string {
  if (locale === 'en') {
    if (type === 'html') return 'Theory content';
    if (type === 'problem') return 'Knowledge check';
    if (type === 'la_faq') return 'FAQ';
    if (type === 'la_sortable') return 'Ordering activity';
    if (type === 'la_crossword') return 'Crossword';
    if (type === 'la_diagram') return 'Visual diagram';
    return type;
  }
  if (type === 'html') return 'Nội dung lý thuyết';
  if (type === 'problem') return 'Câu hỏi kiểm tra';
  if (type === 'la_faq') return 'Hỏi đáp';
  if (type === 'la_sortable') return 'sắp xếp ô chữ';
  if (type === 'la_crossword') return 'Đố vui ô chữ';
  if (type === 'la_diagram') return 'Sơ đồ trực quan';
  return type;
}
