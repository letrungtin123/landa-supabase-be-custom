// ═══════════════════════════════════════════════════════════════
// Course Authoring Service — Replaces OpenEdX Studio CMS
// Course content tree stored as JSONB in course_blocks table
// Structure: course → chapter → sequential → vertical → components
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';

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

// ── Course Outline (recursive tree) ──

export async function getCourseOutline(
  courseId: string,
  tenantId: string,
): Promise<CourseOutlineResponse> {
  // Verify course belongs to tenant
  const courseCheck = await query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM courses WHERE id = $1 AND tenant_id = $2`,
    [courseId, tenantId],
  );
  if (courseCheck.rowCount === 0) throw new Error('Course not found');

  // Get all blocks for this course in one query (avoid N+1)
  const blocksResult = await query<BlockInfo>(
    `SELECT id, course_id, parent_id, block_type, display_name,
            data, metadata, sort_order, is_published, has_draft_changes,
            created_at, updated_at
     FROM course_blocks
     WHERE course_id = $1
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
  // Get next sort_order
  const maxResult = await query<{ max_order: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS max_order
     FROM course_blocks WHERE course_id = $1 AND ${parentId ? 'parent_id = $2' : 'parent_id IS NULL'}`,
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
    `SELECT id, course_id, parent_id, block_type, display_name,
            data, metadata, sort_order, is_published, has_draft_changes,
            created_at, updated_at
     FROM course_blocks WHERE id = $1`,
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
    `UPDATE course_blocks SET ${setClauses.join(', ')} WHERE id = $1
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
       SELECT parent_id FROM course_blocks WHERE id = $1 AND parent_id IS NOT NULL
       UNION ALL
       SELECT cb.parent_id FROM course_blocks cb
       JOIN ancestors a ON cb.id = a.parent_id
       WHERE cb.parent_id IS NOT NULL
     )
     UPDATE course_blocks SET has_draft_changes = true, updated_at = now()
     WHERE id IN (SELECT parent_id FROM ancestors)`,
    [blockId],
  );
}

export async function renameBlock(blockId: string, displayName: string): Promise<BlockInfo> {
  return updateBlock(blockId, { display_name: displayName });
}

export async function publishBlock(blockId: string): Promise<BlockInfo> {
  // Cascade: publish block + tất cả children (recursive) trong 1 query
  // Copy data → published_data, metadata → published_metadata (giống edX draft/published branches)
  await query(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM course_blocks WHERE id = $1
       UNION ALL
       SELECT cb.id FROM course_blocks cb
       JOIN descendants d ON cb.parent_id = d.id
     )
     UPDATE course_blocks
     SET is_published = true,
         has_draft_changes = false,
         published_data = data,
         published_metadata = metadata,
         updated_at = now()
     WHERE id IN (SELECT id FROM descendants)`,
    [blockId],
  );

  return getBlockInfo(blockId);
}

export async function deleteBlock(blockId: string): Promise<void> {
  // CASCADE will delete children automatically
  const result = await query(
    `DELETE FROM course_blocks WHERE id = $1`,
    [blockId],
  );
  if ((result.rowCount ?? 0) === 0) throw new Error('Block not found');
}

export async function reorderChildren(
  parentId: string,
  childIds: string[],
): Promise<void> {
  if (childIds.length === 0) return;

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
     WHERE cb.id = v.block_id AND cb.parent_id = $1`,
    params,
  );
}

// ── Unit Children ──

export async function getUnitChildren(unitId: string): Promise<{ children: UnitChild[] }> {
  const result = await query<UnitChild>(
    `SELECT id, id AS block_id, display_name, block_type,
            has_draft_changes AS has_changes, is_published AS published
     FROM course_blocks
     WHERE parent_id = $1
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
  const conditions: string[] = ['ca.course_id = $1', 'ca.tenant_id = $2'];
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
            ca.file_size, ca.url, ca.thumbnail_url, ca.is_locked,
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
