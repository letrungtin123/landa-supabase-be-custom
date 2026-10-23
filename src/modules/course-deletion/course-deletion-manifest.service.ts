// ═══════════════════════════════════════════════════════════════
// Course deletion storage manifest: before any database row is purged, every
// Storage object a course or a block refers to (assets, block payloads,
// course images, mentor logos, lesson-author artifacts, the course prefix)
// is registered in the durable manifest, and the references that must be
// kept are recorded as warnings on the job. Moved unchanged from
// course-deletion.service.ts.
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { invalidateBlockReadCaches } from '../../config/cache-invalidation.js';
import { extractStoragePath } from '../../config/storage.js';
import {
  registerStorageManifestPaths,
  registerStoragePrefixManifestPaths,
} from '../deletion/storage-manifest.service.js';
import { classifyCourseMentorLogoOwnership } from '../courses/course-mentor-logo-ownership.logic.js';
import {
  createCourseDeletionRepository,
  type BlockPayloadRow,
  type CourseDeletionDb,
  type DeleteJobRow,
} from './course-deletion.repository.js';
import { ASSET_BATCH_SIZE, DELETE_BATCH_SIZE, FIRST_UUID } from './course-deletion.constants.js';

/** Statements on the pool (they join the current transaction, if any). */
const deletionRepository = createCourseDeletionRepository({ query } satisfies CourseDeletionDb);

export interface RetainedStorageReferenceWarning {
  code: 'course_deletion.storage_reference_retained';
  source: string;
  reason: string;
  storage_path?: string;
}

function normalizeCourseStoragePath(value: unknown, tenantId: string, courseId: string): string | null {
  const extracted = normalizeTenantCourseStoragePath(value, tenantId);
  if (!extracted) return null;
  if (!extracted.startsWith(`${tenantId}/courses/${courseId}/`)) return null;
  return extracted;
}

/** A row in course_assets is the authority for a moved asset. Its object key
 * can intentionally retain the former course id, so never infer ownership
 * only from that segment when an asset row has already been tenant-scoped. */
export function normalizeTenantCourseStoragePath(value: unknown, tenantId: string): string | null {
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

export function collectPathsFromBlocks(
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

export async function getCourseAssetPathSet(tenantId: string, courseId: string): Promise<Set<string>> {
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

export function mergeRetainedStorageReferenceWarnings(
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

export async function getRetainedStorageReferenceWarnings(jobId: string): Promise<RetainedStorageReferenceWarning[]> {
  return parseRetainedStorageReferenceWarnings(await deletionRepository.selectWarnings(jobId));
}

export async function persistRetainedStorageReferenceWarnings(
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

export async function ensureCourseStorageManifest(job: DeleteJobRow): Promise<RetainedStorageReferenceWarning[]> {
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
