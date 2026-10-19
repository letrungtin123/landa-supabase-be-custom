// ═══════════════════════════════════════════════════════════════
// Course Authoring Service — Replaces OpenEdX Studio CMS
// Course content tree stored as JSONB in course_blocks table
// Structure: course → chapter → sequential → vertical → components
// ═══════════════════════════════════════════════════════════════

import { afterCommit, query } from '../../config/database.js';
import {
  invalidateBlockReadCaches,
  invalidateCourseReadCaches,
  invalidateTenantCourseCaches,
} from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import { assertTenantCanAddCourseComponent } from '../tenants/tenant-course-components.service.js';
import { deleteFile } from '../../config/storage.js';
import { normalizeDiagramData } from './diagram-data.logic.js';
import { COURSE_AUTHOR_NOTES_KEY, preserveAuthorNotesSql, readCourseAuthorNotes, withoutServerOwnedAuthorNotes,
  type CourseAuthorNotesV1 } from './course-author-notes.logic.js';
import { type CourseComponentLocale } from './course-authoring-problem-defaults.logic.js';
import {
  beginCoursePublishCandidate,
  finishCoursePublishCandidate,
} from './course-publish-governance.repository.js';
import { isIsoTimestamp } from '../../utils/client-error.js';
import { UUID_PATTERN, isUuid } from '../../utils/uuid.js';
import { assertCourseBelongsToTenant } from '../courses/course-access.service.js';
import { getDefaultData, getDefaultMetadata, getDefaultName } from './course-block-defaults.logic.js';
import {
  assertPublishableImageChoiceQuizData,
  assertPublishableMediaQuizData,
  assertPublishableScenarioChatData,
  getImageChoiceQuizImagePaths,
} from './course-publish-checks.logic.js';
import {
  chunkList,
  collectCourseStoragePaths,
  countPublishedReferences,
  isCourseStoragePath,
  stripStoragePathReference,
  type ReferencingBlockRow,
} from './course-storage-paths.logic.js';
import type {
  AssetDeleteResult,
  AssetRecord,
  BlockInfo,
  BlockNode,
  CourseAssetsResponse,
  CourseOutlineResponse,
  DeleteAssetByStoragePathResult,
  UnitChild,
} from './course-authoring.types.js';
export * from './course-authoring.types.js';
export { applyLessonAuthorProposalToCourse, LESSON_AUTHOR_OUTLINE_BUSY_CODE } from './course-lesson-author-apply.service.js';
export {
  getLessonAuthorSortableItems,
  orderLessonAuthorComponents,
} from './lesson-author-components.logic.js';


// ── Course Outline (recursive tree) ──

export async function getCourseOutline(
  courseId: string,
  tenantId: string,
): Promise<CourseOutlineResponse> {
  // Verify course belongs to tenant
  const courseCheck = await query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM courses WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [courseId, tenantId],
  );
  if (courseCheck.rowCount === 0) throw new AppError('Course not found', 404);

  // Get all blocks for this course in one query (avoid N+1)
  const blocksResult = await query<BlockInfo>(
    `WITH RECURSIVE active_tree AS (
       SELECT id, course_id, parent_id, block_type, display_name,
              data, metadata, sort_order, is_published, has_draft_changes,
              created_at, updated_at
       FROM course_blocks
       WHERE course_id = $1
         AND parent_id IS NULL
         AND deleted_at IS NULL
       UNION ALL
       SELECT child.id, child.course_id, child.parent_id, child.block_type, child.display_name,
              child.data, child.metadata, child.sort_order, child.is_published, child.has_draft_changes,
              child.created_at, child.updated_at
       FROM course_blocks child
       JOIN active_tree parent ON parent.id = child.parent_id
       WHERE child.deleted_at IS NULL
     )
     SELECT id, course_id, parent_id, block_type, display_name,
            data, metadata, sort_order, is_published, has_draft_changes,
            created_at, updated_at
     FROM active_tree
     ORDER BY sort_order ASC, created_at ASC`,
    [courseId],
  );

  // Build tree in memory (O(n))
  const blocks = blocksResult.rows;
  const nodeMap = new Map<string, BlockNode>();
  const rootNodes: BlockNode[] = [];

  // First pass: create all nodes
  for (const b of blocks) {
    nodeMap.set(b.id, {
      id: b.id,
      display_name: b.display_name,
      block_type: b.block_type,
      published: b.is_published,
      has_changes: b.has_draft_changes,
      sort_order: b.sort_order,
      children: [],
    });
  }

  // Second pass: build parent-child relationships
  for (const b of blocks) {
    const node = nodeMap.get(b.id)!;
    if (b.parent_id && nodeMap.has(b.parent_id)) {
      nodeMap.get(b.parent_id)!.children!.push(node);
    } else if (!b.parent_id) {
      rootNodes.push(node);
    }
  }

  // The course structure is the first root node (block_type='course')
  // Or synthesize one from course record
  const courseNode: BlockNode = rootNodes.find(n => n.block_type === 'course') ?? {
    id: courseId,
    display_name: courseCheck.rows[0].display_name,
    block_type: 'course',
    published: true,
    has_changes: false,
    sort_order: 0,
    children: rootNodes.filter(n => n.block_type !== 'course'),
  };

  return {
    course_id: courseId,
    course_structure: courseNode,
  };
}

// ── Block CRUD ──

