// ═══════════════════════════════════════════════════════════════
// Course outline transfer jobs, the worker side: claim one due job with a
// lease, prepare and copy its Storage assets (renewing the lease around each
// copy), write the duplicate in one transaction, and mark a failed attempt
// for retry or as terminal (max_attempts) with the copied Storage cleanup.
// Run by src/workers/course-outline-transfer.worker.ts. Moved unchanged from
// course-outline-transfer.service.ts, which still re-exports the entry points.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { query, withDatabaseTransaction } from '../../config/database.js';
import { runtimeTenantSql } from '../../config/runtime-tenant-fence.js';
import {
  invalidateBlockReadCaches,
  invalidateCourseReadCaches,
} from '../../config/cache-invalidation.js';
import { buildStoragePath, downloadFileBuffer, getPublicUrl, uploadFile, deleteFiles } from '../../config/storage.js';
import { AppError } from '../../utils/errors.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { COURSE_AUTHOR_NOTES_KEY } from './course-author-notes.logic.js';
import {
  MOVE_OPERATION_DISABLED_MESSAGE,
  asNumber,
  collectReferencedAssetPaths,
  expectedDestinationParentType,
  isTransferableBlockType,
  normalizeCourseOutlineTransferStoragePath,
  safeTransferFailureMessage,
} from './course-outline-transfer.logic.js';
import type {
  BlockRow,
  CourseOutlineTransferStatus,
  CourseRow,
  PayloadRow,
  TransferAssetRow,
  TransferJobRow,
} from './course-outline-transfer.types.js';

const JOB_LEASE_SECONDS = 15 * 60;
const TRANSFER_ASSET_BATCH_CONCURRENCY = 2;

export async function assertTransferSchemaReady(): Promise<void> {
  const result = await query<{ jobs: string | null; assets: string | null; maps: string | null; rewrite: string | null }>(
    `SELECT to_regclass('public.course_outline_transfer_jobs')::text AS jobs,
            to_regclass('public.course_outline_transfer_job_assets')::text AS assets,
            to_regclass('public.course_outline_transfer_block_maps')::text AS maps,
            to_regprocedure('public.course_outline_transfer_rewrite_jsonb(jsonb,uuid)')::text AS rewrite`,
  );
  const row = result.rows[0];
  if (!row?.jobs || !row.assets || !row.maps || !row.rewrite) {
    throw new AppError('Tính năng chuyển nội dung chưa sẵn sàng. Quản trị viên cần chạy bản cập nhật hệ thống đã được phê duyệt.', 503);
  }
}

async function getSubtreePayloadRows(sourceBlockId: string, sourceCourseId: string): Promise<PayloadRow[]> {
  const result = await query<PayloadRow>(
    `WITH RECURSIVE subtree AS (
       SELECT id, data, metadata, published_data, published_metadata
       FROM course_blocks
       WHERE id = $1::uuid AND course_id = $2 AND deleted_at IS NULL
       UNION ALL
       SELECT child.id, child.data, child.metadata, child.published_data, child.published_metadata
       FROM course_blocks child
       JOIN subtree parent ON parent.id = child.parent_id
       WHERE child.course_id = $2 AND child.deleted_at IS NULL
     )
     SELECT id, data, metadata, published_data, published_metadata
     FROM subtree`,
    [sourceBlockId, sourceCourseId],
  );
  return result.rows;
}

