// ═══════════════════════════════════════════════════════════════
// Course outline service: the outline tree, one block, block creation and
// edits (with the draft flags of ancestors), child order, unit children,
// studio submits of the custom components, a new course's root block and
// course row. SQL lives in course-blocks.repository.ts; this file keeps the
// rules, cache invalidation and messages. Moved from
// course-authoring.service.ts, which still re-exports every function.
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import {
  invalidateBlockReadCaches,
  invalidateCourseReadCaches,
  invalidateTenantCourseCaches,
} from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import { assertTenantCanAddCourseComponent } from '../tenants/tenant-course-components.service.js';
import { normalizeDiagramData } from './diagram-data.logic.js';
import { withoutServerOwnedAuthorNotes } from './course-author-notes.logic.js';
import { type CourseComponentLocale } from './course-authoring-problem-defaults.logic.js';
import { UUID_PATTERN } from '../../utils/uuid.js';
import { getDefaultData, getDefaultMetadata, getDefaultName } from './course-block-defaults.logic.js';
import { createCourseBlocksRepository, type NewCourseRow } from './course-blocks.repository.js';
import type { BlockInfo, BlockNode, CourseOutlineResponse, UnitChild } from './course-authoring.types.js';

const blocksRepository = createCourseBlocksRepository({ query });

// ── Course Outline (recursive tree) ──

export async function getCourseOutline(
  courseId: string,
  tenantId: string,
): Promise<CourseOutlineResponse> {
  // Verify course belongs to tenant
  const course = await blocksRepository.selectTenantCourse(courseId, tenantId);
  if (!course) throw new AppError('Course not found', 404);

  // Get all blocks for this course in one query (avoid N+1)
  const blocks = await blocksRepository.selectActiveOutlineBlocks(courseId);

  // Build tree in memory (O(n))
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
    display_name: course.display_name,
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
  const course = await blocksRepository.selectCourseTenant(courseId, tenantId ?? null);
  if (!course) throw new AppError('Course not found', 404);

  await assertTenantCanAddCourseComponent(course.tenant_id, blockType);

  if (parentId) {
    const parent = await getBlockInfo(parentId, tenantId);
    if (parent.course_id !== courseId) throw new AppError('Parent block not found', 404);
  }

  // Get next sort_order
  const sortOrder = (await blocksRepository.selectNextSortOrder(courseId, parentId)) ?? 0;

  const defaultName = displayName || getDefaultName(blockType, locale);
  const defaultData = data ?? getDefaultData(blockType, boilerplate, locale);
  const defaultMetadata = {
    ...getDefaultMetadata(blockType, boilerplate),
    // AI ID author notes are written by Apply only, never by block creation.
    ...(withoutServerOwnedAuthorNotes(metadata) ?? {}),
  };

  const id = await blocksRepository.insertBlock(courseId, parentId, blockType, defaultName, defaultData, defaultMetadata, sortOrder);

  // Mark parent + ancestors as having changes (quả cầu vàng)
  if (parentId) {
    await markAncestorsDirty(id);
  }

  await Promise.all([
    invalidateCourseReadCaches(courseId),
    invalidateBlockReadCaches([id]),
  ]);
  return { id };
}

export async function getBlockInfo(blockId: string, tenantId?: string | null): Promise<BlockInfo> {
  const block = await blocksRepository.selectBlockInfo(blockId, tenantId ?? null);
  if (!block) throw new AppError('Block not found', 404);
  return block;
}

/** Minimal, allowlist-safe course context for structured audit events. */
export async function getCourseAuditContext(courseId: string): Promise<{ course_id: string; course_name: string }> {
  const context = await blocksRepository.selectCourseAuditContext(courseId);
  if (!context) throw new AppError('Course not found', 404);
  return context;
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

  const block = await blocksRepository.updateBlockFields(blockId, updates);
  if (!block) throw new AppError('Block not found', 404);

  let tenantCourseInvalidation: Promise<void> | null = null;

  if (updates.display_name !== undefined && block.block_type === 'course' && block.parent_id === null) {
    const tenantId = await blocksRepository.updateCourseDisplayName(updates.display_name, block.course_id);
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
  await blocksRepository.markAncestorsDirty(blockId);
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

  await blocksRepository.updateChildOrder(parentId, childIds);
  await Promise.all([
    invalidateCourseReadCaches(parent.course_id),
    invalidateBlockReadCaches([parentId, ...childIds]),
  ]);
}

// ── Unit Children ──

export async function getUnitChildren(unitId: string, tenantId?: string | null): Promise<{ children: UnitChild[] }> {
  await getBlockInfo(unitId, tenantId);
  return { children: await blocksRepository.selectUnitChildren(unitId) };
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

// ── Course creation ──

/** The course row of a new course (inside the caller's audited transaction). */
export async function insertCourseRecord(course: NewCourseRow): Promise<void> {
  await blocksRepository.insertCourse(course);
}

export async function initializeCourseStructure(
  courseId: string,
  displayName: string,
  tenantId?: string,
): Promise<void> {
  // Create the root 'course' block
  await blocksRepository.insertCourseRootBlock(courseId, displayName);
  await Promise.all([
    invalidateCourseReadCaches(courseId, tenantId),
    tenantId ? invalidateTenantCourseCaches(tenantId) : Promise.resolve(),
  ]);
}
