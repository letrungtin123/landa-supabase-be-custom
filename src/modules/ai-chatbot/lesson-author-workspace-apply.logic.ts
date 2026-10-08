import { z } from 'zod';
import type { LessonAuthorBlueprint, LessonAuthorBlueprintChapter } from './chat.service.js';
import type { LessonAuthorComponentProposal, LessonAuthorProposal } from '../course-authoring/course-authoring.service.js';
import type { CourseComponentType } from '../tenants/tenant-course-components.constants.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { readWorkspaceContent, assertWorkspaceApplyReady, type WorkspaceContent, type WorkspaceNodeKind } from './lesson-author-workspace.logic.js';
import { buildWorkspaceInventory } from './lesson-author-workspace-inventory.logic.js';
import { workspaceStoryboardSeed, editWorkspaceStoryboard } from './lesson-author-workspace-storyboard.logic.js';
import { hydrateWorkspaceComponent, editWorkspaceComponent, workspaceAuthorComponentContent, validateWorkspaceComponentChapter } from './lesson-author-workspace-component.logic.js';
import { detectLessonAuthorGeneratedContentDuplicates } from './lesson-author-pedagogical-validator.logic.js';

export const WORKSPACE_SCOPED_APPLY_CONTRACT = 'workspace-scoped-apply-1';
export const WORKSPACE_APPLY_MAX_PAIRS = 131_072;
export type WorkspaceApplyCompileCode = 'WORKSPACE_APPLY_INPUT_INVALID' | 'WORKSPACE_APPLY_SCOPE_INVALID'
  | 'WORKSPACE_APPLY_HASH_INVALID' | 'WORKSPACE_APPLY_REVISION_CONFLICT' | 'WORKSPACE_APPLY_CONTEXT_INCOMPLETE'
  | 'WORKSPACE_APPLY_BINDING_INVALID' | 'WORKSPACE_APPLY_VALIDATION_FAILED' | 'WORKSPACE_APPLY_DEPENDENCY_REQUIRED'
  | 'WORKSPACE_APPLY_TARGET_CHANGED' | 'WORKSPACE_APPLY_LIMIT';
