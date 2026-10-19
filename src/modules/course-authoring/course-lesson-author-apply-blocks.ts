// ═══════════════════════════════════════════════════════════════
// AI ID apply, generated blocks: find, create and update the outline blocks
// an AI ID proposal writes, on the apply's transaction client. Moved
// unchanged from course-lesson-author-apply.service.ts.
// ═══════════════════════════════════════════════════════════════

import { getClient } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import {
  isLessonAuthorGeneratedContentOwned,
  isLessonAuthorMediaProtectedBlock,
  orderLessonAuthorComponents,
} from './lesson-author-components.logic.js';
import { normalizeDiagramData } from './diagram-data.logic.js';
import { stripLessonAuthorSourceRangeSuffix } from '../ai-chatbot/ai-id/lesson-author-intent.logic.js';
import type {
  LessonAuthorComponentProposal,
  LessonAuthorComponentType,
  LessonAuthorUnitProposal,
} from './course-authoring.types.js';

export type DbClient = Awaited<ReturnType<typeof getClient>>;

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

export async function insertGeneratedBlock(
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
): Promise<{ id: string; display_name: string; data: unknown; metadata: unknown } | null> {
  const normalized = normalizeGeneratedTitle(displayName);
  if (!normalized) return null;

  const result = await client.query<{ id: string; display_name: string; data: unknown; metadata: unknown }>(
    `SELECT id, display_name, data, metadata
     FROM course_blocks
     WHERE course_id = $1
       AND parent_id = $2
       AND block_type = $3
       AND deleted_at IS NULL
     ORDER BY sort_order ASC, created_at ASC`,
    [courseId, parentId, blockType],
  );

  const existing = result.rows.find(row => normalizeGeneratedTitle(row.display_name) === normalized);
  return existing ?? null;
}

export async function markAncestorsDirtyWithClient(client: DbClient, blockId: string): Promise<void> {
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

export async function updateGeneratedBlockContent(
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

export async function getOrCreateGeneratedBlock(
  client: DbClient,
  courseId: string,
  parentId: string,
  blockType: string,
  displayName: string,
  data: unknown,
  metadata: Record<string, unknown>,
  options: { updateExisting?: boolean; requireExisting?: boolean } = {},
): Promise<{ id: string; created: boolean; updated: boolean }> {
  const existing = await findExistingChildBlock(client, courseId, parentId, blockType, displayName);
  if (existing) {
    if (options.updateExisting) {
      const canUpdateGeneratedContent = isLessonAuthorGeneratedContentOwned(existing.metadata)
        && !isLessonAuthorMediaProtectedBlock(blockType, existing.data, existing.metadata);
      if (canUpdateGeneratedContent) {
        await updateGeneratedBlockContent(client, existing.id, courseId, parentId, blockType, data, metadata);
        return { id: existing.id, created: false, updated: true };
      }
    } else {
      return { id: existing.id, created: false, updated: false };
    }
  }

  if (options.requireExisting) {
    throw new AppError(`Không tìm thấy ${blockType} đã chọn trong outline. Vui lòng tạo lại đề xuất.`, 409);
  }

  const id = await insertGeneratedBlock(client, courseId, parentId, blockType, displayName, data, metadata);
  return { id, created: true, updated: false };
}

function clampTitle(value: string, fallback: string): string {
  const title = typeof value === 'string' ? value.trim() : '';
  return (title || fallback).slice(0, 250);
}

export function clampStructuralTitle(value: string, fallback: string): string {
  let title = stripLessonAuthorSourceRangeSuffix(value);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = title.replace(
      /^(?:chương|chuong|chapter|phần|phan|part|mục|muc|section|module|sequential|bài học|bai hoc|bài|bai|lesson|unit|vertical)\s+\d+(?:\.\d+){0,2}(?:\s*[:.)-]\s*|\s+)/iu,
      '',
    ).trim();
    if (!next || next === title) break;
    title = next;
  }
  return clampTitle(title, fallback);
}

export async function moveFaqComponentsToUnitEnd(client: DbClient, courseId: string, unitId: string): Promise<void> {
  // Move only FAQ rows. Non-FAQ blocks keep their sort_order and updated_at,
  // which is important for manual media and image components.
  await client.query(
    `WITH non_faq_max AS (
       SELECT COALESCE(MAX(sort_order), -1) AS max_sort_order
       FROM course_blocks
       WHERE course_id = $1
         AND parent_id = $2
         AND deleted_at IS NULL
         AND block_type <> 'la_faq'
     ), ordered_faq AS (
       SELECT cb.id,
              non_faq_max.max_sort_order
                + ROW_NUMBER() OVER (
                    ORDER BY cb.sort_order ASC NULLS LAST, cb.created_at ASC, cb.id ASC
                  ) AS new_sort_order
       FROM course_blocks cb
       CROSS JOIN non_faq_max
       WHERE cb.course_id = $1
         AND cb.parent_id = $2
         AND cb.deleted_at IS NULL
         AND cb.block_type = 'la_faq'
     )
     UPDATE course_blocks cb
     SET sort_order = ordered_faq.new_sort_order::integer,
         updated_at = now()
     FROM ordered_faq
     WHERE cb.id = ordered_faq.id
       AND cb.course_id = $1
       AND cb.parent_id = $2
       AND cb.deleted_at IS NULL
       AND cb.sort_order IS DISTINCT FROM ordered_faq.new_sort_order::integer`,
    [courseId, unitId],
  );
}

export function getLessonAuthorComponents(unit: LessonAuthorUnitProposal): LessonAuthorComponentProposal[] {
  if (Array.isArray(unit.components) && unit.components.length > 0) {
    return orderLessonAuthorComponents(unit.components);
  }
  if (typeof unit.html === 'string' && unit.html.trim()) {
    return [{
      type: 'html',
      title: unit.title,
      data: unit.html,
    }];
  }
  return [];
}

export function buildGeneratedComponentBlock(
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
  const componentData = component.type === 'la_diagram'
    ? normalizeDiagramData(component.data)
    : component.data;
  return {
    blockType: component.type,
    displayName,
    data: componentData,
    metadata: {
      ...(component.metadata ?? {}),
      ...baseMetadata,
      ...(component.type === 'la_diagram' ? { diagram_data: componentData } : {}),
      ai_component_index: componentIndex,
      source: 'lesson_author_proposal',
    },
  };
}
