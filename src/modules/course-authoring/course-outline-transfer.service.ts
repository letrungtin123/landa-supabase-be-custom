// ═══════════════════════════════════════════════════════════════
// Course outline transfer jobs
//
// A transfer is deliberately asynchronous. Copying an outline can involve a
// large, quota-metered Storage payload; keeping that work out of a request
// protects the API pool and makes retries idempotent. Every query below is
// tenant-scoped and the final write is serialised by row locks on both trees.
// ═══════════════════════════════════════════════════════════════
//
// Split by concern, moved unchanged:
// - course-outline-transfer-job.service.ts: the worker side (claim, lease,
//   Storage copy, duplicate, retry / terminal mark);
// - course-outline-transfer.logic.ts: the rules without I/O;
// - course-outline-transfer.types.ts: the row and API types.
// This file keeps the request side and re-exports the rest.

import { query, withDatabaseTransaction } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { assertCourseBelongsToTenant } from '../courses/course-access.service.js';
import { assertTransferSchemaReady } from './course-outline-transfer-job.service.js';
import {
  MOVE_OPERATION_DISABLED_MESSAGE,
  assertUuid,
  decodeCursor,
  destinationPathTypes,
  encodeCursor,
  expectedDestinationParentType,
  isTransferableBlockType,
  normalizeDestinationPath,
  normalizePage,
  normalizeSearch,
} from './course-outline-transfer.logic.js';
import type {
  BlockRow,
  CourseOutlineTransferDestinationOptions,
  CourseOutlineTransferJob,
  CourseOutlineTransferOperation,
  CourseRow,
} from './course-outline-transfer.types.js';

export type {
  CourseOutlineTransferDestinationLevel,
  CourseOutlineTransferDestinationOptions,
  CourseOutlineTransferJob,
  CourseOutlineTransferOperation,
  CourseOutlineTransferStatus,
} from './course-outline-transfer.types.js';
export { normalizeCourseOutlineTransferStoragePath } from './course-outline-transfer.logic.js';
export {
  isCourseOutlineTransferSchemaReady,
  processNextCourseOutlineTransferJob,
} from './course-outline-transfer-job.service.js';

export async function listTransferTargetCourses(
  tenantId: string,
  sourceCourseId: string,
  rawSearch: unknown,
  rawCursor?: unknown,
): Promise<{ courses: Array<{ id: string; display_name: string }>; has_more: boolean; next_cursor: string | null }> {
  const search = normalizeSearch(rawSearch);
  // This chooser is intentionally capped server-side. It prevents a caller
  // from turning the modal into an unbounded course-list endpoint while the
  // keyset cursor preserves stable performance for large tenants.
  const pageSize = 10;
  const cursor = decodeCursor(rawCursor);
  const result = await query<{ id: string; display_name: string }>(
    `SELECT id, display_name
       FROM courses
      WHERE tenant_id = $1::uuid AND id <> $2 AND deleted_at IS NULL
        AND ($3 = '' OR display_name ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL OR (display_name, id) > ($4::text, $5::text))
      ORDER BY display_name ASC, id ASC
      LIMIT $6::integer`,
    [tenantId, sourceCourseId, search, cursor?.displayName ?? null, cursor?.id ?? null, pageSize + 1],
  );
  const courses = result.rows.slice(0, pageSize);
  return {
    courses,
    has_more: result.rows.length > pageSize,
    next_cursor: result.rows.length > pageSize && courses.at(-1) ? encodeCursor(courses.at(-1)!) : null,
  };
}

async function resolveTransferSourceBlockType(tenantId: string, sourceBlockId: string): Promise<string> {
  assertUuid(sourceBlockId, 'Nội dung nguồn');
  const result = await query<{ block_type: string }>(
    `SELECT block.block_type
       FROM course_blocks block
       JOIN courses course ON course.id = block.course_id
      WHERE block.id = $1::uuid AND course.tenant_id = $2::uuid
        AND block.deleted_at IS NULL AND course.deleted_at IS NULL`,
    [sourceBlockId, tenantId],
  );
  const blockType = result.rows[0]?.block_type;
  if (!blockType || !isTransferableBlockType(blockType)) {
    throw new AppError('Nội dung nguồn không hợp lệ.', 404);
  }
  return blockType;
}

