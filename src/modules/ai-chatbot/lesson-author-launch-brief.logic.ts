import { sanitizeIdmAuthorText } from './lesson-author-idm-intent.logic.js';

/**
 * QLT-6 launch brief: how the author starts AI ID, chosen once in the start panel
 * and stored write-once with the workspace (`lesson_author_workspaces.launch_brief`).
 *
 * - `instructional_design`: the full IDM design. The author must enter the learner
 *   audience and the course purpose; the CMS course description stays background.
 * - `preserve_source`: a ready-made document kept word for word. The two texts must
 *   not be sent (the panel hides them).
 *
 * Texts are cleaned like the QLT-5 author intent (HTML and control characters
 * removed, whitespace collapsed) and are data for the AI, never instructions.
 */

export const LESSON_AUTHOR_DESIGN_MODES = ['instructional_design', 'preserve_source'] as const;
export type LessonAuthorDesignMode = typeof LESSON_AUTHOR_DESIGN_MODES[number];
/** Request/body bounds of the contract (code points, Python `len`). */
export const LAUNCH_BRIEF_AUDIENCE_MAX_CHARS = 300;
export const LAUNCH_BRIEF_PURPOSE_MAX_CHARS = 500;
/** Shape version of the stored jsonb (never exposed by read APIs). */
export const LAUNCH_BRIEF_STORAGE_VERSION = 1;
/** Body keys of the brief on the workspace Create request; `design_mode` is required. */
export const LAUNCH_BRIEF_BODY_KEYS = ['design_mode', 'learner_audience', 'course_purpose'] as const;

export const LESSON_AUTHOR_LAUNCH_MODE_INVALID = 'LESSON_AUTHOR_LAUNCH_MODE_INVALID';
export const LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED = 'LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED';
export const LESSON_AUTHOR_LAUNCH_PURPOSE_REQUIRED = 'LESSON_AUTHOR_LAUNCH_PURPOSE_REQUIRED';
export const LESSON_AUTHOR_LAUNCH_BRIEF_TOO_LONG = 'LESSON_AUTHOR_LAUNCH_BRIEF_TOO_LONG';
export const LESSON_AUTHOR_LAUNCH_BRIEF_NOT_ALLOWED = 'LESSON_AUTHOR_LAUNCH_BRIEF_NOT_ALLOWED';
export type LaunchBriefErrorCode =
  | typeof LESSON_AUTHOR_LAUNCH_MODE_INVALID
  | typeof LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED
  | typeof LESSON_AUTHOR_LAUNCH_PURPOSE_REQUIRED
  | typeof LESSON_AUTHOR_LAUNCH_BRIEF_TOO_LONG
  | typeof LESSON_AUTHOR_LAUNCH_BRIEF_NOT_ALLOWED;

/** HTTP 400 messages `[vi, en]`, plain words for authors. */
export const LAUNCH_BRIEF_ERROR_MESSAGES: Readonly<Record<LaunchBriefErrorCode, readonly [string, string]>> = Object.freeze({
  LESSON_AUTHOR_LAUNCH_MODE_INVALID: [
    'Hãy chọn cách AI ID xử lý tài liệu: thiết kế bài giảng từ tài liệu thô hoặc giữ nguyên nội dung tài liệu.',
    'Choose how AI ID should use the document: design a course from raw material, or keep the document content as it is.'],
  LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED: [
    'Hãy nhập đối tượng học: khoá học này dành cho ai.',
    'Please enter the learner audience: who this course is for.'],
  LESSON_AUTHOR_LAUNCH_PURPOSE_REQUIRED: [
    'Hãy nhập mục đích khoá học: học xong, người học cần biết hoặc làm được gì.',
    'Please enter the course purpose: what learners should know or be able to do after the course.'],
  LESSON_AUTHOR_LAUNCH_BRIEF_TOO_LONG: [
    'Đối tượng học tối đa 300 ký tự, mục đích khoá học tối đa 500 ký tự. Hãy rút gọn rồi thử lại.',
    'The learner audience can be up to 300 characters and the course purpose up to 500. Please shorten it and try again.'],
  LESSON_AUTHOR_LAUNCH_BRIEF_NOT_ALLOWED: [
    'Chế độ giữ nguyên nội dung tài liệu không dùng đối tượng học và mục đích khoá học. Hãy bỏ hai thông tin này rồi thử lại.',
    'Keeping the document content as it is does not use the learner audience or the course purpose. Remove them and try again.'],
});

/** The brief as the API exposes it and the AI receives it (cleaned texts; null in preserve_source). */
export interface LessonAuthorLaunchBrief {
  design_mode: LessonAuthorDesignMode;
  learner_audience: string | null;
  course_purpose: string | null;
}

/** The stored jsonb shape (`version` is storage-only). */
export interface StoredLessonAuthorLaunchBrief extends LessonAuthorLaunchBrief {
  version: typeof LAUNCH_BRIEF_STORAGE_VERSION;
}

export class LaunchBriefError extends Error {
  constructor(readonly code: LaunchBriefErrorCode) {
    super(code);
    this.name = 'LaunchBriefError';
  }
}

/** A stored brief that is not the shape this code writes (fails closed, never shown or sent). */
export class LaunchBriefStoredInvalidError extends Error {
  readonly code = 'LESSON_AUTHOR_LAUNCH_BRIEF_STORED_INVALID';
  constructor() {
    super('LESSON_AUTHOR_LAUNCH_BRIEF_STORED_INVALID');
    this.name = 'LaunchBriefStoredInvalidError';
  }
}