export async function createBlock(
  courseId: string,
  parentId: string | null,
  blockType: string,
  displayName?: string,
  data?: any,
  metadata?: any,
  boilerplate?: string,
  tenantId?: string | null,
  locale: CourseComponentLocale = 'vi',
): Promise<{ id: string }> {
  const courseCheck = await query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id
       FROM courses
      WHERE id = $1
        AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
        AND deleted_at IS NULL`,
    [courseId, tenantId ?? null],
  );
  if (courseCheck.rowCount === 0) throw new AppError('Course not found', 404);

  await assertTenantCanAddCourseComponent(courseCheck.rows[0].tenant_id, blockType);

  if (parentId) {
    const parent = await getBlockInfo(parentId, tenantId);
    if (parent.course_id !== courseId) throw new AppError('Parent block not found', 404);
  }

  // Get next sort_order
  const maxResult = await query<{ max_order: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS max_order
     FROM course_blocks WHERE course_id = $1 AND deleted_at IS NULL AND ${parentId ? 'parent_id = $2' : 'parent_id IS NULL'}`,
    parentId ? [courseId, parentId] : [courseId],
  );
  const sortOrder = maxResult.rows[0]?.max_order ?? 0;

  const defaultName = displayName || getDefaultName(blockType, locale);
  const defaultData = data ?? getDefaultData(blockType, boilerplate, locale);
  const defaultMetadata = {
    ...getDefaultMetadata(blockType, boilerplate),
    // AI ID author notes are written by Apply only, never by block creation.
    ...(withoutServerOwnedAuthorNotes(metadata) ?? {}),
  };

  const result = await query<{ id: string }>(
    `INSERT INTO course_blocks (course_id, parent_id, block_type, display_name, data, metadata, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [courseId, parentId, blockType, defaultName, JSON.stringify(defaultData), defaultMetadata, sortOrder],
  );

  // Mark parent + ancestors as having changes (quả cầu vàng)
  if (parentId) {
    await markAncestorsDirty(result.rows[0].id);
  }

  await Promise.all([
    invalidateCourseReadCaches(courseId),
    invalidateBlockReadCaches([result.rows[0].id]),
  ]);
  return { id: result.rows[0].id };
}


export async function assertImageChoiceQuizImageAssets(courseId: string, tenantId: string, raw: any): Promise<void> {
  const storagePaths = getImageChoiceQuizImagePaths(raw);
  if (storagePaths.length === 0) return;

  const result = await query<{ storage_path: string; content_type: string }>(
    `SELECT storage_path, content_type
     FROM course_assets
     WHERE course_id = $1
       AND tenant_id = $2
       AND storage_path = ANY($3::text[])`,
    [courseId, tenantId, storagePaths],
  );

  const rowByPath = new Map(result.rows.map(row => [row.storage_path, row]));
  for (const storagePath of storagePaths) {
    const row = rowByPath.get(storagePath);
    if (!row) {
      throw new AppError('Ảnh đáp án phải là asset thuộc đúng khóa học hiện tại', 400);
    }
    if (!String(row.content_type || '').toLowerCase().startsWith('image/')) {
      throw new AppError('Mỗi đáp án chỉ được dùng asset hình ảnh', 400);
    }
  }
}


export async function getBlockInfo(blockId: string, tenantId?: string | null): Promise<BlockInfo> {
  const result = await query<BlockInfo>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, deleted_at
       FROM course_blocks
       WHERE id = $1
       UNION ALL
       SELECT parent.id, parent.parent_id, parent.deleted_at
       FROM course_blocks parent
       JOIN ancestors a ON parent.id = a.parent_id
     )
     SELECT b.id, b.course_id, c.display_name AS course_name,
            b.parent_id, parent.display_name AS parent_name,
            b.block_type, b.display_name,
            b.data, b.metadata, b.sort_order, b.is_published, b.has_draft_changes,
            b.created_at, b.updated_at
     FROM course_blocks b
     JOIN courses c ON c.id = b.course_id
     LEFT JOIN course_blocks parent ON parent.id = b.parent_id AND parent.deleted_at IS NULL
     WHERE b.id = $1
       AND b.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND ($2::uuid IS NULL OR c.tenant_id = $2::uuid)
       AND NOT EXISTS (SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)`,
    [blockId, tenantId ?? null],
  );
  if (result.rowCount === 0) throw new AppError('Block not found', 404);
  return result.rows[0];
}

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
/** Upper bound of blocks returned by one author-notes read. */
export const COURSE_AUTHOR_NOTES_MAX_BLOCKS = 10_000;

/**
 * Author-only AI ID notes of one course (QC 364564, N6). The route requires
 * `courses.can_edit`; this read is additionally tenant-bound and returns only
 * the active (non-deleted) outline in presentation order. It never returns
 * learner data, publish state or any other metadata key, and each stored
 * value must pass the strict versioned reader to be shown.
 */
export async function getCourseAuthorNotes(courseId: string, tenantId: string): Promise<CourseAuthorNotesView> {
  const course = await query<{ id: string; display_name: string; description: string | null }>(
    `SELECT id, display_name, description FROM courses WHERE id = $1 AND tenant_id = $2::uuid AND deleted_at IS NULL`,
    [courseId, tenantId],
  );
  if (course.rowCount === 0) throw new AppError('Course not found', 404);
  const rows = await query<{ id: string; parent_id: string | null; block_type: string; display_name: string; notes: unknown }>(
    `WITH RECURSIVE tree AS (
       SELECT b.id, b.parent_id, b.block_type::text AS block_type, b.display_name, b.metadata,
              ARRAY[b.sort_order, 0]::bigint[] AS path, b.id::text AS tie
       FROM course_blocks b
       WHERE b.course_id = $1 AND b.parent_id IS NULL AND b.block_type = 'course' AND b.deleted_at IS NULL
       UNION ALL
       SELECT child.id, child.parent_id, child.block_type::text, child.display_name, child.metadata,
              tree.path || ARRAY[child.sort_order::bigint, 0], tree.tie || '/' || child.id::text
       FROM course_blocks child JOIN tree ON child.parent_id = tree.id
       WHERE child.course_id = $1 AND child.deleted_at IS NULL
     )
     SELECT id::text AS id, parent_id::text AS parent_id, block_type, display_name,
            metadata->'${COURSE_AUTHOR_NOTES_KEY}' AS notes
     FROM tree
     WHERE jsonb_typeof(metadata) = 'object' AND metadata ? '${COURSE_AUTHOR_NOTES_KEY}'
     ORDER BY path, tie
     LIMIT ${COURSE_AUTHOR_NOTES_MAX_BLOCKS}`,
    [courseId],
  );
  const root = await query<{ id: string }>(
    `SELECT id::text AS id FROM course_blocks WHERE course_id = $1 AND parent_id IS NULL AND block_type = 'course' AND deleted_at IS NULL
     ORDER BY created_at ASC LIMIT 1`,
    [courseId],
  );
  const blocks = rows.rows.flatMap(row => {
    const notes = readCourseAuthorNotes(row.notes);
    return notes ? [{ block_id: row.id, parent_id: row.parent_id, block_type: row.block_type, display_name: row.display_name, notes }] : [];
  });
  return {
    course_id: course.rows[0].id,
    course: { display_name: course.rows[0].display_name, description: course.rows[0].description ?? null,
      root_block_id: root.rows[0]?.id ?? null },
    blocks,
  };
}

