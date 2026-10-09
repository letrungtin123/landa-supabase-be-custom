// ═══════════════════════════════════════════════════════════════
// Runtime chat course scope — which course a chat turn may read
//
// The course a conversation talks about comes from the client (courseId in
// the query/body) or from the conversation row. Before its outline or lesson
// content reaches the model it must be a live course of the caller's tenant,
// and for learner roles one the learner may open (same rule as the learner
// course pages: learnerCourseAccessCondition).
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { isLearnerRole } from '../../types/index.js';
import { learnerCourseAccessCondition } from '../courses/course-access.js';

/** [HTTP status, Vietnamese, English] — the response picks the request locale. */
export const CHAT_COURSE_ERRORS = {
  NOT_AVAILABLE: [
    404,
    'Không tìm thấy khóa học này hoặc bạn chưa có quyền xem khóa học. Hãy mở lại khóa học từ danh sách của bạn.',
    'This course was not found or you do not have access to it. Please open the course again from your list.',
  ],
} as const satisfies Record<string, readonly [number, string, string]>;

export const CHAT_COURSE_CODE_PREFIX = 'CHAT_COURSE_';

export class ChatCourseScopeError extends AppError {
  public readonly messageEn: string;

  constructor(code: keyof typeof CHAT_COURSE_ERRORS = 'NOT_AVAILABLE') {
    const [status, vi, en] = CHAT_COURSE_ERRORS[code];
    super(vi, status, `${CHAT_COURSE_CODE_PREFIX}${code}`);
    this.name = 'ChatCourseScopeError';
    this.messageEn = en;
  }

  localizedMessage(locale: 'vi' | 'en'): string {
    return locale === 'en' ? this.messageEn : this.message;
  }
}

export interface ChatCourseActor {
  tenantId: string | null | undefined;
  userId: string;
  role: string | null | undefined;
}

const MAX_COURSE_ID_LENGTH = 255;

/** Throws ChatCourseScopeError (404) unless the actor may use the course in chat. */
export async function assertChatCourseAccess(courseId: string, actor: ChatCourseActor): Promise<void> {
  if (!actor.tenantId || typeof courseId !== 'string' || !courseId.trim()
    || courseId.length > MAX_COURSE_ID_LENGTH || /[\x00-\x1f\x7f]/.test(courseId)) {
    throw new ChatCourseScopeError();
  }
  const params: unknown[] = [courseId, actor.tenantId];
  const conditions = ['c.id = $1', 'c.tenant_id = $2::uuid', 'c.deleted_at IS NULL'];
  if (isLearnerRole(actor.role)) {
    params.push(actor.userId);
    conditions.push(learnerCourseAccessCondition('c', `$${params.length}`));
  }
  const result = await query<{ id: string }>(
    `SELECT c.id
     FROM courses c
     WHERE ${conditions.join(' AND ')}
     LIMIT 1`,
    params,
  );
  if (result.rowCount === 0) throw new ChatCourseScopeError();
}
