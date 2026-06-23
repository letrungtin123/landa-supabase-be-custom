// ═══════════════════════════════════════════════════════════════
// Course Authoring Service — Replaces OpenEdX Studio CMS
// Course content tree stored as JSONB in course_blocks table
// Structure: course → chapter → sequential → vertical → components
// ═══════════════════════════════════════════════════════════════

import { getClient, query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';

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
  url: string;
  thumbnail_url: string | null;
  is_locked: boolean;
  date_added: string;
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

  const result = await query<{ id: string }>(
    `INSERT INTO course_blocks (course_id, parent_id, block_type, display_name, data, metadata, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [courseId, parentId, blockType, defaultName, JSON.stringify(data ?? {}), metadata ?? {}, sortOrder],
  );

  // Mark parent + ancestors as having changes (quả cầu vàng)
  if (parentId) {
    await markAncestorsDirty(result.rows[0].id);
  }

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
    la_crossword: 'Ô chữ',
    la_sortable: 'Sắp xếp',
    la_diagram: 'Biểu đồ',
    la_faq: 'FAQ',
    la_pdf: 'PDF',
  };
  return names[blockType] ?? 'Block mới';
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

  // Propagate has_draft_changes lên toàn bộ ancestor chain (giống edX)
  // Khi edit child → parent, grandparent, ... đều hiện quả cầu vàng
  if (!updates.is_published && block.parent_id) {
    await markAncestorsDirty(block.id);
  }

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

export async function renameBlock(blockId: string, displayName: string): Promise<BlockInfo> {
  return updateBlock(blockId, { display_name: displayName });
}

export async function publishBlock(blockId: string): Promise<BlockInfo> {
  await getBlockInfo(blockId);

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
     WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL`,
    [blockId],
  );

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
  await getBlockInfo(parentId);

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
      updatePayload = {
        metadata: { ...block.metadata, crossword_data: crosswordParsed || crosswordRaw },
        data: restData,
      };
      break;
    }
    case 'la_sortable': {
      const sortableRaw = restData.sortable_data;
      const sortableParsed = typeof sortableRaw === 'string' ? safeJsonParse(sortableRaw) : sortableRaw;
      updatePayload = {
        metadata: {
          ...block.metadata,
          sortable_data: sortableParsed || sortableRaw,
          question_text: restData.question_text,
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
): Promise<{ start: number; end: number; page: number; pageSize: number; totalCount: number; assets: AssetRecord[] }> {
  const offset = page * pageSize;
  const conditions: string[] = [
    'ca.course_id = $1',
    'ca.tenant_id = $2',
    'EXISTS (SELECT 1 FROM courses c WHERE c.id = ca.course_id AND c.deleted_at IS NULL)',
  ];
  const params: any[] = [courseId, tenantId];
  let paramIdx = 3;

  if (textSearch) {
    conditions.push(`ca.display_name ILIKE '%' || $${paramIdx++} || '%'`);
    params.push(textSearch);
  }

  const whereClause = conditions.join(' AND ');

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM course_assets ca WHERE ${whereClause}`,
    params,
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0');

  params.push(pageSize, offset);
  const result = await query<any>(
    `SELECT ca.id, ca.course_id, ca.display_name, ca.content_type,
            ca.file_size, ca.url, ca.thumbnail_url, ca.is_locked, ca.is_reference,
            ca.created_at AS date_added
     FROM course_assets ca
     WHERE ${whereClause}
     ORDER BY ca.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    params,
  );

  return {
    start: offset,
    end: Math.min(offset + pageSize, total),
    page,
    pageSize,
    totalCount: total,
    assets: result.rows,
  };
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
  return result.rows[0];
}

export async function deleteAsset(assetId: string): Promise<{ storage_path: string } | null> {
  const result = await query<{ storage_path: string }>(
    `DELETE FROM course_assets WHERE id = $1 RETURNING storage_path`,
    [assetId],
  );
  return result.rows[0] ?? null;
}

export async function deleteAssetByStoragePath(
  courseId: string,
  tenantId: string,
  storagePath: string,
): Promise<{ storage_path: string }[]> {
  const result = await query<{ storage_path: string }>(
    `DELETE FROM course_assets
     WHERE course_id = $1
       AND tenant_id = $2
       AND (storage_path = $3 OR url = $3)
     RETURNING storage_path`,
    [courseId, tenantId, storagePath],
  );
  return result.rows;
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
): Promise<void> {
  // Create the root 'course' block
  await query(
    `INSERT INTO course_blocks (course_id, block_type, display_name, is_published, has_draft_changes)
     VALUES ($1, 'course', $2, true, false)
     ON CONFLICT DO NOTHING`,
    [courseId, displayName],
  );
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
}
