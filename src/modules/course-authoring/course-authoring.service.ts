// ═══════════════════════════════════════════════════════════════
// Course Authoring Service — Replaces OpenEdX Studio CMS
// Course content tree stored as JSONB in course_blocks table
// Structure: course → chapter → sequential → vertical → components
// ═══════════════════════════════════════════════════════════════

import { getClient, query } from '../../config/database.js';
import {
  invalidateBlockReadCaches,
  invalidateCourseReadCaches,
  invalidateTenantCourseCaches,
} from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { deleteFile, extractStoragePath } from '../../config/storage.js';

type DbClient = Awaited<ReturnType<typeof getClient>>;

// ── Types ──

export interface BlockNode {
  id: string;
  display_name: string;
  block_type: string;
  published: boolean;
  has_changes: boolean;
  sort_order: number;
  data?: any;
  metadata?: any;
  children?: BlockNode[];
}

export interface CourseOutlineResponse {
  course_id: string;
  course_structure: BlockNode;
}

export interface BlockInfo {
  id: string;
  course_id: string;
  parent_id: string | null;
  block_type: string;
  display_name: string;
  data: any;
  metadata: any;
  sort_order: number;
  is_published: boolean;
  has_draft_changes: boolean;
  created_at: string;
  updated_at: string;
}

export interface UnitChild {
  id: string;
  block_id: string;
  display_name: string;
  block_type: string;
  has_changes: boolean;
  published: boolean;
}

export interface AssetRecord {
  id: string;
  course_id: string;
  display_name: string;
  content_type: string;
  file_size: number;
  storage_path?: string;
  url: string;
  thumbnail_url: string | null;
  is_locked: boolean;
  is_reference?: boolean;
  is_outline_media?: boolean;
  outline_reference_count?: number;
  date_added: string;
}

