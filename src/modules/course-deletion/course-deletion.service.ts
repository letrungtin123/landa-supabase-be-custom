import { query, getClient } from '../../config/database.js';
import {
  invalidateBlockReadCaches,
  invalidateCourseReadCaches,
  invalidateTenantBadgeCaches,
  invalidateTenantCourseCaches,
} from '../../config/cache-invalidation.js';
import { deleteFile, deleteFileByUrl, extractStoragePath } from '../../config/storage.js';
import { publish, QUEUES } from '../../config/rabbitmq/index.js';
import { AppError } from '../../middleware/error-handler.js';

const DELETE_BATCH_SIZE = 500;
const ASSET_BATCH_SIZE = 100;
const CACHE_INVALIDATION_BATCH_SIZE = 500;

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

async function getCourseBlockIds(courseId: string): Promise<string[]> {
  const result = await query<{ id: string }>(
    'SELECT id FROM course_blocks WHERE course_id = $1',
    [courseId],
  );
  return result.rows.map((row) => row.id);
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

  const blockIds = await getCourseBlockIds(courseId);
  await Promise.all([
    invalidateTenantCourseCaches(tenantId),
    invalidateCourseReadCaches(courseId, tenantId),
    invalidateBlockReadCachesInBatches(blockIds),
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
         updated_at = now()
     WHERE id = $1
       AND (
         status IN ('queued', 'failed')
         OR (status = 'running' AND updated_at < now() - interval '10 minutes')
       )
     RETURNING id, tenant_id, course_id, root_block_id, target_type, status, attempts`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

async function markJobSucceeded(jobId: string, stats: PurgeStats): Promise<void> {
  await query(
    `UPDATE course_deletion_jobs
     SET status = 'succeeded',
         finished_at = now(),
         updated_at = now(),
         stats = $2::jsonb,
         last_error = NULL
     WHERE id = $1`,
    [jobId, JSON.stringify(stats)],
  );
}

export async function markJobRetryable(jobId: string, error: unknown): Promise<void> {
  await query(
    `UPDATE course_deletion_jobs
     SET status = 'queued',
         last_error = $2,
         updated_at = now()
     WHERE id = $1 AND status <> 'succeeded'`,
    [jobId, error instanceof Error ? error.message : String(error)],
  );
}

export async function markJobFailed(jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await query(
    `UPDATE course_deletion_jobs
     SET status = 'failed',
         finished_at = now(),
         last_error = $2,
         updated_at = now()
     WHERE id = $1 AND status <> 'succeeded'`,
    [jobId, message],
  );
  await query(
    `UPDATE courses
     SET delete_status = 'failed', updated_at = now()
     WHERE delete_job_id = $1 AND deleted_at IS NOT NULL`,
    [jobId],
  );
  await query(
    `UPDATE course_blocks
     SET delete_status = 'failed', updated_at = now()
     WHERE delete_job_id = $1 AND deleted_at IS NOT NULL`,
    [jobId],
  );
}

async function deleteAssetsAndFilesByPaths(
  tenantId: string,
  courseId: string,
  rawPaths: string[],
): Promise<Partial<PurgeStats>> {
  const paths = [...new Set(rawPaths)];
  let assetsDeleted = 0;
  let storageDeleteRequested = 0;

  for (let i = 0; i < paths.length; i += ASSET_BATCH_SIZE) {
    const batch = paths.slice(i, i + ASSET_BATCH_SIZE);
    const assetResult = await query<{ storage_path: string | null; url: string | null }>(
      `DELETE FROM course_assets
       WHERE tenant_id = $1
         AND course_id = $2
         AND (storage_path = ANY($3::text[]) OR url = ANY($3::text[]))
       RETURNING storage_path, url`,
      [tenantId, courseId, batch],
    );
    assetsDeleted += assetResult.rowCount || 0;

    const deletePaths = new Set<string>(batch);
    for (const row of assetResult.rows) {
      const storagePath = normalizeCourseStoragePath(row.storage_path, tenantId, courseId);
      if (storagePath) deletePaths.add(storagePath);
      const urlPath = normalizeCourseStoragePath(row.url, tenantId, courseId);
      if (urlPath) deletePaths.add(urlPath);
    }

    storageDeleteRequested += deletePaths.size;
    await Promise.allSettled([...deletePaths].map((path) => deleteFile(path)));
  }

  return { assetsDeleted, storageDeleteRequested };
}

async function deleteAllCourseAssets(tenantId: string, courseId: string): Promise<Partial<PurgeStats>> {
  let assetsDeleted = 0;
  let storageDeleteRequested = 0;

  while (true) {
    const result = await query<{ id: string; storage_path: string | null; url: string | null }>(
      `SELECT id, storage_path, url
       FROM course_assets
       WHERE tenant_id = $1 AND course_id = $2
       LIMIT $3`,
      [tenantId, courseId, ASSET_BATCH_SIZE],
    );
    if (result.rowCount === 0) break;

    const ids = result.rows.map((row) => row.id);
    const paths = new Set<string>();
    for (const row of result.rows) {
      const storagePath = normalizeCourseStoragePath(row.storage_path, tenantId, courseId);
      if (storagePath) paths.add(storagePath);
      const urlPath = normalizeCourseStoragePath(row.url, tenantId, courseId);
      if (urlPath) paths.add(urlPath);
    }

    storageDeleteRequested += paths.size;
    await Promise.allSettled([...paths].map((path) => deleteFile(path)));

    const deleted = await query(
      `DELETE FROM course_assets WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    assetsDeleted += deleted.rowCount || 0;
  }

  return { assetsDeleted, storageDeleteRequested };
}

async function deleteLeafBlocksByCourse(
  tenantId: string,
  courseId: string,
): Promise<Partial<PurgeStats>> {
  let blocksDeleted = 0;
  const stats = emptyStats();

  while (true) {
    const result = await query<BlockPayloadRow>(
      `WITH doomed AS (
         SELECT b.id
         FROM course_blocks b
         WHERE b.course_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM course_blocks child WHERE child.parent_id = b.id
           )
         LIMIT $2
       )
       DELETE FROM course_blocks b
       USING doomed
       WHERE b.id = doomed.id
       RETURNING b.id, b.data, b.metadata, b.published_data, b.published_metadata`,
      [courseId, DELETE_BATCH_SIZE],
    );
    if (result.rowCount === 0) break;

    blocksDeleted += result.rowCount || 0;
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

  stats.blocksDeleted += blocksDeleted;
  return stats;
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

async function nullCourseReferenceInBatches(tableName: 'notifications' | 'study_sessions', courseId: string): Promise<number> {
  let rowsUpdated = 0;

  while (true) {
    const result = await query(
      `WITH rows AS (
         SELECT ctid
         FROM ${tableName}
         WHERE course_id = $1
         LIMIT $2
       )
       UPDATE ${tableName} t
       SET course_id = NULL
       FROM rows
       WHERE t.ctid = rows.ctid`,
      [courseId, DELETE_BATCH_SIZE],
    );
    if (result.rowCount === 0) break;
    rowsUpdated += result.rowCount || 0;
  }

  return rowsUpdated;
}

async function deleteCourseLinkedRows(courseId: string): Promise<Partial<PurgeStats>> {
  const statements = [
    `DELETE FROM team_courses WHERE course_id = $1`,
    `DELETE FROM course_category_courses WHERE course_id = $1`,
    `DELETE FROM course_modal_configs WHERE course_id = $1`,
    `DELETE FROM course_modal_states WHERE course_id = $1`,
    `DELETE FROM section_modal_configs WHERE course_id = $1`,
    `DELETE FROM section_modal_shown WHERE course_id = $1`,
  ];

  let linkedRowsDeleted = 0;
  for (const sql of statements) {
    const result = await query(sql, [courseId]);
    linkedRowsDeleted += result.rowCount || 0;
  }

  const rowsUpdated =
    await nullCourseReferenceInBatches('notifications', courseId) +
    await nullCourseReferenceInBatches('study_sessions', courseId);

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

  const course = await query<{ image_url: string | null }>(
    `SELECT image_url FROM courses WHERE id = $1 AND tenant_id = $2`,
    [job.course_id, job.tenant_id],
  );

  if (course.rowCount === 0) return stats;

  addStats(stats, await deleteAllCourseAssets(job.tenant_id, job.course_id));
  addStats(stats, await deleteLeafBlocksByCourse(job.tenant_id, job.course_id));
  addStats(stats, await deleteEnrollmentsByCourse(job.tenant_id, job.course_id));
  addStats(stats, await deleteCourseLinkedRows(job.course_id));

  if (course.rows[0].image_url) {
    await deleteFileByUrl(course.rows[0].image_url).catch(() => {});
    stats.storageDeleteRequested += 1;
  }

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

  const blockIdsToInvalidate = job.target_type === 'course'
    ? await getCourseBlockIds(job.course_id)
    : job.root_block_id
      ? await getBlockSubtreeIds(job.root_block_id, job.course_id)
      : [];

  const stats = job.target_type === 'course'
    ? await purgeCourse(job)
    : await purgeBlock(job);

  await markJobSucceeded(job.id, stats);
  if (job.target_type === 'course') {
    await Promise.all([
      invalidateTenantCourseCaches(job.tenant_id),
      invalidateCourseReadCaches(job.course_id, job.tenant_id),
      invalidateBlockReadCachesInBatches(blockIdsToInvalidate),
    ]);
  } else {
    await Promise.all([
      invalidateCourseReadCaches(job.course_id, job.tenant_id),
      invalidateBlockReadCachesInBatches(blockIdsToInvalidate),
    ]);
  }
}

export async function requeuePendingDeletionJobs(limit = 100): Promise<void> {
  const result = await query<{ id: string }>(
    `SELECT id
     FROM course_deletion_jobs
     WHERE status IN ('queued', 'running')
     ORDER BY requested_at ASC
     LIMIT $1`,
    [limit],
  );

  for (const row of result.rows) {
    await publishDeleteJob(row.id);
  }
}
