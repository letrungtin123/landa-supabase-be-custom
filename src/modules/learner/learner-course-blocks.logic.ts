import { toLearnerBlockRow } from './learner-block-row.logic.js';

// ═══════════════════════════════════════════════════════════════
// Learner course blocks — shared structure + per-learner completions
//
// GET /api/learner/courses/:id/blocks used to be cached per learner (and
// invalidated by each of their completions). The published structure is the
// same for every learner, so it is built and cached once per course version;
// the learner's completed block ids are overlaid per request. The result has
// the same shape, key order and values as before: every block row ends with
// `completed`.
// ═══════════════════════════════════════════════════════════════

/** One published block as the learner receives it (answer keys removed), without `completed`. */
export type LearnerStructureBlock = Record<string, unknown> & { id: string; block_type?: unknown };

export interface LearnerCourseStructure {
  root_id: string | null;
  blocks: LearnerStructureBlock[];
}

export interface LearnerCourseBlocks {
  root_id: string | null;
  blocks: Array<LearnerStructureBlock & { completed: boolean }>;
}

/** The learner's per-course state, never shared between users. */
export interface LearnerCourseBlocksState {
  completed_block_ids: string[];
}

/** Rows of the published tree query (SQL column order) → shared structure. */
export function buildLearnerCourseStructure(rows: readonly Record<string, unknown>[]): LearnerCourseStructure {
  const blocks = rows.map((row) => toLearnerBlockRow(row) as LearnerStructureBlock);
  const root = blocks.find((block) => block.block_type === 'course') ?? null;
  return { root_id: root?.id ?? null, blocks };
}

/**
 * The learner's view: each block gets `completed` as its last key. The shared
 * structure is not changed (concurrent requests of other learners read it).
 */
export function overlayLearnerBlockCompletions(
  structure: LearnerCourseStructure,
  completedBlockIds: readonly string[],
): LearnerCourseBlocks {
  const completed = new Set(completedBlockIds);
  return {
    root_id: structure.root_id,
    blocks: structure.blocks.map((block) => ({ ...block, completed: completed.has(block.id) })),
  };
}
