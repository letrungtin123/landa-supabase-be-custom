import { z } from 'zod';
import type { LessonAuthorBlueprint, LessonAuthorBlueprintUnit } from './chat.service.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import { readWorkspaceContent, WorkspaceContractError, type WorkspaceContent, type WorkspaceNodeKind } from './lesson-author-workspace.logic.js';

export const WORKSPACE_AGGREGATE_EDIT = 'workspace-aggregate-edit-1';
export const WORKSPACE_MEDIA_EDIT = 'workspace-media-edit-1';
export type WorkspaceStoryboardKind = Exclude<WorkspaceNodeKind, 'component'>;
function invalid(): never { throw new WorkspaceContractError('WORKSPACE_CONTENT_INVALID'); }
function contract(): never { throw new WorkspaceContractError('WORKSPACE_CONTRACT_INVALID'); }
// Plain author text, never executable HTML/URLs masquerading as assets. EN/VI
// and original-language quotations are preserved; no translate/trim/rewrite.
const text = (max: number, empty = false) => z.string().max(max).refine(v => (empty || !!v.trim())
  && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v));
const lines = (max: number, length: number) => z.array(text(length)).max(max);
const objectives = lines(12, 1000);
const dataSchemas = {
  course: z.object({ summary: text(8000), target_audience: text(2000), prerequisites: lines(32, 1000), assessment_strategy: text(8000, true) }).strict(),
  // V1 Blueprints name chapter outputs learning_objectives; the accepted V2
  // architecture/inventory contract names the same author-facing values
  // learning_outcomes. Preserve the persisted version instead of rewriting a
  // revision merely because its title changed.
  chapter: z.union([
    z.object({ objective: text(2000), learning_objectives: objectives }).strict(),
    z.object({ objective: text(2000), learning_outcomes: objectives }).strict(),
  ]),
  lesson: z.object({ objective: text(2000), learning_objectives: objectives, learning_activities: lines(32, 1000), assessment: text(8000, true) }).strict(),
  unit: z.object({}).strict(),
  media_brief: z.object({ content_points: lines(6, 600).min(1), context_description: text(1000).nullable() }).strict(),
};
const referenceList = z.array(z.string().min(1).max(160).refine(v => v.trim() === v)).max(4096)
  .refine(v => new Set(v).size === v.length);
const referencesSchema = z.object({ source_refs: referenceList, primary_evidence_scope_ids: referenceList,
  supporting_evidence_scope_ids: referenceList, learning_objective_refs: referenceList }).strict();
const bindingSchema = z.object({ storyboard_version: z.literal(1),
  kind: z.enum(['course', 'chapter', 'lesson', 'unit', 'media_brief']), canonical_path: z.string().min(1).max(240),
  display_title: text(500), baseline_hash: z.string().regex(/^[0-9a-f]{64}$/),
  chapter_count: z.number().int().min(0).max(4096),
  objective_slots: z.number().int().min(0).max(12), media_type: z.enum(['video', 'static_infographic']).nullable(),
  brief_format: z.enum(['structured_v2', 'outline_v1']).nullable(), readonly_references: referencesSchema,
}).strict();
export type WorkspaceStoryboardBinding = z.infer<typeof bindingSchema>;
export interface WorkspaceStoryboardSeed {
  kind: WorkspaceStoryboardKind; canonical_path: string; parent_path: string | null; sort_order: number;
  binding: WorkspaceStoryboardBinding; baseline: WorkspaceContent;
}

/** Rehydrate an already-persisted storyboard seed after its immutable binding
 * has been independently authenticated by the caller. This is the V2
 * counterpart to workspaceStoryboardSeed(): V2 has no legacy Blueprint row,
 * so the accepted architecture/inventory identity is the authority and the
 * revision-zero content is the exact baseline. */