export class WorkspaceApplyCompileError extends Error {
  constructor(readonly code: WorkspaceApplyCompileCode, readonly findings: Array<{ code: string; path: string }> = []) {
    super(code); this.name = 'WorkspaceApplyCompileError';
  }
}
function fail(code: WorkspaceApplyCompileCode, path = ''): never { throw new WorkspaceApplyCompileError(code, path ? [{ code, path }] : []); }
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.string().uuid();
const ordinal = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const revisionSchema = z.object({ node_id: id, revision: ordinal, content_hash: digest }).strict();
export type WorkspaceApplyRevision = z.infer<typeof revisionSchema>;
const nodeSchema = z.object({
  node_id: id, parent_id: id, kind: z.enum(['chapter', 'lesson', 'unit', 'component', 'media_brief']),
  canonical_path: z.string().min(1).max(240), sort_order: ordinal,
  content_state: z.enum(['planned', 'generating', 'content_ready', 'needs_action']), current_revision: ordinal.nullable(),
  protected_contract: z.record(z.unknown()), contract_hash: digest,
  baseline: z.object({ content: z.unknown(), content_hash: digest }).strict().nullable(),
  current: z.object({ content: z.unknown(), content_hash: digest }).strict().nullable(),
}).strict();
export type WorkspaceApplyNode = z.infer<typeof nodeSchema>;
const mappingSchema = z.object({ node_id: id, target_block_id: id, target_parent_id: id,
  target_block_type: z.string().min(1), target_sort_order: ordinal,
  applied_revision: ordinal, applied_content_hash: digest, target_hash: digest, actual_target_hash: digest,
  receipt_revision_manifest: z.array(revisionSchema).min(1).max(8192),
}).strict();
export type WorkspaceApplyMapping = z.infer<typeof mappingSchema>;
export interface WorkspaceApplyTargets {
  course_root_id: string;
  course_root_hash: string;
  /** Server-loaded mappings, current SQL row fingerprints and their immutable
   * receipts. Never accept target IDs/mapping evidence from an HTTP body. */
  mappings: WorkspaceApplyMapping[];
}
export interface WorkspaceApplyCompileInput {
  workspace_id: string; course_node_id: string; content_locale: 'en' | 'vi'; event_head: number;
  source_snapshot_hash: string; runtime_config_hash: string;
  blueprint: LessonAuthorBlueprint; blueprint_hash: string;
  /** Exact nodes for chapters 1..selected chapter, including optional briefs.
   * Course metadata is intentionally excluded from reads and writes. */
  nodes: readonly WorkspaceApplyNode[];
  /** Actual persisted accepted AI proposals, one complete chapter each. Their
   * payloads are checked against revision 0 and revalidated, never trusted PASS. */
  accepted_baselines: readonly { chapter_path: string; proposal: LessonAuthorProposal; content_hash: string }[];
  allowed: ReadonlySet<CourseComponentType>;
  targets: WorkspaceApplyTargets;
  request: {
    scope_node_id: string; expected_workspace_revision: number;
    expected_revision_manifest: readonly WorkspaceApplyRevision[];
    expected_target_snapshot_hash: string;
  };
}
export interface WorkspaceApplyWrite {
  node_id: string; parent_node_id: string; canonical_path: string; kind: Exclude<WorkspaceNodeKind, 'course' | 'media_brief'>;
  block_type: string; sort_order: number; revision: number; content_hash: string;
  title: string;
  /** Only typed learner payload plus immutable instance/source metadata. */
  component: LessonAuthorComponentProposal | null;
  /** Explicit author-only channel. Repository must not append this to HTML,
   * problem XML, learner component data or create media blocks from briefs. */
  author_metadata: { purpose: string | null; implementation_notes: string | null; storyboard: unknown;
    /** Component only: workspace review context from the protected binding. */
    author_review: unknown;
    media_briefs: Array<{ node_id: string; revision: number; content_hash: string; media_type: string | null; content: WorkspaceContent }> };
  mapped_target: { block_id: string; parent_id: string; sort_order: number; before_hash: string } | null;
}

export interface WorkspaceApplySiblingOffset {
  parent_node_id: string;
  node_sort_order: number;
  target_sort_order: number;
}

/**
 * Once any child of a workspace parent has been materialized, its append
 * offset is immutable for every sibling. Reuse that established offset when
 * an author applies siblings out of presentation order (for example chapters
 * 1, 3, 5, 6 and then chapter 2). Computing from the current last course
 * block would otherwise create a second offset and the database guard would
 * correctly reject the mapping.
 */
export function workspaceApplyEstablishedParentOffsets(entries: readonly WorkspaceApplySiblingOffset[]): Map<string, number> {
  const offsets = new Map<string, number>();
  for (const entry of entries) {
    if (!id.safeParse(entry.parent_node_id).success
      || !Number.isSafeInteger(entry.node_sort_order) || entry.node_sort_order < 0
      || !Number.isSafeInteger(entry.target_sort_order) || entry.target_sort_order < entry.node_sort_order) {
      fail('WORKSPACE_APPLY_TARGET_CHANGED');
    }
    const offset = entry.target_sort_order - entry.node_sort_order;
    if (offsets.has(entry.parent_node_id) && offsets.get(entry.parent_node_id) !== offset) {
      fail('WORKSPACE_APPLY_TARGET_CHANGED');
    }
    offsets.set(entry.parent_node_id, offset);
  }
  return offsets;
}

/** A mapping is reusable only when both immutable workspace content and the
 * actual course target still match the evidence loaded inside the Apply
 * transaction. Reusing it avoids rewriting already-applied ancestors and
 * preserves the receipt/mapping guards as the final authority. */