/** Minimal, allowlist-safe course context for structured audit events. */
export async function getCourseAuditContext(courseId: string): Promise<{ course_id: string; course_name: string }> {
  const result = await query<{ course_id: string; course_name: string }>(
    `SELECT id AS course_id, display_name AS course_name
       FROM courses
      WHERE id = $1 AND deleted_at IS NULL`,
    [courseId],
  );
  if (result.rowCount === 0) throw new AppError('Course not found', 404);
  return result.rows[0];
}

export async function updateBlock(
  blockId: string,
  updates: {
    display_name?: string;
    data?: any;
    metadata?: any;
    is_published?: boolean;
  },
): Promise<BlockInfo> {
  await getBlockInfo(blockId);

  const setClauses: string[] = ['updated_at = now()'];
  const params: any[] = [blockId];
  let paramIdx = 2;

  if (updates.display_name !== undefined) {
    setClauses.push(`display_name = $${paramIdx++}`);
    params.push(updates.display_name);
  }
  if (updates.data !== undefined) {
    setClauses.push(`data = $${paramIdx++}`);
    params.push(JSON.stringify(updates.data));
  }
  if (updates.metadata !== undefined) {
    // Metadata PATCH replaces the editable keys (an outline rename sends only
    // {display_name}), but AI ID author notes are server-owned: a browser can
    // neither forge nor delete them, and the stored value is carried over.
    setClauses.push(updates.metadata === null ? `metadata = $${paramIdx++}` : `metadata = ${preserveAuthorNotesSql(`$${paramIdx++}`)}`);
    params.push(updates.metadata === null ? null : JSON.stringify(withoutServerOwnedAuthorNotes(updates.metadata)));
  }
  if (updates.is_published !== undefined) {
    setClauses.push(`is_published = $${paramIdx++}`);
    params.push(updates.is_published);
    // Publish → clear draft flag; unpublish → mark as draft
    setClauses.push(`has_draft_changes = ${updates.is_published ? 'false' : 'true'}`);
  } else {
    // Editing content → mark as draft
    setClauses.push('has_draft_changes = true');
  }

  const result = await query<BlockInfo>(
    `UPDATE course_blocks SET ${setClauses.join(', ')} WHERE id = $1 AND deleted_at IS NULL
     RETURNING id, course_id, parent_id, block_type, display_name,
               data, metadata, sort_order, is_published, has_draft_changes,
               created_at, updated_at`,
    params,
  );

  if (result.rowCount === 0) throw new AppError('Block not found', 404);

  const block = result.rows[0];
  let tenantCourseInvalidation: Promise<void> | null = null;

  if (updates.display_name !== undefined && block.block_type === 'course' && block.parent_id === null) {
    const courseResult = await query<{ tenant_id: string }>(
      `UPDATE courses
       SET display_name = $1, updated_at = now()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING tenant_id`,
      [updates.display_name, block.course_id],
    );
    const tenantId = courseResult.rows[0]?.tenant_id;
    if (tenantId) tenantCourseInvalidation = invalidateTenantCourseCaches(tenantId);
  }

  // Propagate has_draft_changes lên toàn bộ ancestor chain (giống edX)
  // Khi edit child → parent, grandparent, ... đều hiện quả cầu vàng
  if (!updates.is_published && block.parent_id) {
    await markAncestorsDirty(block.id);
  }

  await Promise.all([
    invalidateCourseReadCaches(block.course_id),
    invalidateBlockReadCaches([block.id]),
    tenantCourseInvalidation ?? Promise.resolve(),
  ]);
  return getBlockInfo(block.id);
}

/**
 * Đánh dấu tất cả ancestors có has_draft_changes = true.
 * Dùng recursive CTE đi ngược từ block → root trong 1 query.
 */
async function markAncestorsDirty(blockId: string): Promise<void> {
  await query(
    `WITH RECURSIVE ancestors AS (
       SELECT parent_id FROM course_blocks WHERE id = $1 AND parent_id IS NOT NULL AND deleted_at IS NULL
       UNION ALL
       SELECT cb.parent_id FROM course_blocks cb
       JOIN ancestors a ON cb.id = a.parent_id
       WHERE cb.parent_id IS NOT NULL AND cb.deleted_at IS NULL
     )
     UPDATE course_blocks SET has_draft_changes = true, updated_at = now()
     WHERE id IN (SELECT parent_id FROM ancestors) AND deleted_at IS NULL`,
    [blockId],
  );
}

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
    const parentResult = await query<{ parent_id: string | null }>(
      `SELECT parent_id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL`,
      [currentId],
    );
    const parentId = parentResult.rows[0]?.parent_id;
    if (!parentId) break; // reached root

    // Check if parent still has ANY children with has_draft_changes = true
    const dirtyCheck = await query<{ has_dirty_children: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM course_blocks
         WHERE parent_id = $1 AND has_draft_changes = true AND deleted_at IS NULL
       ) AS has_dirty_children`,
      [parentId],
    );

    if (dirtyCheck.rows[0]?.has_dirty_children) {
      // Parent still has dirty children — stop here, no need to go further up
      break;
    }

    // No dirty children left — check if the parent block ITSELF has draft changes on its own data
    // (its own data != published_data). If data === published_data, we can safely clear the flag.
    const selfCheck = await query<{ self_is_dirty: boolean }>(
      `SELECT (data IS DISTINCT FROM published_data OR metadata IS DISTINCT FROM published_metadata)
         AS self_is_dirty
       FROM course_blocks WHERE id = $1 AND deleted_at IS NULL`,
      [parentId],
    );

    if (selfCheck.rows[0]?.self_is_dirty) {
      // Parent's own data is still different from published — keep flag, but stop propagating
      break;
    }

    // Clear the parent's flag
    await query(
      `UPDATE course_blocks SET has_draft_changes = false, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [parentId],
    );

    // Continue up to grandparent
    currentId = parentId;
  }
}