async function assertDestinationPath(
  tenantId: string,
  destinationCourseId: string,
  sourceBlockType: string,
  rawPath: unknown,
  destinationParentId: string,
): Promise<void> {
  const path = normalizeDestinationPath(rawPath);
  const expectedTypes = destinationPathTypes(sourceBlockType);

  if (expectedTypes.length === 0) {
    if (path.length !== 0 || destinationParentId !== destinationCourseId) {
      throw new AppError('Vị trí nhận nội dung không phù hợp.', 400);
    }
    return;
  }

  if (path.length !== expectedTypes.length || destinationParentId !== path.at(-1)) {
    throw new AppError('Hãy chọn đầy đủ vị trí nhận nội dung theo cấu trúc khóa học.', 400);
  }

  const result = await query<Array<Pick<BlockRow, 'id' | 'course_id' | 'parent_id' | 'block_type'>>[number] & { parent_block_type: string | null; parent_parent_id: string | null }>(
    `SELECT block.id, block.course_id, block.parent_id, block.block_type,
            parent.block_type AS parent_block_type, parent.parent_id AS parent_parent_id
       FROM course_blocks block
       JOIN courses course ON course.id = block.course_id
       LEFT JOIN course_blocks parent ON parent.id = block.parent_id AND parent.deleted_at IS NULL
      WHERE block.id = ANY($1::uuid[])
        AND block.course_id = $2 AND course.tenant_id = $3::uuid
        AND block.deleted_at IS NULL AND course.deleted_at IS NULL
      ORDER BY array_position($1::uuid[], block.id)`,
    [path, destinationCourseId, tenantId],
  );
  if (result.rows.length !== path.length) {
    throw new AppError('Một vị trí nhận nội dung không còn hợp lệ. Hãy chọn lại.', 409);
  }

  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index];
    if (row.block_type !== expectedTypes[index]) {
      throw new AppError('Cấu trúc vị trí nhận nội dung không phù hợp.', 400);
    }
    if (index === 0) {
      const attachedToCourseRoot = row.parent_block_type === 'course' && row.parent_parent_id === null;
      if (row.parent_id !== null && !attachedToCourseRoot) {
        throw new AppError('Chương nhận nội dung không thuộc gốc của khóa học.', 400);
      }
    } else if (row.parent_id !== path[index - 1]) {
      throw new AppError('Vị trí nhận nội dung không thuộc đúng cấu trúc đã chọn.', 400);
    }
  }
}