async function prepareTransferAssets(job: TransferJobRow): Promise<void> {
  const alreadyPrepared = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM course_outline_transfer_job_assets
      WHERE job_id = $1::uuid AND tenant_id = $2::uuid`,
    [job.id, job.tenant_id],
  );
  if (Number(alreadyPrepared.rows[0]?.count || 0) > 0 || job.asset_count > 0) return;

  const payloadRows = await getSubtreePayloadRows(job.source_block_id, job.source_course_id);
  if (payloadRows.length === 0) throw new AppError('Nội dung nguồn không còn tồn tại hoặc đã bị xóa.', 409);
  const referencedPaths = collectReferencedAssetPaths(payloadRows, job.tenant_id);

  const assetResult = await query<{
    id: string; storage_path: string | null; url: string | null; display_name: string;
    content_type: string | null; file_size: string | number | null;
  }>(
    `SELECT id, storage_path, url, display_name, content_type, file_size
       FROM course_assets
      WHERE tenant_id = $1::uuid AND course_id = $2`,
    [job.tenant_id, job.source_course_id],
  );

  const assetByPath = new Map<string, typeof assetResult.rows[number]>();
  for (const asset of assetResult.rows) {
    const path = normalizeCourseOutlineTransferStoragePath(asset.storage_path)
      || normalizeCourseOutlineTransferStoragePath(asset.url);
    if (path) assetByPath.set(path, asset);
  }

  const referencedAssets = [...referencedPaths].map((path) => {
    const asset = assetByPath.get(path);
    if (!asset) {
      throw new AppError('Không thể chuyển nội dung vì có tệp nguồn không còn thuộc khóa học. Hãy tải lại hoặc xóa liên kết tệp này trước.', 409);
    }
    return { ...asset, source_path: path };
  });

  await withDatabaseTransaction(async () => {
    const root = await query<{ id: string; updated_at: Date }>(
      `SELECT id, updated_at
         FROM course_blocks
        WHERE id = $1::uuid AND course_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [job.source_block_id, job.source_course_id],
    );
    if (root.rowCount === 0 || root.rows[0].updated_at.getTime() !== new Date(job.source_root_updated_at).getTime()) {
      throw new AppError('Nội dung nguồn vừa thay đổi. Hãy tải lại rồi thực hiện lại.', 409);
    }

    for (const asset of referencedAssets) {
      const fileName = asset.source_path.split('/').pop() || `${asset.id}.bin`;
      const targetPath = job.operation === 'move'
        ? asset.source_path
        : buildStoragePath(
          job.tenant_id,
          'courses',
          `${asset.id}-${fileName}`,
          `${job.destination_course_id}/outline-transfers/${job.id}`,
        );
      await query(
        `INSERT INTO course_outline_transfer_job_assets (
           job_id, tenant_id, source_asset_id, source_storage_path, target_storage_path,
           display_name, content_type, file_size, source_url, target_url, status
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::bigint, $9, $10, 'queued')
         ON CONFLICT (job_id, source_asset_id) DO NOTHING`,
        [
          job.id, job.tenant_id, asset.id, asset.source_path, targetPath,
          asset.display_name, asset.content_type, asNumber(asset.file_size), asset.url,
          job.operation === 'move' ? asset.url : getPublicUrl(targetPath),
        ],
      );
    }

    const totalBytes = referencedAssets.reduce((sum, asset) => sum + asNumber(asset.file_size), 0);
    await query(
      `UPDATE course_outline_transfer_jobs
          SET asset_count = $2::integer,
              total_asset_bytes = $3::bigint,
              updated_at = now()
        WHERE id = $1::uuid`,
      [job.id, referencedAssets.length, totalBytes],
    );
  });
}

async function copyAssetsForDuplicate(job: TransferJobRow): Promise<void> {
  const assets = await query<TransferAssetRow>(
    `SELECT id, job_id, tenant_id, source_asset_id, source_storage_path, target_storage_path,
            display_name, content_type, file_size, source_url, target_url, status
       FROM course_outline_transfer_job_assets
      WHERE job_id = $1::uuid AND tenant_id = $2::uuid AND status <> 'copied'
      ORDER BY id`,
    [job.id, job.tenant_id],
  );
  for (let index = 0; index < assets.rows.length; index += TRANSFER_ASSET_BATCH_CONCURRENCY) {
    const batch = assets.rows.slice(index, index + TRANSFER_ASSET_BATCH_CONCURRENCY);
    await Promise.all(batch.map(async (asset) => {
      await renewJobLease(job);
      const source = await downloadFileBuffer(asset.source_storage_path);
      await uploadFile(
        asset.target_storage_path,
        source.buffer,
        asset.content_type || source.contentType || 'application/octet-stream',
        true,
      );
      await query(
        `UPDATE course_outline_transfer_job_assets
            SET status = 'copied', copied_at = now(), updated_at = now()
          WHERE id = $1::uuid AND job_id = $2::uuid AND tenant_id = $3::uuid`,
        [asset.id, job.id, job.tenant_id],
      );
      await renewJobLease(job);
    }));
  }
}

