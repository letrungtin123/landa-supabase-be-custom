// ═══════════════════════════════════════════════════════════════
// Course author notes service: the one read path of the AI ID author notes
// of a course (editors only). SQL lives in course-blocks.repository.ts; moved
// from course-authoring.service.ts, which still re-exports it.
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { readCourseAuthorNotes, type CourseAuthorNotesV1 } from './course-author-notes.logic.js';
import { createCourseBlocksRepository } from './course-blocks.repository.js';

export { COURSE_AUTHOR_NOTES_MAX_BLOCKS } from './course-blocks.repository.js';

const blocksRepository = createCourseBlocksRepository({ query });

export interface CourseAuthorNotesBlock {
  block_id: string;
  parent_id: string | null;
  block_type: string;
  display_name: string;
  notes: CourseAuthorNotesV1;
}
export interface CourseAuthorNotesView {
  course_id: string;
  course: { display_name: string; description: string | null; root_block_id: string | null };
  blocks: CourseAuthorNotesBlock[];
}

/**
 * Author-only AI ID notes of one course (QC 364564, N6). The route requires
 * `courses.can_edit`; this read is additionally tenant-bound and returns only
 * the active (non-deleted) outline in presentation order. It never returns
 * learner data, publish state or any other metadata key, and each stored
 * value must pass the strict versioned reader to be shown.
 */
export async function getCourseAuthorNotes(courseId: string, tenantId: string): Promise<CourseAuthorNotesView> {
  const course = await blocksRepository.selectAuthorNotesCourse(courseId, tenantId);
  if (!course) throw new AppError('Course not found', 404);
  const rows = await blocksRepository.selectAuthorNotesBlocks(courseId);
  const rootId = await blocksRepository.selectCourseRootId(courseId);
  const blocks = rows.flatMap(row => {
    const notes = readCourseAuthorNotes(row.notes);
    return notes ? [{ block_id: row.id, parent_id: row.parent_id, block_type: row.block_type, display_name: row.display_name, notes }] : [];
  });
  return {
    course_id: course.id,
    course: { display_name: course.display_name, description: course.description ?? null,
      root_block_id: rootId ?? null },
    blocks,
  };
}
