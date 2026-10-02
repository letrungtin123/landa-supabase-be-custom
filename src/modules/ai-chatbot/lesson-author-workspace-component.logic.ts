import { z } from 'zod';
import type { LessonAuthorComponentPlan, LessonAuthorComponentProposal, LessonAuthorComponentType, LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import { sanitizeCourseHtmlData } from '../course-authoring/course-html-sanitizer.logic.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import { normalizeDiagramData } from '../course-authoring/diagram-data.logic.js';
import { assertAiGeneratedComponentValid } from './lesson-author-component-registry.logic.js';
import { validateLessonAuthorGeneratedUnitCoverage } from './lesson-author-content-contract.logic.js';
import { validateLessonAuthorPedagogicalQuality, validateReadyWorkspacePedagogy, type LessonAuthorPedagogicalBlueprintChapter } from './lesson-author-pedagogical-validator.logic.js';
import { generationSnapshotHash } from './lesson-author-generation-job.logic.js';
import { readWorkspaceContent, type WorkspaceContent, type WorkspaceJson } from './lesson-author-workspace.logic.js';
import { decodeWorkspaceProblem, encodeWorkspaceProblem, readWorkspaceProblem } from './lesson-author-workspace-problem.logic.js';

export const WORKSPACE_COMPONENT_ADAPTER = 'workspace-component-1';
export type WorkspaceComponentCode = 'WORKSPACE_COMPONENT_PAYLOAD_INVALID' | 'WORKSPACE_COMPONENT_REFERENCE_INVALID'
  | 'WORKSPACE_COMPONENT_STRUCTURE_PROTECTED' | 'WORKSPACE_COMPONENT_CAPABILITY_DENIED'
  | 'WORKSPACE_COMPONENT_MIRROR_CONFLICT' | 'WORKSPACE_COMPONENT_SCOPE_INCOMPLETE'
  | 'WORKSPACE_COMPONENT_BINDING_INVALID' | 'WORKSPACE_COMPONENT_ACCEPTANCE_FAILED';
export class WorkspaceComponentError extends Error {
  constructor(readonly code: WorkspaceComponentCode) { super(code); }
}
function fail(code: WorkspaceComponentCode = 'WORKSPACE_COMPONENT_PAYLOAD_INVALID'): never { throw new WorkspaceComponentError(code); }
const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : fail();
const same = (a: unknown, b: unknown) => generationSnapshotHash(a) === generationSnapshotHash(b);
// Interactive labels/Q&A are plain text in this new editor. HTML has its
// own existing sanitizer; do not smuggle markup through a generic JSON field.
const text = z.string().min(1).max(8000).refine(v => !!v.trim() && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v));
const id = z.union([z.string().min(1).max(120), z.number().int().nonnegative()]);
const faq = z.object({ items: z.array(z.object({ id, question: text, answer: text }).strict()).min(2).max(8) }).strict();
const sortable = z.object({ question_text: text, items: z.array(z.object({ id, text }).strict()).min(3).max(10) }).strict();
const coordinate = z.object({ row: z.number().int().min(0).max(255), col: z.number().int().min(0).max(255) }).strict();
const crossword = z.object({ words: z.array(z.object({ id, answer: z.string().regex(/^[A-Z0-9]{2,24}$/), clue: text,
  hint: z.string().max(8000).refine(v => !/[<>]/.test(v)), row: coordinate.shape.row, col: z.number().int().min(0).max(20), direction: z.literal('across') }).strict()).min(3).max(10),
  keyword_coordinates: z.array(coordinate).max(256) }).strict();