export function workspaceStoryboardBoundSeed(input: {
  kind: WorkspaceStoryboardKind;
  canonical_path: string;
  parent_path: string | null;
  sort_order: number;
  binding: unknown;
  baseline: unknown;
}): WorkspaceStoryboardSeed {
  const parsedBinding = bindingSchema.safeParse(input.binding);
  if (!parsedBinding.success || parsedBinding.data.kind !== input.kind
    || parsedBinding.data.canonical_path !== input.canonical_path
    || !Number.isSafeInteger(input.sort_order) || input.sort_order < 0) contract();
  const baseline = readContent(input.kind, input.baseline);
  if (parsedBinding.data.baseline_hash !== hash(baseline)) contract();
  return { kind: input.kind, canonical_path: input.canonical_path, parent_path: input.parent_path,
    sort_order: input.sort_order, binding: parsedBinding.data, baseline };
}
function readContent(kind: WorkspaceStoryboardKind, value: unknown) {
  const content = readWorkspaceContent(value);
  if (!text(500).safeParse(content.title).success || !text(8000, true).nullable().safeParse(content.purpose).success
    || !text(8000, true).nullable().safeParse(content.implementation_notes).success) invalid();
  const parsed = dataSchemas[kind].safeParse(content.data);
  if (!parsed.success) invalid();
  return content;
}
function refs(value: unknown): string[] {
  const result = referenceList.safeParse(value ?? []);
  return result.success ? result.data : contract();
}
function list<T>(value: T[] | undefined, limit = 4096): T[] {
  if (!Array.isArray(value) || value.length > limit) contract();
  return value;
}
function get<T>(value: T[] | undefined, ordinal: string): T {
  const index = Number(ordinal) - 1;
  if (!Number.isSafeInteger(index) || index < 0) contract();
  return list(value)[index] ?? contract();
}
function allUnits(blueprint: LessonAuthorBlueprint) {
  const units: LessonAuthorBlueprintUnit[] = [];
  for (const chapter of list(blueprint.chapters)) for (const lesson of list(chapter.lessons)) {
    units.push(...list(lesson.units)); if (units.length > 4096) contract();
  }
  return units;
}

/** Project metadata directly from an ALREADY accepted V5 Blueprint. This does
 * not run/replace Blueprint acceptance, create DB nodes or generate prose.
 * Null media means no visible recommendation node; no placeholder asset.
 */
