import { z } from 'zod';

/**
 * AI ID author notes (QC course 364564, defect N6).
 *
 * AI ID Apply materializes learner content into `course_blocks`, but the
 * author-facing design output (QA notes, Hold items, SME questions,
 * nice-to-know, media briefs, the course summary/audience) used to stay in
 * the workspace only. It now travels with each applied block under ONE
 * reserved, server-owned, versioned key of `course_blocks.metadata`:
 *
 *   metadata.ai_id_author_notes = CourseAuthorNotesV1
 *
 * Invariants enforced by the callers of this module:
 * - Only AI ID Apply writes the key. Browser metadata (create, PATCH,
 *   studio_submit) can neither set nor delete it; a PATCH keeps the stored
 *   value server-side.
 * - It is author-only. Every learner read path, export, cross-course transfer
 *   and the generic CMS block read strips it with `withoutAuthorOnlyMetadata`;
 *   only the `courses.can_edit` author-notes endpoint returns it.
 * - Publishing copies metadata to published_metadata unchanged (draft/published
 *   parity is untouched), which is why learner reads must strip it.
 */
export const COURSE_AUTHOR_NOTES_KEY = 'ai_id_author_notes';
export const COURSE_AUTHOR_NOTES_VERSION = 1;
/** Author-facing AI design metadata that is never part of the learner payload.
 * `workspace_storyboard` predates the notes key (objective, outcomes,
 * activities, assessment) and is equally author-only. */
export const AUTHOR_ONLY_METADATA_KEYS: readonly string[] = Object.freeze([COURSE_AUTHOR_NOTES_KEY, 'workspace_storyboard']);
/** Bounds for one block's notes. Workspace content is already bounded; this is
 * a last fence for the stored JSON and the author-notes endpoint. */
export const COURSE_AUTHOR_NOTES_MAX_BYTES = 1024 * 1024;

export type CourseAuthorNotesNodeKind = 'course' | 'chapter' | 'lesson' | 'unit' | 'component';

export interface CourseAuthorMediaBriefV1 {
  node_id: string;
  revision: number;
  content_hash: string;
  media_type: 'video' | 'static_infographic' | null;
  title: string;
  /** The brief's `purpose` in the workspace: why this media is recommended. */
  rationale: string | null;
  content_points: string[];
  context_description: string | null;
  implementation_notes: string | null;
}

export interface CourseAuthorReviewV1 {
  purpose: string | null;
  example_scenario: string | null;
  visual_asset: string | null;
  user_behavior_navigation: string | null;
}

export interface CourseAuthorGuidanceV1 {
  hold_items: Array<{ name: string; reason: string | null; sme_question: string | null; blocked_must_dos: string[] }>;
  pending_objectives: string[];
  nice_to_know: Array<{ name: string; summary: string }>;
  /** Every other question for the SME (QLT-3): the free-text course note
   * only shows the first ten ("và N mục khác"). Absent in notes applied
   * before QLT-3. */
  sme_questions?: string[];
}

/**
 * One open assessment obligation of the run at Apply time (QLT-3): a planned
 * check question the AI could not produce from verified source evidence, so
 * the author must write or verify it. Codes stay machine codes here; Studio
 * explains them in the author's language.
 */
export interface CourseAuthorAssessmentReviewV1 {
  obligation_id: string;
  /** Workspace unit node the obligation belongs to (null when not found). */
  unit_node_id: string | null;
  unit_path: string;
  /** AI unit title at Apply time; the block may have been renamed since. */
  unit_title: string | null;
  /** Planned component slot inside the unit (1-based). */
  component_index: number;
  required_kind: string;
  /** Lesson-local objective refs (`lo_<n>` = the lesson's n-th objective). */
  learning_objective_refs: string[];
  /** The referenced lesson objectives as text, when they could be resolved. */
  learning_objectives: string[];
  unresolved_reason: string;
  evidence_fact_count: number;
}
export const COURSE_AUTHOR_ASSESSMENT_REVIEWS_MAX = 200;
export const COURSE_AUTHOR_UNIT_ASSESSMENT_REVIEWS_MAX = 24;
export const COURSE_AUTHOR_SME_QUESTIONS_MAX = 300;

