import { query, getClient } from '../../config/database.js';
import { env } from '../../config/env.js';
import {
  invalidateBlockReadCaches,
  invalidateCourseReadCaches,
  invalidateTenantBadgeCaches,
  invalidateTenantCourseCaches,
} from '../../config/cache-invalidation.js';
import { deleteFiles, extractStoragePath } from '../../config/storage.js';
import { publish, QUEUES } from '../../config/rabbitmq/index.js';
import { AppError } from '../../middleware/error-handler.js';
import {
  deleteStorageManifest,
  registerStorageManifestPaths,
  registerStoragePrefixManifestPaths,
} from '../deletion/storage-manifest.service.js';

const DELETE_BATCH_SIZE = 500;
const ASSET_BATCH_SIZE = 100;
const CACHE_INVALIDATION_BATCH_SIZE = 500;
const JOB_LEASE_SECONDS = 15 * 60;

type DeleteTargetType = 'course' | 'block';
type DeleteJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

interface DeleteJobRow {
  id: string;
  tenant_id: string;
  course_id: string;
  root_block_id: string | null;
  target_type: DeleteTargetType;
  status: DeleteJobStatus;
  attempts: number;
  is_terminal: boolean;
}

interface BlockPayloadRow {
  id: string;
  data: unknown;
  metadata: unknown;
  published_data: unknown;
  published_metadata: unknown;
}

interface PurgeStats {
  blocksDeleted: number;
  assetsDeleted: number;
  storageDeleteRequested: number;
  enrollmentsDeleted: number;
  linkedRowsDeleted: number;
  rowsUpdated: number;
}

function emptyStats(): PurgeStats {
  return {
    blocksDeleted: 0,
    assetsDeleted: 0,
    storageDeleteRequested: 0,
    enrollmentsDeleted: 0,
    linkedRowsDeleted: 0,
    rowsUpdated: 0,
  };
}

function addStats(total: PurgeStats, next: Partial<PurgeStats>): void {
  for (const key of Object.keys(next) as (keyof PurgeStats)[]) {
    total[key] += next[key] ?? 0;
  }
}

async function invalidateBlockReadCachesInBatches(blockIds: readonly string[]): Promise<void> {
  for (let index = 0; index < blockIds.length; index += CACHE_INVALIDATION_BATCH_SIZE) {
    await invalidateBlockReadCaches(blockIds.slice(index, index + CACHE_INVALIDATION_BATCH_SIZE));
  }
}

async function getBlockSubtreeIds(blockId: string, courseId: string): Promise<string[]> {
  const result = await query<{ id: string }>(
    `WITH RECURSIVE subtree AS (
       SELECT id
       FROM course_blocks
       WHERE id = $1 AND course_id = $2
       UNION ALL
       SELECT child.id
       FROM course_blocks child
       JOIN subtree s ON child.parent_id = s.id
       WHERE child.course_id = $2
     )
     SELECT id FROM subtree`,
    [blockId, courseId],
  );
  return result.rows.map((row) => row.id);
}

function normalizeCourseStoragePath(value: unknown, tenantId: string, courseId: string): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 1200) return null;

  const extracted = extractStoragePath(raw);
  if (!extracted) return null;
  if (!extracted.startsWith(`${tenantId}/courses/`)) return null;
  if (!extracted.includes(`/courses/${courseId}/`)) return null;
  if (/[<>"'`\\]/.test(extracted)) return null;
  return extracted;
}

function collectPathsFromString(value: string, tenantId: string, courseId: string, paths: Set<string>): void {
  const direct = normalizeCourseStoragePath(value, tenantId, courseId);
  if (direct) paths.add(direct);

  const imgSrcRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = imgSrcRegex.exec(value)) !== null) {
    const srcPath = normalizeCourseStoragePath(match[1], tenantId, courseId);
    if (srcPath) paths.add(srcPath);
  }
}

function collectPathsFromValue(value: unknown, tenantId: string, courseId: string, paths: Set<string>): void {
  if (value == null) return;
  if (typeof value === 'string') {
    collectPathsFromString(value, tenantId, courseId, paths);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathsFromValue(item, tenantId, courseId, paths);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectPathsFromValue(item, tenantId, courseId, paths);
    }
  }
}

