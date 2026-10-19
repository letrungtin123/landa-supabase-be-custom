import { afterCommit, query, getClient, withDatabaseTransaction } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { env } from '../../config/env.js';
import {
  invalidateBlockReadCaches,
  invalidateCourseReadCaches,
  invalidateTenantBadgeCaches,
  invalidateTenantCourseCaches,
  invalidateTenantNotificationCaches,
} from '../../config/cache-invalidation.js';
import { extractStoragePath } from '../../config/storage.js';
import { publish, QUEUES } from '../../config/rabbitmq/index.js';
import { AppError } from '../../utils/errors.js';
import {
  deleteStorageManifest,
  registerStorageManifestPaths,
  registerStoragePrefixManifestPaths,
} from '../deletion/storage-manifest.service.js';
import { classifyCourseMentorLogoOwnership } from '../courses/course-mentor-logo-ownership.logic.js';
import {
  createCourseDeletionRepository,
  type BlockPayloadRow,
  type CourseDeletionDb,
  type CourseReferenceTable,
  type DeleteJobRow,
} from './course-deletion.repository.js';

const DELETE_BATCH_SIZE = 500;
const ASSET_BATCH_SIZE = 100;
const CACHE_INVALIDATION_BATCH_SIZE = 500;
const JOB_LEASE_SECONDS = 15 * 60;

/** Statements on the pool (they join the current transaction, if any). */
const deletionRepository = createCourseDeletionRepository({ query } satisfies CourseDeletionDb);

const FIRST_UUID = '00000000-0000-0000-0000-000000000000';

interface PurgeStats {
  blocksDeleted: number;
  assetsDeleted: number;
  storageDeleteRequested: number;
  enrollmentsDeleted: number;
  linkedRowsDeleted: number;
  rowsUpdated: number;
  warnings: RetainedStorageReferenceWarning[];
}

interface RetainedStorageReferenceWarning {
  code: 'course_deletion.storage_reference_retained';
  source: string;
  reason: string;
  storage_path?: string;
}

function emptyStats(): PurgeStats {
  return {
    blocksDeleted: 0,
    assetsDeleted: 0,
    storageDeleteRequested: 0,
    enrollmentsDeleted: 0,
    linkedRowsDeleted: 0,
    rowsUpdated: 0,
    warnings: [],
  };
}

function addStats(total: PurgeStats, next: Partial<PurgeStats>): void {
  for (const [key, value] of Object.entries(next)) {
    if (key === 'warnings' || typeof value !== 'number') continue;
    const statKey = key as Exclude<keyof PurgeStats, 'warnings'>;
    total[statKey] += value;
  }
}

async function invalidateBlockReadCachesInBatches(blockIds: readonly string[]): Promise<void> {
  for (let index = 0; index < blockIds.length; index += CACHE_INVALIDATION_BATCH_SIZE) {
    await invalidateBlockReadCaches(blockIds.slice(index, index + CACHE_INVALIDATION_BATCH_SIZE));
  }
}

async function getBlockSubtreeIds(blockId: string, courseId: string): Promise<string[]> {
  return deletionRepository.selectBlockSubtreeIds(blockId, courseId);
}

function normalizeCourseStoragePath(value: unknown, tenantId: string, courseId: string): string | null {
  const extracted = normalizeTenantCourseStoragePath(value, tenantId);
  if (!extracted) return null;
  if (!extracted.startsWith(`${tenantId}/courses/${courseId}/`)) return null;
  return extracted;
}

async function assertNoActiveOutlineTransferForCourse(
  client: Awaited<ReturnType<typeof getClient>>,
  tenantId: string,
  courseId: string,
): Promise<void> {
  // This is additive-schema aware so deployments remain safe until the user
  // has manually applied the approved transfer-job SQL file.
  const repository = createCourseDeletionRepository(client);
  if (!await repository.selectOutlineTransferTable()) return;
  if (await repository.hasActiveOutlineTransfer(tenantId, courseId)) {
    throw new AppError('Khóa học đang có yêu cầu chuyển nội dung. Vui lòng chờ xử lý hoàn tất trước khi xóa.', 409);
  }
}

/** A row in course_assets is the authority for a moved asset. Its object key
 * can intentionally retain the former course id, so never infer ownership
 * only from that segment when an asset row has already been tenant-scoped. */
