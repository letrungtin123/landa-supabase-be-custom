// ═══════════════════════════════════════════════════════════════
// Courses Service — CRUD courses + modal configs
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';

export async function listCourses(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (tenantId) { params.push(tenantId); conditions.push(`c.tenant_id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conditions.push(`c.display_name ILIKE $${params.length}`); }
  const vis = queryParams.visibility as string;
  if (vis === 'staff_only') conditions.push('c.visible_to_staff_only = true');
  else if (vis === 'public') conditions.push('c.visible_to_staff_only = false');

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM courses c ${where}`, params),
    query(`SELECT c.* FROM courses c ${where} ORDER BY c.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pageSize, offset]),
  ]);
  const total = parseInt(countR.rows[0].count, 10);
  return { data: dataR.rows, total, page, pageSize, totalPages: calcTotalPages(total, pageSize) };
}

export async function createCourse(tenantId: string, input: { id: string; display_name: string; org?: string; visible_to_staff_only?: boolean; image_url?: string; start_date?: string; end_date?: string }) {
  // ── Kiểm tra quota course cho tenant ──
  const { checkQuota } = await import('../tenants/tenants.service.js');
  await checkQuota(tenantId, 'courses');

  const result = await query(
    `INSERT INTO courses (id, tenant_id, display_name, org, visible_to_staff_only, image_url, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [input.id, tenantId, input.display_name, input.org || '', input.visible_to_staff_only ?? false, input.image_url || '', input.start_date || null, input.end_date || null],
  );
  return result.rows[0];
}

export async function updateCourse(courseId: string, input: { display_name?: string; visible_to_staff_only?: boolean; image_url?: string }) {
  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];
  let idx = 1;
  if (input.display_name !== undefined) { sets.push(`display_name = $${idx++}`); params.push(input.display_name); }
  if (input.visible_to_staff_only !== undefined) { sets.push(`visible_to_staff_only = $${idx++}`); params.push(input.visible_to_staff_only); }
  if (input.image_url !== undefined) { sets.push(`image_url = $${idx++}`); params.push(input.image_url); }
  params.push(courseId);
  const result = await query(`UPDATE courses SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
  if (result.rowCount === 0) throw new AppError('Course không tồn tại', 404);
  return result.rows[0];
}

export async function bulkCourseAction(ids: string[], action: string) {
  const staffOnly = action === 'staff_only';
  const r = await query('UPDATE courses SET visible_to_staff_only = $1, updated_at = NOW() WHERE id = ANY($2)', [staffOnly, ids]);
  return { updated: r.rowCount || 0 };
}

/**
 * Hard delete course — CASCADE xóa sạch 14+ bảng.
 * Trả về danh sách storage_path để caller cleanup files.
 */
export async function hardDeleteCourse(courseId: string, tenantId: string) {
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
  const coverUrl = courseCheck.rows[0].image_url;
  if (coverUrl) filePaths.push(coverUrl);

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
