import type { WorkspaceApplyCompileCode, WorkspaceApplyCompileError, WorkspaceApplyNode } from './lesson-author-workspace-apply.logic.js';

/**
 * Why an Apply was refused, in words an author can act on. The top-level
 * error code stays the compatibility contract; the reason only adds a safe
 * category and the human location (ordinal numbers and the author-visible
 * titles of the workspace nodes), never hashes, IDs or validator internals.
 */
export const WORKSPACE_APPLY_REASON_CATEGORIES = [
  'CHAPTER_NOT_COMPLETED',
  'UNIT_NOT_GENERATED',
  'UNIT_FALLBACK_NOT_APPLICABLE',
  'CONTENT_CHANGED',
  'CONTENT_INCOMPLETE',
  'CONTENT_EDIT_INVALID',
  'CONTENT_CHECK_FAILED',
  'STRUCTURE_INVALID',
] as const;
export type WorkspaceApplyReasonCategory = typeof WORKSPACE_APPLY_REASON_CATEGORIES[number];

export interface WorkspaceApplyLocationPart {
  /** 1-based position inside its parent, as the author sees it. */
  number: number;
  /** Current author-visible title, or null when the node has none. */
  title: string | null;
}
export interface WorkspaceApplyLocation {
  chapter: WorkspaceApplyLocationPart | null;
  lesson: WorkspaceApplyLocationPart | null;
  unit: WorkspaceApplyLocationPart | null;
  component: WorkspaceApplyLocationPart | null;
}
export interface WorkspaceApplyReason {
  category: WorkspaceApplyReasonCategory;
  location: WorkspaceApplyLocation | null;
}

const TITLE_MAX = 200;
const LEVELS = ['chapter', 'lesson', 'unit', 'component'] as const;
// Prefix match: V1 validator findings may append a JSON path after the node path.
const NODE_PATH = /^chapter_([1-9][0-9]{0,4})(?:\.lesson_([1-9][0-9]{0,4}))?(?:\.unit_([1-9][0-9]{0,4}))?(?:\.component_([1-9][0-9]{0,4}))?(?![0-9])/;

const DEFAULT_CATEGORY: Readonly<Record<WorkspaceApplyCompileCode, WorkspaceApplyReasonCategory | null>> = {
  WORKSPACE_APPLY_VALIDATION_FAILED: 'CONTENT_CHECK_FAILED',
  WORKSPACE_APPLY_BINDING_INVALID: 'CONTENT_CHANGED',
  WORKSPACE_APPLY_HASH_INVALID: 'CONTENT_CHANGED',
  WORKSPACE_APPLY_CONTEXT_INCOMPLETE: 'CONTENT_INCOMPLETE',
  WORKSPACE_APPLY_SCOPE_INVALID: 'STRUCTURE_INVALID',
  WORKSPACE_APPLY_INPUT_INVALID: 'STRUCTURE_INVALID',
  WORKSPACE_APPLY_LIMIT: 'STRUCTURE_INVALID',
  // These already have specific conflict / dependency answers.
  WORKSPACE_APPLY_REVISION_CONFLICT: null,
  WORKSPACE_APPLY_TARGET_CHANGED: null,
  WORKSPACE_APPLY_DEPENDENCY_REQUIRED: null,
};

const isControl = (code: number, allowLineBreaks: boolean) => (code < 0x20 || code === 0x7f)
  && !(allowLineBreaks && (code === 0x09 || code === 0x0a || code === 0x0d));

/** True when the text holds an ASCII control character (tab and line breaks allowed on request). */
export function hasControlCharacter(text: string, allowLineBreaks = false): boolean {
  for (let index = 0; index < text.length; index += 1) if (isControl(text.charCodeAt(index), allowLineBreaks)) return true;
  return false;
}

/** Author-visible title as one plain line: control characters become spaces, bounded length. */
export function workspacePlainTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = Array.from(value, character => isControl(character.charCodeAt(0), false) ? ' ' : character).join('').trim();
  return clean ? (clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean) : null;
}

function title(node: Pick<WorkspaceApplyNode, 'current' | 'baseline'> | undefined): string | null {
  for (const revision of [node?.current, node?.baseline]) {
    const content = revision?.content;
    const clean = content && typeof content === 'object' && !Array.isArray(content)
      ? workspacePlainTitle((content as Record<string, unknown>).title) : null;
    if (clean) return clean;
  }
  return null;
}

