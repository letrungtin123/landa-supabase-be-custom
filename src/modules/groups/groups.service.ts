// ═══════════════════════════════════════════════════════════════
// Groups Service — Org → SubGroup → Team hierarchy + assignments
// Tenant-scoped, optimized for millions of users
// ═══════════════════════════════════════════════════════════════

import { query, getClient } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';

// ═══ Org Groups (level 1) ═══

export async function listOrgGroups(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (tenantId) { params.push(tenantId); conditions.push(`og.tenant_id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conditions.push(`og.name ILIKE $${params.length}`); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM org_groups og ${where}`, params),
    query(
      `SELECT og.*, (SELECT COUNT(*) FROM sub_groups sg WHERE sg.org_group_id = og.id) AS subgroup_count
       FROM org_groups og ${where}
       ORDER BY og.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);
  const total = parseInt(countR.rows[0].count, 10);
  return { groups: dataR.rows, total, page, page_size: pageSize };
}

export async function createOrgGroup(tenantId: string, input: { name: string; description?: string }) {
  const result = await query(
    'INSERT INTO org_groups (tenant_id, name, description) VALUES ($1, $2, $3) RETURNING id, name',
    [tenantId, input.name, input.description || ''],
  );
  return result.rows[0];
}

export async function updateOrgGroup(id: string, input: { name?: string; description?: string }) {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
  if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
  if (sets.length === 0) throw new AppError('Không có dữ liệu', 400);
  params.push(id);
  const result = await query(`UPDATE org_groups SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, name`, params);
  if (result.rowCount === 0) throw new AppError('Nhóm không tồn tại', 404);
  return result.rows[0];
}

export async function deleteOrgGroup(id: string) {
  const result = await query('DELETE FROM org_groups WHERE id = $1 RETURNING id, name', [id]);
  if (result.rowCount === 0) throw new AppError('Nhóm không tồn tại', 404);
  return result.rows[0];
}

// ═══ Sub Groups (level 2) ═══

export async function listSubGroups(orgGroupId: string, queryParams: Record<string, unknown>) {
  const search = queryParams.search as string;
  const params: unknown[] = [orgGroupId];
  let searchWhere = '';
  if (search) { params.push(`%${search}%`); searchWhere = ` AND sg.name ILIKE $2`; }

  const result = await query(
    `SELECT sg.*, (SELECT COUNT(*) FROM teams t WHERE t.sub_group_id = sg.id) AS team_count
     FROM sub_groups sg WHERE sg.org_group_id = $1${searchWhere}
     ORDER BY sg.name`,
    params,
  );
  return { subgroups: result.rows, total: result.rowCount || 0 };
}

export async function createSubGroup(orgGroupId: string, input: { name: string }) {
  const result = await query(
    'INSERT INTO sub_groups (org_group_id, name) VALUES ($1, $2) RETURNING id, name',
    [orgGroupId, input.name],
  );
  return result.rows[0];
}

export async function getSubGroupDetail(sgId: string) {
  const [sgR, teamsR, membersR, coursesR, categoriesR, courseCatsR] = await Promise.all([
    query(
      `SELECT sg.*, og.name AS org_group_name, og.id AS org_group_id
       FROM sub_groups sg JOIN org_groups og ON og.id = sg.org_group_id WHERE sg.id = $1`,
      [sgId],
    ),
    query('SELECT t.*, (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count FROM teams t WHERE t.sub_group_id = $1 ORDER BY t.name', [sgId]),
    query(
      `SELECT DISTINCT u.id, u.username, u.email, u.avatar_url AS avatar, tm.added_at
       FROM team_members tm JOIN teams t ON t.id = tm.team_id JOIN users u ON u.id = tm.user_id
       WHERE t.sub_group_id = $1 ORDER BY tm.added_at DESC`,
      [sgId],
    ),
    query(
      `SELECT DISTINCT tc.course_id, c.display_name, tc.assigned_at
       FROM team_courses tc JOIN teams t ON t.id = tc.team_id JOIN courses c ON c.id = tc.course_id
       WHERE t.sub_group_id = $1`,
      [sgId],
    ),
    query(
      `SELECT DISTINCT tdc.category_id, dc.name, tdc.assigned_at
       FROM team_doc_categories tdc JOIN teams t ON t.id = tdc.team_id JOIN document_categories dc ON dc.id = tdc.category_id
       WHERE t.sub_group_id = $1`,
      [sgId],
    ),
    query(
      `SELECT DISTINCT tcc.category_id, cc.name, cc.slug, tcc.assigned_at
       FROM team_course_categories tcc JOIN teams t ON t.id = tcc.team_id JOIN course_categories cc ON cc.id = tcc.category_id
       WHERE t.sub_group_id = $1`,
      [sgId],
    ),
  ]);

  if (sgR.rowCount === 0) throw new AppError('Phân nhóm không tồn tại', 404);

  return {
    ...sgR.rows[0],
    team_count: teamsR.rowCount || 0,
    teams: teamsR.rows,
    member_count: membersR.rowCount || 0,
    members: membersR.rows,
    course_count: coursesR.rowCount || 0,
    courses: coursesR.rows,
    category_count: categoriesR.rowCount || 0,
    categories: categoriesR.rows,
    course_category_count: courseCatsR.rowCount || 0,
    course_categories: courseCatsR.rows,
  };
}

export async function updateSubGroup(id: string, input: { name: string }) {
  const result = await query('UPDATE sub_groups SET name = $1 WHERE id = $2 RETURNING id, name', [input.name, id]);
  if (result.rowCount === 0) throw new AppError('Phân nhóm không tồn tại', 404);
  return result.rows[0];
}

export async function deleteSubGroup(id: string) {
  const result = await query('DELETE FROM sub_groups WHERE id = $1 RETURNING id, name', [id]);
  if (result.rowCount === 0) throw new AppError('Phân nhóm không tồn tại', 404);
  return result.rows[0];
}

// ═══ Teams (level 3) ═══

export async function listTeams(subgroupId: string, queryParams: Record<string, unknown>) {
  const search = queryParams.search as string;
  const params: unknown[] = [subgroupId];
  let searchWhere = '';
  if (search) { params.push(`%${search}%`); searchWhere = ` AND t.name ILIKE $2`; }

  const result = await query(
    `SELECT t.*,
            (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count,
            (SELECT COUNT(*) FROM team_courses tc WHERE tc.team_id = t.id) AS course_count,
            (SELECT COUNT(*) FROM team_course_categories tcc WHERE tcc.team_id = t.id) AS course_category_count
     FROM teams t WHERE t.sub_group_id = $1${searchWhere}
     ORDER BY t.name`,
    params,
  );
  return { teams: result.rows, total: result.rowCount || 0 };
}

export async function createTeam(subgroupId: string, input: { name: string }) {
  const result = await query(
    'INSERT INTO teams (sub_group_id, name) VALUES ($1, $2) RETURNING id, name',
    [subgroupId, input.name],
  );
  return result.rows[0];
}

export async function getTeamDetail(teamId: string) {
  const [teamR, membersR, coursesR, categoriesR, courseCatsR] = await Promise.all([
    query(
      `SELECT t.*, sg.name AS subgroup_name, og.id AS org_group_id, og.name AS org_group_name
       FROM teams t
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE t.id = $1`,
      [teamId],
    ),
    query(
      `SELECT u.id, u.username, u.email, u.avatar_url AS avatar, tm.added_at
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1 ORDER BY tm.added_at DESC`,
      [teamId],
    ),
    query(
      `SELECT tc.course_id, c.display_name, tc.assigned_at
       FROM team_courses tc JOIN courses c ON c.id = tc.course_id
       WHERE tc.team_id = $1`,
      [teamId],
    ),
    query(
      `SELECT tdc.category_id, dc.name, tdc.assigned_at
       FROM team_doc_categories tdc JOIN document_categories dc ON dc.id = tdc.category_id
       WHERE tdc.team_id = $1`,
      [teamId],
    ),
    query(
      `SELECT tcc.category_id, cc.name, cc.slug, tcc.assigned_at
       FROM team_course_categories tcc JOIN course_categories cc ON cc.id = tcc.category_id
       WHERE tcc.team_id = $1`,
      [teamId],
    ),
  ]);

  if (teamR.rowCount === 0) throw new AppError('Team không tồn tại', 404);

  return {
    ...teamR.rows[0],
    member_count: membersR.rowCount || 0,
    course_count: coursesR.rowCount || 0,
    course_category_count: courseCatsR.rowCount || 0,
    category_count: categoriesR.rowCount || 0,
    members: membersR.rows,
    courses: coursesR.rows,
    categories: categoriesR.rows,
    course_categories: courseCatsR.rows,
  };
}

export async function updateTeam(id: string, input: { name: string }) {
  const result = await query('UPDATE teams SET name = $1 WHERE id = $2 RETURNING id, name', [input.name, id]);
  if (result.rowCount === 0) throw new AppError('Team không tồn tại', 404);
  return result.rows[0];
}

export async function deleteTeam(id: string) {
  const result = await query('DELETE FROM teams WHERE id = $1 RETURNING id, name', [id]);
  if (result.rowCount === 0) throw new AppError('Team không tồn tại', 404);
  return result.rows[0];
}

// ═══ Team Members ═══

export async function addTeamMembers(teamId: string, userIds: string[]) {
  let added = 0, skipped = 0;
  for (const uid of userIds) {
    const r = await query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [teamId, uid]);
    if (r.rowCount! > 0) added++; else skipped++;
  }
  return { success: true, added, skipped };
}

export async function removeTeamMember(teamId: string, userId: string) {
  const r = await query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2 RETURNING user_id', [teamId, userId]);
  if (r.rowCount === 0) throw new AppError('Thành viên không thuộc team', 404);
  return { success: true };
}

// ═══ Team Courses ═══

export async function assignTeamCourses(teamId: string, courseIds: string[]) {
  let assigned = 0, skipped = 0;
  for (const cid of courseIds) {
    const r = await query('INSERT INTO team_courses (team_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [teamId, cid]);
    if (r.rowCount! > 0) assigned++; else skipped++;
  }
  return { success: true, assigned, skipped };
}

export async function revokeTeamCourse(teamId: string, courseId: string) {
  const r = await query('DELETE FROM team_courses WHERE team_id = $1 AND course_id = $2 RETURNING course_id', [teamId, courseId]);
  if (r.rowCount === 0) throw new AppError('Course không thuộc team', 404);
  return { success: true };
}

// ═══ Team Document Categories ═══

export async function assignTeamDocCategories(teamId: string, categoryIds: string[]) {
  let assigned = 0, skipped = 0;
  for (const cid of categoryIds) {
    const r = await query('INSERT INTO team_doc_categories (team_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [teamId, cid]);
    if (r.rowCount! > 0) assigned++; else skipped++;
  }
  return { success: true, assigned, skipped };
}

export async function revokeTeamDocCategory(teamId: string, categoryId: string) {
  const r = await query('DELETE FROM team_doc_categories WHERE team_id = $1 AND category_id = $2 RETURNING category_id', [teamId, categoryId]);
  if (r.rowCount === 0) throw new AppError('Category không thuộc team', 404);
  return { success: true };
}

// ═══ Team Course Categories ═══

export async function assignTeamCourseCategories(teamId: string, categoryIds: string[]) {
  let assigned = 0, skipped = 0;
  for (const cid of categoryIds) {
    const r = await query('INSERT INTO team_course_categories (team_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [teamId, cid]);
    if (r.rowCount! > 0) assigned++; else skipped++;
  }
  return { success: true, assigned, skipped };
}

export async function revokeTeamCourseCategory(teamId: string, categoryId: string) {
  const r = await query('DELETE FROM team_course_categories WHERE team_id = $1 AND category_id = $2 RETURNING category_id', [teamId, categoryId]);
  if (r.rowCount === 0) throw new AppError('Course category không thuộc team', 404);
  return { success: true };
}

// ═══ Group Audit Logs ═══

export async function getGroupAuditLogs(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [];
  const conditions: string[] = [];

  // Chỉ lấy audit logs liên quan đến groups
  conditions.push(`a.entity_type IN ('org_group', 'sub_group', 'team', 'team_member', 'team_course', 'team_category')`);

  if (tenantId) { params.push(tenantId); conditions.push(`a.tenant_id = $${params.length}`); }
  if (search) { params.push(`%${search}%`); conditions.push(`(a.entity_name ILIKE $${params.length} OR a.actor_username ILIKE $${params.length})`); }
  const actionFilter = queryParams.action as string;
  if (actionFilter && actionFilter !== 'all') { params.push(actionFilter); conditions.push(`a.action = $${params.length}`); }
  const dateFrom = queryParams.date_from as string;
  if (dateFrom) { params.push(dateFrom); conditions.push(`a.created_at >= $${params.length}::timestamptz`); }
  const dateTo = queryParams.date_to as string;
  if (dateTo) { params.push(dateTo); conditions.push(`a.created_at <= $${params.length}::timestamptz`); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM audit_logs a ${where}`, params),
    query(
      `SELECT a.* FROM audit_logs a ${where} ORDER BY a.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);
  const total = parseInt(countR.rows[0].count, 10);
  return { results: dataR.rows, total, page, page_size: pageSize, total_pages: calcTotalPages(total, pageSize) };
}
