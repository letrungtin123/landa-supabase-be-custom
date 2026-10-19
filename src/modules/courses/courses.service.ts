// ═══════════════════════════════════════════════════════════════
// Courses Service — CRUD courses + modal configs
// ═══════════════════════════════════════════════════════════════

import { getClient, query } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import {
  invalidateCourseReadCaches,
  invalidateTenantCourseCaches,
} from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import { assertCourseBelongsToTenant } from './course-access.service.js';
import { classifyCourseMentorLogoOwnership } from './course-mentor-logo-ownership.logic.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import { uploadFile, deleteFile, buildFileName, buildStoragePath, fixMulterFilename } from '../../config/storage.js';
import { getTenantRoleLabels, type RoleLabelMap } from '../tenants/tenant-role-labels.service.js';
import { withoutAuthorOnlyBlockMetadata } from '../course-authoring/course-author-notes.logic.js';
import { buildCourseMarkdown, markdownFilename } from './course-markdown-exporter.js';
import { swallowAndLog } from '../../utils/best-effort.js';
import {
  createCoursesRepository,
  type CourseMentorColumns,
  type CoursesDb,
  type MentorAssignmentHistoryRow,
  type MentorUserRow,
} from './courses.repository.js';
import {
  createCourseMentorSectionRepository,
  type CourseMentorSectionRow,
} from './course-mentor-section.repository.js';
import { createCourseModalConfigRepository } from './course-modal-config.repository.js';

// query() joins the caller's current transaction (withDatabaseTransaction) when there is one.
const poolDb: CoursesDb = { query };
const coursesRepository = createCoursesRepository(poolDb);
const mentorSectionRepository = createCourseMentorSectionRepository(poolDb);
const modalConfigRepository = createCourseModalConfigRepository(poolDb);

interface CourseMentor {
  id: string;
  username: string;
  full_name: string | null;
  email: string;
  phone: string | null;
  avatar: string | null;
  role: string;
  role_label: string;
  bio: string | null;
}

type MentorAssignmentAction = 'assign' | 'remove';

const MENTOR_HISTORY_DEFAULT_PAGE_SIZE = 5;
const MENTOR_HISTORY_PAGE_SIZES = new Set([5, 10, 15, 20]);
const MENTOR_HISTORY_MAX_SEARCH_LENGTH = 100;

interface CourseMentorAssignmentHistoryItem {
  id: string;
  assigned_by_id: string | null;
  assigned_by_name: string;
  assigned_to_id: string | null;
  assigned_to_name: string | null;
  action: MentorAssignmentAction;
  assigned_at: string;
}

type MentorSectionLogoMode = 'light' | 'dark';

interface CourseMentorSection {
  course_id: string;
  description: string | null;
  logo_light: string | null;
  logo_dark: string | null;
  updated_at: string | null;
}

type CourseUpdateInput = {
  display_name?: string;
  description?: string;
  visible_to_staff_only?: boolean;
  image_url?: string;
  is_public?: boolean;
};

export interface CourseAuditSnapshot {
  id: string;
  tenant_id: string;
  display_name: string;
  visible_to_staff_only: boolean;
  image_url: string | null;
}

/** The 404 a course write answers (getCourseAuditName runs first) for a course outside the caller's tenant. */
const COURSE_MISSING_MESSAGE = 'Course không tồn tại';

export async function getCourseAuditName(courseId: string, tenantId: string): Promise<string> {
  const course = await coursesRepository.selectCourseName(courseId, tenantId);
  if (!course) throw new AppError(COURSE_MISSING_MESSAGE, 404);
  return course.display_name;
}

function getRoleDisplayLabel(role: string | null | undefined, labels: RoleLabelMap = {}): string {
  if (!role) return '';
  return labels[role as keyof RoleLabelMap]?.trim() || role;
}