export function workspaceApplyWriteAlreadyMaterialized(write: WorkspaceApplyWrite, mapping: WorkspaceApplyMapping | undefined): boolean {
  return !!mapping && !!write.mapped_target
    && mapping.node_id === write.node_id
    && mapping.target_block_id === write.mapped_target.block_id
    && mapping.target_parent_id === write.mapped_target.parent_id
    && mapping.target_block_type === write.block_type
    && mapping.target_sort_order === write.mapped_target.sort_order
    && mapping.applied_revision === write.revision
    && mapping.applied_content_hash === write.content_hash
    && mapping.target_hash === write.mapped_target.before_hash
    && mapping.actual_target_hash === mapping.target_hash;
}

export function workspaceApplyMaterializationPlan(writes: readonly WorkspaceApplyWrite[], mappings: readonly WorkspaceApplyMapping[], scopeNodeId: string) {
  const byNode = new Map(mappings.map(mapping => [mapping.node_id, mapping]));
  const pending = writes.filter(write => !workspaceApplyWriteAlreadyMaterialized(write, byNode.get(write.node_id)));
  if (pending.length) return { writes: pending, noopAnchor: null };
  const noopAnchor = writes.find(write => write.node_id === scopeNodeId) ?? writes[0];
  if (!noopAnchor || !workspaceApplyWriteAlreadyMaterialized(noopAnchor, byNode.get(noopAnchor.node_id))) {
    fail('WORKSPACE_APPLY_TARGET_CHANGED');
  }
  return { writes: [] as WorkspaceApplyWrite[], noopAnchor };
}
/** Author-only component review context stays in the protected binding; it is
 * carried to the author notes channel, never into learner component data. */
export function workspaceApplyAuthorReview(node: Pick<WorkspaceApplyNode, 'kind' | 'protected_contract'>): unknown {
  if (node.kind !== 'component') return null;
  const metadata = node.protected_contract.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).author_review ?? null : null;
}
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const within = (path: string, scope: string) => path === scope || path.startsWith(`${scope}.`);
const APPLY_SCOPE_PATH = /^chapter_([1-9][0-9]*)(?:\.lesson_([1-9][0-9]*))?(?:\.unit_([1-9][0-9]*))?(?:\.component_([1-9][0-9]*))?$/;
const sortedRevisions = (entries: readonly WorkspaceApplyRevision[]) => [...entries].sort((a, b) => a.node_id.localeCompare(b.node_id));

/** Fail-closed scope/depth binding shared by the repository and both Apply
 * compilers. A node kind can never borrow a broader canonical path. */
export function workspaceApplyScopeChapter(kind: WorkspaceApplyNode['kind'], canonicalPath: string): number | null {
  const match = APPLY_SCOPE_PATH.exec(canonicalPath);
  if (!match) return null;
  const [, chapter, lesson, unit, component] = match;
  const valid = kind === 'chapter' ? !lesson && !unit && !component
    : kind === 'lesson' ? !!lesson && !unit && !component
      : kind === 'unit' ? !!lesson && !!unit && !component
        : kind === 'component' ? !!lesson && !!unit && !!component : false;
  return valid ? Number(chapter) : null;
}
export function workspaceApplyTargetHash(targets: WorkspaceApplyTargets): string {
  return hash({ course_root_id: targets.course_root_id, course_root_hash: targets.course_root_hash,
    mappings: [...targets.mappings].sort((a, b) => a.node_id.localeCompare(b.node_id)).map(m => ({ ...m,
      receipt_revision_manifest: sortedRevisions(m.receipt_revision_manifest) })) });
}
function checkedContent(row: WorkspaceApplyNode, baseline: boolean): WorkspaceContent {
  const revision = baseline ? row.baseline : row.current;
  if (row.content_state !== 'content_ready' || row.current_revision === null || !revision) fail('WORKSPACE_APPLY_CONTEXT_INCOMPLETE', row.canonical_path);
  const content = readWorkspaceContent(revision.content);
  if (hash(content) !== revision.content_hash) fail('WORKSPACE_APPLY_HASH_INVALID', row.canonical_path);
  return content;
}
function blockType(node: WorkspaceApplyNode): string {
  return node.kind === 'component' ? String(node.protected_contract.component_type)
    : ({ chapter: 'chapter', lesson: 'sequential', unit: 'vertical', media_brief: '' })[node.kind];
}

