import type { LessonAuthorComponentProposal } from '../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import type { WorkspaceChapterGenerationContext } from './lesson-author-workspace-generation-context.repository.js';
import type { RagChapterCheckpointRequest } from './lesson-author-chapter-rag-contract.logic.js';
import { readRagChapterCheckpointResponse } from './lesson-author-chapter-rag-contract.logic.js';
import { workspaceComponentContent, validateWorkspaceComponentChapter } from './lesson-author-workspace-component.logic.js';
import { readWorkspaceProblem } from './lesson-author-workspace-problem.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { projectBlueprintDraftArchitecture } from './lesson-author-blueprint-draft-architecture.logic.js';

export class WorkspaceChapterValidationError extends Error {
  constructor(readonly code: 'WORKSPACE_CHAPTER_CONTEXT_INVALID' | 'WORKSPACE_CHAPTER_WIRE_UNSUPPORTED'
    | 'WORKSPACE_CHAPTER_VALIDATION_FAILED' | 'WORKSPACE_CHAPTER_RESPONSE_CHANGED',
    readonly findings: readonly { code: string; path: string }[] = []) { super(code); }
}
function invalid(code: WorkspaceChapterValidationError['code']): never { throw new WorkspaceChapterValidationError(code); }
function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('WORKSPACE_CHAPTER_WIRE_UNSUPPORTED');
  return value as Record<string, any>;
}

/** Projection for the EXISTING strict Python validation endpoint, not a new
 * generation schema. Input is a stored, hash-verified revision-0 CMS component.
 * Learner semantics and provenance are retained; CMS layout/IDs stay in the
 * baseline and are NOT replaced with the returned Python projection. */
export function workspaceComponentValidationWire(component: LessonAuthorComponentProposal, allowed: ReadonlySet<CourseComponentType>): Record<string, unknown> {
  const content = workspaceComponentContent(component, allowed);
  const meta = component.metadata ?? {};
  if (typeof meta.component_plan_id !== 'string') invalid('WORKSPACE_CHAPTER_CONTEXT_INVALID');
  const refs: Record<string, unknown> = {};
  for (const field of ['source_fact_ids', 'covered_source_fact_ids', 'supporting_evidence_fact_ids', 'learning_objective_refs']) {
    const values = meta[field] ?? [];
    if (!Array.isArray(values) || values.some(v => typeof v !== 'string') || new Set(values).size !== values.length)
      invalid('WORKSPACE_CHAPTER_CONTEXT_INVALID');
    refs[field] = [...values];
  }
  const common = { type: component.type, title: component.title, component_plan_id: meta.component_plan_id, ...refs };
  if (component.type === 'html') return { ...common, html: content.data };
  if (component.type === 'problem') {
    const p = readWorkspaceProblem(content.data);
    const base = { ...common, problem_type: p.kind, question: p.question, explanation: p.explanation };
    if ('choices' in p) {
      if (p.kind !== 'dropdown' && p.choices.length > 6) invalid('WORKSPACE_CHAPTER_WIRE_UNSUPPORTED');
      return p.kind === 'dropdown'
        ? { ...base, options: p.choices.map(c => c.text), answer: p.choices.find(c => c.correct)!.text }
        : { ...base, choices: structuredClone(p.choices) };
    }
    return { ...base, answer: p.answers[0], answers: [...p.answers],
      ...(p.kind === 'short_text' ? { case_sensitive: p.case_sensitive } : { tolerance: p.tolerance }) };
  }
  const data = record(content.data);
  if (component.type === 'la_faq') return { ...common, items: data.items.map((r: any) => ({ question: r.question, answer: r.answer })) };
  if (component.type === 'la_sortable') return { ...common, question_text: data.question_text,
    items: data.items.map((r: any) => ({ text: r.text })) };
  if (component.type === 'la_crossword') return { ...common,
    words: data.words.map((r: any) => ({ answer: r.answer, clue: r.clue, hint: r.hint })) };
  if (component.type !== 'la_diagram' || data.diagrams.length !== 1) return invalid('WORKSPACE_CHAPTER_WIRE_UNSUPPORTED');
  const d = data.diagrams[0];
  if (d.nodes.length > 20 || d.edges.length < 1 || d.edges.length > 40
    || d.nodes.some((n: any) => n.type !== 'customShape')) invalid('WORKSPACE_CHAPTER_WIRE_UNSUPPORTED');
  const ids = d.nodes.map((n: any) => n.id);
  return { ...common, name: d.name,
    nodes: d.nodes.map((n: any) => ({ label: n.data.label,
      ...(n.data.shape === undefined ? {} : { shape: n.data.shape }),
      ...(n.data.tooltip === undefined ? {} : { tooltip: n.data.tooltip }) })),
    edges: d.edges.map((e: any) => ({ source: ids.indexOf(e.source), target: ids.indexOf(e.target),
      ...(e.label === undefined ? {} : { label: e.label }) })) };
}