function mapMentor(row: (CourseMentorColumns & { mentor_role_label?: string | null }) | null | undefined, roleLabels: RoleLabelMap = {}): CourseMentor | null {
  if (!row?.mentor_id) return null;
  return {
    id: row.mentor_id,
    username: row.mentor_username!,
    full_name: row.mentor_full_name,
    email: row.mentor_email!,
    phone: row.mentor_phone,
    avatar: row.mentor_avatar,
    role: row.mentor_role!,
    role_label: row.mentor_role_label || getRoleDisplayLabel(row.mentor_role, roleLabels),
    bio: row.mentor_bio,
  };
}

function mapMentorSection(row: CourseMentorSectionRow | null | undefined): CourseMentorSection | null {
  if (!row) return null;
  return {
    course_id: row.course_id,
    description: row.description ?? null,
    logo_light: row.logo_light_path ?? null,
    logo_dark: row.logo_dark_path ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function mapMentorHistory(row: MentorAssignmentHistoryRow): CourseMentorAssignmentHistoryItem {
  return {
    id: String(row.id),
    assigned_by_id: row.assigned_by ?? null,
    assigned_by_name: row.assigned_by_display_name || 'Không xác định',
    assigned_to_id: row.assigned_to ?? null,
    assigned_to_name: row.assigned_to_display_name ?? null,
    action: row.action,
    assigned_at: row.assigned_at,
  };
}


function parseMentorHistoryPageSize(value: unknown): number {
  const parsed = parseInt(String(value ?? MENTOR_HISTORY_DEFAULT_PAGE_SIZE), 10);
  return MENTOR_HISTORY_PAGE_SIZES.has(parsed) ? parsed : MENTOR_HISTORY_DEFAULT_PAGE_SIZE;
}

function normalizeMentorHistorySearch(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const search = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (search.length < 2) return null;
  return search.slice(0, MENTOR_HISTORY_MAX_SEARCH_LENGTH);
}

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function parseMentorHistoryDateBoundary(value: unknown, mode: 'from' | 'to'): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  let date: Date;

  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const start = new Date(Date.UTC(year, month - 1, day));
    if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1 || start.getUTCDate() !== day) {
      throw new AppError(mode === 'from' ? 'date_from khong hop le' : 'date_to khong hop le', 400);
    }
    date = mode === 'to' ? new Date(Date.UTC(year, month - 1, day + 1)) : start;
  } else {
    date = new Date(raw);
  }

  if (Number.isNaN(date.getTime())) {
    throw new AppError(mode === 'from' ? 'date_from khong hop le' : 'date_to khong hop le', 400);
  }
  return date.toISOString();
}

async function selectUserDisplayName(userId: string | null, repository: CoursesRepository): Promise<string | null> {
  if (!userId) return null;
  return repository.selectUserDisplayName(userId);
}

type CoursesRepository = ReturnType<typeof createCoursesRepository>;

/** With `client`, inside that transaction; otherwise through query(). */
async function insertMentorAssignmentHistory(
  courseId: string,
  tenantId: string,
  assignedBy: string | null,
  assignedTo: string | null,
  action: MentorAssignmentAction,
  client?: CoursesDb,
): Promise<void> {
  const repository = client ? createCoursesRepository(client) : coursesRepository;
  const assignedByName = await selectUserDisplayName(assignedBy, repository) || 'Không xác định';
  const assignedToName = action === 'assign'
    ? await selectUserDisplayName(assignedTo, repository) || 'Không xác định'
    : null;
  await repository.insertMentorAssignmentHistory({
    tenantId, courseId, assignedBy, assignedTo, assignedByName, assignedToName, action,
  });
}

/** The message these course endpoints have always returned for a course outside the tenant. */
const COURSE_NOT_FOUND_MESSAGE = 'Course khong ton tai';