async function getDescendantBlockIds(blockId: string): Promise<string[]> {
  const result = await query<{ id: string }>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id
       FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     SELECT id FROM descendants`,
    [blockId],
  );
  return result.rows.map((row) => row.id);
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

  const mediaQuizRows = await query<{ display_name: string; data: any }>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     SELECT display_name, data
     FROM course_blocks
     WHERE id IN (SELECT id FROM descendants)
       AND block_type = 'la_media_quiz'
       AND deleted_at IS NULL
       AND (
         has_draft_changes = true OR
         data IS DISTINCT FROM published_data OR
         metadata IS DISTINCT FROM published_metadata OR
         is_published = false
       )`,
    [blockId],
  );

  for (const row of mediaQuizRows.rows) {
    assertPublishableMediaQuizData(row.data, row.display_name || 'Câu hỏi kèm media');
  }

  const imageChoiceQuizRows = await query<{ display_name: string; data: any; course_id: string; tenant_id: string }>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     SELECT cb.display_name, cb.data, cb.course_id, c.tenant_id
     FROM course_blocks cb
     JOIN courses c ON c.id = cb.course_id
     WHERE cb.id IN (SELECT id FROM descendants)
       AND cb.block_type::text = 'la_image_choice_quiz'
       AND cb.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND (
         cb.has_draft_changes = true OR
         cb.data IS DISTINCT FROM cb.published_data OR
         cb.metadata IS DISTINCT FROM cb.published_metadata OR
         cb.is_published = false
       )`,
    [blockId],
  );

  for (const row of imageChoiceQuizRows.rows) {
    assertPublishableImageChoiceQuizData(row.data, row.display_name || 'Câu hỏi đáp án hình ảnh');
    await assertImageChoiceQuizImageAssets(row.course_id, row.tenant_id, row.data);
  }

  const scenarioChatRows = await query<{ display_name: string; data: any }>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     SELECT display_name, data
     FROM course_blocks
     WHERE id IN (SELECT id FROM descendants)
       AND block_type::text = 'la_scenario_chat'
       AND deleted_at IS NULL
       AND (
         has_draft_changes = true OR
         data IS DISTINCT FROM published_data OR
         metadata IS DISTINCT FROM published_metadata OR
         is_published = false
       )`,
    [blockId],
  );

  for (const row of scenarioChatRows.rows) {
    assertPublishableScenarioChatData(row.data, row.display_name || 'Giao tiếp tình huống');
  }

  // Cascade: publish block + tất cả children (recursive) trong 1 query
  // Copy data → published_data, metadata → published_metadata (giống edX draft/published branches)
  await query(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     UPDATE course_blocks
     SET is_published = true,
         has_draft_changes = false,
         published_data = data,
         published_metadata = metadata,
         updated_at = now()
     WHERE id IN (SELECT id FROM descendants)
       AND deleted_at IS NULL
       AND (
         has_draft_changes = true OR
         data IS DISTINCT FROM published_data OR
         metadata IS DISTINCT FROM published_metadata OR
         is_published = false
       )`,
    [blockId],
  );

  if (governance) {
    await finishCoursePublishCandidate(governance.candidateId, governance.actorId);
  }

  // Propagate clean state upward: if no siblings/cousins remain dirty, clear ancestor flags
  await recalculateAncestorDraftFlags(blockId);
  await cleanupStoragePathsNoLongerReferenced(block.course_id, previousPublishedPaths);
  const descendantIds = await getDescendantBlockIds(blockId);
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

  const pubCheck = await query<{ has_pub: boolean }>(
    `SELECT published_data IS NOT NULL AS has_pub
     FROM course_blocks WHERE id = $1 AND deleted_at IS NULL`,
    [blockId],
  );
  if (!pubCheck.rows[0]?.has_pub) {
    throw new AppError('Block has never been published - cannot rollback', 400);
  }

  const previousDraftPaths = await collectDraftStoragePathsForSubtree(blockId);

  await query(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     UPDATE course_blocks
     SET data = published_data,
         metadata = published_metadata,
         has_draft_changes = false,
         updated_at = now()
     WHERE id IN (SELECT id FROM descendants)
       AND deleted_at IS NULL
       AND published_data IS NOT NULL
       AND (
         has_draft_changes = true OR
         data IS DISTINCT FROM published_data OR
         metadata IS DISTINCT FROM published_metadata
       )`,
    [blockId],
  );

  await query(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     ),
     dirty_nodes AS (
       SELECT id, parent_id
       FROM course_blocks
       WHERE id IN (SELECT id FROM descendants)
         AND has_draft_changes = true
         AND deleted_at IS NULL
     ),
     dirty_ancestors AS (
       SELECT parent_id AS id
       FROM dirty_nodes
       WHERE parent_id IS NOT NULL
       UNION
       SELECT cb.parent_id AS id
       FROM course_blocks cb
       JOIN dirty_ancestors da ON cb.id = da.id
       WHERE cb.parent_id IS NOT NULL
         AND cb.deleted_at IS NULL
     )
     UPDATE course_blocks
     SET has_draft_changes = true,
         updated_at = now()
     WHERE id IN (SELECT id FROM dirty_ancestors WHERE id IS NOT NULL)
       AND deleted_at IS NULL`,
    [blockId],
  );

  await recalculateAncestorDraftFlags(blockId);
  await cleanupStoragePathsNoLongerReferenced(block.course_id, previousDraftPaths);
  const descendantIds = await getDescendantBlockIds(blockId);
  await Promise.all([
    invalidateCourseReadCaches(block.course_id),
    invalidateBlockReadCaches(descendantIds),
  ]);

  return getBlockInfo(blockId, tenantId);
}

export async function deleteBlock(blockId: string): Promise<void> {
  void blockId;
  throw new AppError('Use course deletion queue for block delete', 400);
}

export async function reorderChildren(
  parentId: string,
  childIds: string[],
  tenantId?: string | null,
): Promise<void> {
  if (childIds.length === 0) return;
  const parent = await getBlockInfo(parentId, tenantId);

  // Validate UUID format — chống SQL injection
  for (const id of childIds) {
    if (!UUID_PATTERN.test(id)) throw new AppError('Invalid block ID format', 400);
  }

  // Parameterized VALUES — $1 = parentId, $2/$3 = id/order pairs
  const params: unknown[] = [parentId];
  const valuesList = childIds.map((id, i) => {
    params.push(id, i);
    return `($${params.length - 1}::uuid, $${params.length}::int)`;
  }).join(', ');

  await query(
    `UPDATE course_blocks AS cb SET
       sort_order = v.new_order,
       updated_at = now()
     FROM (VALUES ${valuesList}) AS v(block_id, new_order)
     WHERE cb.id = v.block_id AND cb.parent_id = $1 AND cb.deleted_at IS NULL`,
    params,
  );
  await Promise.all([
    invalidateCourseReadCaches(parent.course_id),
    invalidateBlockReadCaches([parentId, ...childIds]),
  ]);
}

// ── Unit Children ──

export async function getUnitChildren(unitId: string, tenantId?: string | null): Promise<{ children: UnitChild[] }> {
  await getBlockInfo(unitId, tenantId);

  const result = await query<UnitChild>(
    `SELECT id, id AS block_id, display_name, block_type,
            has_draft_changes AS has_changes, is_published AS published
     FROM course_blocks
     WHERE parent_id = $1 AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
    [unitId],
  );

  return { children: result.rows };
}

