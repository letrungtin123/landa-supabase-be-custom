// ═══════════════════════════════════════════════════════════════
// Course Authoring Controller
//
// The handlers the course-authoring routes mount, by concern:
// - course-outline.controller.ts: outline, blocks, unit children, studio submit,
//   course creation;
// - course-assets.controller.ts: course files;
// - course-outline-transfer.controller.ts: outline transfers;
// - course-author-notes.controller.ts: the AI ID author notes read.
// Input sanitizers are in course-block-input.logic.ts.
// ═══════════════════════════════════════════════════════════════

export * from './course-outline.controller.js';
export * from './course-assets.controller.js';
export * from './course-outline-transfer.controller.js';
export * from './course-author-notes.controller.js';
export { sanitizeCourseHtmlData } from './course-html-sanitizer.logic.js';