export interface CourseAuthorNotesV1 {
  version: 1;
  origin: 'ai_instructional_design';
  workspace_id: string;
  node_id: string;
  node_kind: CourseAuthorNotesNodeKind;
  canonical_path: string;
  /** Exact workspace revision these notes were applied from. */
  revision: number;
  content_hash: string;
  content_locale: 'vi' | 'en';
  /** The AI title at Apply time; the block may have been renamed since. */
  title: string;
  purpose: string | null;
  implementation_notes: string | null;
  /** Course/chapter/lesson storyboard fields (summary, audience, objectives…). */
  storyboard: Record<string, string | string[]> | null;
  author_review: CourseAuthorReviewV1 | null;
  media_briefs: CourseAuthorMediaBriefV1[];
  /** Course node of an IDM run only: Hold items, pending objectives, nice-to-know. */
  idm_guidance: CourseAuthorGuidanceV1 | null;
  /**
   * Open assessment obligations ("needs your review"), V2 runs only. A unit
   * carries its own (omitted when it has none); the course root carries the
   * run-wide list (present, possibly empty, for every V2 Apply). The root is
   * refreshed by every Apply, including a semantic replay, so it is the
   * current list; mapped unit blocks are refreshed by the next non-replay Apply.
   */
  assessment_reviews?: CourseAuthorAssessmentReviewV1[];
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = (max: number) => z.string().max(max);
const optionalText = (max: number) => text(max).nullable();
const lines = (count: number, max: number) => z.array(text(max)).max(count);
const assessmentReview = z.object({
  obligation_id: uuid,
  unit_node_id: uuid.nullable(),
  unit_path: text(240),
  unit_title: optionalText(500),
  component_index: z.number().int().min(1).max(99),
  required_kind: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  learning_objective_refs: lines(24, 32),
  learning_objectives: lines(24, 2000),
  unresolved_reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
  evidence_fact_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
const notesSchema = z.object({
  version: z.literal(COURSE_AUTHOR_NOTES_VERSION),
  origin: z.literal('ai_instructional_design'),
  workspace_id: uuid,
  node_id: uuid,
  node_kind: z.enum(['course', 'chapter', 'lesson', 'unit', 'component']),
  canonical_path: text(240),
  revision,
  content_hash: digest,
  content_locale: z.enum(['vi', 'en']),
  title: text(500),
  purpose: optionalText(8000),
  implementation_notes: optionalText(8000),
  storyboard: z.record(z.union([text(8000), lines(64, 2000)])).nullable(),
  author_review: z.object({ purpose: optionalText(2000), example_scenario: optionalText(2000),
    visual_asset: optionalText(2000), user_behavior_navigation: optionalText(2000) }).strict().nullable(),
  media_briefs: z.array(z.object({ node_id: uuid, revision, content_hash: digest,
    media_type: z.enum(['video', 'static_infographic']).nullable(), title: text(500), rationale: optionalText(8000),
    content_points: lines(16, 1000), context_description: optionalText(2000),
    implementation_notes: optionalText(8000) }).strict()).max(32),
  idm_guidance: z.object({
    hold_items: z.array(z.object({ name: text(2000), reason: optionalText(4000), sme_question: optionalText(4000),
      blocked_must_dos: lines(64, 2000) }).strict()).max(200),
    pending_objectives: lines(200, 2000),
    nice_to_know: z.array(z.object({ name: text(2000), summary: text(4000) }).strict()).max(400),
    sme_questions: lines(COURSE_AUTHOR_SME_QUESTIONS_MAX, 2000).optional(),
  }).strict().nullable(),
  assessment_reviews: z.array(assessmentReview).max(COURSE_AUTHOR_ASSESSMENT_REVIEWS_MAX).optional(),
}).strict();

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Strict, versioned read. Unknown versions, extra fields or oversized values
 * are not shown (null) instead of being trusted or partially rendered. */
export function readCourseAuthorNotes(value: unknown): CourseAuthorNotesV1 | null {
  if (!plainObject(value)) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > COURSE_AUTHOR_NOTES_MAX_BYTES) return null;
  } catch { return null; }
  const parsed = notesSchema.safeParse(value);
  return parsed.success ? parsed.data as CourseAuthorNotesV1 : null;
}

/** Strict read of one assessment review entry (null when invalid). */
export function readCourseAuthorAssessmentReview(value: unknown): CourseAuthorAssessmentReviewV1 | null {
  const parsed = assessmentReview.safeParse(value);
  return parsed.success ? parsed.data as CourseAuthorAssessmentReviewV1 : null;
}

/** Fail-closed write-side check used by Apply before a value is persisted. */
export function assertCourseAuthorNotes(value: CourseAuthorNotesV1): CourseAuthorNotesV1 {
  const parsed = readCourseAuthorNotes(value);
  if (!parsed) throw new Error('COURSE_AUTHOR_NOTES_INVALID');
  return parsed;
}

/**
 * Remove author-only keys from a block metadata value. Returns the same value
 * when nothing needs stripping, so learner payloads stay byte-identical for
 * blocks that never carried AI ID notes. JSON text is handled as well because
 * some legacy rows/drivers surface jsonb as a string.
 */
export function withoutAuthorOnlyMetadata<T>(metadata: T): T {
  if (typeof metadata === 'string') {
    if (!AUTHOR_ONLY_METADATA_KEYS.some(key => metadata.includes(`"${key}"`))) return metadata;
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return (plainObject(parsed) ? withoutAuthorOnlyMetadata(parsed) : metadata) as T;
    } catch { return metadata; }
  }
  if (!plainObject(metadata) || !AUTHOR_ONLY_METADATA_KEYS.some(key => Object.prototype.hasOwnProperty.call(metadata, key))) return metadata;
  const copy: Record<string, unknown> = { ...metadata };
  for (const key of AUTHOR_ONLY_METADATA_KEYS) delete copy[key];
  return copy as T;
}

