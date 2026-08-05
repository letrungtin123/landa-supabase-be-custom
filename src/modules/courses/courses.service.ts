// ═══════════════════════════════════════════════════════════════
// Courses Service — CRUD courses + modal configs
// ═══════════════════════════════════════════════════════════════

import { getClient, query } from '../../config/database.js';
import {
  invalidateCourseReadCaches,
  invalidateTenantCourseCaches,
} from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import { uploadFile, deleteFile, buildFileName, buildStoragePath, fixMulterFilename } from '../../config/storage.js';
import { getTenantRoleLabels, type RoleLabelMap } from '../tenants/tenant-role-labels.service.js';
import {
  buildCourseMarkdown,
  markdownFilename,
  type CourseMarkdownBlock,
  type CourseMarkdownCourse,
} from './course-markdown-exporter.js';

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

function getRoleDisplayLabel(role: string | null | undefined, labels: RoleLabelMap = {}): string {
  if (!role) return '';
  return labels[role as keyof RoleLabelMap]?.trim() || role;
}

function mapMentor(row: any, roleLabels: RoleLabelMap = {}): CourseMentor | null {
  if (!row?.mentor_id) return null;
  return {
    id: row.mentor_id,
    username: row.mentor_username,
    full_name: row.mentor_full_name,
    email: row.mentor_email,
    phone: row.mentor_phone,
    avatar: row.mentor_avatar,
    role: row.mentor_role,
    role_label: row.mentor_role_label || getRoleDisplayLabel(row.mentor_role, roleLabels),
    bio: row.mentor_bio,
  };
}