const diagramColor = z.string().regex(/^#[0-9a-f]{6}$/i);
const diagramText = z.string().max(8000).refine(v => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v));
const optionalDiagramTarget = z.string().max(120).optional();
// Course Outline's Diagram editor persists React Flow rendering fields next to
// its learner data. The workspace projects only the editor-owned fields below:
// unknown/transient renderer fields are accepted at this boundary and stripped,
// never reflected back into the workspace payload or trusted as authority.
const diagramPayload = z.object({
  start_diagram_id: z.string().min(1).max(120),
  diagrams: z.array(z.object({
    id: z.string().min(1).max(120),
    name: text,
    nodes: z.array(z.object({
      id: z.string().min(1).max(120),
      type: z.enum(['customShape', 'junction']),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
      data: z.object({
        label: diagramText,
        shape: z.enum(['rectangle', 'rounded', 'ellipse']).optional(),
        bgColor: diagramColor.optional(),
        textColor: diagramColor.optional(),
        tooltip: diagramText.optional(),
        target_diagram_id: optionalDiagramTarget,
      }),
    })).min(2).max(200),
    edges: z.array(z.object({
      id: z.string().min(1).max(120),
      source: z.string().min(1).max(120),
      target: z.string().min(1).max(120),
      label: text.optional(),
      sourceHandle: z.string().min(1).max(120).optional(),
      targetHandle: z.string().min(1).max(120).optional(),
      data: z.object({
        routing: z.enum(['feedback', 'orthogonal']).optional(),
        appearance: z.object({
          lineStyle: z.enum(['solid', 'dashed']),
          arrow: z.enum(['none', 'end']),
          color: diagramColor,
        }).optional(),
      }).optional(),
    })).max(400),
  })).min(1).max(32),
});
function keyFor(type: LessonAuthorComponentType): string {
  const keys: Partial<Record<LessonAuthorComponentType, string>> = { la_faq: 'faq_data', la_sortable: 'sortable_data', la_crossword: 'crossword_data', la_diagram: 'diagram_data' };
  return keys[type] ?? fail();
}
function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fail(); }
}
function payload(component: LessonAuthorComponentProposal): unknown {
  if (component.type === 'html') return component.data;
  if (component.type === 'problem') return decodeWorkspaceProblem(component.data);
  const key = keyFor(component.type);
  if (!key) fail();
  const data = record(component.data), meta = component.metadata ?? {};
  const a = data[key] === undefined ? undefined : parsed(data[key]);
  const b = meta[key] === undefined ? undefined : parsed(meta[key]);
  if (a !== undefined && b !== undefined && !same(a, b)) fail('WORKSPACE_COMPONENT_MIRROR_CONFLICT');
  const value = a ?? b;
  if (value === undefined) fail();
  if (component.type !== 'la_sortable') return value;
  if (meta.question_text !== undefined && data.question_text !== undefined && meta.question_text !== data.question_text) fail('WORKSPACE_COMPONENT_MIRROR_CONFLICT');
  return { ...record(value), question_text: meta.question_text ?? data.question_text };
}
function unique(values: unknown[]) { if (new Set(values.map(v => String(v))).size !== values.length) fail('WORKSPACE_COMPONENT_REFERENCE_INVALID'); }
function diagram(value: unknown) {
  const parsedDiagram = diagramPayload.safeParse(value);
  if (!parsedDiagram.success) fail();
  const d = parsedDiagram.data;
  // The existing AI normalizer emits an empty string for nodes without a
  // drill-down target. Omit it from the typed workspace JSON rather than
  // persisting an undefined value or treating it as a broken reference.
  for (const item of d.diagrams) for (const node of item.nodes) {
    if (node.data.target_diagram_id === '') delete node.data.target_diagram_id;
  }
  unique(d.diagrams.map((v: unknown) => record(v).id));
  if (!d.diagrams.some((v: unknown) => record(v).id === d.start_diagram_id)) fail('WORKSPACE_COMPONENT_REFERENCE_INVALID');
  for (const raw of d.diagrams) {
    const item = record(raw);
    if (typeof item.id !== 'string' || !id.safeParse(item.id).success || !text.safeParse(item.name).success) fail();
    if (!Array.isArray(item.nodes) || item.nodes.length < 2 || item.nodes.length > 200
      || !Array.isArray(item.edges) || item.edges.length > 400) fail();
    unique(item.nodes.map((n: unknown) => record(n).id)); unique(item.edges.map((e: unknown) => record(e).id));
    for (const n of item.nodes) {
      if (!id.safeParse(n.id).success || typeof n.id !== 'string' || !['customShape', 'junction'].includes(n.type)
        || !Number.isFinite(n.position?.x) || !Number.isFinite(n.position?.y)
        || typeof n.data?.label !== 'string' || (n.type !== 'junction' && !text.safeParse(n.data.label).success)
        || /[<>]/.test(n.data.label)) fail();
      if (n.data.target_diagram_id !== undefined
        && !d.diagrams.some(candidate => candidate.id === n.data.target_diagram_id)) fail('WORKSPACE_COMPONENT_REFERENCE_INVALID');
    }
    const ids = new Set(item.nodes.map((n: any) => n.id));
    for (const edge of item.edges) {
      if (!id.safeParse(edge.id).success || typeof edge.id !== 'string' || edge.source === edge.target
        || !ids.has(edge.source) || !ids.has(edge.target)) fail('WORKSPACE_COMPONENT_REFERENCE_INVALID');
      if (edge.label !== undefined && !text.safeParse(edge.label).success) fail();
    }
  }
  // Validate against the current renderer contract, but never accept its
  // dropped edges, rewritten IDs or fallback start diagram as a silent fix.
  const normalized = normalizeDiagramData(d);
  if (normalized.diagrams.some((item, i) => item.edges.length !== d.diagrams[i].edges.length
    || item.edges.some((edge, j) => edge.id !== d.diagrams[i].edges[j].id))) fail('WORKSPACE_COMPONENT_REFERENCE_INVALID');
  return d;
}
function validatePayload(type: LessonAuthorComponentType, value: unknown) {
  if (type === 'problem') return readWorkspaceProblem(value);
  if (type === 'html') {
    try { return sanitizeCourseHtmlData(value); }
    catch { return fail(); }
  }
  if (type === 'la_diagram') return diagram(value);
  const schema = type === 'la_faq' ? faq : type === 'la_sortable' ? sortable : type === 'la_crossword' ? crossword : null;
  const parsedPayload = schema?.safeParse(value);
  if (!parsedPayload?.success) fail();
  const data = record(parsedPayload.data);
  const rows = type === 'la_crossword' ? data.words : data.items;
  unique(rows.map((row: any) => row.id));
  unique(rows.map((row: any) => String(row.question ?? row.text ?? row.answer).normalize('NFKC').trim().toLowerCase()));
  if (type === 'la_crossword') {
    // Current LMS crossword displays one across word per row. Do not invent
    // down-word/grid support that its renderer does not implement.
    unique(rows.map((row: any) => row.row));
    const cells = new Set<string>();
    for (const [index, word] of rows.entries()) {
      if (word.row !== index || word.col + word.answer.length > 30) fail('WORKSPACE_COMPONENT_REFERENCE_INVALID');
      for (let col = word.col; col < word.col + word.answer.length; col++) {
        cells.add(`${word.row}:${col}`);
      }
    }
    unique(data.keyword_coordinates.map((c: any) => `${c.row}:${c.col}`));
    if (data.keyword_coordinates.some((c: any) => !cells.has(`${c.row}:${c.col}`)
      || c.col !== data.keyword_coordinates[0].col)) fail('WORKSPACE_COMPONENT_REFERENCE_INVALID');
  }
  return parsedPayload.data;
}
/** Text-only projection used to compare immutable identities/answer wiring.
 * Content edits may alter answer values, not silently reorder/remove items. */