export async function listTransferDestinationOptions(
  tenantId: string,
  sourceBlockId: string,
  destinationCourseId: string,
  rawPath: unknown,
  rawSearch: unknown,
  rawPageSize: unknown,
  rawCursor?: unknown,
): Promise<CourseOutlineTransferDestinationOptions> {
  const sourceBlockType = await resolveTransferSourceBlockType(tenantId, sourceBlockId);
  const path = normalizeDestinationPath(rawPath);
  const expectedTypes = destinationPathTypes(sourceBlockType);
  if (path.length > expectedTypes.length) {
    throw new AppError('Đường dẫn vị trí nhận nội dung không hợp lệ.', 400);
  }

  await assertCourseBelongsToTenant(destinationCourseId, tenantId, 'Khóa học nhận nội dung không còn hợp lệ.');

  if (path.length === expectedTypes.length) {
    await assertDestinationPath(tenantId, destinationCourseId, sourceBlockType, path, path.at(-1) || destinationCourseId);
    return { source_block_type: sourceBlockType, next_level: 'complete', options: [], has_more: false, next_cursor: null };
  }

  if (path.length > 0) {
    // Validate every previously selected ancestor before exposing its children.
    // This prevents a client from traversing another course or a fabricated tree.
    const partialTypes = expectedTypes.slice(0, path.length);
    const rows = await query<Array<Pick<BlockRow, 'id' | 'parent_id' | 'block_type'>>[number] & { parent_block_type: string | null; parent_parent_id: string | null }>(
      `SELECT block.id, block.parent_id, block.block_type,
              parent.block_type AS parent_block_type, parent.parent_id AS parent_parent_id
         FROM course_blocks block
         JOIN courses course ON course.id = block.course_id
         LEFT JOIN course_blocks parent ON parent.id = block.parent_id AND parent.deleted_at IS NULL
        WHERE block.id = ANY($1::uuid[])
          AND block.course_id = $2 AND course.tenant_id = $3::uuid
          AND block.deleted_at IS NULL AND course.deleted_at IS NULL
        ORDER BY array_position($1::uuid[], block.id)`,
      [path, destinationCourseId, tenantId],
    );
    if (rows.rows.length !== path.length) throw new AppError('Vị trí nhận nội dung không còn hợp lệ. Hãy chọn lại.', 409);
    rows.rows.forEach((row, index) => {
      if (row.block_type !== partialTypes[index]) throw new AppError('Cấu trúc vị trí nhận nội dung không phù hợp.', 400);
      if (index === 0) {
        const attachedToCourseRoot = row.parent_block_type === 'course' && row.parent_parent_id === null;
        if (row.parent_id !== null && !attachedToCourseRoot) throw new AppError('Chương nhận nội dung không thuộc gốc của khóa học.', 400);
      } else if (row.parent_id !== path[index - 1]) {
        throw new AppError('Vị trí nhận nội dung không thuộc đúng cấu trúc đã chọn.', 400);
      }
    });
  }

  const nextLevel = expectedTypes[path.length];
  const search = normalizeSearch(rawSearch);
  const pageSize = normalizePage(rawPageSize, 25);
  const cursor = decodeCursor(rawCursor);
  const parentId = path.at(-1) || null;
  const result = await query<{ id: string; display_name: string; block_type: string }>(
    `SELECT block.id, block.display_name, block.block_type
       FROM course_blocks block
       JOIN courses course ON course.id = block.course_id
      WHERE block.course_id = $1 AND course.tenant_id = $2::uuid AND course.deleted_at IS NULL
        AND block.deleted_at IS NULL AND block.block_type = $3
        AND (
          ($4::uuid IS NOT NULL AND block.parent_id = $4::uuid)
          OR (
            $4::uuid IS NULL AND (
              block.parent_id IS NULL OR EXISTS (
                SELECT 1
                  FROM course_blocks root
                 WHERE root.id = block.parent_id AND root.course_id = block.course_id
                   AND root.block_type = 'course' AND root.parent_id IS NULL AND root.deleted_at IS NULL
              )
            )
          )
        )
        AND ($5 = '' OR block.display_name ILIKE '%' || $5 || '%')
        AND ($6::text IS NULL OR (block.display_name, block.id) > ($6::text, $7::uuid))
      ORDER BY block.display_name ASC, block.id ASC
      LIMIT $8::integer`,
    [destinationCourseId, tenantId, nextLevel, parentId, search, cursor?.displayName ?? null, cursor?.id ?? null, pageSize + 1],
  );
  const options = result.rows.slice(0, pageSize);
  return {
    source_block_type: sourceBlockType,
    next_level: nextLevel,
    options,
    has_more: result.rows.length > pageSize,
    next_cursor: result.rows.length > pageSize && options.at(-1) ? encodeCursor(options.at(-1)!) : null,
  };
}

export async function listTransferDestinationParents(
  tenantId: string,
  destinationCourseId: string,
  sourceBlockType: string,
  rawSearch: unknown,
  rawPageSize: unknown,
): Promise<Array<{ id: string; display_name: string; block_type: string }>> {
  const parentType = expectedDestinationParentType(sourceBlockType);
  const search = normalizeSearch(rawSearch);
  const pageSize = normalizePage(rawPageSize, 30);
  // A few old courses are represented with an implicit root in the outline
  // response. Treat the destination course itself as a virtual root here;
  // requestCourseOutlineTransfer materialises/reparents it atomically only
  // after the operator confirms the transfer.
  if (parentType === 'course') {
    const course = await query<{ id: string; display_name: string }>(
      `SELECT id, display_name
         FROM courses
        WHERE id = $1 AND tenant_id = $2::uuid AND deleted_at IS NULL`,
      [destinationCourseId, tenantId],
    );
    return course.rows.map((row) => ({ ...row, block_type: 'course' }));
  }
  const result = await query<{ id: string; display_name: string; block_type: string }>(
    `SELECT block.id, block.display_name, block.block_type
       FROM course_blocks block
       JOIN courses course ON course.id = block.course_id
      WHERE block.course_id = $1 AND course.tenant_id = $2::uuid AND course.deleted_at IS NULL
        AND block.deleted_at IS NULL AND block.block_type = $3
        AND ($4 = '' OR block.display_name ILIKE '%' || $4 || '%')
      ORDER BY block.sort_order ASC, block.display_name ASC, block.id ASC
      LIMIT $5::integer`,
    [destinationCourseId, tenantId, parentType, search, pageSize],
  );
  return result.rows;
}

