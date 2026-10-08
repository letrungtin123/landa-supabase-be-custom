import { assertCourseAuthorNotes, COURSE_AUTHOR_NOTES_KEY, COURSE_AUTHOR_NOTES_VERSION, type CourseAuthorGuidanceV1,
  type CourseAuthorMediaBriefV1, type CourseAuthorNotesV1, type CourseAuthorReviewV1 } from '../course-authoring/course-author-notes.logic.js';
import { generationSnapshotHash as hash } from './lesson-author-generation-job.logic.js';
import type { WorkspaceApplyMapping, WorkspaceApplyWrite } from './lesson-author-workspace-apply.logic.js';
import type { WorkspaceContent } from './lesson-author-workspace.logic.js';

/**
 * Pure projection of the author-only part of an applied workspace node into
 * `course_blocks.metadata.ai_id_author_notes` (QC 364564, defect N6). The
 * value is deterministic for one exact node revision (plus its media-brief
 * revisions and the run's IDM guidance), so re-applying the same revision
 * yields byte-identical notes and never appends duplicates.
 */
export interface WorkspaceAuthorNotesContext {
  workspace_id: string;
  content_locale: 'vi' | 'en';
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

/** Notes for one chapter/lesson/unit/component write of a compiled Apply. */
export function workspaceBlockAuthorNotes(write: WorkspaceApplyWrite, context: WorkspaceAuthorNotesContext): CourseAuthorNotesV1 {
  const meta = write.author_metadata;
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
  });
}

/** Notes for the workspace course node, written to the course root block. */
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
