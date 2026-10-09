// ═══════════════════════════════════════════════════════════════
// AI course design (lesson author) session sharing — one policy
//
// Sessions belong to a course, not to a private user space:
//   1. Every course editor of the tenant (staff with courses.can_edit,
//      superuser, superadmin in the selected tenant) sees every session of the
//      course, opens it read-only and may Apply its workspace to the course.
//   2. Only the creator continues a session: chat, workspace launch/re-run,
//      node edits, transcriptions, chapter checkpoints.
//   3. Rename/delete: the creator, a superuser of the same tenant, or a
//      superadmin (tenant isolation is enforced by every SQL statement; this
//      module never widens it).
// Errors are [status, vi, en]; the public code is LESSON_AUTHOR_SESSION_<CODE>.
// ═══════════════════════════════════════════════════════════════

import { AppError } from '../../middleware/error-handler.js';

export const LESSON_AUTHOR_SESSION_CODE_PREFIX = 'LESSON_AUTHOR_SESSION_';

/** [HTTP status, Vietnamese, English] — the response picks by the request UI locale. */
export const LESSON_AUTHOR_SESSION_ERRORS = {
  FORBIDDEN: [403, 'Bạn không có quyền xem hoặc quản lý các phiên thiết kế của khoá học này.',
    'You do not have permission to view or manage the design sessions of this course.'],
  INPUT_INVALID: [400, 'Thông tin gửi lên không hợp lệ. Vui lòng tải lại trang rồi thử lại.',
    'Some of the information sent was not valid. Please reload the page and try again.'],
  CURSOR_INVALID: [400, 'Không tải thêm được danh sách. Vui lòng tải lại trang.',
    'More items could not be loaded. Please reload the page.'],
  NOT_FOUND: [404, 'Không tìm thấy phiên thiết kế này. Có thể phiên đã bị xoá.',
    'This design session was not found. It may have been deleted.'],
  CONFLICT: [409, 'Phiên thiết kế vừa được thay đổi ở nơi khác. Vui lòng tải lại danh sách rồi thử lại.',
    'This design session was just changed somewhere else. Please reload the list and try again.'],
  ACTIVE: [409, 'Phiên này đang tạo nội dung. Hãy chờ hoàn tất rồi mới xoá.',
    'This session is still creating content. Wait for it to finish before deleting it.'],
  DELETE_NOT_FOUND: [404, 'Không tìm thấy yêu cầu xoá này.', 'This delete request was not found.'],
  NOT_OWNER: [403, 'Chỉ người tạo phiên thiết kế này mới tiếp tục soạn được. Bạn vẫn có thể xem và đưa nội dung của phiên vào khoá học.',
    'Only the person who started this design session can continue it. You can still view it and add its content to the course.'],
  MANAGE_FORBIDDEN: [403, 'Chỉ người tạo phiên, quản trị viên doanh nghiệp hoặc quản trị viên hệ thống mới được đổi tên hoặc xoá phiên này.',
    'Only the person who started this session, an organization admin or a system admin can rename or delete it.'],
  COURSE_EDIT_REQUIRED: [403, 'Bạn cần quyền chỉnh sửa khoá học để dùng trợ lý soạn khoá học.',
    'You need permission to edit courses to use the course design assistant.'],
} as const satisfies Record<string, readonly [number, string, string]>;

export type LessonAuthorSessionErrorCode = keyof typeof LESSON_AUTHOR_SESSION_ERRORS;

export class LessonAuthorSessionError extends AppError {
  public readonly sessionCode: LessonAuthorSessionErrorCode;
  public readonly messageEn: string;

  constructor(code: LessonAuthorSessionErrorCode) {
    const [status, vi, en] = LESSON_AUTHOR_SESSION_ERRORS[code];
    super(vi, status, `${LESSON_AUTHOR_SESSION_CODE_PREFIX}${code}`);
    this.name = 'LessonAuthorSessionError';
    this.sessionCode = code;
    this.messageEn = en;
  }

  localizedMessage(locale: 'vi' | 'en'): string {
    return locale === 'en' ? this.messageEn : this.message;
  }
}

/** `ui_locale` query first (the AI course design UI sends it), then X-UI-Locale. */
export function lessonAuthorRequestLocale(queryLocale: unknown, header: string | undefined): 'vi' | 'en' {
  if (queryLocale === 'en' || queryLocale === 'vi') return queryLocale;
  return header?.trim().toLowerCase() === 'en' ? 'en' : 'vi';
}

export interface LessonAuthorSessionActor {
  id: string;
  role: string;
}

export interface LessonAuthorSessionPermissions {
  is_owner: boolean;
  /** Chat, launch/re-run, node edits, transcriptions, chapter checkpoints. */
  can_continue: boolean;
  can_rename: boolean;
  can_delete: boolean;
  /** Every course editor that can see the session may Apply its workspace. */
  can_apply: boolean;
}

const MANAGE_OTHERS_ROLES = new Set(['superuser', 'superadmin']);

/** Rename/delete: creator, superuser (same tenant, enforced by SQL) or superadmin. */
export function canManageLessonAuthorSession(actor: LessonAuthorSessionActor, ownerId: string): boolean {
  return actor.id === ownerId || MANAGE_OTHERS_ROLES.has(actor.role);
}

/**
 * Display capabilities for one session. The caller already passed the course
 * editor gate (checkPermission('courses','can_edit') + tenant context); every
 * write still re-checks on the server, so these flags never grant anything.
 */
export function lessonAuthorSessionPermissions(actor: LessonAuthorSessionActor, ownerId: string): LessonAuthorSessionPermissions {
  const isOwner = actor.id === ownerId;
  const canManage = canManageLessonAuthorSession(actor, ownerId);
  return { is_owner: isOwner, can_continue: isOwner, can_rename: canManage, can_delete: canManage, can_apply: true };
}

export type LessonAuthorSessionScope = 'mine' | 'all';

/** List filter: default `all` (owner decision); anything else is rejected. */
export function parseLessonAuthorSessionScope(value: unknown): LessonAuthorSessionScope | null {
  if (value === undefined) return 'all';
  return value === 'mine' || value === 'all' ? value : null;
}

/** Human name of the session creator; never an internal id. */
export function lessonAuthorSessionOwnerName(fullName: unknown, username: unknown): string {
  const name = typeof fullName === 'string' ? fullName.replace(/\s+/g, ' ').trim() : '';
  if (name) return name.slice(0, 160);
  const user = typeof username === 'string' ? username.trim() : '';
  return user ? user.slice(0, 150) : '';
}
