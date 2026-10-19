// ═══════════════════════════════════════════════════════════════
// Course publish service: publish a block with its subtree (optionally
// through a review candidate) and discard a subtree's drafts, then settle
// the draft flags of ancestors and remove the files the outline no longer
// uses. SQL lives in course-blocks.repository.ts; moved from
// course-authoring.service.ts, which still re-exports both entry points.
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { invalidateBlockReadCaches, invalidateCourseReadCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import {
  beginCoursePublishCandidate,
  finishCoursePublishCandidate,
} from './course-publish-governance.repository.js';
import {
  assertPublishableImageChoiceQuizData,
  assertPublishableMediaQuizData,
  assertPublishableScenarioChatData,
} from './course-publish-checks.logic.js';
import { createCourseBlocksRepository } from './course-blocks.repository.js';
import { getBlockInfo } from './course-outline.service.js';
import {
  assertImageChoiceQuizImageAssets,
  cleanupStoragePathsNoLongerReferenced,
  collectDraftStoragePathsForSubtree,
  collectPublishedStoragePathsForSubtree,
} from './course-assets.service.js';
import type { BlockInfo } from './course-authoring.types.js';

const blocksRepository = createCourseBlocksRepository({ query });

/**
 * Recalculate has_draft_changes for ancestors after a block's draft is cleared.
 * Walks upward: for each ancestor, if no children still have has_draft_changes = true,
 * clears the ancestor's own flag. Stops at the first ancestor that still has dirty children.
 */
async function recalculateAncestorDraftFlags(blockId: string): Promise<void> {
  // Walk up the parent chain iteratively (max depth ~4: component → unit → subsection → section)
  let currentId = blockId;

  for (let depth = 0; depth < 10; depth++) {
    // Get parent of current block
    const parentId = await blocksRepository.selectParentId(currentId);
    if (!parentId) break; // reached root

    // Check if parent still has ANY children with has_draft_changes = true
    if (await blocksRepository.selectHasDirtyChildren(parentId)) {
      // Parent still has dirty children — stop here, no need to go further up
      break;
    }

    // No dirty children left — check if the parent block ITSELF has draft changes on its own data
    // (its own data != published_data). If data === published_data, we can safely clear the flag.
    if (await blocksRepository.selectSelfIsDirty(parentId)) {
      // Parent's own data is still different from published — keep flag, but stop propagating
      break;
    }

    // Clear the parent's flag
    await blocksRepository.clearDraftFlag(parentId);

    // Continue up to grandparent
    currentId = parentId;
  }
}

export async function publishBlock(
  blockId: string,
  tenantId?: string | null,
  governance?: { candidateId: string; actorId: string },
): Promise<BlockInfo> {
  const block = await getBlockInfo(blockId, tenantId);
  if (governance) {
    if (!tenantId) throw new AppError('Tenant context is required', 403, 'COURSE_PUBLISH_FORBIDDEN');
    const admission = await beginCoursePublishCandidate({
      candidateId: governance.candidateId,
      tenantId,
      courseId: block.course_id,
      targetBlockId: block.id,
      actorId: governance.actorId,
    });
    if (admission.already_published) return block;
  }
  const previousPublishedPaths = await collectPublishedStoragePathsForSubtree(blockId);

  for (const row of await blocksRepository.selectPendingMediaQuizBlocks(blockId)) {
    assertPublishableMediaQuizData(row.data, row.display_name || 'Câu hỏi kèm media');
  }

  for (const row of await blocksRepository.selectPendingImageChoiceQuizBlocks(blockId)) {
    assertPublishableImageChoiceQuizData(row.data, row.display_name || 'Câu hỏi đáp án hình ảnh');
    await assertImageChoiceQuizImageAssets(row.course_id, row.tenant_id, row.data);
  }

  for (const row of await blocksRepository.selectPendingScenarioChatBlocks(blockId)) {
    assertPublishableScenarioChatData(row.data, row.display_name || 'Giao tiếp tình huống');
  }

  // Cascade: publish block + tất cả children (recursive) trong 1 query
  // Copy data → published_data, metadata → published_metadata (giống edX draft/published branches)
  await blocksRepository.publishSubtree(blockId);

  if (governance) {
    await finishCoursePublishCandidate(governance.candidateId, governance.actorId);
  }

  // Propagate clean state upward: if no siblings/cousins remain dirty, clear ancestor flags
  await recalculateAncestorDraftFlags(blockId);
  await cleanupStoragePathsNoLongerReferenced(block.course_id, previousPublishedPaths);
  const descendantIds = await blocksRepository.selectDescendantIds(blockId);
  await Promise.all([
    invalidateCourseReadCaches(block.course_id),
    invalidateBlockReadCaches(descendantIds),
  ]);

  return getBlockInfo(blockId, tenantId);
}

export async function discardDraftCascade(blockId: string, tenantId?: string | null): Promise<BlockInfo> {
  const block = await getBlockInfo(blockId, tenantId);

  if (!block.has_draft_changes) {
    throw new AppError('Block has no draft changes to discard', 400);
  }

  if (!(await blocksRepository.selectHasPublishedVersion(blockId))) {
    throw new AppError('Block has never been published - cannot rollback', 400);
  }

  const previousDraftPaths = await collectDraftStoragePathsForSubtree(blockId);

  await blocksRepository.restorePublishedSubtree(blockId);
  await blocksRepository.markAncestorsOfDirtySubtreeBlocks(blockId);

  await recalculateAncestorDraftFlags(blockId);
  await cleanupStoragePathsNoLongerReferenced(block.course_id, previousDraftPaths);
  const descendantIds = await blocksRepository.selectDescendantIds(blockId);
  await Promise.all([
    invalidateCourseReadCaches(block.course_id),
    invalidateBlockReadCaches(descendantIds),
  ]);

  return getBlockInfo(blockId, tenantId);
}