function structure(type: LessonAuthorComponentType, value: unknown): unknown {
  if (type === 'html') return null;
  const data = structuredClone(record(value));
  if (type === 'problem') {
    // The component discriminator and protected workspace binding remain
    // server-owned, but every learner-facing Problem field exposed by the
    // canonical Course Outline form (including subtype, answer cardinality
    // and hints) is editable inside the draft.
    return null;
  }
  // FAQ/Sortable/Crossword/Diagram use their canonical outline editors. Their
  // complete validated payload is author-editable; IDs stay data-local and
  // cannot alter the immutable component binding or its provenance.
  return null;
}
function compile(original: LessonAuthorComponentProposal, content: WorkspaceContent): LessonAuthorComponentProposal {
  const next = structuredClone(original);
  next.title = content.title;
  if (next.type === 'html') next.data = content.data;
  else if (next.type === 'problem') next.data = encodeWorkspaceProblem(content.data);
  else {
    const key = keyFor(next.type), data = structuredClone(record(content.data));
    const question = data.question_text;
    if (next.type === 'la_sortable') delete data.question_text;
    next.data = { ...record(next.data), [key]: JSON.stringify(data) };
    next.metadata = { ...next.metadata, [key]: data };
    if (next.type === 'la_sortable') {
      (next.data as Record<string, unknown>).question_text = question;
      next.metadata.question_text = question;
    }
  }
  return next;
}
/** Server-owned original supplies type and metadata. Never accept original
 * or capability authority from an HTTP body. No DB/provider work here. */