export async function listCourses(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const filter = { tenantId, search, visibility: queryParams.visibility as string };
  const [countRow, rows, roleLabels] = await Promise.all([
    coursesRepository.countCourses(filter),
    coursesRepository.selectCoursePage(filter, pageSize, offset),
    getTenantRoleLabels(tenantId),
  ]);
  const total = parseInt(countRow.count, 10);
  return {
    data: rows.map((row) => ({ ...row, mentor: mapMentor(row, roleLabels) })),
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function exportCourseMarkdown(courseId: string, tenantId: string) {
  const course = await coursesRepository.selectMarkdownCourse(courseId, tenantId);
  if (!course) throw new AppError('Course not found', 404);

  const blocks = await coursesRepository.selectMarkdownBlocks(courseId);

  return {
    filename: markdownFilename(courseId),
    // The export reads only known media fields today; stripping AI ID
    // author-only metadata keeps that true for any future exporter field.
    markdown: buildCourseMarkdown(course, blocks.map(withoutAuthorOnlyBlockMetadata)),
  };
}

export async function createCourse(tenantId: string, createdBy: string, input: { id: string; display_name: string; description: string; org?: string; visible_to_staff_only?: boolean; image_url?: string; start_date?: string | null; end_date?: string | null }) {
  // ── Kiểm tra quota course cho tenant ──
  const { checkQuota } = await import('../tenants/tenants.service.js');
  await checkQuota(tenantId, 'courses');

  const course = await coursesRepository.insertCourse({
    id: input.id,
    tenantId,
    displayName: input.display_name,
    description: input.description,
    org: input.org || '',
    visibleToStaffOnly: input.visible_to_staff_only ?? false,
    imageUrl: input.image_url || '',
    startDate: input.start_date || null,
    endDate: input.end_date || null,
    createdBy,
  });
  await initializeCourseMentorSectionDefaults(course.id, tenantId, createdBy);
  await recordCourseMentorAssignmentHistory(course.id, tenantId, createdBy, createdBy, 'assign');
  await Promise.all([
    invalidateTenantCourseCaches(tenantId),
    invalidateCourseReadCaches(course.id, tenantId),
  ]);
  return course;
}

export async function updateCourse(
  courseId: string,
  tenantId: string,
  input: CourseUpdateInput,
  auditEntry?: (before: CourseAuditSnapshot, after: CourseAuditSnapshot) => TransactionalAuditEntry,
) {
  const course = await updateCourseFromDb(courseId, tenantId, input, auditEntry);
  await Promise.all([
    invalidateCourseReadCaches(courseId, course.tenant_id),
    invalidateTenantCourseCaches(course.tenant_id),
  ]);
  return course;
}

async function updateCourseFromDb(
  courseId: string,
  tenantId: string,
  input: CourseUpdateInput,
  auditEntry?: (before: CourseAuditSnapshot, after: CourseAuditSnapshot) => TransactionalAuditEntry,
) {
  if (input.is_public !== undefined) {
    throw new AppError('Chỉ được bật Công khai truy cập ở danh mục khóa học', 400);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const repository = createCoursesRepository(client);
    const current = await repository.lockCourseSnapshot(courseId, tenantId);
    if (!current) throw new AppError('Course không tồn tại', 404);

    const updated = await repository.updateCourseFields(courseId, tenantId, input);
    if (!updated) throw new AppError('Course không tồn tại', 404);
    if (auditEntry) await appendAuditLog(client, auditEntry(current, updated));

    await client.query('COMMIT');
    return updated;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw err;
  } finally {
    client.release();
  }
}

export async function bulkCourseAction(ids: string[], action: string, tenantId: string) {
  const staffOnly = action === 'staff_only';
  const r = await coursesRepository.updateCoursesVisibility(ids, staffOnly, tenantId);
  await Promise.all(r.rows.map((row) => invalidateCourseReadCaches(row.id, row.tenant_id)));
  return { updated: r.rowCount };
}

export async function getCourseMentor(courseId: string, tenantId: string): Promise<CourseMentor | null> {
  const row = await coursesRepository.selectCourseMentor(courseId, tenantId);
  if (!row) throw new AppError('Course khong ton tai', 404);
  const roleLabels = await getTenantRoleLabels(tenantId);
  return mapMentor(row, roleLabels);
}

export async function listMentorCandidates(
  courseId: string,
  tenantId: string,
  queryParams: Record<string, unknown>,
) {
  await assertCourseBelongsToTenant(courseId, tenantId, COURSE_NOT_FOUND_MESSAGE);

  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);

  const [rows, roleLabels] = await Promise.all([
    coursesRepository.selectMentorCandidates(tenantId, search, pageSize, offset),
    getTenantRoleLabels(tenantId),
  ]);

  const total = parseInt(rows[0]?.full_count ?? '0', 10);
  return {
    data: rows.map(({ full_count, ...row }) => ({
      ...row,
      role_label: getRoleDisplayLabel(row.role, roleLabels),
    })),
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function updateCourseMentor(
  courseId: string,
  tenantId: string,
  mentorId: string | null,
  assignedBy: string,
  createAuditEntry?: (context: { courseName: string; mentorName: string | null }) => TransactionalAuditEntry,
): Promise<CourseMentor | null> {
  const client = await getClient();
  let mentorRow: MentorUserRow | null = null;
  let changed = false;

  try {
    await client.query('BEGIN');
    const repository = createCoursesRepository(client);

    const course = await repository.lockCourseMentor(courseId, tenantId);
    if (!course) throw new AppError('Course khong ton tai', 404);

    const currentMentorId = course.mentor_id ?? null;
    if (mentorId !== null) {
      mentorRow = await repository.selectEligibleMentor(mentorId, tenantId);
      if (!mentorRow) throw new AppError('Người phụ trách không hợp lệ', 400);
    }

    if (currentMentorId !== mentorId) {
      await repository.updateCourseMentorId(courseId, tenantId, mentorId);
      await insertMentorAssignmentHistory(
        courseId,
        tenantId,
        assignedBy,
        mentorId,
        mentorId ? 'assign' : 'remove',
        client,
      );
      changed = true;
    }

    if (changed && createAuditEntry) {
      await appendAuditLog(client, createAuditEntry({
        courseName: course.display_name,
        mentorName: mentorRow ? (mentorRow.full_name?.trim() || mentorRow.username) : course.mentor_name,
      }));
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw err;
  } finally {
    client.release();
  }

  if (changed) await invalidateCourseReadCaches(courseId, tenantId);
  if (!mentorRow) return null;

  const roleLabels = await getTenantRoleLabels(tenantId);
  return {
    ...mentorRow,
    role_label: getRoleDisplayLabel(mentorRow.role, roleLabels),
  };
}

export async function recordCourseMentorAssignmentHistory(
  courseId: string,
  tenantId: string,
  assignedBy: string | null,
  assignedTo: string | null,
  action: MentorAssignmentAction,
): Promise<void> {
  await insertMentorAssignmentHistory(courseId, tenantId, assignedBy, assignedTo, action);
}

export async function listCourseMentorAssignmentHistory(
  courseId: string,
  tenantId: string,
  queryParams: Record<string, unknown>,
) {
  await assertCourseBelongsToTenant(courseId, tenantId, COURSE_NOT_FOUND_MESSAGE);

  const pageSize = parseMentorHistoryPageSize(queryParams.page_size);
  const rawPage = parseInt(String(queryParams.page || '1'), 10) || 1;
  const requestedPage = Math.max(rawPage, 1);
  const search = normalizeMentorHistorySearch(queryParams.search);
  const dateFrom = parseMentorHistoryDateBoundary(queryParams.date_from, 'from');
  const dateTo = parseMentorHistoryDateBoundary(queryParams.date_to, 'to');
  if (dateFrom && dateTo && new Date(dateFrom).getTime() >= new Date(dateTo).getTime()) {
    throw new AppError('date_to phai lon hon hoac bang date_from', 400);
  }

  const filter = {
    tenantId,
    courseId,
    dateFrom,
    dateTo,
    searchPattern: search ? `%${escapeSqlLikePattern(search)}%` : null,
  };
  const total = await coursesRepository.countMentorHistory(filter);
  const totalPages = calcTotalPages(total, pageSize);
  const page = totalPages > 0 ? Math.min(requestedPage, totalPages) : 1;
  const offset = calcOffset(page, pageSize);

  const rows = await coursesRepository.selectMentorHistoryPage(filter, pageSize, offset);

  return {
    data: rows.map(mapMentorHistory),
    total,
    page,
    pageSize,
    totalPages,
  };
}

export async function initializeCourseMentorSectionDefaults(
  courseId: string,
  tenantId: string,
  userId: string | null,
): Promise<CourseMentorSection | null> {
  return mapMentorSection(await mentorSectionRepository.insertSectionDefaults(courseId, tenantId, userId));
}

export async function getCourseMentorSection(courseId: string, tenantId: string): Promise<CourseMentorSection | null> {
  await assertCourseBelongsToTenant(courseId, tenantId, COURSE_NOT_FOUND_MESSAGE);
  return mapMentorSection(await mentorSectionRepository.selectSection(courseId, tenantId));
}

export async function upsertCourseMentorSection(
  courseId: string,
  tenantId: string,
  userId: string,
  input: { description?: string | null },
): Promise<CourseMentorSection> {
  await assertCourseBelongsToTenant(courseId, tenantId, COURSE_NOT_FOUND_MESSAGE);
  const description = typeof input.description === 'string'
    ? input.description.trim() || null
    : null;

  const section = await mentorSectionRepository.upsertDescription(courseId, tenantId, description, userId);

  await invalidateCourseReadCaches(courseId, tenantId);
  return mapMentorSection(section)!;
}

export async function uploadCourseMentorSectionLogo(
  courseId: string,
  tenantId: string,
  userId: string,
  mode: MentorSectionLogoMode,
  file: Express.Multer.File,
  auditEntry?: TransactionalAuditEntry,
): Promise<CourseMentorSection> {
  await assertCourseBelongsToTenant(courseId, tenantId, COURSE_NOT_FOUND_MESSAGE);

  const current = await mentorSectionRepository.selectLogoPaths(courseId, tenantId);
  const oldPath = mode === 'light'
    ? current?.logo_light_path
    : current?.logo_dark_path;

  const safeOriginalName = fixMulterFilename(file.originalname);
  const fileName = buildFileName(`${mode}_${safeOriginalName}`);
  const storagePath = buildStoragePath(tenantId, 'courses', fileName, `${courseId}/mentor-section`);

  await uploadFile(storagePath, file.buffer, file.mimetype, true);

  const logoColumn = mode === 'light' ? 'logo_light_path' : 'logo_dark_path';
  const client = await getClient();
  let section: CourseMentorSectionRow;
  try {
    await client.query('BEGIN');
    section = await createCourseMentorSectionRepository(client).upsertLogoPath(courseId, tenantId, logoColumn, storagePath, userId);
    if (auditEntry) await appendAuditLog(client, auditEntry);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    // The storage write happened before the transaction. If either the data
    // write or atomic audit insert fails, compensate by removing this new file.
    await deleteFile(storagePath).catch(swallowAndLog('courses.mentor_logo_cleanup'));
    throw error;
  } finally {
    client.release();
  }

  if (oldPath && oldPath !== storagePath) {
    const ownership = classifyCourseMentorLogoOwnership(oldPath, tenantId, courseId);
    if (ownership.kind === 'course-owned') {
      await deleteFile(ownership.storagePath).catch(swallowAndLog('courses.mentor_logo_cleanup'));
    } else if (ownership.kind === 'unknown') {
      console.warn('[CourseMentorLogo] storage_reference_retained', {
        event: 'course_mentor_logo.storage_reference_retained',
        operation: 'replace',
        tenant_id: tenantId,
        course_id: courseId,
        reason: ownership.reason,
        storage_path: ownership.storagePath,
      });
    }
  }

  await invalidateCourseReadCaches(courseId, tenantId);
  return mapMentorSection(section)!;
}

export async function deleteCourseMentorSectionLogo(
  courseId: string,
  tenantId: string,
  userId: string,
  mode: MentorSectionLogoMode,
  auditEntry?: TransactionalAuditEntry,
): Promise<CourseMentorSection | null> {
  await assertCourseBelongsToTenant(courseId, tenantId, COURSE_NOT_FOUND_MESSAGE);

  const logoColumn = mode === 'light' ? 'logo_light_path' : 'logo_dark_path';
  const client = await getClient();
  let oldPath: string | null = null;
  let section: CourseMentorSectionRow | undefined;
  try {
    await client.query('BEGIN');
    const repository = createCourseMentorSectionRepository(client);
    const current = await repository.lockLogoPath(courseId, tenantId, logoColumn);
    if (!current) { await client.query('COMMIT'); return null; }
    oldPath = current.logo_path;

    section = await repository.clearLogoPath(courseId, tenantId, logoColumn, userId);
    if (auditEntry) await appendAuditLog(client, auditEntry);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw error;
  } finally {
    client.release();
  }

  if (oldPath) {
    const ownership = classifyCourseMentorLogoOwnership(oldPath, tenantId, courseId);
    if (ownership.kind === 'course-owned') {
      await deleteFile(ownership.storagePath).catch(swallowAndLog('courses.mentor_logo_cleanup'));
    } else if (ownership.kind === 'unknown') {
      console.warn('[CourseMentorLogo] storage_reference_retained', {
        event: 'course_mentor_logo.storage_reference_retained',
        operation: 'clear',
        tenant_id: tenantId,
        course_id: courseId,
        reason: ownership.reason,
        storage_path: ownership.storagePath,
      });
    }
  }

  await invalidateCourseReadCaches(courseId, tenantId);
  return mapMentorSection(section);
}

/** Direct course deletion is forbidden; use the durable deletion-job module. */
export async function hardDeleteCourse(courseId: string, tenantId: string) {
  void courseId;
  void tenantId;
  throw new AppError('Direct hard delete is disabled. Use course deletion jobs.', 400);
}

// ── Modal Config ──

/** Read like the write: only a live course of the caller's tenant, else the same 404. */
export async function getCourseModalConfig(courseId: string, tenantId: string) {
  await assertCourseBelongsToTenant(courseId, tenantId, COURSE_MISSING_MESSAGE);
  const config = await modalConfigRepository.selectCourseModalConfig(courseId);
  if (!config) {
    return { course_id: courseId, welcome_enabled: false, welcome_title: '', welcome_description: '', confirm_enabled: false, confirm_title: '', confirm_description: '', confirm_checkbox_text: '', completion_enabled: false, completion_title: '', completion_description: '', completion_social_type: '', completion_social_link: '', updated_at: null };
  }
  return config;
}

export async function upsertCourseModalConfig(courseId: string, tenantId: string, input: Record<string, unknown>) {
  await assertCourseBelongsToTenant(courseId, tenantId, COURSE_NOT_FOUND_MESSAGE);
  const fields = ['welcome_enabled', 'welcome_title', 'welcome_description', 'confirm_enabled', 'confirm_title', 'confirm_description', 'confirm_checkbox_text', 'completion_enabled', 'completion_title', 'completion_description', 'completion_social_type', 'completion_social_link'];
  const present: string[] = [];
  for (const f of fields) {
    if (input[f] !== undefined) present.push(f);
  }
  if (present.length === 0) throw new AppError('Không có dữ liệu', 400);

  await modalConfigRepository.insertCourseModalConfigIfMissing(courseId);
  await modalConfigRepository.updateCourseModalConfig(courseId, present, input);
  await invalidateCourseReadCaches(courseId);
  return { success: true };
}

// ── Section Modal Config ──

/** Read like the write: only a live course of the caller's tenant, else the same 404. */
export async function getSectionModalConfig(courseId: string, tenantId: string, sectionId: string) {
  await assertCourseBelongsToTenant(courseId, tenantId, COURSE_MISSING_MESSAGE);
  const config = await modalConfigRepository.selectSectionModalConfig(courseId, sectionId);
  if (!config) {
    return { course_id: courseId, section_id: sectionId, enabled: false, title: '', description: '', updated_at: null };
  }
  return config;
}

export async function upsertSectionModalConfig(
  courseId: string,
  tenantId: string,
  input: { section_id: string; enabled?: boolean; title?: string; description?: string },
) {
  await assertCourseBelongsToTenant(courseId, tenantId, COURSE_NOT_FOUND_MESSAGE);
  await modalConfigRepository.upsertSectionModalConfig(courseId, {
    sectionId: input.section_id,
    enabled: input.enabled ?? false,
    title: input.title || '',
    description: input.description || '',
  });
  await invalidateCourseReadCaches(courseId);
  return { success: true };
}





