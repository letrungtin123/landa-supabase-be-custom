// ═══════════════════════════════════════════════════════════════
// Course outline transfer jobs
//
// A transfer is deliberately asynchronous. Copying an outline can involve a
// large, quota-metered Storage payload; keeping that work out of a request
// protects the API pool and makes retries idempotent. Every query below is
// tenant-scoped and the final write is serialised by row locks on both trees.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { query, withDatabaseTransaction } from '../../config/database.js';
import {
  invalidateBlockReadCaches,
  invalidateCourseReadCaches,
} from '../../config/cache-invalidation.js';
import { buildStoragePath, downloadFileBuffer, getPublicUrl, uploadFile, deleteFiles } from '../../config/storage.js';
import { AppError } from '../../middleware/error-handler.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import {
  TENANT_DATA_LIMIT_REACHED_MESSAGE,
  TENANT_DATA_LIMIT_REACHED_SQLSTATE,
  TENANT_DATA_QUOTA_RECONCILING_MESSAGE,
  TENANT_DATA_QUOTA_RECONCILING_SQLSTATE,
} from '../tenants/tenant-data-quota.constants.js';

export type CourseOutlineTransferOperation = 'duplicate' | 'move';
export type CourseOutlineTransferStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type CourseOutlineTransferDestinationLevel = 'chapter' | 'sequential' | 'vertical' | 'complete';

type TransferableBlockType = 'chapter' | 'sequential' | 'vertical' | 'component';

const MOVE_OPERATION_DISABLED_MESSAGE = 'Tính năng chuyển nội dung đã ngừng sử dụng. Hãy tạo một yêu cầu nhân bản mới.';

interface CourseRow {
  id: string;
  display_name: string;
  tenant_id: string;
  deleted_at: Date | null;
}

interface BlockRow {
  id: string;
  course_id: string;
  parent_id: string | null;
  block_type: string;
  display_name: string;
  updated_at: Date;
  deleted_at: Date | null;
  delete_status: string | null;
}

interface TransferJobRow {
  id: string;
  tenant_id: string;
  source_course_id: string;
  source_block_id: string;
  destination_course_id: string;
  destination_parent_id: string;
  operation: CourseOutlineTransferOperation;
  requested_by: string;
  requested_username: string | null;
  requested_ip: string | null;
  source_block_name: string;
  source_block_type: string;
  source_root_updated_at: Date;
  destination_parent_updated_at: Date;
  status: CourseOutlineTransferStatus;
  attempts: number;
  max_attempts: number;
  asset_count: number;
  block_count: number;
  lease_token: string | null;
}

interface TransferAssetRow {
  id: string;
  job_id: string;
  tenant_id: string;
  source_asset_id: string;
  source_storage_path: string;
  target_storage_path: string;
  display_name: string;
  content_type: string | null;
  file_size: string | number | null;
  source_url: string | null;
  target_url: string | null;
  status: 'queued' | 'copied';
}

interface PayloadRow {
  id: string;
  data: unknown;
  metadata: unknown;
  published_data: unknown;
  published_metadata: unknown;
}

export interface CourseOutlineTransferJob {
  id: string;
  operation: CourseOutlineTransferOperation;
  status: CourseOutlineTransferStatus;
  source_course_id: string;
  source_block_id: string;
  destination_course_id: string;
  destination_parent_id: string;
  source_block_name: string;
  source_block_type: string;
  attempts: number;
  max_attempts: number;
  block_count: number;
  asset_count: number;
  total_asset_bytes: string;
  copied_asset_bytes: string;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  next_attempt_at: string;
  completed_at: string | null;
}

export interface CourseOutlineTransferDestinationOptions {
  source_block_type: string;
  next_level: CourseOutlineTransferDestinationLevel;
  options: Array<{ id: string; display_name: string; block_type: string }>;
  has_more: boolean;
  next_cursor: string | null;
}

const STRUCTURAL_PARENT: Record<string, string> = {
  chapter: 'course',
  sequential: 'chapter',
  vertical: 'sequential',
};
const DESTINATION_PATH_TYPES: Record<string, Array<'chapter' | 'sequential' | 'vertical'>> = {
  chapter: [],
  sequential: ['chapter'],
  vertical: ['chapter', 'sequential'],
};
const JOB_LEASE_SECONDS = 15 * 60;
const TRANSFER_ASSET_BATCH_CONCURRENCY = 2;

function isTransferableBlockType(blockType: string): boolean {
  return blockType !== 'course';
}

function expectedDestinationParentType(sourceBlockType: string): string {
  return STRUCTURAL_PARENT[sourceBlockType] || 'vertical';
}

