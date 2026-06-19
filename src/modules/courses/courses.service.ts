// ═══════════════════════════════════════════════════════════════
// Courses Service — CRUD courses + modal configs
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import { uploadFile, deleteFile, buildFileName, buildStoragePath, fixMulterFilename } from '../../config/storage.js';
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
  bio: string | null;
}

type MentorSectionLogoMode = 'light' | 'dark';

interface CourseMentorSection {
  course_id: string;
  description: string | null;
  logo_light: string | null;
  logo_dark: string | null;
  updated_at: string | null;
}

function mapMentor(row: any): CourseMentor | null {
  if (!row?.mentor_id) return null;
  return {
    id: row.mentor_id,
    username: row.mentor_username,
    full_name: row.mentor_full_name,
    email: row.mentor_email,
    phone: row.mentor_phone,
    avatar: row.mentor_avatar,
    role: row.mentor_role,
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
  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM courses c ${where}`, params),
    query(
      `SELECT c.*,
              mentor.id AS mentor_id,
              mentor.username AS mentor_username,
              mentor.full_name AS mentor_full_name,
              mentor.email AS mentor_email,
              mentor.phone AS mentor_phone,
              mentor.avatar_url AS mentor_avatar,
              mentor.role AS mentor_role,
              mentor.bio AS mentor_bio
       FROM courses c
       LEFT JOIN users mentor ON mentor.id = c.mentor_id
       ${where}
       ORDER BY c.updated_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);
  const total = parseInt(countR.rows[0].count, 10);
  return {
    data: dataR.rows.map((row: any) => ({ ...row, mentor: mapMentor(row) })),
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
  return result.rows[0];
}

export async function updateCourse(courseId: string, input: { display_name?: string; description?: string; visible_to_staff_only?: boolean; image_url?: string }) {
  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  let idx = 1;
  if (input.display_name !== undefined) { sets.push(`display_name = $${idx++}`); params.push(input.display_name); }
  if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
  if (input.visible_to_staff_only !== undefined) { sets.push(`visible_to_staff_only = $${idx++}`); params.push(input.visible_to_staff_only); }
  if (input.image_url !== undefined) { sets.push(`image_url = $${idx++}`); params.push(input.image_url); }
  params.push(courseId);
  const result = await query(`UPDATE courses SET ${sets.join(', ')} WHERE id = $${idx} AND deleted_at IS NULL RETURNING *`, params);
  if (result.rowCount === 0) throw new AppError('Course không tồn tại', 404);
  return result.rows[0];
}

export async function bulkCourseAction(ids: string[], action: string) {
  const staffOnly = action === 'staff_only';
  const r = await query(
    'UPDATE courses SET visible_to_staff_only = $1, updated_at = NOW() WHERE id = ANY($2) AND deleted_at IS NULL',
    [staffOnly, ids],
  );
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
  return mapMentor(result.rows[0]);
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
  const conditions = ['u.tenant_id = $1', "u.role = 'staff'", 'u.is_active = true'];

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    conditions.push(`(
      lower(COALESCE(u.full_name, '')) LIKE $${params.length}
      OR lower(u.email) LIKE $${params.length}
      OR lower(u.username) LIKE $${params.length}
    )`);
  }

  const result = await query<any>(
    `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url AS avatar,
            u.role, u.bio, COUNT(*) OVER() AS full_count
     FROM users u
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(NULLIF(u.full_name, ''), u.username), u.id
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0', 10);
  return {
    data: result.rows.map(({ full_count, ...row }: any) => row),
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function updateCourseMentor(courseId: string, tenantId: string, mentorId: string | null): Promise<CourseMentor | null> {
  if (mentorId === null) {
    const updateResult = await query(
      `UPDATE courses
       SET mentor_id = NULL, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [courseId, tenantId],
    );
    if (updateResult.rowCount === 0) throw new AppError('Course khong ton tai', 404);
    return null;
  }

  const mentorResult = await query<CourseMentor>(
    `SELECT id, username, full_name, email, phone, avatar_url AS avatar, role, bio
     FROM users
     WHERE id = $1
       AND tenant_id = $2
       AND role = 'staff'
       AND is_active = true`,
    [mentorId, tenantId],
  );
  if (mentorResult.rowCount === 0) throw new AppError('Mentor khong hop le', 400);

  const updateResult = await query(
    `UPDATE courses
     SET mentor_id = $3, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [courseId, tenantId, mentorId],
  );
  if (updateResult.rowCount === 0) throw new AppError('Course khong ton tai', 404);

  return mentorResult.rows[0];
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
  return { success: true };
}