export function workspaceComponentContent(original: LessonAuthorComponentProposal,
  allowed: ReadonlySet<CourseComponentType>, notes: { purpose?: string | null; implementation_notes?: string | null } = {}): WorkspaceContent {
  try {
    if (!allowed.has(original.type)) fail('WORKSPACE_COMPONENT_CAPABILITY_DENIED');
    const projected = validatePayload(original.type, payload(original)) as WorkspaceJson;
    const content = readWorkspaceContent({ title: original.title, purpose: notes.purpose ?? null,
      data: projected, implementation_notes: notes.implementation_notes ?? null });
    assertAiGeneratedComponentValid(original, allowed);
    return content;
  } catch (error) { if (error instanceof WorkspaceComponentError) throw error; return fail(); }
}

/** Canonical author-edit projection. Generation policy is deliberately not
 * re-applied here: Course Outline owns the authoring contract, while immutable
 * type/capability/provenance and typed payload/reference checks remain closed.
 */
function workspaceAuthorComponentContent(original: LessonAuthorComponentProposal,
  allowed: ReadonlySet<CourseComponentType>): WorkspaceContent {
  try {
    if (!allowed.has(original.type)) fail('WORKSPACE_COMPONENT_CAPABILITY_DENIED');
    return readWorkspaceContent({ title: original.title, purpose: null,
      data: validatePayload(original.type, payload(original)) as WorkspaceJson,
      implementation_notes: null });
  } catch (error) { if (error instanceof WorkspaceComponentError) throw error; return fail(); }
}

export function editWorkspaceComponent(original: LessonAuthorComponentProposal, input: unknown,
  allowed: ReadonlySet<CourseComponentType>): LessonAuthorComponentProposal {
  try {
    const baseline = workspaceComponentContent(original, allowed);
    const received = readWorkspaceContent(input);
    const content = { ...received, data: validatePayload(original.type, received.data) as WorkspaceJson };
    if (structure(original.type, baseline.data) !== null
      && !same(structure(original.type, baseline.data), structure(original.type, content.data))) fail('WORKSPACE_COMPONENT_STRUCTURE_PROTECTED');
    // Preserve the original bytes/mirrors for a title-only change or Reset.
    // No normalizer may rewrite unrelated accepted payload/metadata.
    const result = same(content.data, baseline.data) ? { ...structuredClone(original), title: content.title } : compile(original, content);
    // Author edits follow Course Outline's canonical payload contract. The AI
    // generation gate (minimum teaching length/item counts/artifacts) remains
    // mandatory for revision 0, but must not reject a safe manual edit.
    workspaceAuthorComponentContent(result, allowed);
    return result;
  } catch (error) { if (error instanceof WorkspaceComponentError) throw error; return fail(); }
}

const bindingSchema = z.object({
  binding_version: z.literal(1),
  component_type: z.enum(['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram']),
  display_title: z.string().min(1).max(500).optional(),
  metadata: z.record(z.unknown()),
}).strict();
function readBinding(value: unknown) {
  const forbidden = new Set(['__proto__', 'constructor', 'prototype', 'faq_data', 'sortable_data', 'crossword_data', 'diagram_data', 'question_text']);
  function visit(v: unknown, depth: number) {
    if (depth > 32) fail('WORKSPACE_COMPONENT_BINDING_INVALID');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || (Object.getPrototypeOf(v) !== Object.prototype && !Array.isArray(v))) fail('WORKSPACE_COMPONENT_BINDING_INVALID');
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (typeof key !== 'string' || forbidden.has(key) || !('value' in descriptor)) fail('WORKSPACE_COMPONENT_BINDING_INVALID');
      visit(descriptor.value, depth + 1);
    }
  }
  // Check before Zod: object parsers may intentionally omit __proto__.
  visit(value, 0);
  const parsedBinding = bindingSchema.safeParse(value);
  if (!parsedBinding.success) fail('WORKSPACE_COMPONENT_BINDING_INVALID');
  const binding = parsedBinding.data;
  // Server-owned JSON only. Mirrors belong exclusively to revision content.
  const serialized = JSON.stringify(binding);
  if (!serialized || Buffer.byteLength(serialized) > 131072
    || !same(JSON.parse(serialized), binding)) fail('WORKSPACE_COMPONENT_BINDING_INVALID');
  if (typeof binding.metadata.component_plan_id !== 'string' || !binding.metadata.component_plan_id
    || binding.metadata.component_plan_id.length > 160) fail('WORKSPACE_COMPONENT_BINDING_INVALID');
  for (const key of ['source_fact_ids', 'supporting_evidence_fact_ids', 'covered_source_fact_ids', 'learning_objective_refs']) {
    const refs = binding.metadata[key];
    if (refs !== undefined && (!Array.isArray(refs) || refs.length > 4096
      || refs.some(ref => typeof ref !== 'string' || !ref.length || ref.length > 160 || ref.trim() !== ref)
      || new Set(refs).size !== refs.length)) fail('WORKSPACE_COMPONENT_BINDING_INVALID');
  }
  return structuredClone(binding);
}