function normalizeTenantCourseStoragePath(value: unknown, tenantId: string): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 1200) return null;

  const extracted = extractStoragePath(raw);
  if (!extracted) return null;
  if (!extracted.startsWith(`${tenantId}/courses/`)) return null;
  if (/[<>"'`\\]/.test(extracted)) return null;
  return extracted;
}

function collectPathsFromString(
  value: string,
  tenantId: string,
  courseId: string,
  paths: Set<string>,
  allowedAssetPaths?: ReadonlySet<string>,
): void {
  const direct = normalizeCourseStoragePath(value, tenantId, courseId);
  if (direct) paths.add(direct);
  else {
    const movedAssetPath = normalizeTenantCourseStoragePath(value, tenantId);
    if (movedAssetPath && allowedAssetPaths?.has(movedAssetPath)) paths.add(movedAssetPath);
  }

  const imgSrcRegex = /<img[^>]+src=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = imgSrcRegex.exec(value)) !== null) {
    const srcPath = normalizeCourseStoragePath(match[1], tenantId, courseId);
    if (srcPath) paths.add(srcPath);
    else {
      const movedAssetPath = normalizeTenantCourseStoragePath(match[1], tenantId);
      if (movedAssetPath && allowedAssetPaths?.has(movedAssetPath)) paths.add(movedAssetPath);
    }
  }
}

function collectPathsFromValue(
  value: unknown,
  tenantId: string,
  courseId: string,
  paths: Set<string>,
  allowedAssetPaths?: ReadonlySet<string>,
): void {
  if (value == null) return;
  if (typeof value === 'string') {
    collectPathsFromString(value, tenantId, courseId, paths, allowedAssetPaths);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathsFromValue(item, tenantId, courseId, paths, allowedAssetPaths);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectPathsFromValue(item, tenantId, courseId, paths, allowedAssetPaths);
    }
  }
}

function collectPathsFromBlocks(
  rows: BlockPayloadRow[],
  tenantId: string,
  courseId: string,
  allowedAssetPaths?: ReadonlySet<string>,
): string[] {
  const paths = new Set<string>();
  for (const row of rows) {
    collectPathsFromValue(row.data, tenantId, courseId, paths, allowedAssetPaths);
    collectPathsFromValue(row.metadata, tenantId, courseId, paths, allowedAssetPaths);
    collectPathsFromValue(row.published_data, tenantId, courseId, paths, allowedAssetPaths);
    collectPathsFromValue(row.published_metadata, tenantId, courseId, paths, allowedAssetPaths);
  }
  return [...paths];
}

async function getCourseAssetPathSet(tenantId: string, courseId: string): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const row of await deletionRepository.selectCourseAssetPaths(tenantId, courseId)) {
    const storagePath = normalizeTenantCourseStoragePath(row.storage_path, tenantId);
    const urlPath = normalizeTenantCourseStoragePath(row.url, tenantId);
    if (storagePath) paths.add(storagePath);
    if (urlPath) paths.add(urlPath);
  }
  return paths;
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

/**
 * Build the durable object-key manifest before any course rows are purged.
 * Every high-cardinality query is keyset-paginated to stay bounded at scale.
 */
function toRetainedStorageReferenceWarning(
  source: string,
  reason: string,
  storagePath?: string,
): RetainedStorageReferenceWarning {
  return {
    code: 'course_deletion.storage_reference_retained',
    source,
    reason,
    ...(storagePath ? { storage_path: storagePath } : {}),
  };
}