function collectPathsFromBlocks(rows: BlockPayloadRow[], tenantId: string, courseId: string): string[] {
  const paths = new Set<string>();
  for (const row of rows) {
    collectPathsFromValue(row.data, tenantId, courseId, paths);
    collectPathsFromValue(row.metadata, tenantId, courseId, paths);
    collectPathsFromValue(row.published_data, tenantId, courseId, paths);
    collectPathsFromValue(row.published_metadata, tenantId, courseId, paths);
  }
  return [...paths];
}

function normalizeAssignmentStoragePath(value: unknown, tenantId: string, courseId: string): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 1200) return null;
  const extracted = extractStoragePath(raw);
  if (!extracted || !extracted.startsWith(`${tenantId}/assignments/${courseId}/`)) return null;
  if (/[<>"'`\\]/.test(extracted)) return null;
  return extracted;
}

function requireAssignmentStoragePath(value: unknown, tenantId: string, courseId: string, source: string): string | null {
  if (value == null || value === '') return null;
  const path = normalizeAssignmentStoragePath(value, tenantId, courseId);
  const extracted = typeof value === 'string' ? extractStoragePath(value.trim()) : null;
  if (extracted?.startsWith(`${tenantId}/`) && !path) {
    throw new Error(`Unsafe or foreign ${source} storage reference blocked course deletion`);
  }
  return path;
}

function requireCourseOwnedStoragePath(value: unknown, tenantId: string, courseId: string, source: string): string | null {
  if (value == null || value === '') return null;
  const path = normalizeCourseStoragePath(value, tenantId, courseId);
  const extracted = typeof value === 'string' ? extractStoragePath(value.trim()) : null;
  if (extracted?.startsWith(`${tenantId}/`) && !path) {
    throw new Error(`Unsafe or foreign ${source} storage reference blocked course deletion`);
  }
  return path;
}

/**
 * Build the durable object-key manifest before any course rows are purged.
 * Every high-cardinality query is keyset-paginated to stay bounded at scale.
 */
async function ensureCourseStorageManifest(job: DeleteJobRow): Promise<void> {
  if (job.target_type !== 'course') return;
  const alreadyComplete = await query<{ manifest_completed_at: Date | null }>(
    `SELECT manifest_completed_at
     FROM course_deletion_jobs
     WHERE id = $1::uuid`,
    [job.id],
  );
  if (alreadyComplete.rows[0]?.manifest_completed_at) return;

  const directPaths = new Set<string>();

  const [course, mentor] = await Promise.all([
    query<{ image_url: string | null }>(
      `SELECT image_url FROM courses WHERE id = $1 AND tenant_id = $2`,
      [job.course_id, job.tenant_id],
    ),
    query<{ logo_light_path: string | null; logo_dark_path: string | null }>(
      `SELECT logo_light_path, logo_dark_path
       FROM course_mentor_sections
       WHERE course_id = $1 AND tenant_id = $2`,
      [job.course_id, job.tenant_id],
    ),
  ]);
  if (course.rowCount === 0) return;
  for (const value of [
    course.rows[0].image_url,
    mentor.rows[0]?.logo_light_path,
    mentor.rows[0]?.logo_dark_path,
  ]) {
    const path = requireCourseOwnedStoragePath(value, job.tenant_id, job.course_id, 'course metadata');
    if (path) directPaths.add(path);
  }
  await registerStorageManifestPaths('course', job.id, job.tenant_id, [...directPaths]);

  let lastAssetId = '';
  while (true) {
    const rows = await query<{ id: string; storage_path: string | null; url: string | null }>(
      `SELECT id, storage_path, url
       FROM course_assets
       WHERE tenant_id = $1 AND course_id = $2 AND id > $3::uuid
       ORDER BY id
       LIMIT $4`,
      [job.tenant_id, job.course_id, lastAssetId || '00000000-0000-0000-0000-000000000000', ASSET_BATCH_SIZE],
    );
    if (rows.rowCount === 0) break;
    const paths = rows.rows.flatMap((row) => [row.storage_path, row.url])
      .map((value) => requireCourseOwnedStoragePath(value, job.tenant_id, job.course_id, 'course asset'))
      .filter((value): value is string => value !== null);
    await registerStorageManifestPaths('course', job.id, job.tenant_id, paths);
    lastAssetId = rows.rows[rows.rows.length - 1].id;
  }

  let lastBlockId = '';
  while (true) {
    const rows = await query<BlockPayloadRow>(
      `SELECT id, data, metadata, published_data, published_metadata
       FROM course_blocks
       WHERE course_id = $1 AND id > $2::uuid
       ORDER BY id
       LIMIT $3`,
      [job.course_id, lastBlockId || '00000000-0000-0000-0000-000000000000', DELETE_BATCH_SIZE],
    );
    if (rows.rowCount === 0) break;
    await registerStorageManifestPaths(
      'course',
      job.id,
      job.tenant_id,
      collectPathsFromBlocks(rows.rows, job.tenant_id, job.course_id),
    );
    // Invalidate before the destructive phase, in bounded batches. This
    // prevents a cached learner block from surviving a full-course purge and
    // avoids materialising every block ID in Node for very large courses.
    await invalidateBlockReadCaches(rows.rows.map((row) => row.id));
    lastBlockId = rows.rows[rows.rows.length - 1].id;
  }

  let lastAssignmentId = '';
  while (true) {
    const rows = await query<{ id: string; storage_path: string | null }>(
      `SELECT id, attachment_file ->> 'storage_path' AS storage_path
       FROM course_assignments
       WHERE course_id = $1 AND id > $2::uuid
       ORDER BY id
       LIMIT $3`,
      [job.course_id, lastAssignmentId || '00000000-0000-0000-0000-000000000000', DELETE_BATCH_SIZE],
    );
    if (rows.rowCount === 0) break;
    const paths = rows.rows
      .map((row) => requireAssignmentStoragePath(row.storage_path, job.tenant_id, job.course_id, 'assignment attachment'))
      .filter((value): value is string => value !== null);
    await registerStorageManifestPaths('course', job.id, job.tenant_id, paths);
    lastAssignmentId = rows.rows[rows.rows.length - 1].id;
  }

  let lastFileId = '';
  while (true) {
    const rows = await query<{ id: string; storage_path: string }>(
      `SELECT id, storage_path
       FROM assignment_files
       WHERE course_id = $1 AND id > $2::uuid
       ORDER BY id
       LIMIT $3`,
      [job.course_id, lastFileId || '00000000-0000-0000-0000-000000000000', DELETE_BATCH_SIZE],
    );
    if (rows.rowCount === 0) break;
    const paths = rows.rows
      .map((row) => requireAssignmentStoragePath(row.storage_path, job.tenant_id, job.course_id, 'assignment file'))
      .filter((value): value is string => value !== null);
    await registerStorageManifestPaths('course', job.id, job.tenant_id, paths);
    lastFileId = rows.rows[rows.rows.length - 1].id;
  }

  // DB references miss failed/abandoned uploads. Discover both server-owned
  // prefixes directly from storage before the course rows are purged.
  await registerStoragePrefixManifestPaths('course', job.id, job.tenant_id, `${job.tenant_id}/courses/${job.course_id}/`);
  await registerStoragePrefixManifestPaths('course', job.id, job.tenant_id, `${job.tenant_id}/assignments/${job.course_id}/`);

  await query(
    `UPDATE course_deletion_jobs
     SET manifest_completed_at = now(), updated_at = now()
     WHERE id = $1::uuid AND status = 'running'`,
    [job.id],
  );
}

async function publishDeleteJob(jobId: string): Promise<void> {
  try {
    await publish(QUEUES.COURSE_DELETE, { jobId });
  } catch (err) {
    console.error(`[CourseDelete] Failed to publish job ${jobId}:`, err);
  }
}

export async function requestCourseDeletion(
  courseId: string,
  tenantId: string,
  requestedBy: string,
): Promise<{ jobId: string }> {
  const client = await getClient();
  let jobId = '';

  try {
    await client.query('BEGIN');

    const courseResult = await client.query<{ id: string }>(
      `SELECT id
       FROM courses
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [courseId, tenantId],
    );
    if (courseResult.rowCount === 0) {
      throw new AppError('Course not found', 404);
    }

    const jobResult = await client.query<{ id: string }>(
      `INSERT INTO course_deletion_jobs (tenant_id, course_id, target_type, requested_by)
       VALUES ($1, $2, 'course', $3)
       RETURNING id`,
      [tenantId, courseId, requestedBy],
    );
    jobId = jobResult.rows[0].id;

    await client.query(
      `UPDATE courses
       SET deleted_at = now(),
           delete_status = 'queued',
           delete_job_id = $3,
           deleted_by = $4,
           updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [courseId, tenantId, jobId, requestedBy],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await Promise.all([
    invalidateTenantCourseCaches(tenantId),
    invalidateCourseReadCaches(courseId, tenantId),
  ]);
  await publishDeleteJob(jobId);
  return { jobId };
}

export async function requestBlockDeletion(
  blockId: string,
  tenantId: string,
  requestedBy: string,
): Promise<{ jobId: string; courseId: string }> {
  const client = await getClient();
  let jobId = '';
  let courseId = '';

  try {
    await client.query('BEGIN');

    const blockResult = await client.query<{ id: string; course_id: string; block_type: string }>(
      `SELECT b.id, b.course_id, b.block_type
       FROM course_blocks b
       JOIN courses c ON c.id = b.course_id
       WHERE b.id = $1
         AND c.tenant_id = $2
         AND c.deleted_at IS NULL
         AND b.deleted_at IS NULL
       FOR UPDATE OF b`,
      [blockId, tenantId],
    );
    if (blockResult.rowCount === 0) {
      throw new AppError('Block not found', 404);
    }
    if (blockResult.rows[0].block_type === 'course') {
      throw new AppError('Use course delete for root course block', 400);
    }

    courseId = blockResult.rows[0].course_id;
    const jobResult = await client.query<{ id: string }>(
      `INSERT INTO course_deletion_jobs (tenant_id, course_id, root_block_id, target_type, requested_by)
       VALUES ($1, $2, $3, 'block', $4)
       RETURNING id`,
      [tenantId, courseId, blockId, requestedBy],
    );
    jobId = jobResult.rows[0].id;

    await client.query(
      `UPDATE course_blocks
       SET deleted_at = now(),
           delete_status = 'queued',
           delete_job_id = $2,
           deleted_by = $3,
           updated_at = now()
       WHERE id = $1`,
      [blockId, jobId, requestedBy],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const blockIds = await getBlockSubtreeIds(blockId, courseId);
  await Promise.all([
    invalidateCourseReadCaches(courseId, tenantId),
    invalidateBlockReadCachesInBatches(blockIds),
  ]);
  await publishDeleteJob(jobId);
  return { jobId, courseId };
}

async function markJobRunning(jobId: string): Promise<DeleteJobRow | null> {
  const result = await query<DeleteJobRow>(
    `UPDATE course_deletion_jobs
     SET status = 'running',
         attempts = attempts + 1,
         started_at = COALESCE(started_at, now()),
         lease_expires_at = now() + ($2::int * interval '1 second'),
         updated_at = now()
     WHERE id = $1
       AND is_terminal = false
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       AND (
         status IN ('queued', 'failed')
         OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
       )
     RETURNING id, tenant_id, course_id, root_block_id, target_type, status, attempts`,
    [jobId, JOB_LEASE_SECONDS],
  );
  return result.rows[0] ?? null;
}

async function markJobSucceeded(jobId: string, stats: PurgeStats): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // The completed manifest contains object keys and is no longer needed once
    // the purge commits. Retaining it would itself become deletion residue.
    await client.query(
      `DELETE FROM deletion_storage_items
       WHERE job_kind = 'course' AND job_id = $1::uuid`,
      [jobId],
    );
    await client.query(
      `DELETE FROM deletion_storage_scan_cursors
       WHERE job_kind = 'course' AND job_id = $1::uuid`,
      [jobId],
    );
    await client.query(
      `UPDATE course_deletion_jobs
       SET status = 'succeeded',
           course_id = NULL,
           root_block_id = NULL,
           is_terminal = false,
           finished_at = now(),
           lease_expires_at = NULL,
           next_attempt_at = NULL,
           updated_at = now(),
           stats = $2::jsonb,
           last_error = NULL
       WHERE id = $1`,
      [jobId, JSON.stringify(stats)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function markJobRetryable(jobId: string, error: unknown): Promise<void> {
  const result = await query<{ course_id: string | null; root_block_id: string | null; target_type: DeleteTargetType; is_terminal: boolean }>(
    `UPDATE course_deletion_jobs
     SET status = CASE WHEN attempts >= $3::int THEN 'failed' ELSE 'queued' END,
         is_terminal = attempts >= $3::int,
         lease_expires_at = NULL,
         next_attempt_at = CASE
           WHEN attempts >= $3::int THEN NULL
           ELSE now() + (
             LEAST(
               $4::numeric * power(2::numeric, GREATEST(attempts - 1, 0)),
               $5::numeric
             ) * (0.75 + random() * 0.5)
           ) * interval '1 millisecond'
         END,
         last_error = $2,
         updated_at = now()
     WHERE id = $1 AND status = 'running'
     RETURNING course_id, root_block_id, target_type, is_terminal`,
    [
      jobId,
      (error instanceof Error ? error.message : String(error)).slice(0, 4000),
      env.DELETION_MAX_ATTEMPTS,
      env.DELETION_RETRY_BASE_MS,
      env.DELETION_RETRY_MAX_MS,
    ],
  );
  const job = result.rows[0];
  if (!job?.is_terminal || !job.course_id) return;
  if (job.target_type === 'course') {
    await query(
      `UPDATE courses
       SET delete_status = 'failed', updated_at = now()
       WHERE id = $1 AND deleted_at IS NOT NULL`,
      [job.course_id],
    );
  } else if (job.root_block_id) {
    await query(
      `UPDATE course_blocks
       SET delete_status = 'failed', updated_at = now()
       WHERE id = $1 AND deleted_at IS NOT NULL`,
      [job.root_block_id],
    );
  }
  console.error(`[CourseDelete] Job ${jobId} reached terminal failure after retry budget was exhausted`);
}

async function deleteAssetsAndFilesByPaths(
  tenantId: string,
  courseId: string,
  rawPaths: string[],
  deleteStorage = true,
): Promise<Partial<PurgeStats>> {
  const paths = [...new Set(rawPaths)];
  let assetsDeleted = 0;
  let storageDeleteRequested = 0;

  for (let i = 0; i < paths.length; i += ASSET_BATCH_SIZE) {
    const batch = paths.slice(i, i + ASSET_BATCH_SIZE);
    const assetResult = await query<{ storage_path: string | null; url: string | null }>(
      `SELECT storage_path, url
       FROM course_assets
       WHERE tenant_id = $1
         AND course_id = $2
         AND (storage_path = ANY($3::text[]) OR url = ANY($3::text[]))`,
      [tenantId, courseId, batch],
    );

    const deletePaths = new Set<string>(batch);
    for (const row of assetResult.rows) {
      const storagePath = normalizeCourseStoragePath(row.storage_path, tenantId, courseId);
      if (storagePath) deletePaths.add(storagePath);
      const urlPath = normalizeCourseStoragePath(row.url, tenantId, courseId);
      if (urlPath) deletePaths.add(urlPath);
    }

    if (deleteStorage && deletePaths.size > 0) {
      await deleteFiles([...deletePaths]);
      storageDeleteRequested += deletePaths.size;
    }

    // External storage is deleted first. If the process dies here, a retry
    // repeats a safe remove; deleting this row first would orphan the object.
    const deleted = await query(
      `DELETE FROM course_assets
       WHERE tenant_id = $1
         AND course_id = $2
         AND (storage_path = ANY($3::text[]) OR url = ANY($3::text[]))`,
      [tenantId, courseId, batch],
    );
    assetsDeleted += deleted.rowCount || 0;
  }

  return { assetsDeleted, storageDeleteRequested };
}

async function deleteAllCourseAssets(tenantId: string, courseId: string): Promise<Partial<PurgeStats>> {
  let assetsDeleted = 0;

  while (true) {
    const result = await query<{ id: string }>(
      `SELECT id
       FROM course_assets
       WHERE tenant_id = $1 AND course_id = $2
       LIMIT $3`,
      [tenantId, courseId, ASSET_BATCH_SIZE],
    );
    if (result.rowCount === 0) break;

    const ids = result.rows.map((row) => row.id);
    const deleted = await query(
      `DELETE FROM course_assets WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    assetsDeleted += deleted.rowCount || 0;
  }

  return { assetsDeleted };
}

/**
 * Full-course storage has already been enumerated into a durable manifest.
 * Delete every block in one database statement rather than repeatedly peeling
 * leaves: a deeply nested million-node tree otherwise degrades to one delete
 * round-trip per depth level. The production parent FK is ON DELETE CASCADE,
 * so deleting the complete course set in one statement is valid.
 */
async function deleteAllCourseBlocks(courseId: string): Promise<Partial<PurgeStats>> {
  const result = await query(
    `DELETE FROM course_blocks
     WHERE course_id = $1`,
    [courseId],
  );
  return { blocksDeleted: result.rowCount || 0 };
}

async function deleteLeafBlocksByRoot(
  tenantId: string,
  courseId: string,
  rootBlockId: string,
): Promise<Partial<PurgeStats>> {
  const stats = emptyStats();

  while (true) {
    const result = await query<BlockPayloadRow>(
      `WITH RECURSIVE subtree AS (
         SELECT id FROM course_blocks WHERE id = $1
         UNION ALL
         SELECT child.id
         FROM course_blocks child
         JOIN subtree s ON child.parent_id = s.id
       ),
       doomed AS (
         SELECT b.id
         FROM course_blocks b
         JOIN subtree s ON s.id = b.id
         WHERE NOT EXISTS (
           SELECT 1 FROM course_blocks child WHERE child.parent_id = b.id
         )
         LIMIT $2
       )
       DELETE FROM course_blocks b
       USING doomed
       WHERE b.id = doomed.id
       RETURNING b.id, b.data, b.metadata, b.published_data, b.published_metadata`,
      [rootBlockId, DELETE_BATCH_SIZE],
    );
    if (result.rowCount === 0) break;

    stats.blocksDeleted += result.rowCount || 0;
    const blockIds = result.rows.map((row) => row.id);
    const paths = collectPathsFromBlocks(result.rows, tenantId, courseId);
    addStats(stats, await deleteAssetsAndFilesByPaths(tenantId, courseId, paths));

    const sectionConfigDeleted = await query(
      `DELETE FROM section_modal_configs
       WHERE course_id = $1 AND section_id = ANY($2::text[])`,
      [courseId, blockIds],
    );
    const sectionShownDeleted = await query(
      `DELETE FROM section_modal_shown
       WHERE course_id = $1 AND section_id = ANY($2::text[])`,
      [courseId, blockIds],
    );
    stats.linkedRowsDeleted += (sectionConfigDeleted.rowCount || 0) + (sectionShownDeleted.rowCount || 0);
  }

  return stats;
}

async function deleteEnrollmentsByCourse(tenantId: string, courseId: string): Promise<Partial<PurgeStats>> {
  let enrollmentsDeleted = 0;

  while (true) {
    const result = await query<{ id: string }>(
      `WITH doomed AS (
         SELECT id
         FROM enrollments
         WHERE tenant_id = $1 AND course_id = $2
         LIMIT $3
       )
       DELETE FROM enrollments e
       USING doomed
       WHERE e.id = doomed.id
       RETURNING e.id`,
      [tenantId, courseId, DELETE_BATCH_SIZE],
    );
    if (result.rowCount === 0) break;
    enrollmentsDeleted += result.rowCount || 0;
  }

  return { enrollmentsDeleted };
}

type CourseReferenceTable =
  | 'notifications'
  | 'study_sessions'
  | 'chat_conversations'
  | 'assignment_feedback_history'
  | 'notification_email_jobs'
  | 'lesson_author_jobs'
  | 'course_mentor_assignment_history'
  | 'course_mentor_sections'
  | 'team_courses'
  | 'course_category_courses'
  | 'course_modal_configs'
  | 'course_modal_states'
  | 'section_modal_configs'
  | 'section_modal_shown'
  | 'tenant_badge_rule_courses';

async function deleteCourseReferenceInBatches(
  tableName: CourseReferenceTable,
  courseId: string,
): Promise<number> {
  let rowsDeleted = 0;

  while (true) {
    const result = await query(
      `WITH doomed AS (
         SELECT ctid
         FROM ${tableName}
         WHERE course_id = $1
         LIMIT $2
       )
       DELETE FROM ${tableName} t
       USING doomed
       WHERE t.ctid = doomed.ctid`,
      [courseId, DELETE_BATCH_SIZE],
    );
    if (result.rowCount === 0) break;
    rowsDeleted += result.rowCount || 0;
  }

  return rowsDeleted;
}

async function deleteCourseAuditLogsInBatches(courseId: string): Promise<number> {
  let rowsDeleted = 0;
  while (true) {
    const result = await query(
      `WITH doomed AS (
         SELECT ctid
         FROM audit_logs
         WHERE entity_type = 'course' AND entity_id = $1::text
         LIMIT $2
       )
       DELETE FROM audit_logs logs
       USING doomed
       WHERE logs.ctid = doomed.ctid`,
      [courseId, DELETE_BATCH_SIZE],
    );
    if (result.rowCount === 0) return rowsDeleted;
    rowsDeleted += result.rowCount || 0;
  }
}

async function deleteCourseOutboxInBatches(courseId: string): Promise<number> {
  let rowsDeleted = 0;
  while (true) {
    const result = await query(
      `WITH doomed AS (
         SELECT outbox.ctid
         FROM email_outbox outbox
         WHERE outbox.related_submission_id IN (
                 SELECT id FROM assignment_submissions WHERE course_id = $1
               )
            OR outbox.related_notification_id IN (
                 SELECT id FROM notifications WHERE course_id = $1
               )
         LIMIT $2
       )
       DELETE FROM email_outbox outbox
       USING doomed
       WHERE outbox.ctid = doomed.ctid`,
      [courseId, DELETE_BATCH_SIZE],
    );
    if (result.rowCount === 0) return rowsDeleted;
    rowsDeleted += result.rowCount || 0;
  }
}

async function touchJobLease(jobId: string): Promise<void> {
  await query(
    `UPDATE course_deletion_jobs
     SET lease_expires_at = now() + ($2::int * interval '1 second'), updated_at = now()
     WHERE id = $1 AND status = 'running'`,
    [jobId, JOB_LEASE_SECONDS],
  );
}

async function deleteCourseLinkedRows(courseId: string): Promise<Partial<PurgeStats>> {
  const directCourseTables: readonly CourseReferenceTable[] = [
    'notification_email_jobs',
    'lesson_author_jobs',
    'course_mentor_assignment_history',
    'course_mentor_sections',
    'team_courses',
    'course_category_courses',
    'course_modal_configs',
    'course_modal_states',
    'section_modal_configs',
    'section_modal_shown',
    // The FK is SET NULL, which would leave its display-name snapshot behind.
    'tenant_badge_rule_courses',
  ];

  // Do not retain course title/details in audit rows or personalized queued
  // mail. Both operations are bounded to avoid one large WAL/lock spike.
  let linkedRowsDeleted = await deleteCourseAuditLogsInBatches(courseId);
  linkedRowsDeleted += await deleteCourseOutboxInBatches(courseId);
  for (const tableName of directCourseTables) {
    linkedRowsDeleted += await deleteCourseReferenceInBatches(tableName, courseId);
  }

  const rowsUpdated = 0;
  linkedRowsDeleted +=
    await deleteCourseReferenceInBatches('notifications', courseId) +
    await deleteCourseReferenceInBatches('study_sessions', courseId) +
    await deleteCourseReferenceInBatches('chat_conversations', courseId);

  return { linkedRowsDeleted, rowsUpdated };
}

async function purgeCourse(job: DeleteJobRow): Promise<PurgeStats> {
  const stats = emptyStats();

  await query(
    `UPDATE courses
     SET delete_status = 'running', updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL`,
    [job.course_id, job.tenant_id],
  );

  const course = await query<{ id: string }>(
    `SELECT id FROM courses WHERE id = $1 AND tenant_id = $2`,
    [job.course_id, job.tenant_id],
  );

  if (course.rowCount === 0) return stats;

  addStats(stats, await deleteAllCourseAssets(job.tenant_id, job.course_id));
  // Delete outbox rows while their related submission IDs still exist. Deleting
  // enrollments first would cascade submissions and merely SET NULL on outbox,
  // leaving the mail body (which may contain learner/course personal data).
  addStats(stats, await deleteCourseLinkedRows(job.course_id));
  // Section-modal rows are removed above, before the complete block set is
  // deleted in one statement. This makes wide and deep course trees O(n), not
  // O(n × depth), while retaining bounded memory in the application process.
  addStats(stats, await deleteAllCourseBlocks(job.course_id));
  const feedbackHistory = await deleteCourseReferenceInBatches('assignment_feedback_history', job.course_id);
  stats.linkedRowsDeleted += feedbackHistory;
  const backupCleanup = await query<{ deleted: number }>(
    `SELECT public.purge_course_backup_pii($1::text) AS deleted`,
    [job.course_id],
  );
  stats.linkedRowsDeleted += Number(backupCleanup.rows[0]?.deleted || 0);
  addStats(stats, await deleteEnrollmentsByCourse(job.tenant_id, job.course_id));

  const deletedCourse = await query(
    `DELETE FROM courses
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NOT NULL`,
    [job.course_id, job.tenant_id],
  );

  if ((deletedCourse.rowCount || 0) > 0) {
    await invalidateTenantBadgeCaches(job.tenant_id);
  }

  return stats;
}

async function purgeBlock(job: DeleteJobRow): Promise<PurgeStats> {
  const stats = emptyStats();
  if (!job.root_block_id) return stats;

  await query(
    `UPDATE course_blocks
     SET delete_status = 'running', updated_at = now()
     WHERE id = $1 AND deleted_at IS NOT NULL`,
    [job.root_block_id],
  );

  addStats(stats, await deleteLeafBlocksByRoot(job.tenant_id, job.course_id, job.root_block_id));
  return stats;
}

export async function runDeletionJob(jobId: string): Promise<void> {
  const job = await markJobRunning(jobId);
  if (!job) return;

  // A course can contain millions of blocks; versioned course caches make a
  // per-block preload unnecessary. Block-only deletion keeps the narrower path.
  const blockIdsToInvalidate = job.target_type === 'block' && job.root_block_id
      ? await getBlockSubtreeIds(job.root_block_id, job.course_id)
      : [];

  const heartbeat = setInterval(() => {
    touchJobLease(job.id).catch((error) => console.error('[CourseDelete] Lease heartbeat failed:', error));
  }, 60_000);
  heartbeat.unref();
  try {
    let stats: PurgeStats;
    if (job.target_type === 'course') {
      await ensureCourseStorageManifest(job);
      const storageDeleteRequested = await deleteStorageManifest('course', job.id);
      await touchJobLease(job.id);
      stats = await purgeCourse(job);
      stats.storageDeleteRequested += storageDeleteRequested;
    } else {
      stats = await purgeBlock(job);
    }

    await markJobSucceeded(job.id, stats);
    if (job.target_type === 'course') {
      await Promise.all([
        invalidateTenantCourseCaches(job.tenant_id),
        invalidateCourseReadCaches(job.course_id, job.tenant_id),
      ]);
    } else {
      await Promise.all([
        invalidateCourseReadCaches(job.course_id, job.tenant_id),
        invalidateBlockReadCachesInBatches(blockIdsToInvalidate),
      ]);
    }
  } finally {
    clearInterval(heartbeat);
  }
}

export async function requeuePendingDeletionJobs(limit = 100): Promise<void> {
  const result = await query<{ id: string }>(
    `SELECT id
     FROM course_deletion_jobs
     WHERE is_terminal = false
       AND (
         (status IN ('queued', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
         OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
       )
     ORDER BY requested_at ASC
     LIMIT $1`,
    [limit],
  );

  for (const row of result.rows) {
    await publishDeleteJob(row.id);
  }
}

/** Explicit operator retry for a job that exhausted the automatic retry budget. */
export async function retryTerminalCourseDeletionJob(jobId: string, tenantId: string): Promise<void> {
  const result = await query<{
    id: string;
    course_id: string;
    root_block_id: string | null;
    target_type: DeleteTargetType;
  }>(
    `UPDATE course_deletion_jobs
     SET status = 'queued',
         is_terminal = false,
         attempts = 0,
         started_at = NULL,
         finished_at = NULL,
         next_attempt_at = now(),
         lease_expires_at = NULL,
         last_error = NULL,
         updated_at = now()
     WHERE id = $1::uuid
       AND tenant_id = $2::uuid
       AND is_terminal = true
       AND course_id IS NOT NULL
     RETURNING id, course_id, root_block_id, target_type`,
    [jobId, tenantId],
  );
  const job = result.rows[0];
  if (!job) throw new AppError('Không tìm thấy deletion job terminal để retry', 404);

  if (job.target_type === 'course') {
    await query(
      `UPDATE courses
       SET delete_status = 'queued', updated_at = now()
       WHERE id = $1::varchar AND tenant_id = $2::uuid AND deleted_at IS NOT NULL`,
      [job.course_id, tenantId],
    );
  } else if (job.root_block_id) {
    await query(
      `UPDATE course_blocks
       SET delete_status = 'queued', updated_at = now()
       WHERE id = $1::uuid AND course_id = $2::varchar AND deleted_at IS NOT NULL`,
      [job.root_block_id, job.course_id],
    );
  }

  await publishDeleteJob(job.id);
}

export async function getCourseDeletionJobStatus(jobId: string, tenantId: string) {
  const result = await query<{
    id: string;
    course_id: string | null;
    target_type: DeleteTargetType;
    status: DeleteJobStatus;
    requested_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
    attempts: number;
    is_terminal: boolean;
    next_attempt_at: Date | null;
    last_error: string | null;
    stats: PurgeStats;
  }>(
    `SELECT id, course_id, target_type, status, requested_at, started_at, finished_at, attempts,
            is_terminal, next_attempt_at, last_error, stats
     FROM course_deletion_jobs
     WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [jobId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Deletion job not found', 404);
  return result.rows[0];
}
