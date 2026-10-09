import { assertCourseAuthorNotes, COURSE_AUTHOR_ASSESSMENT_REVIEWS_MAX, COURSE_AUTHOR_NOTES_KEY, COURSE_AUTHOR_NOTES_VERSION,
  COURSE_AUTHOR_UNIT_ASSESSMENT_REVIEWS_MAX, readCourseAuthorAssessmentReview, type CourseAuthorAssessmentReviewV1,
  type CourseAuthorGuidanceV1, type CourseAuthorMediaBriefV1, type CourseAuthorNotesV1,
  type CourseAuthorReviewV1 } from '../course-authoring/course-author-notes.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import type { WorkspaceApplyMapping, WorkspaceApplyWrite } from './lesson-author-workspace-apply.logic.js';
import type { WorkspaceContent } from './lesson-author-workspace.logic.js';

/**
 * Pure projection of the author-only part of an applied workspace node into
 * `course_blocks.metadata.ai_id_author_notes` (QC 364564, defect N6). The
 * value is deterministic for one exact node revision (plus its media-brief
 * revisions, the run's IDM guidance and the run's open assessment
 * obligations), so re-applying the same state yields byte-identical notes and
 * never appends duplicates.
 */
export interface WorkspaceAuthorNotesContext {
  workspace_id: string;
  content_locale: 'vi' | 'en';
  /** Open assessment obligations of a V2 run read at Apply time (QLT-3);
   * absent for V1 workspaces, which have no obligations. */
  assessment_reviews?: readonly CourseAuthorAssessmentReviewV1[];
}

/** One open obligation row joined to its verified unit/lesson revisions. */
export interface WorkspaceAssessmentObligationInput {
  obligation_id: string;
  unit_node_id: string | null;
  unit_path: string;
  component_index: number;
  required_kind: string;
  learning_objective_refs: readonly string[];
  unresolved_reason: string;
  evidence_fact_count: number;
  /** Current unit revision content when its hash verified, else null. */
  unit: WorkspaceContent | null;
  /** Current revision content of the unit's lesson when verified, else null. */
  lesson: WorkspaceContent | null;
}

const REVIEW_KEYS = ['purpose', 'example_scenario', 'visual_asset', 'user_behavior_navigation'] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Only the known plain-text storyboard shapes (course/chapter/lesson). A unit
 * storyboard is `{}` and a component has none; both become null. */
function storyboard(value: unknown): Record<string, string | string[]> | null {
  const source = record(value);
  if (!source) return null;
  const entries = Object.entries(source).flatMap(([key, item]): Array<[string, string | string[]]> =>
    typeof item === 'string' ? [[key, item]] : Array.isArray(item) && item.every(line => typeof line === 'string') ? [[key, item as string[]]] : []);
  return entries.length ? Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : null;
}

/** Workspace-only component review context (protected contract metadata). */
export function workspaceAuthorReview(value: unknown): CourseAuthorReviewV1 | null {
  const source = record(value);
  if (!source || Object.keys(source).some(key => !(REVIEW_KEYS as readonly string[]).includes(key))) return null;
  const review = Object.fromEntries(REVIEW_KEYS.map(key => [key, nullableText(source[key])])) as unknown as CourseAuthorReviewV1;
  return REVIEW_KEYS.some(key => review[key] !== null) ? review : null;
}

function mediaBrief(brief: WorkspaceApplyWrite['author_metadata']['media_briefs'][number]): CourseAuthorMediaBriefV1 {
  const data = record(brief.content.data);
  return {
    node_id: brief.node_id, revision: brief.revision, content_hash: brief.content_hash,
    media_type: brief.media_type === 'video' || brief.media_type === 'static_infographic' ? brief.media_type : null,
    title: brief.content.title, rationale: nullableText(brief.content.purpose),
    content_points: stringList(data?.content_points), context_description: nullableText(data?.context_description),
    implementation_notes: nullableText(brief.content.implementation_notes),
  };
}

const OBJECTIVE_REF = /^lo_([1-9][0-9]*)$/;

/**
 * Author-facing projection of a run's open assessment obligations (QLT-3).
 * `lo_<n>` refs are lesson-local (the lesson's n-th objective, see Python
 * `module_layout`), so they resolve against the unit's lesson revision. Rows
 * that would not validate are skipped: the list is advisory and must never
 * fail an Apply. Order is the caller's (course order).
 */
export function workspaceAssessmentReviews(rows: readonly WorkspaceAssessmentObligationInput[]): CourseAuthorAssessmentReviewV1[] {
  return rows.flatMap(row => {
    const objectives = stringList(record(row.lesson?.data)?.learning_objectives);
    const refs = row.learning_objective_refs.slice(0, 24);
    const resolved = refs.map(ref => OBJECTIVE_REF.exec(ref)).map(match => match ? objectives[Number(match[1]) - 1] : undefined)
      .map(value => value?.trim() ? value.trim().slice(0, 2000) : null).filter((value): value is string => !!value);
    const title = nullableText(row.unit?.title);
    const review = readCourseAuthorAssessmentReview({
      obligation_id: row.obligation_id, unit_node_id: row.unit_node_id, unit_path: row.unit_path,
      unit_title: title ? title.slice(0, 500) : null, component_index: row.component_index,
      required_kind: row.required_kind, learning_objective_refs: [...refs], learning_objectives: [...new Set(resolved)],
      unresolved_reason: row.unresolved_reason, evidence_fact_count: row.evidence_fact_count,
    });
    return review ? [review] : [];
  }).slice(0, COURSE_AUTHOR_ASSESSMENT_REVIEWS_MAX);
}