function retainedStorageReferenceWarningForValue(
  value: unknown,
  tenantId: string,
  source: string,
): RetainedStorageReferenceWarning | null {
  if (value == null || value === '') return null;
  const raw = typeof value === 'string' ? value.trim() : '';
  const extracted = raw ? extractStoragePath(raw) : null;
  const safeTenantPath = extracted
    && extracted.startsWith(`${tenantId}/`)
    && !extracted.includes('..')
    && !/[<>"'`\\]/.test(extracted)
    ? extracted
    : undefined;
  return toRetainedStorageReferenceWarning(
    source,
    safeTenantPath ? 'unrecognized-tenant-path' : 'foreign-or-untrusted-tenant-path',
    safeTenantPath,
  );
}

function warnRetainedStorageReference(job: DeleteJobRow, warning: RetainedStorageReferenceWarning): void {
  console.warn('[CourseDelete] storage_reference_retained', {
    event: warning.code,
    deletion_job_id: job.id,
    tenant_id: job.tenant_id,
    course_id: job.course_id,
    ...warning,
  });
}

function warningKey(warning: RetainedStorageReferenceWarning): string {
  return `${warning.code}|${warning.source}|${warning.reason}|${warning.storage_path || ''}`;
}

function mergeRetainedStorageReferenceWarnings(
  ...warningSets: ReadonlyArray<ReadonlyArray<RetainedStorageReferenceWarning>>
): RetainedStorageReferenceWarning[] {
  const warnings = new Map<string, RetainedStorageReferenceWarning>();
  for (const warning of warningSets.flat()) warnings.set(warningKey(warning), warning);
  return [...warnings.values()];
}

function parseRetainedStorageReferenceWarnings(value: unknown): RetainedStorageReferenceWarning[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RetainedStorageReferenceWarning[] => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (row.code !== 'course_deletion.storage_reference_retained'
      || typeof row.source !== 'string'
      || typeof row.reason !== 'string'
      || (row.storage_path !== undefined && typeof row.storage_path !== 'string')) return [];
    return [{
      code: row.code,
      source: row.source,
      reason: row.reason,
      ...(typeof row.storage_path === 'string' ? { storage_path: row.storage_path } : {}),
    }];
  });
}

async function getRetainedStorageReferenceWarnings(jobId: string): Promise<RetainedStorageReferenceWarning[]> {
  return parseRetainedStorageReferenceWarnings(await deletionRepository.selectWarnings(jobId));
}

async function persistRetainedStorageReferenceWarnings(
  job: DeleteJobRow,
  warnings: readonly RetainedStorageReferenceWarning[],
): Promise<void> {
  if (warnings.length === 0) return;
  await deletionRepository.saveWarnings(job.id, JSON.stringify(warnings));
}