/** Standalone accepted-content split, NOT the planned graph inventory builder.
 * Planned nodes MUST freeze a plan binding before generation (see below).
 * Never a browser input.
 * Baseline content is canonical typed learner data; protected binding retains
 * metadata but not a stale second copy of the interactive payload.
 */
export function workspaceComponentStorage(original: LessonAuthorComponentProposal, allowed: ReadonlySet<CourseComponentType>) {
  const content = workspaceComponentContent(original, allowed);
  const metadata = structuredClone(original.metadata ?? {});
  if (!['html', 'problem'].includes(original.type)) {
    const key = keyFor(original.type);
    const shell = record(original.data);
    if (Object.keys(shell).some(field => field !== key && !(original.type === 'la_sortable' && field === 'question_text'))) fail('WORKSPACE_COMPONENT_BINDING_INVALID');
    delete metadata[key];
    if (original.type === 'la_sortable') delete metadata.question_text;
  }
  const binding = readBinding({ binding_version: 1, component_type: original.type, metadata });
  return { content, binding };
}

/** Identity/provenance for a planned node must exist BEFORE structure_ready.
 * The worker cannot replace this immutable contract with generated metadata.
 * Coverage here is the required canonical set, not a claim that text was
 * generated/verified. Baseline publication still requires generation coverage
 * acceptance against this plan; never use this helper to manufacture PASS.
 */
export function workspaceComponentPlanBinding(plan: LessonAuthorComponentPlan) {
  return readBinding({ binding_version: 1, component_type: plan.type,
    ...(plan.title ? { display_title: plan.title } : {}),
    metadata: {
      component_plan_id: plan.component_plan_id,
      source_fact_ids: plan.source_fact_ids ?? [],
      covered_source_fact_ids: plan.source_fact_ids ?? [],
      supporting_evidence_fact_ids: plan.supporting_evidence_fact_ids ?? [],
      learning_objective_refs: plan.learning_objective_refs ?? [],
      generated_by: 'lesson_author_ai',
      ...(plan.type === 'problem' ? { weight: 1 } : {}),
    },
  });
}

/** Rehydrate ONLY hash-checked stored binding + revision-0 content. XML is
 * deterministically reserialized; byte preservation applies to editing an
 * in-memory CMS original, not to this typed persisted representation.
 */
export function hydrateWorkspaceComponent(bindingInput: unknown, baselineInput: unknown,
  allowed: ReadonlySet<CourseComponentType>): LessonAuthorComponentProposal {
  try {
    const binding = readBinding(bindingInput), received = readWorkspaceContent(baselineInput);
    if (!allowed.has(binding.component_type)) fail('WORKSPACE_COMPONENT_CAPABILITY_DENIED');
    const baseline = { ...received, data: validatePayload(binding.component_type, received.data) as WorkspaceJson };
    const courseMetadata = structuredClone(binding.metadata);
    // Author-review context is workspace-only. It must never leak into the
    // canonical course component written by Apply.
    delete courseMetadata.author_review;
    const component = compile({ type: binding.component_type, title: baseline.title, data: {}, metadata: courseMetadata }, baseline);
    assertAiGeneratedComponentValid(component, allowed);
    return component;
  } catch (error) { if (error instanceof WorkspaceComponentError) throw error; return fail('WORKSPACE_COMPONENT_BINDING_INVALID'); }
}

/** Full *ready* chapter check, not an HTTP acceptance receipt or source-fidelity
 * claim. The production transaction materializer is still required. Never
 * call this with placeholder/pending units and report its result as PASS. */