/** Pure server-domain compiler. It cannot authorize a caller, read a DB,
 * allocate block IDs, choose append offsets, mutate the course, or issue a
 * committed receipt. Fresh authority and exact hash/CAS/target rechecks plus
 * draft-only parity remain mandatory in the repository transaction. */
export function compileWorkspaceApply(input: WorkspaceApplyCompileInput) {
  try { return compile(input); }
  catch (error) {
    if (error instanceof WorkspaceApplyCompileError) throw error;
    // Never leak arbitrary content/validator exception strings to HTTP callers.
    throw new WorkspaceApplyCompileError('WORKSPACE_APPLY_INPUT_INVALID');
  }
}
function compile(input: WorkspaceApplyCompileInput) {
  if (!id.safeParse(input.workspace_id).success || !id.safeParse(input.course_node_id).success
    || !['en', 'vi'].includes(input.content_locale) || !ordinal.safeParse(input.event_head).success
    || !digest.safeParse(input.source_snapshot_hash).success || !digest.safeParse(input.runtime_config_hash).success
    || !digest.safeParse(input.blueprint_hash).success || hash(input.blueprint) !== input.blueprint_hash) fail('WORKSPACE_APPLY_HASH_INVALID');
  if (input.nodes.length > 8192 || input.request.expected_revision_manifest.length > 8192 || Buffer.byteLength(JSON.stringify({ blueprint: input.blueprint, nodes: input.nodes,
    baselines: input.accepted_baselines, targets: input.targets })) > 64 * 1024 * 1024) fail('WORKSPACE_APPLY_LIMIT');
  if (input.request.expected_workspace_revision !== input.event_head) fail('WORKSPACE_APPLY_REVISION_CONFLICT');
  const nodes = input.nodes.map(n => nodeSchema.parse(n));
  const byId = new Map(nodes.map(n => [n.node_id, n])), byPath = new Map(nodes.map(n => [n.canonical_path, n]));
  if (byId.size !== nodes.length || byPath.size !== nodes.length || byId.has(input.course_node_id)) fail('WORKSPACE_APPLY_BINDING_INVALID');
  const scope = byId.get(input.request.scope_node_id);
  if (!scope) fail('WORKSPACE_APPLY_SCOPE_INVALID');
  const chapterCount = workspaceApplyScopeChapter(scope.kind, scope.canonical_path);
  if (chapterCount === null) fail('WORKSPACE_APPLY_SCOPE_INVALID');
  if (chapterCount > input.blueprint.chapters.length) fail('WORKSPACE_APPLY_SCOPE_INVALID');

  // Recompute immutable inventory from the exact accepted V5 architecture.
  // Capabilities on later, out-of-scope chapters must not block this scope.
  const types = new Set<CourseComponentType>(['html', 'problem', 'la_faq', 'la_sortable', 'la_crossword', 'la_diagram']);
  const inventory = buildWorkspaceInventory(input.blueprint, types).nodes.filter(n => {
    const m = /^chapter_([1-9][0-9]*)/.exec(n.canonical_path); return m && Number(m[1]) <= chapterCount;
  });
  if (inventory.length !== nodes.length) fail('WORKSPACE_APPLY_CONTEXT_INCOMPLETE');
  const current = new Map<string, WorkspaceContent>(), baseline = new Map<string, WorkspaceContent>();
  for (const item of inventory) {
    const node = byPath.get(item.canonical_path);
    if (!node || node.kind !== item.kind || node.sort_order !== item.sort_order
      || node.parent_id !== (item.parent_path === 'course' ? input.course_node_id : byPath.get(item.parent_path!)?.node_id)
      || hash(node.protected_contract) !== node.contract_hash || node.contract_hash !== item.contract_hash) fail('WORKSPACE_APPLY_BINDING_INVALID', item.canonical_path);
    baseline.set(node.node_id, checkedContent(node, true)); current.set(node.node_id, checkedContent(node, false));
    if (node.current_revision === 0 && node.current!.content_hash !== node.baseline!.content_hash) fail('WORKSPACE_APPLY_BINDING_INVALID', node.canonical_path);
    if (node.kind !== 'component') {
      const seed = workspaceStoryboardSeed(input.blueprint, node.kind, node.canonical_path);
      if (!seed || !same(seed.baseline, baseline.get(node.node_id))) fail('WORKSPACE_APPLY_BINDING_INVALID', node.canonical_path);
      editWorkspaceStoryboard(seed, current.get(node.node_id));
    }
  }
  const revision_manifest = sortedRevisions(nodes.map(n => ({ node_id: n.node_id, revision: n.current_revision!, content_hash: n.current!.content_hash })));
  const expected = input.request.expected_revision_manifest.map(e => revisionSchema.parse(e));
  if (new Set(expected.map(e => e.node_id)).size !== expected.length || !same(sortedRevisions(expected), revision_manifest)) fail('WORKSPACE_APPLY_REVISION_CONFLICT');
  if (input.accepted_baselines.length !== chapterCount || new Set(input.accepted_baselines.map(b => b.chapter_path)).size !== chapterCount) fail('WORKSPACE_APPLY_CONTEXT_INCOMPLETE');
  const components = new Map<string, LessonAuthorComponentProposal>();
  const effectiveChapters: LessonAuthorBlueprintChapter[] = [], effectiveProposals: LessonAuthorProposal[] = [];
  const warnings: Array<{ code: string; path: string }> = [];
  const componentLocations: Array<{ path: string; component: LessonAuthorComponentProposal }> = [];
  function validate(proposal: LessonAuthorProposal, blueprint: LessonAuthorBlueprintChapter, path: string) {
    const result = validateWorkspaceComponentChapter({ proposal, blueprint, allowed: input.allowed });
    const remap = (f: { code: string; path: string }) => ({ code: f.code, path: f.path.replace(/^chapter_1(?=\.|$)/, path) });
    if (result.status === 'FAIL' || !result.scope_complete || result.deferred_checks.length) {
      throw new WorkspaceApplyCompileError('WORKSPACE_APPLY_VALIDATION_FAILED', result.findings.map(remap));
    }
    warnings.push(...result.warnings.map(remap));
  }
  for (let ci = 0; ci < chapterCount; ci++) {
    const path = `chapter_${ci + 1}`, approved = input.blueprint.chapters[ci], artifact = input.accepted_baselines.find(b => b.chapter_path === path);
    if (!artifact || !digest.safeParse(artifact.content_hash).success || hash(artifact.proposal) !== artifact.content_hash) fail('WORKSPACE_APPLY_HASH_INVALID', path);
    const original = artifact.proposal;
    if (original.chapters.length !== 1 || original.chapters[0].title !== approved.title) fail('WORKSPACE_APPLY_BINDING_INVALID', path);
    validate(original, approved, path); // Actual generation coverage BEFORE binding hydration.
    const effective = structuredClone(approved);
    const chapterNode = byPath.get(path)!;
    const chapterContent = current.get(chapterNode.node_id)!;
    effective.title = chapterContent.title;
    Object.assign(effective, chapterContent.data);
    const proposal: LessonAuthorProposal = { summary: '', chapters: [{ title: effective.title, lessons: effective.lessons.map((lesson, li) => {
      const lessonPath = `${path}.lesson_${li + 1}`, lessonNode = byPath.get(lessonPath)!;
      const lessonContent = current.get(lessonNode.node_id)!;
      lesson.title = lessonContent.title; Object.assign(lesson, lessonContent.data);
      if (original.chapters[0].lessons[li].title !== approved.lessons[li].title) fail('WORKSPACE_APPLY_BINDING_INVALID', lessonPath);
      return { title: lesson.title, units: lesson.units.map((unit, ui) => {
        const unitPath = `${lessonPath}.unit_${ui + 1}`, unitNode = byPath.get(unitPath)!;
        const unitContent = current.get(unitNode.node_id)!;
        unit.title = unitContent.title; unit.purpose = unitContent.purpose ?? undefined;
        const sourceUnit = original.chapters[0].lessons[li].units[ui];
        if (sourceUnit.title !== approved.lessons[li].units[ui].title || sourceUnit.components?.length !== unit.component_plan.length) fail('WORKSPACE_APPLY_BINDING_INVALID', unitPath);
        return { title: unit.title, source_fact_ids: unit.source_fact_ids, components: unit.component_plan.map((_plan, pi) => {
          const componentPath = `${unitPath}.component_${pi + 1}`, node = byPath.get(componentPath)!;
          const raw = sourceUnit.components![pi];
          // Rehydrate the persisted revision before semantic comparison so
          // additive defaults (for example Problem hints on pre-hints
          // workspaces) do not invalidate an otherwise identical baseline.
          // Stored hashes remain untouched; only the typed comparison is
          // canonicalized through the same trusted adapter used for Apply.
          const hydrated = hydrateWorkspaceComponent(node.protected_contract, baseline.get(node.node_id), input.allowed);
          if (raw.type !== _plan.type || !same(workspaceAuthorComponentContent(raw, input.allowed), workspaceAuthorComponentContent(hydrated, input.allowed))) fail('WORKSPACE_APPLY_BINDING_INVALID', componentPath);
          const protectedMetadata = node.protected_contract.metadata as Record<string, unknown>;
          if (raw.metadata?.component_plan_id !== protectedMetadata.component_plan_id) fail('WORKSPACE_APPLY_BINDING_INVALID', componentPath);
          // Publication compares provenance as sets. Genuine coverage has
          // already passed the full validator above, before canonical hydration.
          for (const key of ['source_fact_ids', 'supporting_evidence_fact_ids', 'learning_objective_refs']) {
            const actual = raw.metadata?.[key] ?? [], expected = protectedMetadata[key];
            if (!Array.isArray(actual) || actual.some(v => typeof v !== 'string') || new Set(actual).size !== actual.length
              || !Array.isArray(expected) || !same([...actual].sort(), [...expected].sort())) fail('WORKSPACE_APPLY_BINDING_INVALID', componentPath);
          }
          const compiled = editWorkspaceComponent(hydrated, current.get(node.node_id), input.allowed);
          components.set(node.node_id, compiled); componentLocations.push({ path: componentPath, component: compiled });
          return compiled;
        }) };
      }) };
    }) }] };
    validate(proposal, effective, path);
    effectiveChapters.push(effective); effectiveProposals.push(proposal);
  }

  // The shared detector caps one call at96 pairs. Invoke it on exact pairs so
  // the final domain check never silently stops at that legacy display budget.
  if (componentLocations.length * (componentLocations.length - 1) / 2 > WORKSPACE_APPLY_MAX_PAIRS) fail('WORKSPACE_APPLY_LIMIT');
  for (let i = 0; i < componentLocations.length; i++) for (let j = i + 1; j < componentLocations.length; j++) {
    const a = componentLocations[i], b = componentLocations[j];
    const found = detectLessonAuthorGeneratedContentDuplicates({ summary: '', chapters: [{ title: '', lessons: [{ title: '',
      units: [{ title: '', components: [a.component, b.component] }] }] }] });
    if (found.some(f => f.severity === 'error')) throw new WorkspaceApplyCompileError('WORKSPACE_APPLY_VALIDATION_FAILED', found.map(f => ({ code: f.code, path: b.path })));
  }

  const writeNodes = inventory.map(n => byPath.get(n.canonical_path)!).filter(n => n.kind !== 'media_brief'
    && (within(n.canonical_path, scope.canonical_path) || within(scope.canonical_path, n.canonical_path)));
  const writing = new Set(writeNodes.map(n => n.node_id));
  // Explicit architecture prerequisite concepts must already be taught, not
  // silently assigned to a later unit or matched by title.
  const taught = new Set<string>();
  const concepts = new Map(input.blueprint.source_map?.concepts.map(c => [c.id, c]) ?? []);
  for (const chapter of effectiveChapters) for (const lesson of chapter.lessons) {
    if ((lesson.prerequisite_concept_ids ?? []).some(c => !taught.has(c))) fail('WORKSPACE_APPLY_DEPENDENCY_REQUIRED');
    for (const unit of lesson.units) {
      const unitConcepts = unit.primary_concept_ids ?? unit.concept_ids ?? [];
      if (unitConcepts.some(c => !concepts.has(c) || (concepts.get(c)!.prerequisite_concept_ids ?? []).some(p => !taught.has(p)))) fail('WORKSPACE_APPLY_DEPENDENCY_REQUIRED');
      unitConcepts.forEach(c => taught.add(c));
    }
  }
  // Canonical order is presentation order, not an implicit Apply dependency.
  // Resolve only prerequisite concepts explicitly declared by the accepted
  // architecture. This lets authors Apply any independent hierarchy scope while
  // still requiring receipt-backed content for a genuine prerequisite unit.
  const orderedBlueprintUnits = input.blueprint.chapters.flatMap((chapter, ci) => chapter.lessons.flatMap((lesson, li) =>
    lesson.units.map((unit, ui) => ({
      path: `chapter_${ci + 1}.lesson_${li + 1}.unit_${ui + 1}`,
      lesson,
      unit,
    }))));
  const selectedUnits = orderedBlueprintUnits.filter(entry => within(entry.path, scope.canonical_path));
  const selectedPaths = new Set(selectedUnits.map(entry => entry.path));
  const explicitPrerequisitePaths = new Set<string>();
  for (const selectedUnit of selectedUnits) {
    const requiredConcepts = new Set(selectedUnit.lesson.prerequisite_concept_ids ?? []);
    for (const conceptId of selectedUnit.unit.primary_concept_ids ?? selectedUnit.unit.concept_ids ?? []) {
      for (const prerequisite of concepts.get(conceptId)?.prerequisite_concept_ids ?? []) requiredConcepts.add(prerequisite);
    }
    for (const conceptId of requiredConcepts) {
      const owner = orderedBlueprintUnits.find(candidate => candidate.path !== selectedUnit.path
        && (candidate.unit.primary_concept_ids ?? candidate.unit.concept_ids ?? []).includes(conceptId));
      if (!owner) fail('WORKSPACE_APPLY_DEPENDENCY_REQUIRED', selectedUnit.path);
      if (!selectedPaths.has(owner.path)) explicitPrerequisitePaths.add(owner.path);
    }
  }
  const targets: WorkspaceApplyTargets = { course_root_id: id.parse(input.targets.course_root_id),
    course_root_hash: digest.parse(input.targets.course_root_hash), mappings: input.targets.mappings.map(m => mappingSchema.parse(m)) };
  const mappings = new Map(targets.mappings.map(m => [m.node_id, m]));
  if (mappings.size !== targets.mappings.length || new Set(targets.mappings.map(m => m.target_block_id)).size !== mappings.size) fail('WORKSPACE_APPLY_TARGET_CHANGED');
  const offsets = new Map<string, number>();
  for (const m of targets.mappings) {
    const n = byId.get(m.node_id);
    if (!n || n.kind === 'media_brief' || m.target_hash !== m.actual_target_hash || m.target_block_type !== blockType(n)
      || m.target_block_id === targets.course_root_id || m.applied_revision > n.current_revision!
      || m.applied_revision === n.current_revision && m.applied_content_hash !== n.current!.content_hash
      || m.target_parent_id !== (n.kind === 'chapter' ? targets.course_root_id : mappings.get(n.parent_id)?.target_block_id)) fail('WORKSPACE_APPLY_TARGET_CHANGED');
    const offset = m.target_sort_order - n.sort_order;
    if (offset < 0 || offsets.has(n.parent_id) && offsets.get(n.parent_id) !== offset) fail('WORKSPACE_APPLY_TARGET_CHANGED');
    offsets.set(n.parent_id, offset);
    if (new Set(m.receipt_revision_manifest.map(e => e.node_id)).size !== m.receipt_revision_manifest.length) fail('WORKSPACE_APPLY_TARGET_CHANGED');
    if (!m.receipt_revision_manifest.some(e => e.node_id === m.node_id && e.revision === m.applied_revision
      && e.content_hash === m.applied_content_hash)) fail('WORKSPACE_APPLY_TARGET_CHANGED');
  }
  const target_snapshot_hash = workspaceApplyTargetHash(targets);
  if (input.request.expected_target_snapshot_hash !== target_snapshot_hash) fail('WORKSPACE_APPLY_TARGET_CHANGED');
  const required = nodes.filter(n => !writing.has(n.node_id) && [...explicitPrerequisitePaths].some(path =>
    within(n.canonical_path, path) || within(path, n.canonical_path)));
  for (const n of required) {
    const owner = n.kind === 'media_brief' ? byId.get(n.parent_id)! : n;
    const m = mappings.get(owner.node_id);
    if (!m || m.applied_revision !== owner.current_revision || m.applied_content_hash !== owner.current!.content_hash
      || !m.receipt_revision_manifest.some(e => e.node_id === n.node_id && e.revision === n.current_revision && e.content_hash === n.current!.content_hash)) {
      fail('WORKSPACE_APPLY_DEPENDENCY_REQUIRED', n.canonical_path);
    }
  }
  const writes: WorkspaceApplyWrite[] = writeNodes.map(n => {
    const content = current.get(n.node_id)!, mapping = mappings.get(n.node_id);
    return { node_id: n.node_id, parent_node_id: n.parent_id, canonical_path: n.canonical_path, kind: n.kind as WorkspaceApplyWrite['kind'],
      block_type: blockType(n), sort_order: n.sort_order, revision: n.current_revision!, content_hash: n.current!.content_hash,
      title: content.title, component: components.get(n.node_id) ?? null,
      author_metadata: { purpose: content.purpose, implementation_notes: content.implementation_notes,
        storyboard: n.kind === 'component' ? null : content.data,
        author_review: workspaceApplyAuthorReview(n),
        media_briefs: nodes.filter(b => b.kind === 'media_brief' && b.parent_id === n.node_id).sort((a, b) => a.sort_order - b.sort_order).map(b => ({ node_id: b.node_id,
          revision: b.current_revision!, content_hash: b.current!.content_hash, media_type: typeof b.protected_contract.media_type === 'string' ? b.protected_contract.media_type : null,
          content: current.get(b.node_id)! })) },
      mapped_target: mapping ? { block_id: mapping.target_block_id, parent_id: mapping.target_parent_id, sort_order: mapping.target_sort_order, before_hash: mapping.target_hash } : null };
  });
  const revision_set_hash = hash(revision_manifest);
  const checks = { schema: 'PASS', security: 'PASS', evidence: 'PASS', pedagogy: 'PASS', coverage: 'PASS', duplicates: 'PASS', dependencies: 'PASS', registry: 'PASS' } as const;
  const acceptance = { scope_id: scope.node_id, revision_set_hash, source_snapshot_hash: input.source_snapshot_hash, target_snapshot_hash, checks };
  assertWorkspaceApplyReady({ ...acceptance, kind: scope.kind, complete: true, validation: acceptance });
  const result = { validation_contract: WORKSPACE_SCOPED_APPLY_CONTRACT, workspace_id: input.workspace_id, content_locale: input.content_locale,
    scope_node_id: scope.node_id, scope_path: scope.canonical_path, expected_workspace_revision: input.event_head,
    runtime_config_hash: input.runtime_config_hash, blueprint_hash: input.blueprint_hash,
    capability_hash: hash([...input.allowed].sort()), revision_manifest, revision_set_hash,
    binding_manifest: inventory.map(n => ({ node_id: byPath.get(n.canonical_path)!.node_id, canonical_path: n.canonical_path,
      parent_node_id: byPath.get(n.canonical_path)!.parent_id, sort_order: n.sort_order, contract_hash: n.contract_hash })),
    required_applied_dependencies: required.map(n => n.node_id).sort(),
    effective_context_hash: hash({ chapters: effectiveChapters, proposals: effectiveProposals }),
    acceptance, warnings, semantic_fidelity: 'not_measured' as const, writes };
  return structuredClone({ ...result, compilation_hash: hash(result) });
}