/** Strip author-only metadata from every metadata-like column of a block row. */
export function withoutAuthorOnlyBlockMetadata<T extends object>(row: T): T {
  const source = row as Record<string, unknown>;
  let copy: Record<string, unknown> | null = null;
  for (const column of ['metadata', 'published_metadata']) {
    if (!Object.prototype.hasOwnProperty.call(source, column)) continue;
    const stripped = withoutAuthorOnlyMetadata(source[column]);
    if (stripped !== source[column]) { copy ??= { ...source }; copy[column] = stripped; }
  }
  return (copy ?? row) as T;
}

/** Browser-supplied metadata may never forge or delete server-owned notes. */
export function withoutServerOwnedAuthorNotes<T>(metadata: T): T {
  if (!plainObject(metadata) || !Object.prototype.hasOwnProperty.call(metadata, COURSE_AUTHOR_NOTES_KEY)) return metadata;
  const copy: Record<string, unknown> = { ...metadata };
  delete copy[COURSE_AUTHOR_NOTES_KEY];
  return copy as T;
}

/** SQL expression for a metadata PATCH: `$param` replaces the editable
 * metadata, the stored server-owned notes are carried over unchanged. Must be
 * used inside `UPDATE course_blocks SET metadata = …` so `metadata` is the
 * locked current row value. */
export function preserveAuthorNotesSql(param: string): string {
  return `((${param}::jsonb - '${COURSE_AUTHOR_NOTES_KEY}') || CASE WHEN jsonb_typeof(metadata)='object' AND metadata ? '${COURSE_AUTHOR_NOTES_KEY}'`
    + ` THEN jsonb_build_object('${COURSE_AUTHOR_NOTES_KEY}', metadata->'${COURSE_AUTHOR_NOTES_KEY}') ELSE '{}'::jsonb END)`;
}