export function isLaunchBriefErrorCode(value: unknown): value is LaunchBriefErrorCode {
  return typeof value === 'string' && Object.hasOwn(LAUNCH_BRIEF_ERROR_MESSAGES, value);
}

function codePoints(value: string): number {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}

const fail = (code: LaunchBriefErrorCode): never => { throw new LaunchBriefError(code); };

/**
 * One required author text: a string whose trimmed raw length fits the bound
 * (the panel's character limit) and that keeps some text after cleaning.
 * The raw bound is checked first, so cleaning never runs on oversized input.
 */
function requiredText(value: unknown, maximum: number, required: LaunchBriefErrorCode): string {
  if (typeof value !== 'string') return fail(required);
  if (codePoints(value.trim()) > maximum) fail(LESSON_AUTHOR_LAUNCH_BRIEF_TOO_LONG);
  return sanitizeIdmAuthorText(value, maximum) ?? fail(required);
}

/**
 * Parse the brief keys of a workspace Create body (other keys are the caller's).
 * Throws `LaunchBriefError` with the contract code of the first problem.
 */
export function parseLaunchBrief(body: Readonly<Record<string, unknown>>): LessonAuthorLaunchBrief {
  const mode = body.design_mode;
  if (typeof mode !== 'string' || !(LESSON_AUTHOR_DESIGN_MODES as readonly string[]).includes(mode)) {
    fail(LESSON_AUTHOR_LAUNCH_MODE_INVALID);
  }
  if (mode === 'preserve_source') {
    // "Must be absent": even an empty or null value is a client that still shows the design fields.
    if (Object.hasOwn(body, 'learner_audience') || Object.hasOwn(body, 'course_purpose')) {
      fail(LESSON_AUTHOR_LAUNCH_BRIEF_NOT_ALLOWED);
    }
    return { design_mode: 'preserve_source', learner_audience: null, course_purpose: null };
  }
  return {
    design_mode: 'instructional_design',
    learner_audience: requiredText(body.learner_audience, LAUNCH_BRIEF_AUDIENCE_MAX_CHARS,
      LESSON_AUTHOR_LAUNCH_AUDIENCE_REQUIRED),
    course_purpose: requiredText(body.course_purpose, LAUNCH_BRIEF_PURPOSE_MAX_CHARS,
      LESSON_AUTHOR_LAUNCH_PURPOSE_REQUIRED),
  };
}

/**
 * A text the cleaner could have produced: plain single spaces only, no edge
 * space, no control character, no angle bracket, 1..maximum code points.
 */
function cleanText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && codePoints(value) <= maximum && value === value.trim()
    && !/[<>\u0000-\u001f\u007f-\u009f]|[^\S ]| {2}/.test(value);
}

/** True for an already-cleaned brief this module would have produced (service and storage re-checks). */
export function isNormalizedLaunchBrief(value: unknown): value is LessonAuthorLaunchBrief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const brief = value as Record<string, unknown>;
  const keys = Object.keys(brief);
  if (keys.length !== 3 || LAUNCH_BRIEF_BODY_KEYS.some(key => !Object.hasOwn(brief, key))) return false;
  if (brief.design_mode === 'preserve_source') return brief.learner_audience === null && brief.course_purpose === null;
  return brief.design_mode === 'instructional_design'
    && cleanText(brief.learner_audience, LAUNCH_BRIEF_AUDIENCE_MAX_CHARS)
    && cleanText(brief.course_purpose, LAUNCH_BRIEF_PURPOSE_MAX_CHARS);
}

/** The jsonb written once at workspace creation. */
export function storedLaunchBrief(brief: LessonAuthorLaunchBrief): StoredLessonAuthorLaunchBrief {
  return { design_mode: brief.design_mode, learner_audience: brief.learner_audience,
    course_purpose: brief.course_purpose, version: LAUNCH_BRIEF_STORAGE_VERSION };
}

/**
 * Read the stored column: null for workspaces created before QLT-6, the public
 * brief (without `version`) otherwise. Any other shape fails closed.
 */
export function readStoredLaunchBrief(value: unknown): LessonAuthorLaunchBrief | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new LaunchBriefStoredInvalidError();
  const { version, ...brief } = value as Record<string, unknown>;
  if (version !== LAUNCH_BRIEF_STORAGE_VERSION || !isNormalizedLaunchBrief(brief)) throw new LaunchBriefStoredInvalidError();
  return { design_mode: brief.design_mode, learner_audience: brief.learner_audience, course_purpose: brief.course_purpose };
}

/** Whether a stored brief (raw column value) is exactly the requested brief. */
export function sameLaunchBrief(stored: unknown, requested: LessonAuthorLaunchBrief): boolean {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return false;
  const { version, ...brief } = stored as Record<string, unknown>;
  return version === LAUNCH_BRIEF_STORAGE_VERSION && isNormalizedLaunchBrief(brief)
    && brief.design_mode === requested.design_mode && brief.learner_audience === requested.learner_audience
    && brief.course_purpose === requested.course_purpose;
}

/**
 * The request-identity input of a workspace Create with its brief: the same
 * operation with a different brief must hash differently (replay conflict). A
 * request without a brief keeps its pre-QLT-6 identity unchanged.
 */
export function withLaunchBriefIdentity<T extends Record<string, unknown>>(
  identity: T, brief: LessonAuthorLaunchBrief | null | undefined,
): T | (T & { launch_brief: LessonAuthorLaunchBrief }) {
  if (!brief) return identity;
  return { ...identity, launch_brief: { design_mode: brief.design_mode, learner_audience: brief.learner_audience,
    course_purpose: brief.course_purpose } };
}