// ── Studio Submit (custom XBlock data) ──

function normalizeCrosswordData(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;

  const crossword = raw as Record<string, unknown>;
  if (!Array.isArray(crossword.words)) return crossword;

  return {
    ...crossword,
    words: crossword.words.map((rawWord) => {
      if (!rawWord || typeof rawWord !== 'object' || Array.isArray(rawWord)) return rawWord;

      const word = rawWord as Record<string, unknown>;
      const answer = typeof word.answer === 'string' ? word.answer : '';
      // `length` is redundant display data; never let it diverge from answer.
      return answer.length > 0 ? { ...word, length: answer.length } : word;
    }),
  };
}

export async function studioSubmit(
  blockId: string,
  submitData: any,
  tenantId?: string | null,
): Promise<any> {
  // Get current block
  const block = await getBlockInfo(blockId, tenantId);

  // Extract display_name (FE gửi kèm trong submitData)
  const displayName = submitData.display_name;
  const { display_name: _dn, ...restData } = submitData;

  // Merge submit data into block's data/metadata based on type
  let updatePayload: { display_name?: string; data?: any; metadata?: any } = {};

  switch (block.block_type) {
    case 'la_crossword': {
      // FE gửi crossword_data dạng JSON string
      const crosswordRaw = restData.crossword_data;
      const crosswordParsed = typeof crosswordRaw === 'string' ? safeJsonParse(crosswordRaw) : crosswordRaw;
      const crosswordData = normalizeCrosswordData(crosswordParsed ?? crosswordRaw);
      const normalizedCrosswordRaw = typeof crosswordRaw === 'string' && crosswordParsed
        ? JSON.stringify(crosswordData)
        : crosswordData;
      const cwMediaPayload: any = {};
      if (restData.problem_media) cwMediaPayload.problem_media = restData.problem_media;
      else if ('problem_media' in restData) delete block.metadata?.problem_media;
      updatePayload = {
        metadata: { ...block.metadata, crossword_data: crosswordData, ...cwMediaPayload },
        data: { ...restData, crossword_data: normalizedCrosswordRaw },
      };
      break;
    }
    case 'la_sortable': {
      const sortableRaw = restData.sortable_data;
      const sortableParsed = typeof sortableRaw === 'string' ? safeJsonParse(sortableRaw) : sortableRaw;
      const soMediaPayload: any = {};
      if (restData.problem_media) soMediaPayload.problem_media = restData.problem_media;
      else if ('problem_media' in restData) delete block.metadata?.problem_media;
      updatePayload = {
        metadata: {
          ...block.metadata,
          sortable_data: sortableParsed || sortableRaw,
          question_text: restData.question_text,
          ...soMediaPayload,
        },
        data: restData,
      };
      break;
    }
    case 'la_diagram': {
      const diagramRaw = restData.diagram_data;
      const diagramData = normalizeDiagramData(diagramRaw);
      updatePayload = {
        metadata: { ...block.metadata, diagram_data: diagramData },
        data: { ...restData, diagram_data: diagramData },
      };
      break;
    }
    case 'la_faq': {
      const faqRaw = restData.faq_data;
      const faqParsed = typeof faqRaw === 'string' ? safeJsonParse(faqRaw) : faqRaw;
      updatePayload = {
        metadata: { ...block.metadata, faq_data: faqParsed || faqRaw },
        data: restData,
      };
      break;
    }
    case 'la_pdf':
      updatePayload = {
        metadata: { ...block.metadata, ...restData },
        data: restData,
      };
      break;
    default:
      updatePayload = { data: restData };
  }

  // Gắn display_name nếu có
  if (displayName) {
    updatePayload.display_name = displayName;
  }

  const updated = await updateBlock(blockId, updatePayload);

  await Promise.all([
    invalidateCourseReadCaches(block.course_id),
    invalidateBlockReadCaches([blockId]),
  ]);
  return { success: true, block: updated };
}

/** Parse JSON an toàn, trả null nếu lỗi */
function safeJsonParse(str: string): any {
  try { return JSON.parse(str); } catch { return null; }
}

// ── Course Assets ──