export function validateWorkspaceComponentChapter(input: {
  proposal: LessonAuthorProposal; blueprint: LessonAuthorPedagogicalBlueprintChapter;
  allowed: ReadonlySet<CourseComponentType>;
}) {
  return validateWorkspaceChapter(input);
}

/** Separate Save-only contract; never accepted as final Apply validation. */
export function validateWorkspaceReadyComponentChapter(input: {
  proposal: LessonAuthorProposal; blueprint: LessonAuthorPedagogicalBlueprintChapter;
  allowed: ReadonlySet<CourseComponentType>; readyUnits: ReadonlySet<string>;
}) {
  return validateWorkspaceChapter(input, input.readyUnits);
}
function validateWorkspaceChapter(input: {
  proposal: LessonAuthorProposal; blueprint: LessonAuthorPedagogicalBlueprintChapter;
  allowed: ReadonlySet<CourseComponentType>;
}, readyUnits?: ReadonlySet<string>) {
  const { proposal, blueprint, allowed } = input;
  if (proposal.chapters.length !== 1 || !blueprint.lessons.length
    || proposal.chapters[0].lessons.length !== blueprint.lessons.length) fail('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE');
  const findings: Array<{ code: string; path: string }> = [];
  const seenReady = new Set<string>();
  for (const [li, expected] of blueprint.lessons.entries()) {
    const lesson = proposal.chapters[0].lessons[li];
    if (!expected.units.length || lesson.units.length !== expected.units.length) fail('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE');
    for (const [ui, unit] of lesson.units.entries()) {
      const path = `chapter_1.lesson_${li + 1}.unit_${ui + 1}`;
      if (readyUnits && !readyUnits.has(`${li}:${ui}`)) {
        if (unit.components?.length || unit.html) fail('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE');
        continue;
      }
      seenReady.add(`${li}:${ui}`);
      if (!unit.components?.length || !expected.units[ui].component_plan?.length) fail('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE');
      let sawFaq = false;
      for (const [ci, component] of unit.components.entries()) {
        if (sawFaq && component.type !== 'la_faq') findings.push({ code: 'WORKSPACE_FAQ_NOT_LAST', path });
        sawFaq ||= component.type === 'la_faq';
        try { workspaceAuthorComponentContent(component, allowed); }
        catch (e) { findings.push({ code: e instanceof WorkspaceComponentError ? e.code : 'WORKSPACE_COMPONENT_PAYLOAD_INVALID', path: `${path}.component_${ci + 1}` }); }
      }
      const coverage = validateLessonAuthorGeneratedUnitCoverage(expected.units[ui], unit.components.map(c => ({
        type: c.type, data: c.data, component_plan_id: c.metadata?.component_plan_id as string | undefined,
        source_fact_ids: c.metadata?.source_fact_ids as string[] | undefined,
        supporting_evidence_fact_ids: c.metadata?.supporting_evidence_fact_ids as string[] | undefined,
        covered_source_fact_ids: c.metadata?.covered_source_fact_ids as string[] | undefined,
      })));
      if (coverage) findings.push({ code: 'WORKSPACE_COMPONENT_COVERAGE_INVALID', path });
    }
  }
  if (readyUnits && (!seenReady.size || seenReady.size !== readyUnits.size)) fail('WORKSPACE_COMPONENT_SCOPE_INCOMPLETE');
  const pedagogy = readyUnits
    ? validateReadyWorkspacePedagogy({ proposal, blueprint_chapter: blueprint, readyUnits })
    : { ...validateLessonAuthorPedagogicalQuality({ proposal, blueprint_chapter: blueprint }), deferred_checks: [], scope_complete: true };
  findings.push(...pedagogy.findings.filter(f => f.severity === 'error').map(f => ({ code: f.code, path: f.path })));
  return { status: findings.length ? 'FAIL' as const : pedagogy.status, findings,
    warnings: pedagogy.findings.filter(f => f.severity === 'warning').map(f => ({ code: f.code, path: f.path })),
    semantic_fidelity: 'not_measured' as const, validation_contract: readyUnits ? 'workspace-component-edit-ready-1' : WORKSPACE_COMPONENT_ADAPTER,
    scope_complete: pedagogy.scope_complete, deferred_checks: pedagogy.deferred_checks };
}