export function workspaceChapterValidationUnits(context: WorkspaceChapterGenerationContext) {
  const { blueprint, chapterIndex, proposal, allowed } = context;
  const chapter = blueprint.chapters[chapterIndex];
  if (!chapter || blueprint.architecture_contract_version !== 5 || blueprint.content_contract_version !== 1
    || proposal.chapters.length !== 1 || proposal.chapters[0].title !== chapter.title)
    invalid('WORKSPACE_CHAPTER_CONTEXT_INVALID');
  const result = validateWorkspaceComponentChapter({ proposal, blueprint: chapter, allowed });
  if (result.status === 'FAIL' || !result.scope_complete || result.deferred_checks.length)
    throw new WorkspaceChapterValidationError('WORKSPACE_CHAPTER_VALIDATION_FAILED', result.findings);
  let ordinal = 0;
  return chapter.lessons.flatMap((l, li) => l.units.map((u, ui) => {
    const actual = proposal.chapters[0].lessons[li]?.units[ui];
    if (!actual || actual.title !== u.title || proposal.chapters[0].lessons[li].title !== l.title
      || actual.components?.length !== u.component_plan.length) invalid('WORKSPACE_CHAPTER_CONTEXT_INVALID');
    return { unit_index: ordinal++, unit: { title: u.title, source_refs: [...(u.source_refs ?? [])],
      source_fact_ids: [...(u.source_fact_ids ?? [])], supporting_evidence_fact_ids: [...(u.supporting_evidence_fact_ids ?? [])],
      components: actual.components!.map((c, i) => {
        if (c.metadata?.component_plan_id !== u.component_plan[i].component_plan_id || c.type !== u.component_plan[i].type)
          invalid('WORKSPACE_CHAPTER_CONTEXT_INVALID');
        return workspaceComponentValidationWire(c, allowed);
      }) } };
  }));
}

/** Python finalization validates only: it must not mutate an immutable accepted
 * unit. Match exactly the sent units, then re-run Node full-chapter validators
 * on the stored CMS baseline, not on a lossy re-normalization of Python output. */
export function acceptWorkspaceChapterValidation(context: WorkspaceChapterGenerationContext,
  request: RagChapterCheckpointRequest, raw: unknown) {
  if (request.checkpoint_action !== 'validate_chapter' || request.correlation_id !== context.correlation_id
    || hash(request.blueprint_architecture) !== hash(projectBlueprintDraftArchitecture(context.blueprint, context.chapterIndex))
    || hash(request.checkpoint_units) !== hash(workspaceChapterValidationUnits(context))) invalid('WORKSPACE_CHAPTER_CONTEXT_INVALID');
  const response = readRagChapterCheckpointResponse(raw, request);
  if (response.status !== 'ready') return invalid('WORKSPACE_CHAPTER_RESPONSE_CHANGED');
  const chapters = response.proposal.chapters;
  const chapter = context.blueprint.chapters[context.chapterIndex];
  if (!Array.isArray(chapters) || chapters.length !== 1) invalid('WORKSPACE_CHAPTER_RESPONSE_CHANGED');
  const actual = record(chapters[0]);
  if (actual.title !== chapter.title || !Array.isArray(actual.lessons) || actual.lessons.length !== chapter.lessons.length)
    invalid('WORKSPACE_CHAPTER_RESPONSE_CHANGED');
  let ordinal = 0;
  for (const [li, expected] of chapter.lessons.entries()) {
    const lesson = record(actual.lessons[li]);
    if (lesson.title !== expected.title || !Array.isArray(lesson.units) || lesson.units.length !== expected.units.length)
      invalid('WORKSPACE_CHAPTER_RESPONSE_CHANGED');
    for (const unit of lesson.units) {
      if (hash(unit) !== hash(request.checkpoint_units[ordinal++].unit)) invalid('WORKSPACE_CHAPTER_RESPONSE_CHANGED');
    }
  }
  return { input_context_hash: context.input_context_hash,
    result_hash: hash({ input_context_hash: context.input_context_hash, proposal: context.proposal,
      contract: 'workspace-chapter-baseline-1' }), validation_contract: 'workspace-chapter-baseline-1' as const,
    usage: { usage: response.usage, usage_source: response.usage_source, usage_complete: response.usage_complete } };
}