async function getOrCreateDestinationCourseRoot(
  tenantId: string,
  destinationCourseId: string,
): Promise<BlockRow> {
  const existing = await query<BlockRow>(
    `SELECT block.id, block.course_id, block.parent_id, block.block_type, block.display_name,
            block.updated_at, block.deleted_at, block.delete_status
       FROM course_blocks block
       JOIN courses course ON course.id = block.course_id
      WHERE block.course_id = $1 AND course.tenant_id = $2::uuid
        AND course.deleted_at IS NULL AND block.parent_id IS NULL
        AND block.block_type = 'course' AND block.deleted_at IS NULL
      ORDER BY block.created_at ASC
      LIMIT 1
      FOR UPDATE OF block`,
    [destinationCourseId, tenantId],
  );
  if (existing.rows[0]) return existing.rows[0];

  const course = await query<CourseRow>(
    `SELECT id, display_name, tenant_id, deleted_at
       FROM courses
      WHERE id = $1 AND tenant_id = $2::uuid AND deleted_at IS NULL
      FOR UPDATE`,
    [destinationCourseId, tenantId],
  );
  if (!course.rows[0]) throw new AppError('Khóa học nhận nội dung không còn hợp lệ.', 409);
  const created = await query<BlockRow>(
    `INSERT INTO course_blocks (
       course_id, parent_id, block_type, display_name, data, metadata, sort_order,
       is_published, has_draft_changes
     ) VALUES ($1, NULL, 'course', $2, '{}'::jsonb, '{}'::jsonb, 0, true, true)
     RETURNING id, course_id, parent_id, block_type, display_name, updated_at, deleted_at, delete_status`,
    [destinationCourseId, course.rows[0].display_name],
  );
  const root = created.rows[0];
  if (!root) throw new AppError('Không thể chuẩn bị vị trí nhận nội dung.', 500);
  // Preserve legacy outlines exactly while turning their synthesized root
  // into a durable one. No records are duplicated or discarded.
  await query(
    `UPDATE course_blocks
        SET parent_id = $2::uuid, has_draft_changes = true, updated_at = now()
      WHERE course_id = $1 AND parent_id IS NULL AND id <> $2::uuid AND deleted_at IS NULL`,
    [destinationCourseId, root.id],
  );
  return root;
}

