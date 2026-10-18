// ═══════════════════════════════════════════════════════════════
// Learner query schemas: the query string of the learner list routes, read
// the way the controller always read it. They coerce and never reject:
// every request accepted before is accepted with the same values (a page
// that is not a number reads as NaN, a repeated parameter keeps its old
// reading). Request bodies are still read by the controller as before.
// ═══════════════════════════════════════════════════════════════

import { z } from 'zod';

/** `?page=2` -> 2; absent or empty -> undefined; not a number -> NaN (as before). */
const optionalInt = z.unknown().transform(value => (value ? parseInt(value as string) : undefined));
/** The raw value as text, unchecked (a repeated parameter stays a list at run time, as before). */
const rawText = z.unknown().transform(value => value as string | undefined);

/** GET /api/learner/courses */
export const learnerCoursesQuerySchema = z.object({
  search: rawText,
  category_id: rawText,
  page: optionalInt,
  page_size: optionalInt,
});

/** GET /api/learner/library/documents */
export const learnerLibraryDocumentsQuerySchema = z.object({
  page: optionalInt,
  page_size: optionalInt,
  category: rawText,
  extension: rawText,
  search: rawText,
  ordering: rawText,
});

/** GET /api/learner/notifications */
export const learnerNotificationsQuerySchema = z.object({
  page: optionalInt,
  page_size: optionalInt,
});

/** GET /api/learner/progress-batch (the list is split and checked in the controller). */
export const learnerBatchProgressQuerySchema = z.object({
  courseIds: rawText,
});
