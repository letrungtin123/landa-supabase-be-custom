// AI ID session name (C1, QC feedback 2026-10-21). An AI ID session is a chat_conversations row; a new
// one has the column default title below. When the V2 course skeleton succeeds, the session takes the
// AI course title, only while it still has that default (a title the author chose is kept).

/** chat_conversations.title column default: a session nobody has named yet. */
export const LESSON_AUTHOR_DEFAULT_SESSION_TITLE = 'Cuộc hội thoại mới';

/** The longest session title: the rename route's limit (UTF-16 code units; the column holds 255). */
export const LESSON_AUTHOR_SESSION_TITLE_MAX_LENGTH = 200;

/**
 * The session title made from the AI course title, normalized like a rename (NFC, one line, single
 * spaces) and cut to the rename limit without splitting a character; null when nothing is left.
 */
export function lessonAuthorSessionTitleFromCourseTitle(courseTitle: unknown): string | null {
  if (typeof courseTitle !== 'string') return null;
  const normalized = courseTitle.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= LESSON_AUTHOR_SESSION_TITLE_MAX_LENGTH) return normalized;
  let cut = '';
  for (const character of normalized) {
    if (cut.length + character.length > LESSON_AUTHOR_SESSION_TITLE_MAX_LENGTH) break;
    cut += character;
  }
  return cut.trimEnd();
}