function mapMentorSection(row: any): CourseMentorSection | null {
  if (!row) return null;
  return {
    course_id: row.course_id,
    description: row.description ?? null,
    logo_light: row.logo_light_path ?? null,
    logo_dark: row.logo_dark_path ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function mapMentorHistory(row: any): CourseMentorAssignmentHistoryItem {
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

async function selectUserDisplayName(userId: string | null, client?: any): Promise<string | null> {
  if (!userId) return null;
  const sql = `SELECT COALESCE(NULLIF(full_name, ''), username, email, 'Không xác định') AS display_name
               FROM users
               WHERE id = $1
               LIMIT 1`;
  const result = client ? await client.query(sql, [userId]) : await query<{ display_name: string }>(sql, [userId]);
  return result.rows[0]?.display_name || null;
}

async function insertMentorAssignmentHistory(
  courseId: string,
  tenantId: string,
  assignedBy: string | null,
  assignedTo: string | null,
  action: MentorAssignmentAction,
  client?: any,
): Promise<void> {
  const assignedByName = await selectUserDisplayName(assignedBy, client) || 'Không xác định';
  const assignedToName = action === 'assign'
    ? await selectUserDisplayName(assignedTo, client) || 'Không xác định'
    : null;
  const sql = `INSERT INTO course_mentor_assignment_history
                 (tenant_id, course_id, assigned_by, assigned_to, assigned_by_display_name, assigned_to_display_name, action)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`;
  const params = [tenantId, courseId, assignedBy, assignedTo, assignedByName, assignedToName, action];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

async function ensureCourseInTenant(courseId: string, tenantId: string): Promise<void> {
  const result = await query(
    `SELECT id FROM courses WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [courseId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Course khong ton tai', 404);
}

export async function listCourses(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [];
  const conditions: string[] = ['c.deleted_at IS NULL'];

  if (tenantId) { params.push(tenantId); conditions.push(`c.tenant_id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conditions.push(`c.display_name ILIKE $${params.length}`); }
  const vis = queryParams.visibility as string;
  if (vis === 'staff_only') conditions.push('c.visible_to_staff_only = true');
  else if (vis === 'public') conditions.push('c.visible_to_staff_only = false');

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const [countR, dataR, roleLabels] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM courses c ${where}`, params),
    query(
      `SELECT c.*,
              creator.id AS creator_id,
              NULLIF(creator.full_name, '') AS creator_display_name,
              mentor.id AS mentor_id,
              mentor.username AS mentor_username,
              mentor.full_name AS mentor_full_name,
              mentor.email AS mentor_email,
              mentor.phone AS mentor_phone,
              mentor.avatar_url AS mentor_avatar,
              mentor.role AS mentor_role,
              mentor.bio AS mentor_bio
       FROM courses c
       LEFT JOIN users creator ON creator.id = c.created_by
       LEFT JOIN users mentor ON mentor.id = c.mentor_id
       ${where}
       ORDER BY c.updated_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
    getTenantRoleLabels(tenantId),
  ]);
  const total = parseInt(countR.rows[0].count, 10);
  return {
    data: dataR.rows.map((row: any) => ({ ...row, mentor: mapMentor(row, roleLabels) })),
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function exportCourseMarkdown(courseId: string, tenantId: string) {
  const courseResult = await query<CourseMarkdownCourse>(
    `SELECT id, display_name, description, org, start_date, end_date, created_at, updated_at
     FROM courses
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [courseId, tenantId],
  );
  if (courseResult.rowCount === 0) throw new AppError('Course not found', 404);

  const blocksResult = await query<CourseMarkdownBlock>(
    `WITH RECURSIVE active_tree AS (
       SELECT id, parent_id, block_type::text AS block_type, display_name,
              published_data AS data,
              COALESCE(published_metadata, metadata, '{}'::jsonb) AS metadata,
              sort_order, created_at
       FROM course_blocks
       WHERE course_id = $1
         AND parent_id IS NULL
         AND deleted_at IS NULL
         AND is_published = true
       UNION ALL
       SELECT child.id, child.parent_id, child.block_type::text AS block_type, child.display_name,
              child.published_data AS data,
              COALESCE(child.published_metadata, child.metadata, '{}'::jsonb) AS metadata,
              child.sort_order, child.created_at
       FROM course_blocks child
       JOIN active_tree parent ON parent.id = child.parent_id
       WHERE child.deleted_at IS NULL
         AND child.is_published = true
     )
     SELECT id, parent_id, block_type, display_name, data, metadata, sort_order, created_at
     FROM active_tree
     ORDER BY COALESCE(sort_order, 0), created_at, id`,
    [courseId],
  );

  return {
    filename: markdownFilename(courseId),
    markdown: buildCourseMarkdown(courseResult.rows[0], blocksResult.rows),
  };
}

export async function createCourse(tenantId: string, createdBy: string, input: { id: string; display_name: string; description: string; org?: string; visible_to_staff_only?: boolean; image_url?: string; start_date?: string | null; end_date?: string | null }) {
  // ── Kiểm tra quota course cho tenant ──
  const { checkQuota } = await import('../tenants/tenants.service.js');
  await checkQuota(tenantId, 'courses');

  const result = await query(
    `INSERT INTO courses (id, tenant_id, display_name, description, org, visible_to_staff_only, image_url, start_date, end_date, created_by, mentor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     RETURNING *`,
    [input.id, tenantId, input.display_name, input.description, input.org || '', input.visible_to_staff_only ?? false, input.image_url || '', input.start_date || null, input.end_date || null, createdBy],
  );
  await initializeCourseMentorSectionDefaults(result.rows[0].id, tenantId, createdBy);
  await recordCourseMentorAssignmentHistory(result.rows[0].id, tenantId, createdBy, createdBy, 'assign');
  await Promise.all([
    invalidateTenantCourseCaches(tenantId),
    invalidateCourseReadCaches(result.rows[0].id, tenantId),
  ]);
  return result.rows[0];
}

export async function updateCourse(courseId: string, tenantId: string, input: CourseUpdateInput) {
  const course = await updateCourseFromDb(courseId, tenantId, input);
  await Promise.all([
    invalidateCourseReadCaches(courseId, course.tenant_id),
    invalidateTenantCourseCaches(course.tenant_id),
  ]);
  return course;
}

async function updateCourseFromDb(courseId: string, tenantId: string, input: CourseUpdateInput) {
  if (input.is_public === true && input.visible_to_staff_only === true) {
    throw new AppError('Khóa học công khai không thể đang lưu trữ', 400);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const current = await client.query<{ id: string; tenant_id: string; is_public: boolean }>(
      `SELECT id, tenant_id, COALESCE(is_public, false) AS is_public
       FROM courses
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [courseId, tenantId],
    );
    if (current.rowCount === 0) throw new AppError('Course không tồn tại', 404);

    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;
    if (input.display_name !== undefined) { sets.push(`display_name = $${idx++}`); params.push(input.display_name); }
    if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
    if (input.visible_to_staff_only !== undefined) { sets.push(`visible_to_staff_only = $${idx++}`); params.push(input.visible_to_staff_only); }
    if (input.image_url !== undefined) { sets.push(`image_url = $${idx++}`); params.push(input.image_url); }
    if (input.is_public !== undefined) { sets.push(`is_public = $${idx++}`); params.push(input.is_public); }
    if (input.is_public === true && input.visible_to_staff_only === undefined) {
      sets.push('visible_to_staff_only = false');
    }
    if (input.visible_to_staff_only === true && input.is_public === undefined) {
      sets.push('is_public = false');
    }

    params.push(courseId, tenantId);
    const result = await client.query(
      `UPDATE courses
       SET ${sets.join(', ')}
       WHERE id = $${idx++} AND tenant_id = $${idx} AND deleted_at IS NULL
       RETURNING *`,
      params,
    );

    if (input.is_public === true && current.rows[0].is_public !== true) {
      await client.query(
        `DELETE FROM team_courses tc
         USING teams t
         JOIN sub_groups sg ON sg.id = t.sub_group_id
         JOIN org_groups og ON og.id = sg.org_group_id
         WHERE tc.team_id = t.id
           AND tc.course_id = $1
           AND og.tenant_id = $2::uuid`,
        [courseId, tenantId],
      );

      await client.query(
        `DELETE FROM course_category_courses ccc
         WHERE ccc.course_id = $1
           AND EXISTS (
             SELECT 1
             FROM team_course_categories tcc
             JOIN teams t ON t.id = tcc.team_id
             JOIN sub_groups sg ON sg.id = t.sub_group_id
             JOIN org_groups og ON og.id = sg.org_group_id
             WHERE tcc.category_id = ccc.category_id
               AND og.tenant_id = $2::uuid
           )`,
        [courseId, tenantId],
      );
    }

    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function bulkCourseAction(ids: string[], action: string) {
  const staffOnly = action === 'staff_only';
  const r = await query(
    `UPDATE courses
     SET visible_to_staff_only = $1,
         is_public = CASE WHEN $1::boolean THEN false ELSE is_public END,
         updated_at = NOW()
     WHERE id = ANY($2) AND deleted_at IS NULL
     RETURNING id, tenant_id`,
    [staffOnly, ids],
  );
  await Promise.all((r.rows as Array<{ id: string; tenant_id: string }>).map((row) => invalidateCourseReadCaches(row.id, row.tenant_id)));
  return { updated: r.rowCount || 0 };
}

export async function getCourseMentor(courseId: string, tenantId: string): Promise<CourseMentor | null> {
  const result = await query<any>(
    `SELECT mentor.id AS mentor_id,
            mentor.username AS mentor_username,
            mentor.full_name AS mentor_full_name,
            mentor.email AS mentor_email,
            mentor.phone AS mentor_phone,
            mentor.avatar_url AS mentor_avatar,
            mentor.role AS mentor_role,
            mentor.bio AS mentor_bio
     FROM courses c
     LEFT JOIN users mentor ON mentor.id = c.mentor_id
     WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL`,
    [courseId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Course khong ton tai', 404);
  const roleLabels = await getTenantRoleLabels(tenantId);
  return mapMentor(result.rows[0], roleLabels);
}

export async function listMentorCandidates(
  courseId: string,
  tenantId: string,
  queryParams: Record<string, unknown>,
) {
  const courseResult = await query(
    `SELECT id FROM courses WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [courseId, tenantId],
  );
  if (courseResult.rowCount === 0) throw new AppError('Course khong ton tai', 404);

  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [tenantId];
  const conditions = ['u.tenant_id = $1', "u.role IN ('staff', 'superuser')", 'u.is_active = true'];

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    conditions.push(`(
      lower(COALESCE(u.full_name, '')) LIKE $${params.length}
      OR lower(u.email) LIKE $${params.length}
      OR lower(u.username) LIKE $${params.length}
    )`);
  }

  const [result, roleLabels] = await Promise.all([
    query<any>(
      `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url AS avatar,
              u.role, u.bio, COUNT(*) OVER() AS full_count
     FROM users u
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(NULLIF(u.full_name, ''), u.username), u.id
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
    getTenantRoleLabels(tenantId),
  ]);

  const total = parseInt(result.rows[0]?.full_count ?? '0', 10);
  return {
    data: result.rows.map(({ full_count, ...row }: any) => ({
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
): Promise<CourseMentor | null> {
  const client = await getClient();
  let mentorRow: any = null;
  let changed = false;

  try {
    await client.query('BEGIN');

    const courseResult = await client.query<{ mentor_id: string | null }>(
      `SELECT mentor_id
       FROM courses
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [courseId, tenantId],
    );
    if (courseResult.rowCount === 0) throw new AppError('Course khong ton tai', 404);

    const currentMentorId = courseResult.rows[0].mentor_id ?? null;
    if (mentorId !== null) {
      const mentorResult = await client.query<any>(
        `SELECT id, username, full_name, email, phone, avatar_url AS avatar, role, bio
         FROM users
         WHERE id = $1
           AND tenant_id = $2
           AND role IN ('staff', 'superuser')
           AND is_active = true`,
        [mentorId, tenantId],
      );
      if (mentorResult.rowCount === 0) throw new AppError('Người phụ trách không hợp lệ', 400);
      mentorRow = mentorResult.rows[0];
    }

    if (currentMentorId !== mentorId) {
      await client.query(
        `UPDATE courses
         SET mentor_id = $3, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [courseId, tenantId, mentorId],
      );
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

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
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
  await ensureCourseInTenant(courseId, tenantId);

  const pageSize = parseMentorHistoryPageSize(queryParams.page_size);
  const rawPage = parseInt(String(queryParams.page || '1'), 10) || 1;
  const requestedPage = Math.max(rawPage, 1);
  const search = normalizeMentorHistorySearch(queryParams.search);
  const dateFrom = parseMentorHistoryDateBoundary(queryParams.date_from, 'from');
  const dateTo = parseMentorHistoryDateBoundary(queryParams.date_to, 'to');
  if (dateFrom && dateTo && new Date(dateFrom).getTime() >= new Date(dateTo).getTime()) {
    throw new AppError('date_to phai lon hon hoac bang date_from', 400);
  }

  const params: unknown[] = [tenantId, courseId];
  const conditions = ['tenant_id = $1', 'course_id = $2'];

  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`assigned_at >= $${params.length}::timestamptz`);
  }

  if (dateTo) {
    params.push(dateTo);
    conditions.push(`assigned_at < $${params.length}::timestamptz`);
  }

  if (search) {
    params.push(`%${escapeSqlLikePattern(search)}%`);
    conditions.push(`lower(COALESCE(assigned_by_display_name, '') || ' ' || COALESCE(assigned_to_display_name, '')) LIKE $${params.length} ESCAPE '\\'`);
  }

  const where = conditions.join(' AND ');
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM course_mentor_assignment_history
     WHERE ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);
  const totalPages = calcTotalPages(total, pageSize);
  const page = totalPages > 0 ? Math.min(requestedPage, totalPages) : 1;
  const offset = calcOffset(page, pageSize);

  const result = await query<any>(
    `SELECT id::text, assigned_by, assigned_to, assigned_by_display_name,
            assigned_to_display_name, action, assigned_at
     FROM course_mentor_assignment_history
     WHERE ${where}
     ORDER BY assigned_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  );

  return {
    data: result.rows.map(mapMentorHistory),
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
  const result = await query<any>(
    `INSERT INTO course_mentor_sections (tenant_id, course_id, logo_light_path, logo_dark_path, updated_by)
     SELECT t.id,
            $2,
            NULLIF(t.settings #>> '{branding,header_logo}', ''),
            NULLIF(t.settings #>> '{branding,header_logo_dark}', ''),
            $3
     FROM tenants t
     WHERE t.id = $1
     ON CONFLICT (tenant_id, course_id) DO NOTHING
     RETURNING course_id, description, logo_light_path, logo_dark_path, updated_at`,
    [tenantId, courseId, userId],
  );
  return mapMentorSection(result.rows[0]);
}

export async function getCourseMentorSection(courseId: string, tenantId: string): Promise<CourseMentorSection | null> {
  await ensureCourseInTenant(courseId, tenantId);
  const result = await query<any>(
    `SELECT course_id, description, logo_light_path, logo_dark_path, updated_at
     FROM course_mentor_sections
     WHERE course_id = $1 AND tenant_id = $2`,
    [courseId, tenantId],
  );
  return mapMentorSection(result.rows[0]);
}

export async function upsertCourseMentorSection(
  courseId: string,
  tenantId: string,
  userId: string,
  input: { description?: string | null },
): Promise<CourseMentorSection> {
  await ensureCourseInTenant(courseId, tenantId);
  const description = typeof input.description === 'string'
    ? input.description.trim() || null
    : null;

  const result = await query<any>(
    `INSERT INTO course_mentor_sections (tenant_id, course_id, description, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, course_id)
     DO UPDATE SET
       description = EXCLUDED.description,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING course_id, description, logo_light_path, logo_dark_path, updated_at`,
    [tenantId, courseId, description, userId],
  );

  await invalidateCourseReadCaches(courseId, tenantId);
  return mapMentorSection(result.rows[0])!;
}

export async function uploadCourseMentorSectionLogo(
  courseId: string,
  tenantId: string,
  userId: string,
  mode: MentorSectionLogoMode,
  file: Express.Multer.File,
): Promise<CourseMentorSection> {
  await ensureCourseInTenant(courseId, tenantId);

  const current = await query<any>(
    `SELECT logo_light_path, logo_dark_path
     FROM course_mentor_sections
     WHERE course_id = $1 AND tenant_id = $2`,
    [courseId, tenantId],
  );
  const oldPath = mode === 'light'
    ? current.rows[0]?.logo_light_path
    : current.rows[0]?.logo_dark_path;

  const safeOriginalName = fixMulterFilename(file.originalname);
  const fileName = buildFileName(`${mode}_${safeOriginalName}`);
  const storagePath = buildStoragePath(tenantId, 'courses', fileName, `${courseId}/mentor-section`);

  await uploadFile(storagePath, file.buffer, file.mimetype, true);

  const logoColumn = mode === 'light' ? 'logo_light_path' : 'logo_dark_path';
  const result = await query<any>(
    `INSERT INTO course_mentor_sections (tenant_id, course_id, ${logoColumn}, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, course_id)
     DO UPDATE SET
       ${logoColumn} = EXCLUDED.${logoColumn},
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING course_id, description, logo_light_path, logo_dark_path, updated_at`,
    [tenantId, courseId, storagePath, userId],
  );

  if (oldPath && oldPath !== storagePath) {
    await deleteFile(oldPath).catch(() => {});
  }

  await invalidateCourseReadCaches(courseId, tenantId);
  return mapMentorSection(result.rows[0])!;
}

export async function deleteCourseMentorSectionLogo(
  courseId: string,
  tenantId: string,
  userId: string,
  mode: MentorSectionLogoMode,
): Promise<CourseMentorSection | null> {
  await ensureCourseInTenant(courseId, tenantId);

  const logoColumn = mode === 'light' ? 'logo_light_path' : 'logo_dark_path';
  const current = await query<any>(
    `SELECT ${logoColumn} AS logo_path
     FROM course_mentor_sections
     WHERE course_id = $1 AND tenant_id = $2`,
    [courseId, tenantId],
  );

  if (current.rowCount === 0) return null;
  const oldPath = current.rows[0]?.logo_path;

  const result = await query<any>(
    `UPDATE course_mentor_sections
     SET ${logoColumn} = NULL, updated_by = $3, updated_at = NOW()
     WHERE course_id = $1 AND tenant_id = $2
     RETURNING course_id, description, logo_light_path, logo_dark_path, updated_at`,
    [courseId, tenantId, userId],
  );

  if (oldPath) {
    await deleteFile(oldPath).catch(() => {});
  }

  await invalidateCourseReadCaches(courseId, tenantId);
  return mapMentorSection(result.rows[0]);
}

/**
 * Hard delete course — CASCADE xóa sạch 14+ bảng.
 * Trả về danh sách storage_path để caller cleanup files.
 */
export async function hardDeleteCourse(courseId: string, tenantId: string) {
  void courseId;
  void tenantId;
  throw new AppError('Direct hard delete is disabled. Use course deletion jobs.', 400);

  // 1. Verify course tồn tại + thuộc tenant (tenant isolation)
  const courseCheck = await query<{ id: string; image_url: string | null }>(
    'SELECT id, image_url FROM courses WHERE id = $1 AND tenant_id = $2',
    [courseId, tenantId],
  );
  if (courseCheck.rowCount === 0) throw new AppError('Course không tồn tại hoặc không thuộc tenant', 404);

  // 2. Lấy danh sách files trên Storage TRƯỚC khi cascade xóa
  const assetsResult = await query<{ storage_path: string }>(
    'SELECT storage_path FROM course_assets WHERE course_id = $1 AND storage_path IS NOT NULL',
    [courseId],
  );
  const filePaths = assetsResult.rows.map(r => r.storage_path);

  // Cover image
  const coverUrl = courseCheck.rows[0].image_url || '';
  if (coverUrl.length > 0) filePaths.push(coverUrl);

  // 3. DELETE — CASCADE tự xóa: course_blocks, block_completions,
  //    course_assets, enrollments, course_progress, team_courses,
  //    course_category_courses, course_modal_configs, course_modal_states,
  //    section_modal_configs, section_modal_shown
  //    SET NULL: notifications.course_id, study_sessions.course_id
  const result = await query('DELETE FROM courses WHERE id = $1 AND tenant_id = $2', [courseId, tenantId]);
  if (result.rowCount === 0) throw new AppError('Xóa course thất bại', 500);

  return { filePaths };
}

// ── Modal Config ──

export async function getCourseModalConfig(courseId: string) {
  const result = await query('SELECT * FROM course_modal_configs WHERE course_id = $1', [courseId]);
  if (result.rowCount === 0) {
    return { course_id: courseId, welcome_enabled: false, welcome_title: '', welcome_description: '', confirm_enabled: false, confirm_title: '', confirm_description: '', confirm_checkbox_text: '', completion_enabled: false, completion_title: '', completion_description: '', completion_social_type: '', completion_social_link: '', updated_at: null };
  }
  return result.rows[0];
}

export async function upsertCourseModalConfig(courseId: string, input: Record<string, unknown>) {
  const fields = ['welcome_enabled', 'welcome_title', 'welcome_description', 'confirm_enabled', 'confirm_title', 'confirm_description', 'confirm_checkbox_text', 'completion_enabled', 'completion_title', 'completion_description', 'completion_social_type', 'completion_social_link'];
  const sets: string[] = [];
  const params: unknown[] = [courseId];
  let idx = 2;
  for (const f of fields) {
    if (input[f] !== undefined) { sets.push(`${f} = $${idx++}`); params.push(input[f]); }
  }
  if (sets.length === 0) throw new AppError('Không có dữ liệu', 400);
  sets.push('updated_at = NOW()');

  await query(
    `INSERT INTO course_modal_configs (course_id) VALUES ($1) ON CONFLICT (course_id) DO NOTHING`,
    [courseId],
  );
  await query(`UPDATE course_modal_configs SET ${sets.join(', ')} WHERE course_id = $1`, params);
  await invalidateCourseReadCaches(courseId);
  return { success: true };
}

// ── Section Modal Config ──

export async function getSectionModalConfig(courseId: string, sectionId: string) {
  const result = await query('SELECT * FROM section_modal_configs WHERE course_id = $1 AND section_id = $2', [courseId, sectionId]);
  if (result.rowCount === 0) {
    return { course_id: courseId, section_id: sectionId, enabled: false, title: '', description: '', updated_at: null };
  }
  return result.rows[0];
}

export async function upsertSectionModalConfig(courseId: string, input: { section_id: string; enabled?: boolean; title?: string; description?: string }) {
  await query(
    `INSERT INTO section_modal_configs (course_id, section_id, enabled, title, description)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (course_id, section_id) DO UPDATE SET
       enabled = COALESCE($3, section_modal_configs.enabled),
       title = COALESCE($4, section_modal_configs.title),
       description = COALESCE($5, section_modal_configs.description),
       updated_at = NOW()`,
    [courseId, input.section_id, input.enabled ?? false, input.title || '', input.description || ''],
  );
  await invalidateCourseReadCaches(courseId);
  return { success: true };
}