export async function getCourseAssets(
  courseId: string,
  tenantId: string,
  page = 0,
  pageSize = 50,
  textSearch = '',
  options: { cursor?: string | null; cursorPagination?: boolean } = {},
): Promise<CourseAssetsResponse> {
  const safePage = Math.max(0, page);
  const safePageSize = Math.max(1, Math.min(pageSize, 100));
  await assertCourseBelongsToTenant(courseId, tenantId, 'Course not found');

  const conditions: string[] = ['ca.course_id = $1', 'ca.tenant_id = $2'];
  const params: any[] = [courseId, tenantId];
  let paramIdx = 3;
  const normalizedSearch = textSearch.trim();

  if (normalizedSearch) {
    conditions.push(`ca.display_name ILIKE '%' || $${paramIdx++} || '%'`);
    params.push(normalizedSearch);
  }

  if (options.cursorPagination || options.cursor) {
    const cursor = decodeAssetCursor(options.cursor);
    if (cursor) {
      conditions.push(`(ca.created_at < $${paramIdx} OR (ca.created_at = $${paramIdx} AND ca.id < $${paramIdx + 1}))`);
      params.push(cursor.created_at, cursor.id);
      paramIdx += 2;
    }

    const whereClause = conditions.join(' AND ');
    params.push(safePageSize + 1);
    const result = await query<any>(
      `SELECT ca.id, ca.course_id, ca.display_name, ca.content_type,
              ca.storage_path,
              ca.file_size, ca.url, ca.thumbnail_url, ca.is_locked, ca.is_reference,
              ca.created_at, ca.created_at AS date_added,
              to_char(ca.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
       FROM course_assets ca
       WHERE ${whereClause}
       ORDER BY ca.created_at DESC, ca.id DESC
       LIMIT $${paramIdx}`,
      params,
    );

    const rows = result.rows;
    const hasMore = rows.length > safePageSize;
    if (hasMore) rows.length = safePageSize;
    const assets = await annotateAssetRowsWithOutlineReferences(courseId, rows);
    const lastRow = rows[rows.length - 1];

    return {
      start: 0,
      end: assets.length,
      page: safePage,
      pageSize: safePageSize,
      totalCount: null,
      assets,
      hasMore,
      nextCursor: hasMore && lastRow ? encodeAssetCursor(lastRow) : null,
    };
  }

  const offset = safePage * safePageSize;
  const whereClause = conditions.join(' AND ');

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM course_assets ca WHERE ${whereClause}`,
    params,
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0');

  params.push(safePageSize, offset);
  const result = await query<any>(
    `SELECT ca.id, ca.course_id, ca.display_name, ca.content_type,
            ca.storage_path,
            ca.file_size, ca.url, ca.thumbnail_url, ca.is_locked, ca.is_reference,
            ca.created_at, ca.created_at AS date_added,
              to_char(ca.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
     FROM course_assets ca
     WHERE ${whereClause}
     ORDER BY ca.created_at DESC, ca.id DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    params,
  );

  const assets = await annotateAssetRowsWithOutlineReferences(courseId, result.rows);
  const hasMore = offset + assets.length < total;
  const lastRow = result.rows[result.rows.length - 1];

  return {
    start: offset,
    end: Math.min(offset + safePageSize, total),
    page: safePage,
    pageSize: safePageSize,
    totalCount: total,
    assets,
    hasMore,
    nextCursor: hasMore && lastRow ? encodeAssetCursor(lastRow) : null,
  };
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function encodeAssetCursor(row: { cursor_created_at?: string; created_at?: string | Date; date_added?: string | Date; id: string }): string {
  const createdAt = row.cursor_created_at ?? row.created_at ?? row.date_added;
  return encodeBase64Url(JSON.stringify({
    created_at: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
    id: row.id,
  }));
}

function decodeAssetCursor(cursor?: string | null): { created_at: string; id: string } | null {
  const value = typeof cursor === 'string' ? cursor.trim() : '';
  if (!value) return null;

  try {
    const parsed = JSON.parse(decodeBase64Url(value));
    if (
      !parsed ||
      !isIsoTimestamp(parsed.created_at) ||
      !isUuid(parsed.id)
    ) {
      throw new AppError('invalid cursor payload', 400);
    }
    return { created_at: parsed.created_at, id: parsed.id };
  } catch {
    throw new AppError('Cursor không hợp lệ', 400);
  }
}

async function annotateAssetRowsWithOutlineReferences(courseId: string, rows: any[]): Promise<AssetRecord[]> {
  const storagePaths = rows
    .map((row) => (typeof row.storage_path === 'string' ? row.storage_path.trim() : ''))
    .filter(isCourseStoragePath);
  const outlineReferenceCountByPath = new Map<string, number>();

  if (storagePaths.length > 0) {
    const referenceResult = await query<{ storage_path: string; reference_count: string }>(
      `WITH candidate(storage_path) AS (
         SELECT unnest($2::text[])
       )
       SELECT c.storage_path, COUNT(DISTINCT cb.id)::text AS reference_count
       FROM candidate c
       JOIN course_blocks cb ON cb.course_id = $1
        AND cb.deleted_at IS NULL
        AND (
          position(c.storage_path in COALESCE(cb.data::text, '')) > 0 OR
          position(c.storage_path in COALESCE(cb.metadata::text, '')) > 0 OR
          position(c.storage_path in COALESCE(cb.published_data::text, '')) > 0 OR
          position(c.storage_path in COALESCE(cb.published_metadata::text, '')) > 0
        )
       GROUP BY c.storage_path`,
      [courseId, Array.from(new Set(storagePaths))],
    );

    for (const row of referenceResult.rows) {
      if (row.storage_path) outlineReferenceCountByPath.set(row.storage_path, Number(row.reference_count) || 0);
    }
  }

  return rows.map((row) => {
    const storagePath = typeof row.storage_path === 'string' ? row.storage_path : '';
    const outlineReferenceCount = outlineReferenceCountByPath.get(storagePath) ?? 0;
    const { created_at: _createdAt, cursor_created_at: _cursorCreatedAt, ...assetRow } = row;
    return {
      ...assetRow,
      is_outline_media: outlineReferenceCount > 0,
      outline_reference_count: outlineReferenceCount,
    };
  });
}
/** 404 unless the course exists, is not deleted and belongs to the tenant. */
export async function assertCourseInTenant(courseId: string, tenantId: string | null | undefined): Promise<void> {
  if (!tenantId) throw new AppError('Course not found', 404);
  await assertCourseBelongsToTenant(courseId, tenantId, 'Course not found');
}

export async function createAssetRecord(
  courseId: string,
  tenantId: string,
  displayName: string,
  contentType: string,
  fileSize: number,
  storagePath: string,
  url: string,
  uploadedBy: string,
): Promise<AssetRecord> {
  // The course must belong to the asset's tenant; otherwise nothing is inserted.
  // Every parameter is typed: $1 and $2 appear twice, and an untyped SELECT-list
  // parameter is deduced as text while `c.id = $1` deduces varchar, which
  // PostgreSQL refuses ("inconsistent types deduced for parameter $1").
  const result = await query<AssetRecord>(
    `INSERT INTO course_assets (course_id, tenant_id, display_name, content_type, file_size, storage_path, url, uploaded_by)
     SELECT $1::varchar, $2::uuid, $3::varchar, $4::varchar, $5::bigint, $6::text, $7::text, $8::uuid
     WHERE EXISTS (SELECT 1 FROM courses c WHERE c.id = $1::varchar AND c.tenant_id = $2::uuid AND c.deleted_at IS NULL)
     RETURNING id, course_id, display_name, content_type, file_size, storage_path, url, thumbnail_url, is_locked, created_at AS date_added`,
    [courseId, tenantId, displayName, contentType, fileSize, storagePath, url, uploadedBy],
  );
  if (result.rowCount === 0) throw new AppError('Course not found', 404);
  await invalidateCourseReadCaches(courseId, tenantId);
  return result.rows[0];
}


async function getBlocksReferencingStoragePath(courseId: string, storagePath: string): Promise<ReferencingBlockRow[]> {
  const result = await query<ReferencingBlockRow>(
    `SELECT id, data, metadata, published_data, published_metadata
       FROM course_blocks
      WHERE course_id = $1
        AND deleted_at IS NULL
        AND (
          position($2 in COALESCE(data::text, '')) > 0 OR
          position($2 in COALESCE(metadata::text, '')) > 0 OR
          position($2 in COALESCE(published_data::text, '')) > 0 OR
          position($2 in COALESCE(published_metadata::text, '')) > 0
        )`,
    [courseId, storagePath],
  );
  return result.rows;
}


async function cleanupBlockReferences(
  courseId: string,
  storagePath: string,
  options: { includePublished: boolean },
): Promise<void> {
  try {
    const blocks = await getBlocksReferencingStoragePath(courseId, storagePath);

    for (const block of blocks) {
      const updates: Array<{ column: string; value: any }> = [];

      const newData = block.data ? stripStoragePathReference(block.data, storagePath) : block.data;
      const newMeta = block.metadata ? stripStoragePathReference(block.metadata, storagePath) : block.metadata;
      if (JSON.stringify(newData) !== JSON.stringify(block.data)) updates.push({ column: 'data', value: newData });
      if (JSON.stringify(newMeta) !== JSON.stringify(block.metadata)) updates.push({ column: 'metadata', value: newMeta });

      if (options.includePublished) {
        const newPubData = block.published_data ? stripStoragePathReference(block.published_data, storagePath) : block.published_data;
        const newPubMeta = block.published_metadata ? stripStoragePathReference(block.published_metadata, storagePath) : block.published_metadata;
        if (JSON.stringify(newPubData) !== JSON.stringify(block.published_data)) updates.push({ column: 'published_data', value: newPubData });
        if (JSON.stringify(newPubMeta) !== JSON.stringify(block.published_metadata)) updates.push({ column: 'published_metadata', value: newPubMeta });
      }

      if (updates.length === 0) continue;

      const params: any[] = [block.id];
      const setClauses = updates.map((update, index) => {
        params.push(JSON.stringify(update.value));
        return `${update.column} = $${index + 2}::jsonb`;
      });
      setClauses.push('updated_at = now()');

      await query(
        `UPDATE course_blocks SET ${setClauses.join(', ')} WHERE id = $1`,
        params,
      );
    }
  } catch (err) {
    console.error('[cleanupBlockReferences] Error:', err);
  }
}

async function collectPublishedStoragePathsForSubtree(blockId: string): Promise<Set<string>> {
  const result = await query<{ published_data: any; published_metadata: any }>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     SELECT published_data, published_metadata
     FROM course_blocks
     WHERE id IN (SELECT id FROM descendants)
       AND (
         has_draft_changes = true OR
         data IS DISTINCT FROM published_data OR
         metadata IS DISTINCT FROM published_metadata OR
         is_published = false
       )`,
    [blockId],
  );

  const paths = new Set<string>();
  for (const row of result.rows) {
    collectCourseStoragePaths(row.published_data, paths);
    collectCourseStoragePaths(row.published_metadata, paths);
  }
  return paths;
}

async function collectDraftStoragePathsForSubtree(blockId: string): Promise<Set<string>> {
  const result = await query<{ data: any; metadata: any }>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
       WHERE cb.deleted_at IS NULL
     )
     SELECT data, metadata
     FROM course_blocks
     WHERE id IN (SELECT id FROM descendants)
       AND (
         has_draft_changes = true OR
         data IS DISTINCT FROM published_data OR
         metadata IS DISTINCT FROM published_metadata
       )`,
    [blockId],
  );

  const paths = new Set<string>();
  for (const row of result.rows) {
    collectCourseStoragePaths(row.data, paths);
    collectCourseStoragePaths(row.metadata, paths);
  }
  return paths;
}