function destinationPathTypes(sourceBlockType: string): Array<'chapter' | 'sequential' | 'vertical'> {
  return DESTINATION_PATH_TYPES[sourceBlockType] || ['chapter', 'sequential', 'vertical'];
}

function normalizeSearch(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}

function normalizePage(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback;
}

function decodeCursor(value: unknown): { displayName: string; id: string } | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { displayName?: unknown; id?: unknown };
    if (typeof parsed.displayName !== 'string' || typeof parsed.id !== 'string' || parsed.displayName.length > 500 || parsed.id.length > 500) {
      throw new Error('invalid cursor');
    }
    return { displayName: parsed.displayName, id: parsed.id };
  } catch {
    throw new AppError('Trang dữ liệu không hợp lệ. Hãy tải lại danh sách.', 400);
  }
}

function encodeCursor(row: { display_name: string; id: string }): string {
  return Buffer.from(JSON.stringify({ displayName: row.display_name, id: row.id }), 'utf8').toString('base64url');
}

function normalizeDestinationPath(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 3) {
    throw new AppError('Đường dẫn vị trí nhận nội dung không hợp lệ.', 400);
  }
  return value.map((item) => {
    if (typeof item !== 'string') throw new AppError('Đường dẫn vị trí nhận nội dung không hợp lệ.', 400);
    assertUuid(item, 'Vị trí nhận nội dung');
    return item;
  });
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(`${label} không hợp lệ`, 400);
  }
}

function asNumber(value: string | number | null | undefined): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function safeTransferFailureMessage(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (code === TENANT_DATA_LIMIT_REACHED_SQLSTATE) return TENANT_DATA_LIMIT_REACHED_MESSAGE;
  if (code === TENANT_DATA_QUOTA_RECONCILING_SQLSTATE) return TENANT_DATA_QUOTA_RECONCILING_MESSAGE;
  if (error instanceof AppError) return error.message;
  return 'Hệ thống chưa thể xử lý yêu cầu chuyển nội dung. Vui lòng thử lại sau ít phút.';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeStoragePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 1_200) return null;
  if (/^[0-9a-f-]{36}\/courses\/[\w.\-/]+$/i.test(raw)) return raw;
  const marker = '/object/public/landa-storage/';
  const markerIndex = raw.indexOf(marker);
  if (markerIndex < 0) return null;
  try {
    return decodeURIComponent(raw.slice(markerIndex + marker.length).split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
}

function collectStringValues(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, output);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStringValues(item, output);
  }
}

function collectReferencedAssetPaths(payloadRows: PayloadRow[], tenantId: string): Set<string> {
  // A quota-neutral move intentionally retains the physical object key. A
  // component moved for a second time can therefore reference an older course
  // segment, while its authoritative course_assets row belongs to this source
  // course. Discover every tenant-owned course key here; the tenant+course
  // asset lookup below remains the ownership boundary.
  const tenantCoursePrefix = `${tenantId}/courses/`;
  const matcher = new RegExp(`${escapeRegExp(tenantCoursePrefix)}[^\\s"'<>()\\[\\]{}]+`, 'g');
  const paths = new Set<string>();
  for (const row of payloadRows) {
    const strings: string[] = [];
    collectStringValues(row.data, strings);
    collectStringValues(row.metadata, strings);
    collectStringValues(row.published_data, strings);
    collectStringValues(row.published_metadata, strings);
    for (const value of strings) {
      const direct = normalizeStoragePath(value);
      if (direct?.startsWith(tenantCoursePrefix)) paths.add(direct);
      for (const match of value.matchAll(matcher)) {
        const candidate = match[0].split(/[?#]/, 1)[0].replace(/[.,;:!?]+$/, '');
        if (candidate.startsWith(tenantCoursePrefix)) paths.add(candidate);
      }
    }
  }
  return paths;
}

async function assertTransferSchemaReady(): Promise<void> {
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
    const path = normalizeStoragePath(asset.storage_path) || normalizeStoragePath(asset.url);
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
              public.course_outline_transfer_rewrite_jsonb(COALESCE(source.metadata, '{}'::jsonb), $5::uuid),
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
  const result = await query<TransferJobRow>(
    `WITH candidate AS (
       SELECT id
         FROM course_outline_transfer_jobs
        WHERE (status = 'queued' AND next_attempt_at <= now())
           OR (status = 'running' AND lease_expires_at < now())
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
    [leaseToken, JOB_LEASE_SECONDS],
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

  const course = await query<{ id: string }>(
    `SELECT id FROM courses WHERE id = $1 AND tenant_id = $2::uuid AND deleted_at IS NULL`,
    [destinationCourseId, tenantId],
  );
  if (!course.rows[0]) throw new AppError('Khóa học nhận nội dung không còn hợp lệ.', 404);

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