/** Location of a canonical node path, with titles read from the exact nodes the Apply loaded. */
export function workspaceApplyLocation(path: string,
  nodes: readonly Pick<WorkspaceApplyNode, 'canonical_path' | 'current' | 'baseline'>[]): WorkspaceApplyLocation | null {
  const match = NODE_PATH.exec(path);
  if (!match) return null;
  const byPath = new Map(nodes.map(node => [node.canonical_path, node]));
  const location: WorkspaceApplyLocation = { chapter: null, lesson: null, unit: null, component: null };
  let prefix = '';
  for (const [index, level] of LEVELS.entries()) {
    const ordinal = match[index + 1];
    if (!ordinal) break;
    prefix = prefix ? `${prefix}.${level}_${ordinal}` : `${level}_${ordinal}`;
    location[level] = { number: Number(ordinal), title: title(byPath.get(prefix)) };
  }
  return location;
}

/** Reason of a compiler refusal, or null when the code already has its own answer. */
export function workspaceApplyReasonFromCompileError(error: Pick<WorkspaceApplyCompileError, 'code' | 'findings' | 'reason'>,
  nodes: readonly Pick<WorkspaceApplyNode, 'canonical_path' | 'current' | 'baseline'>[]): WorkspaceApplyReason | null {
  const category = DEFAULT_CATEGORY[error.code] === null ? null : error.reason ?? DEFAULT_CATEGORY[error.code] ?? null;
  if (!category) return null;
  const path = error.findings.find(finding => NODE_PATH.test(finding.path))?.path;
  return { category, location: path ? workspaceApplyLocation(path, nodes) : null };
}

function part(value: unknown): WorkspaceApplyLocationPart | null | undefined {
  if (value === null) return null;
  const item = value as Record<string, unknown> | undefined;
  if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.number) || Number(item.number) < 1
    || !(item.title === null || typeof item.title === 'string' && item.title.length <= TITLE_MAX)) return undefined;
  return { number: Number(item.number), title: item.title as string | null };
}

/** Strict reader for a reason carried on an error object; anything else is no reason. */
export function readWorkspaceApplyReason(value: unknown): WorkspaceApplyReason | null {
  const reason = value as Record<string, unknown> | null | undefined;
  if (!reason || typeof reason !== 'object'
    || !(WORKSPACE_APPLY_REASON_CATEGORIES as readonly unknown[]).includes(reason.category)) return null;
  const raw = reason.location as Record<string, unknown> | null | undefined;
  if (raw === null || raw === undefined) return { category: reason.category as WorkspaceApplyReasonCategory, location: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parts = LEVELS.map(level => part(raw[level]));
  if (parts.some(item => item === undefined)) return null;
  const [chapter, lesson, unit, component] = parts as Array<WorkspaceApplyLocationPart | null>;
  return { category: reason.category as WorkspaceApplyReasonCategory, location: { chapter, lesson, unit, component } };
}

type Locale = 'vi' | 'en';
const NAMES = {
  vi: { chapter: 'Chương', lesson: 'mục', unit: 'bài học', component: 'nội dung' },
  en: { chapter: 'Chapter', lesson: 'section', unit: 'lesson', component: 'content' },
} as const;

/** "Chương 4 «X»", "bài học «Y» (Chương 4)", "nội dung «Z» trong bài học «Y» (Chương 4)". */
export function workspaceApplyLocationText(location: WorkspaceApplyLocation | null, locale: Locale): string | null {
  if (!location?.chapter) return null;
  const n = NAMES[locale];
  const quote = (value: string | null) => value ? (locale === 'vi' ? ` «${value}»` : ` "${value}"`) : '';
  const chapter = `${n.chapter} ${location.chapter.number}`;
  const named = (name: string, item: WorkspaceApplyLocationPart) => item.title ? `${name}${quote(item.title)}` : `${name} ${item.number}`;
  if (location.component) {
    const owner = location.unit ? ` ${locale === 'vi' ? 'trong' : 'in'} ${named(n.unit, location.unit)}` : '';
    return `${named(n.component, location.component)}${owner} (${chapter})`;
  }
  if (location.unit) return `${named(n.unit, location.unit)} (${chapter})`;
  if (location.lesson) return `${named(n.lesson, location.lesson)} (${chapter})`;
  return `${chapter}${quote(location.chapter.title)}`;
}

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);
// 'Viết lại chương' / 'Rewrite chapter' must stay the label of the recovery lane's chapter rewrite action.
const REWRITE = { vi: "Bạn có thể dùng 'Viết lại chương' hoặc tự soạn phần này trong khoá học.",
  en: "You can use 'Rewrite chapter' or write this part yourself in the course." } as const;