/** The open obligations of one unit node (never of another unit). */
export function workspaceUnitAssessmentReviews(context: WorkspaceAuthorNotesContext, unitNodeId: string): CourseAuthorAssessmentReviewV1[] {
  return (context.assessment_reviews ?? []).filter(review => review.unit_node_id === unitNodeId)
    .slice(0, COURSE_AUTHOR_UNIT_ASSESSMENT_REVIEWS_MAX);
}

/** Notes for one chapter/lesson/unit/component write of a compiled Apply. */
export function workspaceBlockAuthorNotes(write: WorkspaceApplyWrite, context: WorkspaceAuthorNotesContext): CourseAuthorNotesV1 {
  const meta = write.author_metadata;
  // Only a unit with open obligations carries the key, so the notes of every
  // other block stay byte-identical to notes written before QLT-3.
  const reviews = write.kind === 'unit' ? workspaceUnitAssessmentReviews(context, write.node_id) : [];
  return assertCourseAuthorNotes({
    version: COURSE_AUTHOR_NOTES_VERSION, origin: 'ai_instructional_design',
    workspace_id: context.workspace_id, node_id: write.node_id, node_kind: write.kind,
    canonical_path: write.canonical_path, revision: write.revision, content_hash: write.content_hash,
    content_locale: context.content_locale, title: write.title,
    purpose: nullableText(meta.purpose), implementation_notes: nullableText(meta.implementation_notes),
    storyboard: write.kind === 'component' ? null : storyboard(meta.storyboard),
    author_review: write.kind === 'component' ? workspaceAuthorReview(meta.author_review) : null,
    media_briefs: meta.media_briefs.map(mediaBrief),
    idm_guidance: null,
    ...(reviews.length ? { assessment_reviews: reviews } : {}),
  });
}

/** Notes for the workspace course node, written to the course root block.
 * A V2 Apply always records the run-wide obligation list (possibly empty), so
 * an obligation resolved since the last Apply disappears from the root. */
export function workspaceCourseAuthorNotes(input: WorkspaceAuthorNotesContext & {
  node_id: string; revision: number; content_hash: string; content: WorkspaceContent;
  idm_guidance: CourseAuthorGuidanceV1 | null;
}): CourseAuthorNotesV1 {
  return assertCourseAuthorNotes({
    version: COURSE_AUTHOR_NOTES_VERSION, origin: 'ai_instructional_design',
    workspace_id: input.workspace_id, node_id: input.node_id, node_kind: 'course', canonical_path: 'course',
    revision: input.revision, content_hash: input.content_hash, content_locale: input.content_locale,
    title: input.content.title, purpose: nullableText(input.content.purpose),
    implementation_notes: nullableText(input.content.implementation_notes),
    storyboard: storyboard(input.content.data), author_review: null, media_briefs: [],
    idm_guidance: input.idm_guidance,
    ...(input.assessment_reviews ? { assessment_reviews: input.assessment_reviews.slice(0, COURSE_AUTHOR_ASSESSMENT_REVIEWS_MAX) } : {}),
  });
}

/** Canonical (key-order independent) fingerprint; jsonb reorders keys. */
export function workspaceAuthorNotesHash(value: unknown): string {
  return hash(value ?? null);
}

/** Block metadata written by a content Apply: learner component metadata,
 * the mapping identity keys checked by the SQL guard, the legacy storyboard
 * and the versioned author notes. */
export function workspaceApplyBlockMetadata(write: WorkspaceApplyWrite, context: WorkspaceAuthorNotesContext): Record<string, unknown> {
  return { ...(write.component?.metadata ?? {}), workspace_id: context.workspace_id, workspace_node_id: write.node_id,
    generated_by: 'lesson_author_ai',
    ...(write.kind === 'component' ? {} : { workspace_storyboard: write.author_metadata.storyboard }),
    [COURSE_AUTHOR_NOTES_KEY]: workspaceBlockAuthorNotes(write, context) };
}

/**
 * A mapped block whose learner content is already current can still carry
 * stale notes: a media brief was edited after the unit was applied, or the
 * block was applied before notes existed. Those writes need a metadata-only
 * refresh of the notes key (publish state and learner payload untouched).
 * Exact current notes are skipped, so an identical re-Apply writes nothing.
 */
export function workspaceAuthorNotesRefreshes(input: {
  materialized: readonly WorkspaceApplyWrite[];
  mappings: readonly WorkspaceApplyMapping[];
  stored_notes: ReadonlyMap<string, unknown>;
  context: WorkspaceAuthorNotesContext;
}): Array<{ write: WorkspaceApplyWrite; mapping: WorkspaceApplyMapping; notes: CourseAuthorNotesV1 }> {
  const byNode = new Map(input.mappings.map(mapping => [mapping.node_id, mapping]));
  return input.materialized.flatMap(write => {
    const mapping = byNode.get(write.node_id);
    if (!mapping) return [];
    const notes = workspaceBlockAuthorNotes(write, input.context);
    return workspaceAuthorNotesHash(input.stored_notes.get(mapping.target_block_id)) === workspaceAuthorNotesHash(notes)
      ? [] : [{ write, mapping, notes }];
  });
}
