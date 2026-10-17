// ═══════════════════════════════════════════════════════════════
// Block completion — what one POST /api/learner/complete-blocks may write
//
// `marked` keeps its meaning for every client: the number of distinct ids
// that are active published leaf blocks of the course. Only the blocks among
// them that the enrollment has not completed yet are written; when there is
// none, nothing is written and progress is not recalculated.
// ═══════════════════════════════════════════════════════════════

/** Most block ids one request may carry (a unit has far fewer). */
export const MAX_COMPLETE_BLOCK_IDS = 200;

/** [HTTP status, Vietnamese, English] — the response picks by X-UI-Locale. */
export const COMPLETE_BLOCKS_LIMIT_ERROR = [
  400,
  `Mỗi lần chỉ ghi nhận được tối đa ${MAX_COMPLETE_BLOCK_IDS} nội dung. Vui lòng thử lại với ít nội dung hơn.`,
  `At most ${MAX_COMPLETE_BLOCK_IDS} items can be recorded at a time. Please try again with fewer items.`,
] as const;

/** One requested block that is an active published leaf of the course. */
export interface ActiveBlockCompletionRow {
  id: string;
  completed: boolean;
}

export interface BlockCompletionPlan {
  /** Same value as before this change: active leaf blocks among the ids. */
  marked: number;
  /** Active leaf blocks the enrollment has not completed yet. */
  missing: string[];
}

export function planBlockCompletion(rows: readonly ActiveBlockCompletionRow[]): BlockCompletionPlan {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.completed !== true) missing.push(row.id);
  }
  return { marked: seen.size, missing };
}

/**
 * Response of POST /api/learner/complete-blocks. `marked` is the original
 * field; the others were added for the learner app (older clients ignore
 * them). `progress`, `is_completed` and `completion_changed` are present only
 * when this request completed something and the course progress was
 * recalculated.
 */
export interface MarkBlocksCompleteResult {
  marked: number;
  newly_completed: number;
  progress?: number;
  is_completed?: boolean;
  completion_changed?: boolean;
}