async function deleteCourseAssetsByStoragePaths(courseId: string, storagePaths: string[]): Promise<string[]> {
  const uniquePaths = Array.from(new Set(storagePaths.filter(isCourseStoragePath)));
  if (uniquePaths.length === 0) return [];

  const result = await query<{ storage_path: string }>(
    `DELETE FROM course_assets
      WHERE course_id = $1
        AND COALESCE(is_reference, false) = false
        AND (storage_path = ANY($2::text[]) OR url = ANY($2::text[]))
      RETURNING storage_path`,
    [courseId, uniquePaths],
  );

  const deletedPaths = Array.from(new Set(result.rows.map((row) => row.storage_path).filter(Boolean)));
  // Publish and discard run this inside their audited transaction. The objects
  // are removed once it committed: each delete's quota fence waits for the
  // tenant quota row this transaction already locked (a statement_timeout
  // later the file stayed), and a rollback must keep the files its rows use.
  if (deletedPaths.length > 0) {
    await afterCommit(async () => {
      await Promise.allSettled(deletedPaths.map((path) => deleteFile(path)));
    });
  }
  return deletedPaths;
}


async function collectReferencedCandidateStoragePaths(courseId: string, storagePaths: string[]): Promise<Set<string>> {
  const uniquePaths = Array.from(new Set(storagePaths.filter(isCourseStoragePath)));
  const referenced = new Set<string>();
  if (uniquePaths.length === 0) return referenced;

  for (const chunk of chunkList(uniquePaths, 100)) {
    const result = await query<{ storage_path: string }>(
      `WITH candidate(storage_path) AS (
         SELECT unnest($2::text[])
       )
       SELECT DISTINCT c.storage_path
       FROM course_blocks cb
       JOIN candidate c ON (
         position(c.storage_path in COALESCE(cb.data::text, '')) > 0 OR
         position(c.storage_path in COALESCE(cb.metadata::text, '')) > 0 OR
         position(c.storage_path in COALESCE(cb.published_data::text, '')) > 0 OR
         position(c.storage_path in COALESCE(cb.published_metadata::text, '')) > 0
       )
       WHERE cb.course_id = $1
         AND cb.deleted_at IS NULL`,
      [courseId, chunk],
    );

    for (const row of result.rows) {
      if (row.storage_path) referenced.add(row.storage_path);
    }
  }

  return referenced;
}