export function workspaceStoryboardSeed(blueprint: LessonAuthorBlueprint, kind: WorkspaceStoryboardKind,
  path: string): WorkspaceStoryboardSeed | null {
  if (!blueprint || blueprint.architecture_contract_version !== 5 || blueprint.content_contract_version !== 1) contract();
  let title: string, purpose: string | null = null, data: WorkspaceContent['data'], parent: string | null, order: number;
  let scopedUnits: LessonAuthorBlueprintUnit[] = [], sourceRefs: string[] = [], localRefs: string[] = [], slots = 0;
  let mediaType: WorkspaceStoryboardBinding['media_type'] = null, briefFormat: WorkspaceStoryboardBinding['brief_format'] = null;
  if (kind === 'course') {
    if (path !== 'course') contract();
    title = blueprint.title; parent = null; order = 0; scopedUnits = allUnits(blueprint);
    sourceRefs = blueprint.chapters.flatMap(c => [...refs(c.source_refs), ...list(c.lessons).flatMap(l => refs(l.source_refs))]);
    data = { summary: blueprint.summary, target_audience: blueprint.target_audience,
      prerequisites: blueprint.prerequisites, assessment_strategy: blueprint.assessment_strategy };
  } else {
    const match = /^chapter_([1-9][0-9]*)(?:\.lesson_([1-9][0-9]*))?(?:\.unit_([1-9][0-9]*))?(\.media_1)?$/.exec(path);
    if (!match || (kind === 'chapter' ? !!match[2] || !!match[3] || !!match[4]
      : kind === 'lesson' ? !match[2] || !!match[3] || !!match[4]
        : kind === 'unit' ? !match[2] || !match[3] || !!match[4]
          : !match[2] || !match[3] || !match[4])) contract();
    const chapter = get(blueprint.chapters, match[1]);
    if (kind === 'chapter') {
      title = chapter.title; parent = 'course'; order = Number(match[1]) - 1;
      scopedUnits = list(chapter.lessons).flatMap(lesson => list(lesson.units));
      sourceRefs = [...refs(chapter.source_refs), ...chapter.lessons.flatMap(l => refs(l.source_refs))];
      data = { objective: chapter.objective, learning_objectives: chapter.learning_objectives ?? [] };
      slots = (chapter.learning_objectives ?? []).length;
    } else {
      const lesson = get(chapter.lessons, match[2]);
      if (kind === 'lesson') {
        title = lesson.title; parent = `chapter_${match[1]}`; order = Number(match[2]) - 1;
        scopedUnits = list(lesson.units); sourceRefs = refs(lesson.source_refs);
        const lo = lesson.learning_objectives ?? []; slots = lo.length; localRefs = lo.map((_v, i) => `lo_${i + 1}`);
        data = { objective: lesson.objective, learning_objectives: lo, learning_activities: lesson.learning_activities, assessment: lesson.assessment };
      } else {
        const unit = get(lesson.units, match[3]);
        scopedUnits = [unit]; localRefs = refs(unit.learning_objective_refs);
        const unitPath = `chapter_${match[1]}.lesson_${match[2]}.unit_${match[3]}`;
        if (kind === 'unit') {
          title = unit.title; purpose = unit.purpose ?? null; data = {}; parent = `chapter_${match[1]}.lesson_${match[2]}`; order = Number(match[3]) - 1;
        } else {
          const media = unit.media_plan;
          const decisions = blueprint.media_review?.decisions?.filter(d => d.unit_path === unitPath) ?? [];
          if (blueprint.media_review && (blueprint.media_review.version !== 'media-review-v1' || decisions.length !== 1)) contract();
          const status = decisions[0]?.status;
          if (status && !['PROPOSED', 'NOT_NEEDED', 'SOURCE_GAP', 'FAILED', 'NOT_EVALUATED'].includes(status)) contract();
          if (!media) { if (status === 'PROPOSED') contract(); return null; }
          if (status && !['PROPOSED', 'NOT_EVALUATED'].includes(status)) contract();
          if (!['video', 'static_infographic'].includes(media.type)) contract();
          title = media.title; purpose = media.rationale; parent = unitPath;
          // Components occupy 0..N-1 in the installed unique sibling order.
          order = list(unit.component_plan).length; mediaType = media.type;
          if (media.brief_version === 2) {
            if (!lines(6, 500).min(1).safeParse(media.content_points).success || !text(1000).safeParse(media.context_description).success) contract();
            data = { content_points: media.content_points!, context_description: media.context_description! }; briefFormat = 'structured_v2';
          } else {
            if (media.brief_version !== undefined || !text(600).safeParse(media.content_outline).success) contract();
            // Legacy outline is one honest bullet, NOT a fabricated screenplay
            // or rationale repurposed as a setting/context description.
            data = { content_points: [media.content_outline], context_description: null }; briefFormat = 'outline_v1';
          }
        }
      }
    }
  }
  if (scopedUnits.length > 4096) contract();
  const merge = (values: string[]) => refs([...new Set(values)]);
  const baseline = readContent(kind, { title, purpose, data, implementation_notes: null });
  const parsedBinding = bindingSchema.safeParse({ storyboard_version: 1, kind, canonical_path: path, display_title: title,
    baseline_hash: hash(baseline), chapter_count: kind === 'course' ? blueprint.chapters.length : 0, objective_slots: slots, media_type: mediaType, brief_format: briefFormat,
    readonly_references: { source_refs: merge([...sourceRefs, ...scopedUnits.flatMap(u => refs(u.source_refs))]),
      primary_evidence_scope_ids: merge(scopedUnits.flatMap(u => refs(u.primary_evidence_scope_ids))),
      supporting_evidence_scope_ids: merge(scopedUnits.flatMap(u => refs(u.supporting_evidence_scope_ids))), learning_objective_refs: localRefs } });
  if (!parsedBinding.success) contract();
  return { kind, canonical_path: path, parent_path: parent, sort_order: order, baseline, binding: parsedBinding.data };
}