export async function requestCourseOutlineTransfer(input: {
  tenantId: string;
  requestedBy: string;
  requestedUsername?: string | null;
  requestedIp?: string | null;
  sourceBlockId: string;
  destinationCourseId: string;
  destinationParentId: string;
  destinationPathIds?: unknown;
  operation: CourseOutlineTransferOperation;
  idempotencyKey: string;
}): Promise<CourseOutlineTransferJob> {
  await assertTransferSchemaReady();
  assertUuid(input.sourceBlockId, 'Nội dung nguồn');
  assertUuid(input.idempotencyKey, 'Mã yêu cầu');
  if (input.operation !== 'duplicate') throw new AppError(MOVE_OPERATION_DISABLED_MESSAGE, 400);

  return withDatabaseTransaction(async () => {
    const lockKeys = [input.sourceBlockId, input.destinationParentId].sort();
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 20260916))`, [lockKeys[0]]);
    if (lockKeys[1] !== lockKeys[0]) {
      await query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 20260916))`, [lockKeys[1]]);
    }
    const sourceResult = await query<BlockRow>(
      `SELECT b.id, b.course_id, b.parent_id, b.block_type, b.display_name, b.updated_at, b.deleted_at, b.delete_status
         FROM course_blocks b
         JOIN courses c ON c.id = b.course_id
        WHERE b.id = $1::uuid AND c.tenant_id = $2::uuid
          AND b.deleted_at IS NULL AND c.deleted_at IS NULL
        FOR UPDATE OF b`,
      [input.sourceBlockId, input.tenantId],
    );
    const source = sourceResult.rows[0];
    if (!source || !isTransferableBlockType(source.block_type)) throw new AppError('Nội dung nguồn không hợp lệ.', 404);
    if (source.delete_status && source.delete_status !== 'active') throw new AppError('Nội dung nguồn đang được xử lý xóa.', 409);
    if (source.course_id === input.destinationCourseId) throw new AppError('Hãy chọn một khóa học khác để chuyển hoặc nhân bản nội dung.', 400);

    const existing = await query<CourseOutlineTransferJob>(
      `SELECT id, operation, status, source_course_id, source_block_id, destination_course_id, destination_parent_id,
              source_block_name, source_block_type, attempts, max_attempts, block_count, asset_count,
              total_asset_bytes::text, copied_asset_bytes::text, last_error, created_at::text,
              started_at::text, next_attempt_at::text, completed_at::text
         FROM course_outline_transfer_jobs
        WHERE tenant_id = $1::uuid AND requested_by = $2::uuid AND idempotency_key = $3::uuid
        LIMIT 1`,
      [input.tenantId, input.requestedBy, input.idempotencyKey],
    );
    if (existing.rows[0]) return existing.rows[0];

    const virtualCourseRoot = source.block_type === 'chapter' && input.destinationParentId === input.destinationCourseId;
    if (!virtualCourseRoot) assertUuid(input.destinationParentId, 'Vị trí nhận nội dung');
    await assertDestinationPath(
      input.tenantId,
      input.destinationCourseId,
      source.block_type,
      input.destinationPathIds,
      input.destinationParentId,
    );
    const destinationParentId = virtualCourseRoot
      ? (await getOrCreateDestinationCourseRoot(input.tenantId, input.destinationCourseId)).id
      : input.destinationParentId;
    const destinationResult = await query<BlockRow>(
      `SELECT b.id, b.course_id, b.parent_id, b.block_type, b.display_name, b.updated_at, b.deleted_at, b.delete_status
         FROM course_blocks b
         JOIN courses c ON c.id = b.course_id
        WHERE b.id = $1::uuid AND b.course_id = $2 AND c.tenant_id = $3::uuid
          AND b.deleted_at IS NULL AND c.deleted_at IS NULL
        FOR UPDATE OF b`,
      [destinationParentId, input.destinationCourseId, input.tenantId],
    );
    const destination = destinationResult.rows[0];
    if (!destination || destination.block_type !== expectedDestinationParentType(source.block_type)) {
      throw new AppError('Vị trí nhận nội dung không phù hợp.', 400);
    }

    const blockCount = await query<{ count: string }>(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM course_blocks WHERE id = $1::uuid AND course_id = $2 AND deleted_at IS NULL
         UNION ALL
         SELECT child.id FROM course_blocks child JOIN subtree parent ON parent.id = child.parent_id
          WHERE child.course_id = $2 AND child.deleted_at IS NULL
       ) SELECT COUNT(*)::text AS count FROM subtree`,
      [source.id, source.course_id],
    );

    const created = await query<CourseOutlineTransferJob>(
      `INSERT INTO course_outline_transfer_jobs (
         tenant_id, source_course_id, source_block_id, destination_course_id, destination_parent_id,
         operation, requested_by, requested_username, requested_ip, idempotency_key,
         source_block_name, source_block_type, source_root_updated_at, destination_parent_updated_at,
         block_count, status
       ) VALUES (
         $1::uuid, $2, $3::uuid, $4, $5::uuid, $6, $7::uuid, $8, $9, $10::uuid,
         $11, $12, $13, $14, $15::integer, 'queued'
       )
        RETURNING id, operation, status, source_course_id, source_block_id, destination_course_id, destination_parent_id,
                  source_block_name, source_block_type, attempts, max_attempts, block_count, asset_count,
                  total_asset_bytes::text, copied_asset_bytes::text, last_error, created_at::text,
                  started_at::text, next_attempt_at::text, completed_at::text`,
      [
        input.tenantId, source.course_id, source.id, input.destinationCourseId, destinationParentId,
        input.operation, input.requestedBy, input.requestedUsername || null, input.requestedIp || null,
        input.idempotencyKey, source.display_name, source.block_type, source.updated_at, destination.updated_at,
        Number(blockCount.rows[0]?.count || 0),
      ],
    );
    return created.rows[0];
  });
}

export async function getCourseOutlineTransferJob(tenantId: string, jobId: string): Promise<CourseOutlineTransferJob> {
  assertUuid(jobId, 'Mã yêu cầu');
  const result = await query<CourseOutlineTransferJob>(
    `SELECT id, operation, status, source_course_id, source_block_id, destination_course_id, destination_parent_id,
            source_block_name, source_block_type, attempts, max_attempts, block_count, asset_count,
            total_asset_bytes::text, copied_asset_bytes::text, last_error, created_at::text,
            started_at::text, next_attempt_at::text, completed_at::text
       FROM course_outline_transfer_jobs
      WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [jobId, tenantId],
  );
  if (!result.rows[0]) throw new AppError('Không tìm thấy yêu cầu chuyển nội dung.', 404);
  return result.rows[0];
}