function normalizeLessonAuthorStoragePath(value: unknown, tenantId: string): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 1200) return null;
  const path = extractStoragePath(raw);
  if (!path || !path.startsWith(`${tenantId}/lesson-author/`)) return null;
  if (path.includes('..') || /[<>"'`\\]/.test(path)) return null;
  return path;
}

async function registerLessonAuthorPrivateArtifactsForCourse(
  job: DeleteJobRow,
): Promise<RetainedStorageReferenceWarning[]> {
  if (!await deletionRepository.transcriptionJobsTableExists()) return [];

  const rows = await deletionRepository.selectTranscriptionPaths(job.tenant_id, job.course_id);
  const warnings: RetainedStorageReferenceWarning[] = [];
  const paths: string[] = [];
  for (const row of rows) {
    for (const [source, value] of [
      ['lesson_author_transcription_jobs.source_storage_path', row.source_storage_path],
      ['lesson_author_transcription_jobs.transcript_storage_path', row.transcript_storage_path],
    ] as const) {
      if (value == null || value === '') continue;
      const path = normalizeLessonAuthorStoragePath(value, job.tenant_id);
      if (path) paths.push(path);
      else warnings.push(toRetainedStorageReferenceWarning(source, 'foreign-or-untrusted-tenant-path'));
    }
  }
  await registerStorageManifestPaths('course', job.id, job.tenant_id, paths);
  return warnings;
}

async function ensureCourseStorageManifest(job: DeleteJobRow): Promise<RetainedStorageReferenceWarning[]> {
  if (job.target_type !== 'course') return [];
  if (await deletionRepository.selectManifestCompletedAt(job.id)) return [];

  const directPaths = new Set<string>();

  const [course, mentor] = await Promise.all([
    deletionRepository.selectCourseImage(job.course_id, job.tenant_id),
    deletionRepository.selectMentorLogos(job.course_id, job.tenant_id),
  ]);
  if (course.rowCount === 0) return [];
  const warnings: RetainedStorageReferenceWarning[] = [];
  const imagePath = normalizeCourseStoragePath(course.rows[0].image_url, job.tenant_id, job.course_id);
  if (imagePath) directPaths.add(imagePath);
  else {
    const warning = retainedStorageReferenceWarningForValue(course.rows[0].image_url, job.tenant_id, 'courses.image_url');
    if (warning) warnings.push(warning);
  }

  for (const [source, value] of [
    ['course_mentor_sections.logo_light_path', mentor?.logo_light_path],
    ['course_mentor_sections.logo_dark_path', mentor?.logo_dark_path],
  ] as const) {
    const ownership = classifyCourseMentorLogoOwnership(value, job.tenant_id, job.course_id);
    if (ownership.kind === 'course-owned') {
      directPaths.add(ownership.storagePath);
    } else if (ownership.kind === 'unknown') {
      const warning = toRetainedStorageReferenceWarning(source, ownership.reason, ownership.storagePath);
      warnings.push(warning);
    }
  }
  await registerStorageManifestPaths('course', job.id, job.tenant_id, [...directPaths]);
  warnings.push(...await registerLessonAuthorPrivateArtifactsForCourse(job));

  // course_assets is the ownership authority for a transferred outline asset.
  // Keep the set to validate payload references later without allowing a
  // crafted block JSON to delete an object owned by another course.
  const courseAssetPaths = new Set<string>();
  let lastAssetId = '';
  while (true) {
    const rows = await deletionRepository.selectCourseAssetPage(job.tenant_id, job.course_id, lastAssetId || FIRST_UUID, ASSET_BATCH_SIZE);
    if (rows.rowCount === 0) break;
    const paths: string[] = [];
    for (const row of rows.rows) {
      for (const [source, value] of [
        ['course_assets.storage_path', row.storage_path],
        ['course_assets.url', row.url],
      ] as const) {
        const path = normalizeTenantCourseStoragePath(value, job.tenant_id);
        if (path) paths.push(path);
        else {
          const warning = retainedStorageReferenceWarningForValue(value, job.tenant_id, source);
          if (warning) warnings.push(warning);
        }
      }
    }
    for (const path of paths) courseAssetPaths.add(path);
    await registerStorageManifestPaths('course', job.id, job.tenant_id, paths);
    lastAssetId = rows.rows[rows.rows.length - 1].id;
  }

  let lastBlockId = '';
  while (true) {
    const rows = await deletionRepository.selectBlockPayloadPage(job.course_id, lastBlockId || FIRST_UUID, DELETE_BATCH_SIZE);
    if (rows.rowCount === 0) break;
    await registerStorageManifestPaths(
      'course',
      job.id,
      job.tenant_id,
      collectPathsFromBlocks(rows.rows, job.tenant_id, job.course_id, courseAssetPaths),
    );
    // Invalidate before the destructive phase, in bounded batches. This
    // prevents a cached learner block from surviving a full-course purge and
    // avoids materialising every block ID in Node for very large courses.
    await invalidateBlockReadCaches(rows.rows.map((row) => row.id));
    lastBlockId = rows.rows[rows.rows.length - 1].id;
  }

  let lastAssignmentId = '';
  while (true) {
    const rows = await deletionRepository.selectAssignmentAttachmentPage(job.course_id, lastAssignmentId || FIRST_UUID, DELETE_BATCH_SIZE);
    if (rows.rowCount === 0) break;
    const paths: string[] = [];
    for (const row of rows.rows) {
      const path = normalizeAssignmentStoragePath(row.storage_path, job.tenant_id, job.course_id);
      if (path) paths.push(path);
      else {
        const warning = retainedStorageReferenceWarningForValue(
          row.storage_path,
          job.tenant_id,
          'course_assignments.attachment_file.storage_path',
        );
        if (warning) warnings.push(warning);
      }
    }
    await registerStorageManifestPaths('course', job.id, job.tenant_id, paths);
    lastAssignmentId = rows.rows[rows.rows.length - 1].id;
  }

  let lastFileId = '';
  while (true) {
    const rows = await deletionRepository.selectAssignmentFilePage(job.course_id, lastFileId || FIRST_UUID, DELETE_BATCH_SIZE);
    if (rows.rowCount === 0) break;
    const paths: string[] = [];
    for (const row of rows.rows) {
      const path = normalizeAssignmentStoragePath(row.storage_path, job.tenant_id, job.course_id);
      if (path) paths.push(path);
      else {
        const warning = retainedStorageReferenceWarningForValue(row.storage_path, job.tenant_id, 'assignment_files.storage_path');
        if (warning) warnings.push(warning);
      }
    }
    await registerStorageManifestPaths('course', job.id, job.tenant_id, paths);
    lastFileId = rows.rows[rows.rows.length - 1].id;
  }

  // DB references miss failed/abandoned uploads. Discover both server-owned
  // prefixes directly from storage before the course rows are purged.
  await registerStoragePrefixManifestPaths(
    'course',
    job.id,
    job.tenant_id,
    `${job.tenant_id}/courses/${job.course_id}/`,
    // A moved outline asset intentionally keeps the source course segment in
    // Storage. course_assets is the ownership authority, so the prefix sweep
    // must not enqueue an object now owned by a different course.
    { excludeCourseAssetReferencesForOtherCourses: job.course_id },
  );
  await registerStoragePrefixManifestPaths('course', job.id, job.tenant_id, `${job.tenant_id}/assignments/${job.course_id}/`);

  await deletionRepository.markManifestCompleted(job.id);
  for (const warning of warnings) warnRetainedStorageReference(job, warning);
  return warnings;
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
  auditEntry?: (jobId: string, courseName: string) => TransactionalAuditEntry,
): Promise<{ jobId: string }> {
  const client = await getClient();
  let jobId = '';

  try {
    await client.query('BEGIN');
    const repository = createCourseDeletionRepository(client);

    const courseResult = await repository.lockActiveCourse(courseId, tenantId);
    if (courseResult.rowCount === 0) {
      throw new AppError('Course not found', 404);
    }
    await assertNoActiveOutlineTransferForCourse(client, tenantId, courseId);

    jobId = await repository.insertCourseJob(tenantId, courseId, requestedBy);

    await repository.markCourseDeleteQueued(courseId, tenantId, jobId, requestedBy);

    // The course is permanently purged by the asynchronous worker. Preserve
    // its name in the audit row while the locked course record still exists.
    const courseName = courseResult.rows[0].display_name?.trim() || courseId;
    if (auditEntry) await appendAuditLog(client, auditEntry(jobId, courseName));

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
  auditEntry?: TransactionalAuditEntry,
): Promise<{ jobId: string; courseId: string }> {
  const client = await getClient();
  let jobId = '';
  let courseId = '';

  try {
    await client.query('BEGIN');
    const repository = createCourseDeletionRepository(client);

    const blockResult = await repository.lockActiveBlock(blockId, tenantId);
    if (blockResult.rowCount === 0) {
      throw new AppError('Block not found', 404);
    }
    if (blockResult.rows[0].block_type === 'course') {
      throw new AppError('Use course delete for root course block', 400);
    }

    courseId = blockResult.rows[0].course_id;
    await assertNoActiveOutlineTransferForCourse(client, tenantId, courseId);
    jobId = await repository.insertBlockJob(tenantId, courseId, blockId, requestedBy);

    await repository.markBlockDeleteQueued(blockId, jobId, requestedBy);

    if (auditEntry) await appendAuditLog(client, auditEntry);

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
  // The job committed on its own connection above. AI ID applies a delete
  // proposal inside its audited transaction (applyLessonAuthorJob): the
  // wake-up waits for that transaction instead of holding it open; if it
  // rolls back, the committed job is still picked up by the sweeper.
  await afterCommit(() => publishDeleteJob(jobId));
  return { jobId, courseId };
}

async function markJobRunning(jobId: string): Promise<DeleteJobRow | null> {
  return deletionRepository.markJobRunning(jobId, JOB_LEASE_SECONDS);
}

async function markJobSucceeded(jobId: string, stats: PurgeStats): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // The completed manifest contains object keys and is no longer needed once
    // the purge commits. Retaining it would itself become deletion residue.
    const repository = createCourseDeletionRepository(client);
    await repository.deleteManifestItems(jobId);
    await repository.deleteManifestScanCursors(jobId);
    await repository.markJobSucceeded(jobId, JSON.stringify(stats));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw error;
  } finally {
    client.release();
  }
}

export async function markJobRetryable(jobId: string, error: unknown): Promise<void> {
  const job = await deletionRepository.markJobRetryable({
    jobId,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
    maxAttempts: env.DELETION_MAX_ATTEMPTS,
    retryBaseMs: env.DELETION_RETRY_BASE_MS,
    retryMaxMs: env.DELETION_RETRY_MAX_MS,
  });
  if (!job?.is_terminal || !job.course_id) return;
  if (job.target_type === 'course') {
    await deletionRepository.markCourseDeleteFailed(job.course_id);
  } else if (job.root_block_id) {
    await deletionRepository.markBlockDeleteFailed(job.root_block_id);
  }
  console.error(`[CourseDelete] Job ${jobId} reached terminal failure after retry budget was exhausted`);
}

async function registerDeletedBlockAssetManifest(
  job: DeleteJobRow,
  rawPaths: string[],
): Promise<Partial<PurgeStats>> {
  const paths = [...new Set(rawPaths)];
  let assetsDeleted = 0;

  for (let i = 0; i < paths.length; i += ASSET_BATCH_SIZE) {
    const batch = paths.slice(i, i + ASSET_BATCH_SIZE);
    const assetRows = await deletionRepository.selectCourseAssetsByPaths(job.tenant_id, job.course_id, batch);

    const manifestPaths = new Set<string>(batch);
    for (const row of assetRows) {
      const storagePath = normalizeTenantCourseStoragePath(row.storage_path, job.tenant_id);
      if (storagePath) manifestPaths.add(storagePath);
      const urlPath = normalizeTenantCourseStoragePath(row.url, job.tenant_id);
      if (urlPath) manifestPaths.add(urlPath);
    }

    // The manifest write and DB reference deletion are in the same transaction
    // as the block deletion. Storage is drained only after that transaction
    // commits, so no committed row can point at an already-deleted object.
    await registerStorageManifestPaths('course', job.id, job.tenant_id, [...manifestPaths]);

    const deleted = await deletionRepository.deleteCourseAssetsByPaths(job.tenant_id, job.course_id, batch);
    assetsDeleted += deleted || 0;
  }

  return { assetsDeleted };
}

async function deleteAllCourseAssets(tenantId: string, courseId: string): Promise<Partial<PurgeStats>> {
  let assetsDeleted = 0;

  while (true) {
    const result = await deletionRepository.selectCourseAssetIdBatch(tenantId, courseId, ASSET_BATCH_SIZE);
    if (result.rowCount === 0) break;

    const ids = result.rows.map((row) => row.id);
    const deleted = await deletionRepository.deleteCourseAssetsByIds(ids);
    assetsDeleted += deleted || 0;
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
  const deleted = await deletionRepository.deleteAllCourseBlocks(courseId);
  return { blocksDeleted: deleted || 0 };
}

async function deleteLeafBlocksByRoot(
  job: DeleteJobRow,
): Promise<Partial<PurgeStats>> {
  const stats = emptyStats();
  if (!job.root_block_id) return stats;
  const courseAssetPaths = await getCourseAssetPathSet(job.tenant_id, job.course_id);

  while (true) {
    const batch = await withDatabaseTransaction(async () => {
      const result = await deletionRepository.deleteLeafBlockBatch(job.root_block_id!, job.course_id, DELETE_BATCH_SIZE);
      if (result.rowCount === 0) return null;

      const blockIds = result.rows.map((row) => row.id);
      const paths = collectPathsFromBlocks(result.rows, job.tenant_id, job.course_id, courseAssetPaths);
      const assetStats = await registerDeletedBlockAssetManifest(job, paths);
      const sectionConfigDeleted = await deletionRepository.deleteSectionModalConfigs(job.course_id, blockIds);
      const sectionShownDeleted = await deletionRepository.deleteSectionModalShown(job.course_id, blockIds);
      return {
        blocksDeleted: result.rowCount || 0,
        linkedRowsDeleted: (sectionConfigDeleted || 0) + (sectionShownDeleted || 0),
        ...assetStats,
      };
    });
    if (!batch) break;
    addStats(stats, batch);
  }

  return stats;
}

async function deleteEnrollmentsByCourse(tenantId: string, courseId: string): Promise<Partial<PurgeStats>> {
  let enrollmentsDeleted = 0;

  while (true) {
    const deleted = await deletionRepository.deleteEnrollmentBatch(tenantId, courseId, DELETE_BATCH_SIZE);
    if (deleted === 0) break;
    enrollmentsDeleted += deleted || 0;
  }

  return { enrollmentsDeleted };
}


async function isOptionalCourseReferenceTableAvailable(tableName: CourseReferenceTable): Promise<boolean> {
  if (tableName !== 'lesson_author_blueprints' && tableName !== 'lesson_author_transcription_jobs') return true;
  return deletionRepository.tableExists(tableName === 'lesson_author_blueprints' ? 'public.lesson_author_blueprints' : 'public.lesson_author_transcription_jobs');
}

async function deleteCourseReferenceInBatches(
  tableName: CourseReferenceTable,
  courseId: string,
): Promise<number> {
  // Keeps a rolling deployment safe when the application process comes up
  // before the additive Blueprint migration has been run manually.
  if (!(await isOptionalCourseReferenceTableAvailable(tableName))) return 0;
  let rowsDeleted = 0;

  while (true) {
    const deleted = await deletionRepository.deleteCourseReferenceBatch(tableName, courseId, DELETE_BATCH_SIZE);
    if (deleted === 0) break;
    rowsDeleted += deleted || 0;
  }

  return rowsDeleted;
}

async function deleteCourseOutboxInBatches(courseId: string): Promise<number> {
  let rowsDeleted = 0;
  while (true) {
    const deleted = await deletionRepository.deleteCourseOutboxBatch(courseId, DELETE_BATCH_SIZE);
    if (deleted === 0) return rowsDeleted;
    rowsDeleted += deleted || 0;
  }
}

async function touchJobLease(jobId: string): Promise<void> {
  await deletionRepository.touchJobLease(jobId, JOB_LEASE_SECONDS);
}

async function deleteCourseLinkedRows(courseId: string): Promise<Partial<PurgeStats>> {
  const directCourseTables: readonly CourseReferenceTable[] = [
    'notification_email_jobs',
    'lesson_author_blueprints',
    'lesson_author_jobs',
    'lesson_author_transcription_jobs',
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

  // Audit rows stay available until their fixed 30-day retention cleanup.
  // Other related data remains bounded to avoid one large WAL/lock spike.
  let linkedRowsDeleted = await deleteCourseOutboxInBatches(courseId);
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

  await deletionRepository.markCourseDeleteRunning(job.course_id, job.tenant_id);

  if (!await deletionRepository.courseExists(job.course_id, job.tenant_id)) return stats;

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
  stats.linkedRowsDeleted += await deletionRepository.purgeCourseBackupPii(job.course_id);
  addStats(stats, await deleteEnrollmentsByCourse(job.tenant_id, job.course_id));

  const deletedCourse = await deletionRepository.deleteCourse(job.course_id, job.tenant_id);

  if ((deletedCourse || 0) > 0) {
    await invalidateTenantBadgeCaches(job.tenant_id);
    // The course's notifications were deleted with it (unread counts).
    await invalidateTenantNotificationCaches(job.tenant_id);
  }

  return stats;
}

async function purgeBlock(job: DeleteJobRow): Promise<PurgeStats> {
  const stats = emptyStats();
  if (!job.root_block_id) return stats;

  await deletionRepository.markBlockDeleteRunning(job.root_block_id);

  addStats(stats, await deleteLeafBlocksByRoot(job));
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
      const existingWarnings = await getRetainedStorageReferenceWarnings(job.id);
      const discoveredWarnings = await ensureCourseStorageManifest(job);
      const warnings = mergeRetainedStorageReferenceWarnings(existingWarnings, discoveredWarnings);
      await persistRetainedStorageReferenceWarnings(job, warnings);

      // All database references are removed first. The durable manifest stays
      // intact across a storage failure, so a retry can safely re-run the
      // idempotent object removal after the database transaction has committed.
      stats = await purgeCourse(job);
      stats.warnings = warnings;
      await touchJobLease(job.id);
      stats.storageDeleteRequested += await deleteStorageManifest('course', job.id);
    } else {
      stats = await purgeBlock(job);
      await touchJobLease(job.id);
      stats.storageDeleteRequested += await deleteStorageManifest('course', job.id);
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
  for (const id of await deletionRepository.selectRunnableJobIds(limit)) {
    await publishDeleteJob(id);
  }
}

/** Explicit operator retry for a job that exhausted the automatic retry budget. */
export async function retryTerminalCourseDeletionJob(jobId: string, tenantId: string): Promise<void> {
  const job = await deletionRepository.requeueTerminalJob(jobId, tenantId);
  if (!job) throw new AppError('Không tìm thấy deletion job terminal để retry', 404);

  if (job.target_type === 'course') {
    await deletionRepository.markCourseDeleteRequeued(job.course_id, tenantId);
  } else if (job.root_block_id) {
    await deletionRepository.markBlockDeleteRequeued(job.root_block_id, job.course_id);
  }

  // The retry endpoint runs this inside its audited transaction: the wake-up
  // is sent once that commits and never holds the transaction open. A message
  // lost after the commit is recovered by requeuePendingDeletionJobs().
  await afterCommit(() => publishDeleteJob(job.id));
}

export async function getCourseDeletionJobStatus(jobId: string, tenantId: string) {
  const result = await deletionRepository.selectJobStatus<PurgeStats>(jobId, tenantId);
  if (result.rowCount === 0) throw new AppError('Deletion job not found', 404);
  return result.rows[0];
}