async function cleanupStoragePathsNoLongerReferenced(courseId: string, candidateStoragePaths: Set<string>): Promise<string[]> {
  if (candidateStoragePaths.size === 0) return [];

  const candidatePaths = Array.from(candidateStoragePaths).filter(isCourseStoragePath);
  const currentPaths = await collectReferencedCandidateStoragePaths(courseId, candidatePaths);
  const removedPaths = candidatePaths.filter((path) => !currentPaths.has(path));
  return deleteCourseAssetsByStoragePaths(courseId, removedPaths);
}

export async function deleteAsset(assetId: string, courseId: string, tenantId: string): Promise<AssetDeleteResult | null> {
  const assetResult = await query<any>(
    `SELECT * FROM course_assets WHERE id = $1 AND course_id = $2 AND tenant_id = $3`,
    [assetId, courseId, tenantId],
  );
  const asset = assetResult.rows[0];
  if (!asset) return null;

  const referencingBlocks = await getBlocksReferencingStoragePath(asset.course_id, asset.storage_path);
  const publishedReferenceCount = countPublishedReferences(referencingBlocks, asset.storage_path);
  if (referencingBlocks.length > 0) {
    return {
      asset,
      deleted: false,
      pendingPublishedReferences: true,
      publishedReferenceCount: Math.max(publishedReferenceCount, referencingBlocks.length),
      storagePathsToDelete: [],
    };
  }

  const deleted = await query<any>(
    `DELETE FROM course_assets WHERE id = $1 AND course_id = $2 AND tenant_id = $3 RETURNING *`,
    [assetId, courseId, tenantId],
  );
  await invalidateCourseReadCaches(courseId, tenantId);

  return {
    asset: deleted.rows[0],
    deleted: true,
    pendingPublishedReferences: false,
    publishedReferenceCount: 0,
    storagePathsToDelete: asset.storage_path ? [asset.storage_path] : [],
  };
}

export async function deleteAssetByStoragePath(
  courseId: string,
  tenantId: string,
  storagePath: string,
): Promise<DeleteAssetByStoragePathResult> {
  // Tenant first: the block-reference lookup below must never answer for a
  // course of another tenant (it would reveal which files that course uses).
  await assertCourseInTenant(courseId, tenantId);
  const referencingBlocks = await getBlocksReferencingStoragePath(courseId, storagePath);
  const publishedReferenceCount = countPublishedReferences(referencingBlocks, storagePath);
  if (referencingBlocks.length > 0) {
    return {
      deletedRows: [],
      pendingPublishedReferences: true,
      publishedReferenceCount: Math.max(publishedReferenceCount, referencingBlocks.length),
      storagePathsToDelete: [],
    };
  }

  const result = await query<{ storage_path: string; display_name: string | null }>(
    `DELETE FROM course_assets
     WHERE course_id = $1
       AND tenant_id = $2
       AND (storage_path = $3 OR url = $3)
     RETURNING storage_path, display_name`,
    [courseId, tenantId, storagePath],
  );
  if (result.rowCount && result.rowCount > 0) await invalidateCourseReadCaches(courseId, tenantId);

  return {
    deletedRows: result.rows,
    pendingPublishedReferences: false,
    publishedReferenceCount: 0,
    storagePathsToDelete: result.rows.map((row) => row.storage_path).filter(Boolean),
  };
}

// ── Course Creation with Root Block ──

export async function initializeCourseStructure(
  courseId: string,
  displayName: string,
  tenantId?: string,
): Promise<void> {
  // Create the root 'course' block
  await query(
    `INSERT INTO course_blocks (course_id, block_type, display_name, is_published, has_draft_changes)
     VALUES ($1, 'course', $2, true, false)
     ON CONFLICT DO NOTHING`,
    [courseId, displayName],
  );
  await Promise.all([
    invalidateCourseReadCaches(courseId, tenantId),
    tenantId ? invalidateTenantCourseCaches(tenantId) : Promise.resolve(),
  ]);
}

export async function updateCourseAssetReference(
  courseId: string,
  assetIds: string[],
  isReference: boolean,
  tenantId: string,
): Promise<void> {
  if (!assetIds.length) return;
  await query(
    `UPDATE course_assets SET is_reference = $3
     WHERE course_id = $1 AND tenant_id = $4 AND id = ANY($2)`,
    [courseId, assetIds, isReference, tenantId],
  );
  await invalidateCourseReadCaches(courseId, tenantId);
}
