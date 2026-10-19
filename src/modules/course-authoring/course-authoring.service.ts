// ═══════════════════════════════════════════════════════════════
// Course Authoring Service — Replaces OpenEdX Studio CMS
// Course content tree stored as JSONB in course_blocks table
// Structure: course → chapter → sequential → vertical → components
//
// The entry points other modules import, by concern:
// - course-outline.service.ts: outline, blocks, child order, studio submit,
//   a new course's rows;
// - course-publish.service.ts: publish and discard of a subtree;
// - course-assets.service.ts: course files and the files the outline uses;
// - course-author-notes.service.ts: the AI ID author notes read;
// - course-lesson-author-apply.service.ts: the AI ID apply;
// - course-authoring.types.ts: the shared types.
// SQL lives in course-blocks.repository.ts and course-assets.repository.ts.
// ═══════════════════════════════════════════════════════════════

export * from './course-authoring.types.js';
export {
  createBlock,
  deleteBlock,
  getBlockInfo,
  getCourseAuditContext,
  getCourseOutline,
  getUnitChildren,
  initializeCourseStructure,
  insertCourseRecord,
  reorderChildren,
  studioSubmit,
  updateBlock,
} from './course-outline.service.js';
export { discardDraftCascade, publishBlock } from './course-publish.service.js';
export {
  assertCourseInTenant,
  assertImageChoiceQuizImageAssets,
  createAssetRecord,
  deleteAsset,
  deleteAssetByStoragePath,
  getCourseAssets,
  updateCourseAssetReference,
} from './course-assets.service.js';
export {
  COURSE_AUTHOR_NOTES_MAX_BLOCKS,
  getCourseAuthorNotes,
  type CourseAuthorNotesBlock,
  type CourseAuthorNotesView,
} from './course-author-notes.service.js';
export { applyLessonAuthorProposalToCourse, LESSON_AUTHOR_OUTLINE_BUSY_CODE } from './course-lesson-author-apply.service.js';
export {
  getLessonAuthorSortableItems,
  orderLessonAuthorComponents,
} from './lesson-author-components.logic.js';