/** Content-only edit. No canonical objective/provenance changes, no learner
 * payload compilation and no claim that changed objective text is still taught.
 */
export function editWorkspaceStoryboard(seed: WorkspaceStoryboardSeed, value: unknown): WorkspaceContent {
  if (!bindingSchema.safeParse(seed.binding).success || seed.binding.kind !== seed.kind || seed.binding.canonical_path !== seed.canonical_path
    || seed.binding.baseline_hash !== hash(seed.baseline)) contract();
  const content = readContent(seed.kind, value);
  if (seed.kind === 'chapter') {
    const baselineData = seed.baseline.data as { learning_objectives?: string[]; learning_outcomes?: string[] };
    const candidateData = content.data as { learning_objectives?: string[]; learning_outcomes?: string[] };
    const usesV2Outcomes = Array.isArray(baselineData.learning_outcomes);
    const expected = usesV2Outcomes ? baselineData.learning_outcomes! : baselineData.learning_objectives!;
    const candidate = usesV2Outcomes ? candidateData.learning_outcomes : candidateData.learning_objectives;
    if (!candidate || candidate.length !== expected.length
      || (usesV2Outcomes ? candidateData.learning_objectives !== undefined : candidateData.learning_outcomes !== undefined)
      || (!usesV2Outcomes && expected.length !== seed.binding.objective_slots)) {
      throw new WorkspaceContractError('WORKSPACE_NODE_FIELD_PROTECTED');
    }
  } else if (seed.kind === 'lesson') {
    if ((content.data as { learning_objectives: string[] }).learning_objectives.length !== seed.binding.objective_slots) {
      throw new WorkspaceContractError('WORKSPACE_NODE_FIELD_PROTECTED');
    }
  }
  if (seed.kind === 'media_brief' && seed.binding.brief_format === 'structured_v2'
    && (content.data as { context_description: string | null }).context_description === null) invalid();
  return content;
}

/** Reusable DTO builder for the future authorized detail/overview composition.
 * Reference metadata is explicitly separate from editable content. Do not
 * accept this projection back as proof or display internal IDs as UI labels.
 */
export function workspaceStoryboardView(seed: WorkspaceStoryboardSeed, current: unknown) {
  const content = editWorkspaceStoryboard(seed, current);
  return { kind: seed.kind, content, readonly_references: structuredClone(seed.binding.readonly_references),
    media_type: seed.binding.media_type, brief_format: seed.binding.brief_format,
    user_modified: hash(content) !== seed.binding.baseline_hash,
    author_review_required: hash(content) !== seed.binding.baseline_hash,
    semantic_fidelity: 'not_measured' as const, apply_readiness: 'NOT_EVALUATED' as const };
}

/** Overview uses chapter revisions by exact canonical path, never outcome
 * position or fuzzy title matching. It contains no second outcome copy at root.
 */
export function workspaceOverview(root: WorkspaceStoryboardSeed, rootCurrent: unknown,
  chapters: readonly { seed: WorkspaceStoryboardSeed; current: unknown }[]) {
  if (root.kind !== 'course' || !chapters.length || chapters.length !== root.binding.chapter_count) contract();
  const sorted = [...chapters].sort((a, b) => a.seed.sort_order - b.seed.sort_order);
  const seen = new Set<string>();
  const chapterViews = sorted.map(({ seed, current }, index) => {
    if (seed.kind !== 'chapter' || seed.parent_path !== 'course' || seed.canonical_path !== `chapter_${index + 1}`
      || seed.sort_order !== index || seen.has(seed.canonical_path)) contract();
    seen.add(seed.canonical_path);
    const view = workspaceStoryboardView(seed, current);
    const data = view.content.data as { objective: string; learning_objectives?: string[]; learning_outcomes?: string[] };
    return { canonical_path: seed.canonical_path, title: view.content.title, chapter_objective: data.objective,
      learning_objectives: data.learning_objectives ?? data.learning_outcomes ?? [],
      user_modified: view.user_modified, author_review_required: view.author_review_required };
  });
  return { course: workspaceStoryboardView(root, rootCurrent), chapters: chapterViews };
}