async function renewJobLease(job: TransferJobRow): Promise<void> {
  const result = await query<{ id: string }>(
    `UPDATE course_outline_transfer_jobs
        SET lease_expires_at = now() + ($3::integer * interval '1 second'), updated_at = now()
      WHERE id = $1::uuid AND status = 'running' AND lease_token = $2::uuid
      RETURNING id`,
    [job.id, job.lease_token, JOB_LEASE_SECONDS],
  );
  if (!result.rows[0]) throw new AppError('Yêu cầu chuyển nội dung đã được một worker khác tiếp quản.', 409);
}

async function assertOwnedJobLease(job: TransferJobRow): Promise<void> {
  const result = await query<{ id: string }>(
    `SELECT id
       FROM course_outline_transfer_jobs
      WHERE id = $1::uuid AND status = 'running' AND lease_token = $2::uuid
        AND lease_expires_at > now()
      FOR UPDATE`,
    [job.id, job.lease_token],
  );
  if (!result.rows[0]) throw new AppError('Yêu cầu chuyển nội dung đã được một worker khác tiếp quản.', 409);
}

async function assertCoursesAreSafeToMove(job: TransferJobRow): Promise<void> {
  const learnerState = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
         FROM enrollments
        WHERE course_id = ANY($1::varchar[])
          AND COALESCE(is_active, true) = true
       UNION ALL
       SELECT 1
         FROM course_progress progress
         JOIN enrollments enrollment ON enrollment.id = progress.enrollment_id
        WHERE enrollment.course_id = ANY($1::varchar[])
     ) AS exists`,
    [[job.source_course_id, job.destination_course_id]],
  );
  if (learnerState.rows[0]?.exists) {
    throw new AppError('Không thể chuyển nội dung khi một trong hai khóa học đang có học viên. Hãy dùng Nhân bản để giữ an toàn cho tiến độ học.', 409);
  }
}

async function lockAndValidateTransfer(job: TransferJobRow): Promise<{ source: BlockRow; destination: BlockRow; sourceCourse: CourseRow; destinationCourse: CourseRow }> {
  // Stable transaction locks prevent two operators from deadlocking by
  // requesting A → B and B → A at the same time.
  const lockKeys = [job.source_block_id, job.destination_parent_id].sort();
  await query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 20260916))`, [lockKeys[0]]);
  if (lockKeys[1] !== lockKeys[0]) {
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 20260916))`, [lockKeys[1]]);
  }
  const sourceResult = await query<BlockRow>(
    `SELECT b.id, b.course_id, b.parent_id, b.block_type, b.display_name, b.updated_at, b.deleted_at, b.delete_status
       FROM course_blocks b
       JOIN courses c ON c.id = b.course_id
      WHERE b.id = $1::uuid AND b.course_id = $2 AND c.tenant_id = $3::uuid
        AND b.deleted_at IS NULL AND c.deleted_at IS NULL
      FOR UPDATE OF b`,
    [job.source_block_id, job.source_course_id, job.tenant_id],
  );
  const destinationResult = await query<BlockRow>(
    `SELECT b.id, b.course_id, b.parent_id, b.block_type, b.display_name, b.updated_at, b.deleted_at, b.delete_status
       FROM course_blocks b
       JOIN courses c ON c.id = b.course_id
      WHERE b.id = $1::uuid AND b.course_id = $2 AND c.tenant_id = $3::uuid
        AND b.deleted_at IS NULL AND c.deleted_at IS NULL
      FOR UPDATE OF b`,
    [job.destination_parent_id, job.destination_course_id, job.tenant_id],
  );
  const courses = await query<CourseRow>(
    `SELECT id, display_name, tenant_id, deleted_at
       FROM courses
      WHERE id = ANY($1::varchar[]) AND tenant_id = $2::uuid AND deleted_at IS NULL
      FOR UPDATE`,
    [[job.source_course_id, job.destination_course_id], job.tenant_id],
  );
  const source = sourceResult.rows[0];
  const destination = destinationResult.rows[0];
  const sourceCourse = courses.rows.find((row) => row.id === job.source_course_id);
  const destinationCourse = courses.rows.find((row) => row.id === job.destination_course_id);
  if (!source || !destination || !sourceCourse || !destinationCourse) {
    throw new AppError('Khóa học hoặc vị trí nhận nội dung không còn hợp lệ.', 409);
  }
  if (source.updated_at.getTime() !== new Date(job.source_root_updated_at).getTime()) {
    throw new AppError('Nội dung nguồn vừa thay đổi. Hãy tải lại rồi thực hiện lại.', 409);
  }
  if (destination.updated_at.getTime() !== new Date(job.destination_parent_updated_at).getTime()) {
    throw new AppError('Vị trí nhận nội dung vừa thay đổi. Hãy tải lại rồi thực hiện lại.', 409);
  }
  if (source.block_type !== job.source_block_type || !isTransferableBlockType(source.block_type)) {
    throw new AppError('Loại nội dung nguồn không thể chuyển.', 409);
  }
  if (destination.block_type !== expectedDestinationParentType(source.block_type)) {
    throw new AppError('Vị trí nhận không phù hợp với loại nội dung đang chọn.', 409);
  }
  return { source, destination, sourceCourse, destinationCourse };
}

function transferAuditEntry(job: TransferJobRow, destinationCourseName: string): TransactionalAuditEntry {
  return {
    tenantId: job.tenant_id,
    actorId: job.requested_by,
    actorUsername: job.requested_username || undefined,
    action: job.operation === 'move' ? 'UPDATE' : 'CREATE',
    // `audit_entity_type` is a PostgreSQL enum. The transfer itself is a
    // durable job rather than a domain entity, so record the actual source
    // outline block under the existing, supported enum value. The event code
    // and structured context still distinguish duplicate from move precisely.
    entityType: 'course_block',
    entityId: job.source_block_id,
    entityName: job.source_block_name,
    ipAddress: job.requested_ip || undefined,
    event: {
      code: job.operation === 'move' ? 'course.outline.moved' : 'course.outline.duplicated',
      context: {
        course_id: job.destination_course_id,
        course_name: destinationCourseName,
        related_entity_name: job.source_block_name,
        related_entity_type: job.source_block_type,
        component_type: job.source_block_type,
        affected_count: job.block_count,
        file_count: job.asset_count,
      },
    },
  };
}

async function finishMove(job: TransferJobRow): Promise<void> {
  await withDatabaseTransaction(async (client) => {
    await assertOwnedJobLease(job);
    const { source, destination, sourceCourse, destinationCourse } = await lockAndValidateTransfer(job);
    // The course rows are now locked FOR UPDATE. A concurrent enrollment that
    // references either course must wait, so this check cannot race a new
    // learner/progress record between validation and the structural move.
    await assertCoursesAreSafeToMove(job);
    const nextOrder = await query<{ next_order: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
         FROM course_blocks
        WHERE course_id = $1 AND parent_id = $2::uuid AND deleted_at IS NULL`,
      [job.destination_course_id, job.destination_parent_id],
    );
    const sourceParentId = source.parent_id;

    await query(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM course_blocks WHERE id = $1::uuid AND course_id = $2 AND deleted_at IS NULL
         UNION ALL
         SELECT child.id FROM course_blocks child JOIN subtree parent ON parent.id = child.parent_id
          WHERE child.course_id = $2 AND child.deleted_at IS NULL
       )
       UPDATE course_blocks block
          SET course_id = $3,
              is_published = false,
              has_draft_changes = true,
              published_data = NULL,
              published_metadata = NULL,
              updated_at = now()
        WHERE block.id IN (SELECT id FROM subtree)`,
      [job.source_block_id, job.source_course_id, job.destination_course_id],
    );
    await query(
      `UPDATE course_blocks
          SET parent_id = $2::uuid, sort_order = $3::integer, updated_at = now()
        WHERE id = $1::uuid AND course_id = $4`,
      [job.source_block_id, job.destination_parent_id, nextOrder.rows[0]?.next_order ?? 0, job.destination_course_id],
    );
    await query(
      `UPDATE course_assets
          SET course_id = $3,
              -- Make the durable object key explicit. This lets the deletion
              -- manifest protect an asset that remains under its former
              -- course prefix after a quota-neutral move.
              storage_path = transfer_asset.source_storage_path
         FROM course_outline_transfer_job_assets transfer_asset
        WHERE course_assets.tenant_id = $1::uuid
          AND course_assets.course_id = $2
          AND transfer_asset.job_id = $4::uuid
          AND transfer_asset.tenant_id = $1::uuid
          AND course_assets.id = transfer_asset.source_asset_id`,
      [job.tenant_id, job.source_course_id, job.destination_course_id, job.id],
    );
    if (sourceParentId) {
      await query(
        `WITH RECURSIVE ancestors AS (
           SELECT id, parent_id FROM course_blocks WHERE id = $1::uuid AND course_id = $2 AND deleted_at IS NULL
           UNION ALL
           SELECT parent.id, parent.parent_id FROM course_blocks parent JOIN ancestors child ON child.parent_id = parent.id
            WHERE parent.course_id = $2 AND parent.deleted_at IS NULL
         )
         UPDATE course_blocks SET has_draft_changes = true, updated_at = now()
          WHERE id IN (SELECT id FROM ancestors)`,
        [sourceParentId, job.source_course_id],
      );
    }
    await query(
      `UPDATE course_outline_transfer_jobs
          SET status = 'succeeded', lease_token = NULL, lease_expires_at = NULL,
              completed_at = now(), last_error = NULL, updated_at = now()
        WHERE id = $1::uuid AND status = 'running' AND lease_token = $2::uuid`,
      [job.id, job.lease_token],
    );
    await query(`DELETE FROM course_outline_transfer_job_assets WHERE job_id = $1::uuid`, [job.id]);
    await appendAuditLog(client, transferAuditEntry(job, destinationCourse.display_name));
    void sourceCourse;
  });
  await Promise.all([
    invalidateCourseReadCaches(job.source_course_id, job.tenant_id),
    invalidateCourseReadCaches(job.destination_course_id, job.tenant_id),
    invalidateBlockReadCaches([job.source_block_id, job.destination_parent_id]),
  ]);
}

async function finishDuplicate(job: TransferJobRow): Promise<void> {
  const remaining = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM course_outline_transfer_job_assets
      WHERE job_id = $1::uuid AND tenant_id = $2::uuid AND status <> 'copied'`,
    [job.id, job.tenant_id],
  );
  if (Number(remaining.rows[0]?.count || 0) > 0) throw new AppError('Một số tệp vẫn đang được sao chép.', 409);

  await withDatabaseTransaction(async (client) => {
    await assertOwnedJobLease(job);
    const { destination, destinationCourse } = await lockAndValidateTransfer(job);
    const nextOrder = await query<{ next_order: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
         FROM course_blocks
        WHERE course_id = $1 AND parent_id = $2::uuid AND deleted_at IS NULL`,
      [job.destination_course_id, job.destination_parent_id],
    );

    await query(
      `WITH RECURSIVE subtree AS (
         SELECT id, parent_id FROM course_blocks WHERE id = $1::uuid AND course_id = $2 AND deleted_at IS NULL
         UNION ALL
         SELECT child.id, child.parent_id FROM course_blocks child JOIN subtree parent ON parent.id = child.parent_id
          WHERE child.course_id = $2 AND child.deleted_at IS NULL
       )
       INSERT INTO course_outline_transfer_block_maps (job_id, tenant_id, source_block_id, target_block_id)
       SELECT $3::uuid, $4::uuid, id, gen_random_uuid() FROM subtree
       ON CONFLICT (job_id, source_block_id) DO NOTHING`,
      [job.source_block_id, job.source_course_id, job.id, job.tenant_id],
    );
    await query(
      `WITH RECURSIVE subtree AS (
         SELECT id, parent_id, block_type, display_name, data, metadata, sort_order
           FROM course_blocks WHERE id = $1::uuid AND course_id = $2 AND deleted_at IS NULL
         UNION ALL
         SELECT child.id, child.parent_id, child.block_type, child.display_name, child.data, child.metadata, child.sort_order
           FROM course_blocks child JOIN subtree parent ON parent.id = child.parent_id
          WHERE child.course_id = $2 AND child.deleted_at IS NULL
       )
       INSERT INTO course_blocks (
         id, course_id, parent_id, block_type, display_name, data, metadata, sort_order,
         is_published, has_draft_changes, published_data, published_metadata, deleted_at, delete_status, created_at, updated_at
       )
       SELECT map.target_block_id,
              $3,
              CASE WHEN source.id = $1::uuid THEN $4::uuid ELSE parent_map.target_block_id END,
              source.block_type,
              source.display_name,
              public.course_outline_transfer_rewrite_jsonb(COALESCE(source.data, '{}'::jsonb), $5::uuid),
              -- AI ID author notes describe the SOURCE course's AI workspace;
              -- they are author-only and never travel to another course.
              public.course_outline_transfer_rewrite_jsonb(CASE WHEN jsonb_typeof(source.metadata) = 'object'
                THEN source.metadata - '${COURSE_AUTHOR_NOTES_KEY}' ELSE COALESCE(source.metadata, '{}'::jsonb) END, $5::uuid),
              CASE WHEN source.id = $1::uuid THEN $6::integer ELSE source.sort_order END,
              false, true, NULL, NULL, NULL, 'active', now(), now()
         FROM subtree source
         JOIN course_outline_transfer_block_maps map
           ON map.job_id = $5::uuid AND map.source_block_id = source.id
         LEFT JOIN course_outline_transfer_block_maps parent_map
           ON parent_map.job_id = $5::uuid AND parent_map.source_block_id = source.parent_id
       ON CONFLICT (id) DO NOTHING`,
      [
        job.source_block_id, job.source_course_id, job.destination_course_id,
        job.destination_parent_id, job.id, nextOrder.rows[0]?.next_order ?? 0,
      ],
    );
    await query(
      `INSERT INTO course_assets (
         course_id, tenant_id, display_name, content_type, file_size, storage_path, url, thumbnail_url,
         is_locked, is_reference, created_at
       )
       SELECT $2, asset.tenant_id, asset.display_name, asset.content_type, asset.file_size,
              asset.target_storage_path, asset.target_url, NULL, false, false, now()
         FROM course_outline_transfer_job_assets asset
        WHERE asset.job_id = $1::uuid AND asset.tenant_id = $3::uuid AND asset.status = 'copied'`,
      [job.id, job.destination_course_id, job.tenant_id],
    );
    await query(
      `UPDATE course_outline_transfer_jobs
          SET status = 'succeeded', lease_token = NULL, lease_expires_at = NULL,
              copied_asset_bytes = total_asset_bytes, completed_at = now(), last_error = NULL, updated_at = now()
        WHERE id = $1::uuid AND status = 'running' AND lease_token = $2::uuid`,
      [job.id, job.lease_token],
    );
    await query(`DELETE FROM course_outline_transfer_block_maps WHERE job_id = $1::uuid`, [job.id]);
    await query(`DELETE FROM course_outline_transfer_job_assets WHERE job_id = $1::uuid`, [job.id]);
    await appendAuditLog(client, transferAuditEntry(job, destinationCourse.display_name));
    void destination;
  });
  await Promise.all([
    invalidateCourseReadCaches(job.destination_course_id, job.tenant_id),
    invalidateBlockReadCaches([job.destination_parent_id]),
  ]);
}

async function cleanupFailedDuplicateAssets(jobId: string, tenantId: string): Promise<void> {
  const result = await query<{ target_storage_path: string }>(
    `SELECT target_storage_path FROM course_outline_transfer_job_assets
      WHERE job_id = $1::uuid AND tenant_id = $2::uuid AND status = 'copied'`,
    [jobId, tenantId],
  );
  if (result.rows.length === 0) return;
  await deleteFiles(result.rows.map((row) => row.target_storage_path));
}

function isTerminalTransferError(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  // A failed precondition (changed/deleted source, an invalid destination,
  // enrollment conflict, quota policy, etc.) cannot heal by retrying. Keep
  // retries exclusively for infrastructure/transient failures. A lease loss
  // is the one expected 409: another worker has ownership already.
  return !error.message.includes('worker khác tiếp quản');
}

async function markJobRetryable(job: TransferJobRow, error: unknown): Promise<void> {
  // last_error is returned to the operator, so it must never expose database,
  // Storage provider, object-key, or infrastructure details.
  const message = safeTransferFailureMessage(error).slice(0, 500);
  const terminal = isTerminalTransferError(error);
  const result = await query<{ status: CourseOutlineTransferStatus }>(
    `UPDATE course_outline_transfer_jobs
        SET status = CASE WHEN $4::boolean OR attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            lease_token = NULL,
            lease_expires_at = NULL,
            next_attempt_at = CASE
              WHEN $4::boolean OR attempts >= max_attempts THEN now()
              ELSE now() + (
                LEAST(30 * power(2::numeric, GREATEST(attempts - 1, 0)), 3600)
                * (0.75 + random() * 0.5)
              ) * interval '1 second'
            END,
            last_error = $2,
            updated_at = now()
      WHERE id = $1::uuid AND status = 'running' AND lease_token = $3::uuid
      RETURNING status`,
    [job.id, message, job.lease_token, terminal],
  );
  if (result.rows[0]?.status === 'failed' && job.operation === 'duplicate') {
    try {
      await cleanupFailedDuplicateAssets(job.id, job.tenant_id);
    } catch (cleanupError) {
      console.error(`[CourseOutlineTransfer] Could not clean copied Storage for terminal job ${job.id}:`, cleanupError);
    }
  }
}

async function claimNextJob(): Promise<TransferJobRow | null> {
  const leaseToken = randomUUID();
  const tenantFence = runtimeTenantSql('tenant_id', 3);
  const result = await query<TransferJobRow>(
    `WITH candidate AS (
       SELECT id
         FROM course_outline_transfer_jobs
        WHERE ((status = 'queued' AND next_attempt_at <= now())
           OR (status = 'running' AND lease_expires_at < now()))
          ${tenantFence.clause}
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE course_outline_transfer_jobs job
        SET status = 'running', attempts = attempts + 1, lease_token = $1::uuid,
            lease_expires_at = now() + ($2::integer * interval '1 second'),
            started_at = COALESCE(started_at, now()), updated_at = now()
       FROM candidate
      WHERE job.id = candidate.id
      RETURNING job.*`,
    [leaseToken, JOB_LEASE_SECONDS, ...tenantFence.params],
  );
  return result.rows[0] ?? null;
}

export async function processNextCourseOutlineTransferJob(): Promise<boolean> {
  const job = await claimNextJob();
  if (!job) return false;
  try {
    // Preserve the persisted union for historical jobs, but never execute a
    // structural move again. Queued legacy move jobs become terminal failures
    // before any course block or Storage data is touched.
    if (job.operation !== 'duplicate') {
      throw new AppError(MOVE_OPERATION_DISABLED_MESSAGE, 409);
    }
    await prepareTransferAssets(job);
    await copyAssetsForDuplicate(job);
    await finishDuplicate(job);
    console.log(`[CourseOutlineTransfer] ${job.operation} completed job=${job.id}`);
  } catch (error) {
    await markJobRetryable(job, error);
    console.error(`[CourseOutlineTransfer] ${job.operation} failed job=${job.id}:`, error);
  }
  return true;
}

export async function isCourseOutlineTransferSchemaReady(): Promise<boolean> {
  try {
    await assertTransferSchemaReady();
    return true;
  } catch {
    return false;
  }
}