/** Plain VI/EN sentence telling the author what happened and what to do next. */
export function workspaceApplyReasonMessage(reason: WorkspaceApplyReason, locale: Locale): string {
  const where = workspaceApplyLocationText(reason.location, locale);
  const vi = locale === 'vi';
  switch (reason.category) {
    case 'CHAPTER_NOT_COMPLETED': return vi
      ? `${where ? capitalize(where) : 'Một chương'} chưa hoàn tất bước kiểm tra cuối, nên chưa áp dụng được. ${REWRITE.vi}`
      : `${where ? capitalize(where) : 'A chapter'} did not finish its final check, so it cannot be applied yet. ${REWRITE.en}`;
    case 'UNIT_NOT_GENERATED': return vi
      ? `${where ? capitalize(where) : 'Một số bài học'} chưa được AI soạn xong, nên chưa áp dụng được. ${REWRITE.vi}`
      : where ? `${capitalize(where)} was not finished by the AI, so it cannot be applied yet. ${REWRITE.en}`
        : `Some lessons were not finished by the AI, so they cannot be applied yet. ${REWRITE.en}`;
    case 'UNIT_FALLBACK_NOT_APPLICABLE': return vi
      ? `${where ? capitalize(where) : 'Một số bài học'} chỉ có bản nháp chép từ tài liệu nguồn vì AI chưa soạn được, nên không đưa vào khoá học. ${REWRITE.vi}`
      : where ? `${capitalize(where)} only has a draft copied from the source because the AI could not write it, so it is not added to the course. ${REWRITE.en}`
        : `Some lessons only have a draft copied from the source because the AI could not write them, so they are not added to the course. ${REWRITE.en}`;
    case 'CONTENT_CHANGED': return vi
      ? `Nội dung của ${where ?? 'một phần bản thiết kế'} không còn khớp với bản đã được kiểm tra. Hãy tải lại bản thiết kế rồi thử lại. Nếu vẫn không được, bạn có thể dùng 'Viết lại chương' hoặc tự soạn phần này trong khoá học.`
      : `The content of ${where ?? 'part of the design'} no longer matches the checked version. Reload the design and try again. If it still fails, you can use 'Rewrite chapter' or write this part yourself in the course.`;
    case 'CONTENT_INCOMPLETE': return vi
      ? `${where ? capitalize(where) : 'Một phần bản thiết kế'} chưa có nội dung hoàn chỉnh, nên chưa áp dụng được. Hãy chờ AI soạn xong, hoặc dùng 'Viết lại chương'.`
      : `${where ? capitalize(where) : 'Part of the design'} does not have complete content yet, so it cannot be applied. Wait for the AI to finish, or use 'Rewrite chapter'.`;
    case 'CONTENT_EDIT_INVALID': return vi
      ? `Phần bạn đã sửa ở ${where ?? 'bản thiết kế'} chưa hợp lệ. Hãy mở mục này, kiểm tra lại các ô bắt buộc rồi lưu lại trước khi áp dụng.`
      : `Your changes to ${where ?? 'the design'} are not valid. Open it, check the required fields and save again before applying.`;
    case 'CONTENT_CHECK_FAILED': return vi
      ? `${where ? capitalize(where) : 'Nội dung này'} chưa đạt bước kiểm tra trước khi áp dụng. Hãy mở mục này để xem và sửa, hoặc tự soạn trong khoá học.`
      : `${where ? capitalize(where) : 'This content'} did not pass the check before applying. Open it to review and fix it, or write it yourself in the course.`;
    case 'STRUCTURE_INVALID': return vi
      ? 'Cấu trúc của bản thiết kế khoá học này không còn hợp lệ để áp dụng. Hãy tạo một bản thiết kế mới cho phần này.'
      : 'The structure of this course design is no longer valid to apply. Create a new course design for this part.';
  }
}