export interface CourseAssetsResponse {
  start: number;
  end: number;
  page: number;
  pageSize: number;
  totalCount: number | null;
  assets: AssetRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

interface ReferencingBlockRow {
  id: string;
  data: any;
  metadata: any;
  published_data: any;
  published_metadata: any;
}

export interface AssetDeleteResult {
  asset: any;
  deleted: boolean;
  pendingPublishedReferences: boolean;
  publishedReferenceCount: number;
  storagePathsToDelete: string[];
}

export interface DeleteAssetByStoragePathResult {
  deletedRows: { storage_path: string; display_name: string | null }[];
  pendingPublishedReferences: boolean;
  publishedReferenceCount: number;
  storagePathsToDelete: string[];
}

export type LessonAuthorComponentType = 'html' | 'problem' | 'la_faq' | 'la_sortable' | 'la_crossword' | 'la_diagram';

export interface LessonAuthorComponentProposal {
  type: LessonAuthorComponentType;
  title: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

export interface LessonAuthorUnitProposal {
  title: string;
  html?: string;
  components?: LessonAuthorComponentProposal[];
}

export interface LessonAuthorLessonProposal {
  title: string;
  units: LessonAuthorUnitProposal[];
}

export interface LessonAuthorChapterProposal {
  title: string;
  lessons: LessonAuthorLessonProposal[];
}

export interface LessonAuthorProposal {
  summary: string;
  chapters: LessonAuthorChapterProposal[];
}

export interface ApplyLessonAuthorProposalInput {
  courseId: string;
  tenantId: string;
  requestedBy: string;
  proposal: LessonAuthorProposal;
  jobId?: string;
  kbId?: string | null;
}

export interface ApplyLessonAuthorProposalResult {
  created_block_ids: string[];
  updated_block_ids: string[];
}

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
  if (courseCheck.rowCount === 0) throw new Error('Course not found');

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
): Promise<{ id: string }> {
  const courseCheck = await query<{ id: string }>(
    `SELECT id FROM courses WHERE id = $1 AND deleted_at IS NULL`,
    [courseId],
  );
  if (courseCheck.rowCount === 0) throw new AppError('Course not found', 404);

  if (parentId) {
    const parent = await getBlockInfo(parentId);
    if (parent.course_id !== courseId) throw new AppError('Parent block not found', 404);
  }

  // Get next sort_order
  const maxResult = await query<{ max_order: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS max_order
     FROM course_blocks WHERE course_id = $1 AND deleted_at IS NULL AND ${parentId ? 'parent_id = $2' : 'parent_id IS NULL'}`,
    parentId ? [courseId, parentId] : [courseId],
  );
  const sortOrder = maxResult.rows[0]?.max_order ?? 0;

  const defaultName = displayName || getDefaultName(blockType);
  const defaultData = data ?? getDefaultData(blockType, boilerplate);
  const defaultMetadata = {
    ...getDefaultMetadata(blockType, boilerplate),
    ...(metadata ?? {}),
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

function getDefaultName(blockType: string): string {
  const names: Record<string, string> = {
    chapter: 'Chương mới',
    sequential: 'Bài học mới',
    vertical: 'Unit mới',
    video: 'Video',
    html: 'Văn bản',
    problem: 'Câu hỏi',
    la_media_quiz: 'Câu hỏi kèm media',
    la_crossword: 'Đố vui ô chữ',
    la_sortable: 'sắp xếp ô chữ',
    la_diagram: 'Biểu đồ',
    la_faq: 'FAQ',
    la_pdf: 'PDF',
  };
  return names[blockType] ?? 'Block mới';
}

function mediaQuizModeFromBoilerplate(boilerplate?: string): 'single_select' | 'multiple_select' {
  return boilerplate === 'media_quiz_multiple_select' ? 'multiple_select' : 'single_select';
}

function mediaQuizModeValue(raw: unknown, fallback: 'single_select' | 'multiple_select'): 'single_select' | 'multiple_select' {
  return raw === 'single_select' || raw === 'multiple_select' ? raw : fallback;
}

function getDefaultData(blockType: string, boilerplate?: string): any {
  if (blockType !== 'la_media_quiz') return {};
  const mode = mediaQuizModeFromBoilerplate(boilerplate);
  return {
    version: 1,
    mode,
    require_correct_to_advance: true,
    questions: [
      {
        id: 'q1',
        mode,
        prompt_html: '<p>Câu hỏi 1</p>',
        explanation_html: '',
        hints: [],
        media: null,
        choices: [
          { id: 'choice_0', html: '<p>Đáp án đúng</p>', correct: true },
          { id: 'choice_1', html: '<p>Đáp án sai</p>', correct: false },
          ...(mode === 'multiple_select'
            ? [{ id: 'choice_2', html: '<p>Một đáp án đúng khác</p>', correct: true }]
            : []),
        ],
      },
    ],
  };
}

function getDefaultMetadata(blockType: string, boilerplate?: string): Record<string, unknown> {
  if (blockType !== 'la_media_quiz') return {};
  return { media_quiz_mode: mediaQuizModeFromBoilerplate(boilerplate) };
}

function assertPublishableMediaQuizData(raw: any, label: string): void {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object' || !Array.isArray(data.questions) || data.questions.length === 0) {
    throw new AppError(`${label} cần ít nhất một câu hỏi kèm media trước khi publish`, 400);
  }
  const dataMode = mediaQuizModeValue(data.mode, 'single_select');
  data.questions.forEach((question: any, index: number) => {
    const questionMode = mediaQuizModeValue(question?.mode, dataMode);
    if (!question?.media?.storage_path || typeof question.media.storage_path !== 'string') {
      throw new AppError(`${label} - câu hỏi ${index + 1} cần tải media lên trước khi publish`, 400);
    }
    if (!Array.isArray(question?.choices) || question.choices.length < 2) {
      throw new AppError(`${label} - câu hỏi ${index + 1} cần ít nhất hai lựa chọn trước khi publish`, 400);
    }
    const correctCount = question.choices.filter((choice: any) => choice?.correct === true).length;
    if (correctCount === 0) {
      throw new AppError(`${label} - câu hỏi ${index + 1} cần ít nhất một đáp án đúng trước khi publish`, 400);
    }
    if (questionMode === 'single_select' && correctCount !== 1) {
      throw new AppError(`${label} - câu hỏi ${index + 1} phải có đúng một đáp án đúng trước khi publish`, 400);
    }
  });
}

export async function getBlockInfo(blockId: string): Promise<BlockInfo> {
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
     SELECT b.id, b.course_id, b.parent_id, b.block_type, b.display_name,
            b.data, b.metadata, b.sort_order, b.is_published, b.has_draft_changes,
            b.created_at, b.updated_at
     FROM course_blocks b
     JOIN courses c ON c.id = b.course_id
     WHERE b.id = $1
       AND b.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)`,
    [blockId],
  );
  if (result.rowCount === 0) throw new Error('Block not found');
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
    setClauses.push(`metadata = $${paramIdx++}`);
    params.push(updates.metadata);
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

  if (result.rowCount === 0) throw new Error('Block not found');

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
  return block;
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

export async function renameBlock(blockId: string, displayName: string): Promise<BlockInfo> {
  return updateBlock(blockId, { display_name: displayName });
}

export async function publishBlock(blockId: string): Promise<BlockInfo> {
  const block = await getBlockInfo(blockId);
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

  // Propagate clean state upward: if no siblings/cousins remain dirty, clear ancestor flags
  await recalculateAncestorDraftFlags(blockId);
  await cleanupStoragePathsNoLongerReferenced(block.course_id, previousPublishedPaths);
  const descendantIds = await getDescendantBlockIds(blockId);
  await Promise.all([
    invalidateCourseReadCaches(block.course_id),
    invalidateBlockReadCaches(descendantIds),
  ]);

  return getBlockInfo(blockId);
}

/**
 * Discard draft changes on a single block — revert data to the last published version.
 * Reverse of publishBlock: copies published_data → data, published_metadata → metadata.
 * Non-recursive: only reverts the targeted block, not its children.
 */
export async function discardDraft(blockId: string): Promise<BlockInfo> {
  const block = await getBlockInfo(blockId);

  if (!block.has_draft_changes) {
    throw new AppError('Block has no draft changes to discard', 400);
  }

  // Check if published_data exists (block must have been published at least once)
  const pubCheck = await query<{ has_pub: boolean }>(
    `SELECT published_data IS NOT NULL AS has_pub
     FROM course_blocks WHERE id = $1 AND deleted_at IS NULL`,
    [blockId],
  );
  if (!pubCheck.rows[0]?.has_pub) {
    throw new AppError('Block has never been published — cannot rollback', 400);
  }

  await query(
    `UPDATE course_blocks
     SET data = published_data,
         metadata = published_metadata,
         has_draft_changes = false,
         updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL`,
    [blockId],
  );

  // Propagate clean state upward: if no siblings remain dirty, clear ancestor flags
  await recalculateAncestorDraftFlags(blockId);
  await Promise.all([
    invalidateCourseReadCaches(block.course_id),
    invalidateBlockReadCaches([blockId]),
  ]);

  return getBlockInfo(blockId);
}

export async function discardDraftCascade(blockId: string): Promise<BlockInfo> {
  const block = await getBlockInfo(blockId);

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

  return getBlockInfo(blockId);
}

export async function deleteBlock(blockId: string): Promise<void> {
  void blockId;
  throw new AppError('Use course deletion queue for block delete', 400);
}

export async function reorderChildren(
  parentId: string,
  childIds: string[],
): Promise<void> {
  if (childIds.length === 0) return;
  const parent = await getBlockInfo(parentId);

  // Validate UUID format — chống SQL injection
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const id of childIds) {
    if (!uuidRegex.test(id)) throw new AppError('Invalid block ID format', 400);
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

export async function getUnitChildren(unitId: string): Promise<{ children: UnitChild[] }> {
  await getBlockInfo(unitId);

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

export async function studioSubmit(
  blockId: string,
  submitData: any,
): Promise<any> {
  // Get current block
  const block = await getBlockInfo(blockId);
  const previousPublishedPaths = await collectPublishedStoragePathsForSubtree(blockId);

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
      const cwMediaPayload: any = {};
      if (restData.problem_media) cwMediaPayload.problem_media = restData.problem_media;
      else if ('problem_media' in restData) delete block.metadata?.problem_media;
      updatePayload = {
        metadata: { ...block.metadata, crossword_data: crosswordParsed || crosswordRaw, ...cwMediaPayload },
        data: restData,
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
      const diagramParsed = typeof diagramRaw === 'string' ? safeJsonParse(diagramRaw) : diagramRaw;
      updatePayload = {
        metadata: { ...block.metadata, diagram_data: diagramParsed || diagramRaw },
        data: restData,
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

  // Auto-sync published_metadata/published_data so learner sees changes immediately
  // (learner API uses COALESCE(published_metadata, metadata) — if published_metadata exists
  // but is stale, learner won't see the new data)
  if (updatePayload.metadata || updatePayload.data) {
    const syncClauses: string[] = ['updated_at = now()'];
    const syncParams: any[] = [blockId];
    let syncIdx = 2;
    if (updatePayload.metadata) {
      syncClauses.push(`published_metadata = $${syncIdx++}`);
      syncParams.push(updatePayload.metadata);
    }
    if (updatePayload.data) {
      syncClauses.push(`published_data = $${syncIdx++}`);
      syncParams.push(JSON.stringify(updatePayload.data));
    }
    syncClauses.push('has_draft_changes = false');
    await query(
      `UPDATE course_blocks SET ${syncClauses.join(', ')} WHERE id = $1 AND deleted_at IS NULL`,
      syncParams,
    );
    await cleanupStoragePathsNoLongerReferenced(block.course_id, previousPublishedPaths);
  }

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
  const courseCheck = await query<{ id: string }>(
    `SELECT id FROM courses WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [courseId, tenantId],
  );
  if (courseCheck.rowCount === 0) throw new AppError('Course not found', 404);

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
      typeof parsed.created_at !== 'string' ||
      Number.isNaN(Date.parse(parsed.created_at)) ||
      typeof parsed.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.id)
    ) {
      throw new Error('invalid cursor payload');
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
  const result = await query<AssetRecord>(
    `INSERT INTO course_assets (course_id, tenant_id, display_name, content_type, file_size, storage_path, url, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, course_id, display_name, content_type, file_size, url, thumbnail_url, is_locked, created_at AS date_added`,
    [courseId, tenantId, displayName, contentType, fileSize, storagePath, url, uploadedBy],
  );
  await invalidateCourseReadCaches(courseId, tenantId);
  return result.rows[0];
}

const STORAGE_REFERENCE_KEYS = new Set(['video_storage_path', 'video_url', 'url', 'storage_path', 'pdf_url', 'src']);
const COURSE_STORAGE_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/courses\/.+\/[^/]+$/i;

function isCourseStoragePath(value: string): boolean {
  const storagePath = extractStoragePath(value.trim());
  return !!storagePath && COURSE_STORAGE_PATH_RE.test(storagePath);
}

function collectCourseStoragePaths(value: any, paths: Set<string>): void {
  if (value == null) return;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const storagePath = extractStoragePath(trimmed);
    if (storagePath && COURSE_STORAGE_PATH_RE.test(storagePath)) {
      paths.add(storagePath);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectCourseStoragePaths(item, paths);
    return;
  }

  if (typeof value === 'object') {
    for (const nested of Object.values(value)) collectCourseStoragePaths(nested, paths);
  }
}

function collectCourseStoragePathsFromValues(...values: any[]): Set<string> {
  const paths = new Set<string>();
  for (const value of values) collectCourseStoragePaths(value, paths);
  return paths;
}

function valueContainsStoragePath(value: any, storagePath: string): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.includes(storagePath);
  try {
    return JSON.stringify(value).includes(storagePath);
  } catch {
    return false;
  }
}

function stripStoragePathReference(value: any, storagePath: string): any {
  if (Array.isArray(value)) {
    return value
      .filter((item) => {
        if (item === storagePath) return false;
        if (item && typeof item === 'object') {
          if (item.url === storagePath || item.video_url === storagePath || item.storage_path === storagePath || item.src === storagePath || item.pdf_url === storagePath || item.video_storage_path === storagePath) {
            return false;
          }
        }
        return true;
      })
      .map((item) => stripStoragePathReference(item, storagePath));
  }

  if (value !== null && typeof value === 'object') {
    const next: any = {};
    for (const [key, nested] of Object.entries(value)) {
      if (nested === storagePath && STORAGE_REFERENCE_KEYS.has(key)) continue;
      next[key] = stripStoragePathReference(nested, storagePath);
    }
    return next;
  }

  return value;
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

function countPublishedReferences(blocks: ReferencingBlockRow[], storagePath: string): number {
  return blocks.filter((block) =>
    valueContainsStoragePath(block.published_data, storagePath) ||
    valueContainsStoragePath(block.published_metadata, storagePath),
  ).length;
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

async function collectAllStoragePathsForCourse(courseId: string): Promise<Set<string>> {
  const result = await query<ReferencingBlockRow>(
    `SELECT id, data, metadata, published_data, published_metadata
       FROM course_blocks
      WHERE course_id = $1
        AND deleted_at IS NULL`,
    [courseId],
  );

  const paths = new Set<string>();
  for (const row of result.rows) {
    collectCourseStoragePaths(row.data, paths);
    collectCourseStoragePaths(row.metadata, paths);
    collectCourseStoragePaths(row.published_data, paths);
    collectCourseStoragePaths(row.published_metadata, paths);
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
  await Promise.allSettled(deletedPaths.map((path) => deleteFile(path)));
  return deletedPaths;
}

function chunkList<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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

async function getNextChildSortOrder(
  client: DbClient,
  courseId: string,
  parentId: string | null,
): Promise<number> {
  const result = parentId
    ? await client.query<{ next_order: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
         FROM course_blocks
         WHERE course_id = $1 AND parent_id = $2 AND deleted_at IS NULL`,
        [courseId, parentId],
      )
    : await client.query<{ next_order: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
         FROM course_blocks
         WHERE course_id = $1 AND parent_id IS NULL AND deleted_at IS NULL`,
        [courseId],
      );

  return result.rows[0]?.next_order ?? 0;
}

async function insertGeneratedBlock(
  client: DbClient,
  courseId: string,
  parentId: string | null,
  blockType: string,
  displayName: string,
  data: unknown,
  metadata: Record<string, unknown>,
): Promise<string> {
  const sortOrder = await getNextChildSortOrder(client, courseId, parentId);
  const result = await client.query<{ id: string }>(
    `INSERT INTO course_blocks (
       course_id, parent_id, block_type, display_name,
       data, metadata, sort_order, is_published, has_draft_changes
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, true)
     RETURNING id`,
    [
      courseId,
      parentId,
      blockType,
      displayName,
      JSON.stringify(data),
      metadata,
      sortOrder,
    ],
  );
  return result.rows[0].id;
}

function normalizeGeneratedTitle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findExistingChildBlock(
  client: DbClient,
  courseId: string,
  parentId: string,
  blockType: string,
  displayName: string,
): Promise<string | null> {
  const normalized = normalizeGeneratedTitle(displayName);
  if (!normalized) return null;

  const result = await client.query<{ id: string; display_name: string }>(
    `SELECT id, display_name
     FROM course_blocks
     WHERE course_id = $1
       AND parent_id = $2
       AND block_type = $3
       AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
    [courseId, parentId, blockType],
  );

  const existing = result.rows.find(row => normalizeGeneratedTitle(row.display_name) === normalized);
  return existing?.id ?? null;
}

async function markAncestorsDirtyWithClient(client: DbClient, blockId: string): Promise<void> {
  await client.query(
    `WITH RECURSIVE ancestors AS (
       SELECT parent_id
       FROM course_blocks
       WHERE id = $1 AND parent_id IS NOT NULL AND deleted_at IS NULL
       UNION ALL
       SELECT cb.parent_id
       FROM course_blocks cb
       JOIN ancestors a ON cb.id = a.parent_id
       WHERE cb.parent_id IS NOT NULL AND cb.deleted_at IS NULL
     )
     UPDATE course_blocks
     SET has_draft_changes = true, updated_at = now()
     WHERE id IN (SELECT parent_id FROM ancestors) AND deleted_at IS NULL`,
    [blockId],
  );
}

async function updateGeneratedBlockContent(
  client: DbClient,
  blockId: string,
  courseId: string,
  parentId: string,
  blockType: string,
  data: unknown,
  metadata: Record<string, unknown>,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `UPDATE course_blocks
     SET data = $5,
         metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
         has_draft_changes = true,
         updated_at = now()
     WHERE id = $1
       AND course_id = $2
       AND parent_id = $3
       AND block_type = $4
       AND deleted_at IS NULL
     RETURNING id`,
    [blockId, courseId, parentId, blockType, JSON.stringify(data), JSON.stringify(metadata)],
  );
  if (result.rowCount === 0) throw new Error('Existing generated block not found for update');
  await markAncestorsDirtyWithClient(client, blockId);
}

async function getOrCreateGeneratedBlock(
  client: DbClient,
  courseId: string,
  parentId: string,
  blockType: string,
  displayName: string,
  data: unknown,
  metadata: Record<string, unknown>,
  options: { updateExisting?: boolean } = {},
): Promise<{ id: string; created: boolean; updated: boolean }> {
  const existingId = await findExistingChildBlock(client, courseId, parentId, blockType, displayName);
  if (existingId) {
    if (options.updateExisting) {
      await updateGeneratedBlockContent(client, existingId, courseId, parentId, blockType, data, metadata);
      return { id: existingId, created: false, updated: true };
    }
    return { id: existingId, created: false, updated: false };
  }

  const id = await insertGeneratedBlock(client, courseId, parentId, blockType, displayName, data, metadata);
  return { id, created: true, updated: false };
}

function clampTitle(value: string, fallback: string): string {
  const title = typeof value === 'string' ? value.trim() : '';
  return (title || fallback).slice(0, 250);
}

function getLessonAuthorComponents(unit: LessonAuthorUnitProposal): LessonAuthorComponentProposal[] {
  if (Array.isArray(unit.components) && unit.components.length > 0) return unit.components;
  if (typeof unit.html === 'string' && unit.html.trim()) {
    return [{
      type: 'html',
      title: unit.title,
      data: unit.html,
    }];
  }
  return [];
}

function buildGeneratedComponentBlock(
  component: LessonAuthorComponentProposal,
  unitTitle: string,
  baseMetadata: Record<string, unknown>,
  componentIndex: number,
): {
  blockType: LessonAuthorComponentType;
  displayName: string;
  data: unknown;
  metadata: Record<string, unknown>;
} {
  const displayName = clampTitle(component.title, `${unitTitle} component ${componentIndex + 1}`);
  return {
    blockType: component.type,
    displayName,
    data: component.data,
    metadata: {
      ...(component.metadata ?? {}),
      ...baseMetadata,
      ai_component_index: componentIndex,
      source: 'lesson_author_proposal',
    },
  };
}

function logLessonAuthorApply(stage: string, details: Record<string, unknown> = {}): void {
  console.log(`[LessonAuthorApply] ${stage}`, details);
}

function getProposalApplyMetrics(proposal: LessonAuthorProposal): Record<string, unknown> {
  let lessons = 0;
  let units = 0;
  let components = 0;
  const componentTypes = new Set<string>();

  proposal.chapters.forEach(chapter => {
    lessons += chapter.lessons.length;
    chapter.lessons.forEach(lesson => {
      units += lesson.units.length;
      lesson.units.forEach(unit => {
        const unitComponents = getLessonAuthorComponents(unit);
        components += unitComponents.length;
        unitComponents.forEach(component => componentTypes.add(component.type));
      });
    });
  });

  return {
    chapters: proposal.chapters.length,
    lessons,
    units,
    components,
    component_types: Array.from(componentTypes),
  };
}

export async function applyLessonAuthorProposalToCourse(
  input: ApplyLessonAuthorProposalInput,
): Promise<ApplyLessonAuthorProposalResult> {
  const client = await getClient();

  try {
    logLessonAuthorApply('start', {
      course_id: input.courseId,
      tenant_id: input.tenantId,
      job_id: input.jobId ?? null,
      kb_id: input.kbId ?? null,
      ...getProposalApplyMetrics(input.proposal),
    });
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`course:${input.tenantId}:${input.courseId}`]);
    logLessonAuthorApply('transaction_locked', {
      course_id: input.courseId,
      tenant_id: input.tenantId,
      job_id: input.jobId ?? null,
    });

    const courseResult = await client.query<{ id: string; display_name: string }>(
      `SELECT id, display_name
       FROM courses
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [input.courseId, input.tenantId],
    );
    if (courseResult.rowCount === 0) throw new AppError('Course not found', 404);

    let rootResult = await client.query<{ id: string }>(
      `SELECT id
       FROM course_blocks
       WHERE course_id = $1
         AND parent_id IS NULL
         AND block_type = 'course'
         AND deleted_at IS NULL
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE`,
      [input.courseId],
    );

    let createdRoot = false;
    if (rootResult.rowCount === 0) {
      createdRoot = true;
      rootResult = await client.query<{ id: string }>(
        `INSERT INTO course_blocks (
           course_id, block_type, display_name, is_published, has_draft_changes
         )
         VALUES ($1, 'course', $2, true, true)
         RETURNING id`,
        [input.courseId, courseResult.rows[0].display_name],
      );
    }

    const rootId = rootResult.rows[0].id;
    logLessonAuthorApply('root_ready', {
      course_id: input.courseId,
      root_id: rootId,
      created_root: createdRoot,
    });
    const createdBlockIds: string[] = [];
    const updatedBlockIds: string[] = [];
    const baseMetadata = {
      generated_by: 'lesson_author_ai',
      job_id: input.jobId ?? null,
      kb_id: input.kbId ?? null,
      requested_by: input.requestedBy,
      generated_at: new Date().toISOString(),
    };

    for (const [chapterIndex, chapter] of input.proposal.chapters.entries()) {
      const chapterTitle = clampTitle(chapter.title, `Generated chapter ${chapterIndex + 1}`);
      const chapterBlock = await getOrCreateGeneratedBlock(
        client,
        input.courseId,
        rootId,
        'chapter',
        chapterTitle,
        {},
        { ...baseMetadata, ai_index: chapterIndex },
      );
      if (chapterBlock.created) createdBlockIds.push(chapterBlock.id);
      logLessonAuthorApply('chapter_ready', {
        job_id: input.jobId ?? null,
        title: chapterTitle,
        id: chapterBlock.id,
        created: chapterBlock.created,
      });

      for (const [lessonIndex, lesson] of chapter.lessons.entries()) {
        const lessonTitle = clampTitle(lesson.title, `Generated lesson ${lessonIndex + 1}`);
        const sequentialBlock = await getOrCreateGeneratedBlock(
          client,
          input.courseId,
          chapterBlock.id,
          'sequential',
          lessonTitle,
          {},
          { ...baseMetadata, ai_index: lessonIndex },
        );
        if (sequentialBlock.created) createdBlockIds.push(sequentialBlock.id);
        logLessonAuthorApply('lesson_ready', {
          job_id: input.jobId ?? null,
          chapter_id: chapterBlock.id,
          title: lessonTitle,
          id: sequentialBlock.id,
          created: sequentialBlock.created,
        });

        for (const [unitIndex, unit] of lesson.units.entries()) {
          const unitTitle = clampTitle(unit.title, `Generated unit ${unitIndex + 1}`);
          const verticalBlock = await getOrCreateGeneratedBlock(
            client,
            input.courseId,
            sequentialBlock.id,
            'vertical',
            unitTitle,
            {},
            { ...baseMetadata, ai_index: unitIndex },
          );
          if (verticalBlock.created) createdBlockIds.push(verticalBlock.id);
          logLessonAuthorApply('unit_ready', {
            job_id: input.jobId ?? null,
            lesson_id: sequentialBlock.id,
            title: unitTitle,
            id: verticalBlock.id,
            created: verticalBlock.created,
          });

          for (const [componentIndex, component] of getLessonAuthorComponents(unit).entries()) {
            const generatedComponent = buildGeneratedComponentBlock(
              component,
              unitTitle,
              { ...baseMetadata, ai_index: unitIndex },
              componentIndex,
            );
            const componentBlock = await getOrCreateGeneratedBlock(
              client,
              input.courseId,
              verticalBlock.id,
              generatedComponent.blockType,
              generatedComponent.displayName,
              generatedComponent.data,
              generatedComponent.metadata,
              { updateExisting: true },
            );
            if (componentBlock.created) createdBlockIds.push(componentBlock.id);
            if (componentBlock.updated) updatedBlockIds.push(componentBlock.id);
            logLessonAuthorApply('component_ready', {
              job_id: input.jobId ?? null,
              unit_id: verticalBlock.id,
              type: generatedComponent.blockType,
              title: generatedComponent.displayName,
              id: componentBlock.id,
              created: componentBlock.created,
              updated: componentBlock.updated,
            });
          }
        }
      }
    }

    await client.query(
      `UPDATE course_blocks
       SET has_draft_changes = true, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [rootId],
    );

    await client.query('COMMIT');
    logLessonAuthorApply('commit_done', {
      course_id: input.courseId,
      job_id: input.jobId ?? null,
      created_count: createdBlockIds.length,
      created_block_ids: createdBlockIds,
      updated_count: updatedBlockIds.length,
      updated_block_ids: updatedBlockIds,
    });
    await Promise.all([
      invalidateCourseReadCaches(input.courseId, input.tenantId),
      invalidateBlockReadCaches([rootId, ...createdBlockIds, ...updatedBlockIds]),
    ]);
    return { created_block_ids: createdBlockIds, updated_block_ids: updatedBlockIds };
  } catch (err) {
    await client.query('ROLLBACK');
    logLessonAuthorApply('rollback_done', {
      course_id: input.courseId,
      job_id: input.jobId ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    client.release();
  }
}

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
