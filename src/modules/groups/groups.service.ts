// ═══════════════════════════════════════════════════════════════
// Groups Service — Org → SubGroup → Team hierarchy + assignments
// Tenant-scoped, optimized for millions of users
// ═══════════════════════════════════════════════════════════════

import { query, getClient } from '../../config/database.js';
import {
  invalidateTenantCourseCaches,
  invalidateTenantLibraryCaches,
  invalidateUserMembershipCaches,
} from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import {
  appendAuditLogViewerScopeFilter,
  AUDIT_LOG_PUBLIC_SELECT_COLUMNS,
  AUDIT_LOG_RETENTION_DAYS,
} from '../audit-logs/audit-logs.service.js';
import type { UserRole } from '../../types/index.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import {
  enqueueTeamMemberAddedEmails,
  wakeEmailOutboxWorker,
} from '../assignments/email-outbox.service.js';
import { getCourseNotificationSmtpStatus } from '../notifications/notifications.service.js';
import {
  getGroupLabelSet,
  getTenantGroupLabels,
  lowerGroupLabel,
} from '../tenants/tenant-group-labels.service.js';
import {
  assertUserNotActiveDemoIframeAccount,
  getActiveDemoIframeUserIds,
} from '../demo-login/demo-iframe.service.js';

interface AddTeamMembersOptions {
  tenantId: string;
  actorUserId: string;
  auditEntry?: (result: { teamName: string; added: number }) => TransactionalAuditEntry | null;
}

interface CourseCategorySummary {
  name: string;
  courseCount: number;
}

async function getTeamTenantId(teamId: string): Promise<string | null> {
  const result = await query<{ tenant_id: string }>(
    `SELECT og.tenant_id
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE t.id = $1`,
    [teamId],
  );
  return result.rows[0]?.tenant_id ?? null;
}

async function assertTeamInTenant(teamId: string, tenantId: string): Promise<void> {
  const teamTenantId = await getTeamTenantId(teamId);
  if (!teamTenantId || teamTenantId !== tenantId) {
    throw new AppError('Team không tồn tại hoặc không thuộc tenant hiện tại', 404);
  }
}

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

export async function updateOrgGroup(id: string, tenantId: string, input: { name?: string; description?: string }) {
  const before = await query<{ name: string }>(
    'SELECT name FROM org_groups WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE',
    [id, tenantId],
  );
  if (before.rowCount === 0) throw new AppError('Nhóm không tồn tại', 404);
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
  if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }
  if (sets.length === 0) throw new AppError('Không có dữ liệu', 400);
  params.push(id, tenantId);
  const result = await query(
    `UPDATE org_groups SET ${sets.join(', ')} WHERE id = $${idx} AND tenant_id = $${idx + 1}::uuid RETURNING id, name`,
    params,
  );
  if (result.rowCount === 0) throw new AppError('Nhóm không tồn tại', 404);
  return { ...result.rows[0], previousName: before.rows[0].name };
}

export async function deleteOrgGroup(id: string, tenantId: string) {
  const result = await query(
    'DELETE FROM org_groups WHERE id = $1 AND tenant_id = $2::uuid RETURNING id, name',
    [id, tenantId],
  );
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

export async function createSubGroup(orgGroupId: string, tenantId: string, input: { name: string }) {
  const result = await query(
    `INSERT INTO sub_groups (org_group_id, name)
     SELECT id, $3 FROM org_groups WHERE id = $1 AND tenant_id = $2::uuid
     RETURNING id, name`,
    [orgGroupId, tenantId, input.name],
  );
  if (result.rowCount === 0) throw new AppError('Nhóm không tồn tại hoặc không thuộc tenant hiện tại', 404);
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

export async function updateSubGroup(id: string, tenantId: string, input: { name: string }) {
  const before = await query<{ name: string }>(
    `SELECT sg.name
     FROM sub_groups sg JOIN org_groups og ON og.id = sg.org_group_id
     WHERE sg.id = $1 AND og.tenant_id = $2::uuid FOR UPDATE OF sg`,
    [id, tenantId],
  );
  if (before.rowCount === 0) throw new AppError('Phân nhóm không tồn tại', 404);
  const result = await query(
    `UPDATE sub_groups sg SET name = $1
     FROM org_groups og
     WHERE sg.id = $2 AND sg.org_group_id = og.id AND og.tenant_id = $3::uuid
     RETURNING sg.id, sg.name`,
    [input.name, id, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Phân nhóm không tồn tại', 404);
  return { ...result.rows[0], previousName: before.rows[0].name };
}

export async function deleteSubGroup(id: string, tenantId: string) {
  const result = await query(
    `DELETE FROM sub_groups sg
     USING org_groups og
     WHERE sg.id = $1 AND sg.org_group_id = og.id AND og.tenant_id = $2::uuid
     RETURNING sg.id, sg.name`,
    [id, tenantId],
  );
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

export async function createTeam(subgroupId: string, tenantId: string, input: { name: string }) {
  const result = await query(
    `INSERT INTO teams (sub_group_id, name)
     SELECT sg.id, $3
     FROM sub_groups sg
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE sg.id = $1 AND og.tenant_id = $2::uuid
     RETURNING id, name`,
    [subgroupId, tenantId, input.name],
  );
  if (result.rowCount === 0) throw new AppError('Phân nhóm không tồn tại hoặc không thuộc tenant hiện tại', 404);
  return result.rows[0];
}

export async function getTeamDetail(teamId: string) {
  const teamR = await query(
    `SELECT t.*,
            sg.name AS subgroup_name,
            og.id AS org_group_id,
            og.name AS org_group_name,
            (SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = t.id) AS member_count,
            (SELECT COUNT(*)::int FROM team_courses tc WHERE tc.team_id = t.id) AS course_count,
            (SELECT COUNT(*)::int FROM team_doc_categories tdc WHERE tdc.team_id = t.id) AS category_count,
            (SELECT COUNT(*)::int FROM team_course_categories tcc WHERE tcc.team_id = t.id) AS course_category_count
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE t.id = $1`,
    [teamId],
  );

  if (teamR.rowCount === 0) throw new AppError('Team không tồn tại', 404);

  const team = teamR.rows[0];
  return {
    ...team,
    member_count: Number(team.member_count || 0),
    course_count: Number(team.course_count || 0),
    course_category_count: Number(team.course_category_count || 0),
    category_count: Number(team.category_count || 0),
    members: [],
    courses: [],
    categories: [],
    course_categories: [],
  };
}

export async function listTeamMembers(
  teamId: string,
  tenantId: string | null,
  queryParams: Record<string, unknown>,
) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [teamId];
  const conditions = ['tm.team_id = $1::uuid'];

  if (tenantId) {
    params.push(tenantId);
    conditions.push(`og.tenant_id = $${params.length}::uuid`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(
      u.username ILIKE $${params.length}
      OR u.email ILIKE $${params.length}
      OR u.full_name ILIKE $${params.length}
    )`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const from = `FROM team_members tm
    JOIN teams t ON t.id = tm.team_id
    JOIN sub_groups sg ON sg.id = t.sub_group_id
    JOIN org_groups og ON og.id = sg.org_group_id
    JOIN users u ON u.id = tm.user_id`;

  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count ${from} ${where}`, params),
    query(
      `SELECT u.id,
              u.username,
              u.email,
              u.full_name,
              u.avatar_url AS avatar,
              tm.added_at
       ${from}
       ${where}
       ORDER BY tm.added_at DESC, u.id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = parseInt(countR.rows[0]?.count || '0', 10);
  return {
    data: dataR.rows,
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function listTeamDocCategories(
  teamId: string,
  tenantId: string | null,
  queryParams: Record<string, unknown>,
) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [teamId];
  const conditions = ['tdc.team_id = $1::uuid'];

  if (tenantId) {
    params.push(tenantId);
    conditions.push(`og.tenant_id = $${params.length}::uuid`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`unaccent(dc.name) ILIKE unaccent($${params.length})`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const from = `FROM team_doc_categories tdc
    JOIN teams t ON t.id = tdc.team_id
    JOIN sub_groups sg ON sg.id = t.sub_group_id
    JOIN org_groups og ON og.id = sg.org_group_id
    JOIN document_categories dc ON dc.id = tdc.category_id`;

  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count ${from} ${where}`, params),
    query(
      `SELECT tdc.category_id,
              dc.name,
              tdc.assigned_at
       ${from}
       ${where}
       ORDER BY tdc.assigned_at DESC, dc.name
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = parseInt(countR.rows[0]?.count || '0', 10);
  return {
    data: dataR.rows,
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function listTeamCourseCategories(
  teamId: string,
  tenantId: string | null,
  queryParams: Record<string, unknown>,
) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [teamId];
  const conditions = ['tcc.team_id = $1::uuid'];

  if (tenantId) {
    params.push(tenantId);
    conditions.push(`og.tenant_id = $${params.length}::uuid`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`unaccent(cc.name) ILIKE unaccent($${params.length})`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const from = `FROM team_course_categories tcc
    JOIN teams t ON t.id = tcc.team_id
    JOIN sub_groups sg ON sg.id = t.sub_group_id
    JOIN org_groups og ON og.id = sg.org_group_id
    JOIN course_categories cc ON cc.id = tcc.category_id`;

  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count ${from} ${where}`, params),
    query(
      `SELECT tcc.category_id,
              cc.name,
              cc.slug,
              tcc.assigned_at
       ${from}
       ${where}
       ORDER BY tcc.assigned_at DESC, cc.name
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = parseInt(countR.rows[0]?.count || '0', 10);
  return {
    data: dataR.rows,
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function updateTeam(id: string, tenantId: string, input: { name: string }) {
  const before = await query<{ name: string }>(
    `SELECT t.name
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE t.id = $1 AND og.tenant_id = $2::uuid FOR UPDATE OF t`,
    [id, tenantId],
  );
  if (before.rowCount === 0) throw new AppError('Team không tồn tại', 404);
  const result = await query(
    `UPDATE teams t SET name = $1
     FROM sub_groups sg
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE t.id = $2 AND t.sub_group_id = sg.id AND og.tenant_id = $3::uuid
     RETURNING t.id, t.name`,
    [input.name, id, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Team không tồn tại', 404);
  return { ...result.rows[0], previousName: before.rows[0].name };
}

export async function deleteTeam(id: string, tenantId: string) {
  const result = await query(
    `DELETE FROM teams t
     USING sub_groups sg, org_groups og
     WHERE t.id = $1
       AND t.sub_group_id = sg.id
       AND sg.org_group_id = og.id
       AND og.tenant_id = $2::uuid
     RETURNING t.id, t.name`,
    [id, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Team không tồn tại', 404);
  return result.rows[0];
}

// ═══ Team Members ═══

export async function getGroupNotificationSmtpStatus(tenantId: string) {
  return getCourseNotificationSmtpStatus(tenantId);
}

export async function addTeamMembers(
  teamId: string,
  userIds: string[],
  options: AddTeamMembersOptions,
) {
  const normalizedUserIds = Array.from(new Set(
    userIds
      .filter((uid): uid is string => typeof uid === 'string')
      .map(uid => uid.trim())
      .filter(Boolean),
  ));
  const lockedDemoUsers = await getActiveDemoIframeUserIds(normalizedUserIds);
  if (lockedDemoUsers.size > 0) {
    throw new AppError('Không thể cập nhật team membership cho learner demo iframe đang hoạt động', 403);
  }
  const smtpStatus = await getCourseNotificationSmtpStatus(options.tenantId);
  const sendEmail = smtpStatus.can_send_email;
  const emailSkippedReason = sendEmail ? null : smtpStatus.reason;
  const groupLabels = await getTenantGroupLabels(options.tenantId);
  const labels = getGroupLabelSet(groupLabels);
  const groupLabelLower = lowerGroupLabel(labels.group);
  const subgroupLabelLower = lowerGroupLabel(labels.subgroup);
  const teamLabelLower = lowerGroupLabel(labels.team);

  if (normalizedUserIds.length === 0) {
    return {
      success: true,
      added: 0,
      skipped: 0,
      notification_id: null,
      email_requested: sendEmail,
      email_queued: 0,
      email_skipped_reason: emailSkippedReason,
      teamName: teamId,
    };
  }

  const client = await getClient();
  let notificationId: string | null = null;
  let added = 0;
  let emailQueued = 0;
  let teamName = teamId;
  try {
    await client.query('BEGIN');

    const teamResult = await client.query<{
      id: string;
      team_name: string;
      subgroup_name: string;
      org_group_name: string;
    }>(
      `SELECT t.id,
              t.name AS team_name,
              sg.name AS subgroup_name,
              og.name AS org_group_name
       FROM teams t
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE t.id = $1::uuid
         AND og.tenant_id = $2::uuid
       FOR SHARE`,
      [teamId, options.tenantId],
    );

    const team = teamResult.rows[0];
    if (!team) {
      throw new AppError(`${labels.team} không tồn tại hoặc không thuộc tenant hiện tại.`, 404);
    }
    teamName = team.team_name;

    const insertResult = await client.query<{ user_id: string }>(
      `WITH input_users AS (
         SELECT DISTINCT unnest($2::uuid[]) AS user_id
       ),
       eligible_users AS (
         SELECT iu.user_id
         FROM input_users iu
         JOIN users u
           ON u.id = iu.user_id
          AND u.tenant_id = $3::uuid
         WHERE u.role IN ('learner', 'learner_plus')
           AND u.is_active = true
       )
       INSERT INTO team_members (team_id, user_id)
       SELECT $1::uuid, user_id
       FROM eligible_users
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
      [teamId, normalizedUserIds, options.tenantId],
    );

    const insertedUserIds = insertResult.rows.map(row => row.user_id);
    added = insertedUserIds.length;

    if (added > 0) {
      const categoryResult = await client.query<{
        name: string;
        course_count: string;
      }>(
        `SELECT cc.name,
                COUNT(DISTINCT c.id)::int AS course_count
         FROM team_course_categories tcc
         JOIN course_categories cc
           ON cc.id = tcc.category_id
         LEFT JOIN course_category_courses ccc
           ON ccc.category_id = tcc.category_id
         LEFT JOIN courses c
           ON c.id = ccc.course_id
          AND c.tenant_id = $2::uuid
          AND c.deleted_at IS NULL
          AND c.visible_to_staff_only = false
         WHERE tcc.team_id = $1::uuid
         GROUP BY cc.id, cc.name
         ORDER BY cc.name`,
        [teamId, options.tenantId],
      );
      const courseCategories: CourseCategorySummary[] = categoryResult.rows.map(row => ({
        name: row.name,
        courseCount: Number(row.course_count || 0),
      }));
      const title = `Bạn đã được thêm vào ${teamLabelLower} ${team.team_name}`;
      const message = `Bạn vừa được thêm vào ${teamLabelLower} ${team.team_name} thuộc ${subgroupLabelLower} ${team.subgroup_name} - ${groupLabelLower} ${team.org_group_name}.`;

      const notification = await client.query<{ id: string }>(
        `INSERT INTO notifications (tenant_id, course_id, type, metadata, title, message, sent_by, recipient_count)
         VALUES (
           $1::uuid,
           NULL,
           'team_member_added',
           jsonb_build_object(
             'send_email', $6::boolean,
             'recipient_rule', 'team_members_added',
             'team_id', $2::uuid,
             'team_name', $3::text,
             'subgroup_name', $4::text,
             'org_group_name', $5::text,
             'group_labels', $12::jsonb,
             'course_categories', $7::jsonb
           ),
           $8::varchar,
           $9::text,
           $10::uuid,
           $11::int
         )
         RETURNING id`,
        [
          options.tenantId,
          teamId,
          team.team_name,
          team.subgroup_name,
          team.org_group_name,
          sendEmail,
          JSON.stringify(courseCategories),
          title,
          message,
          options.actorUserId,
          added,
          JSON.stringify(labels),
        ],
      );
      notificationId = notification.rows[0].id;

      await client.query(
        `INSERT INTO notification_recipients (notification_id, user_id)
         SELECT $1::uuid, unnest($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [notificationId, insertedUserIds],
      );

      if (sendEmail) {
        emailQueued = await enqueueTeamMemberAddedEmails(client, {
          tenantId: options.tenantId,
          notificationId,
          orgGroupName: team.org_group_name,
          subGroupName: team.subgroup_name,
          teamName: team.team_name,
          groupLabels,
          courseCategories,
        });
      }
    }

    if (added > 0 && options.auditEntry) {
      const entry = options.auditEntry({ teamName, added });
      if (entry) await appendAuditLog(client, entry);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (emailQueued > 0) {
    wakeEmailOutboxWorker('team-member-added');
  }
  await invalidateUserMembershipCaches(normalizedUserIds);

  return {
    success: true,
    added,
    skipped: normalizedUserIds.length - added,
    notification_id: notificationId,
    email_requested: sendEmail,
    email_queued: emailQueued,
    email_skipped_reason: emailSkippedReason,
    teamName,
  };
}

export async function removeTeamMember(teamId: string, userId: string, tenantId: string) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Không thể cập nhật team membership cho learner demo iframe đang hoạt động');
  const context = await query<{ team_name: string; username: string }>(
    `SELECT t.name AS team_name, u.username
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     JOIN users u ON u.id = $2
     WHERE t.id = $1 AND og.tenant_id = $3::uuid`,
    [teamId, userId, tenantId],
  );
  const result = await removeTeamMemberFromDb(teamId, userId, tenantId);
  await invalidateUserMembershipCaches([userId]);
  return {
    ...result,
    teamName: context.rows[0]?.team_name || teamId,
    username: context.rows[0]?.username || userId,
  };
}

async function removeTeamMemberFromDb(teamId: string, userId: string, tenantId: string) {
  const r = await query(
    `DELETE FROM team_members tm
     USING teams t, sub_groups sg, org_groups og
     WHERE tm.team_id = t.id
       AND t.sub_group_id = sg.id
       AND sg.org_group_id = og.id
       AND tm.team_id = $1 AND tm.user_id = $2 AND og.tenant_id = $3::uuid
     RETURNING tm.user_id`,
    [teamId, userId, tenantId],
  );
  if (r.rowCount === 0) throw new AppError('Thành viên không thuộc team', 404);
  return { success: true };
}

// ═══ Team Courses ═══

export async function assignTeamCourses(teamId: string, courseIds: string[], tenantId: string) {
  void courseIds;
  await assertTeamInTenant(teamId, tenantId);
  throw new AppError('Không còn hỗ trợ phân khóa học riêng cho team. Vui lòng phân danh mục khóa học.', 400);
}

export async function revokeTeamCourse(teamId: string, courseId: string, tenantId: string) {
  await assertTeamInTenant(teamId, tenantId);
  const context = await query<{ team_name: string; course_name: string | null }>(
    `SELECT t.name AS team_name, c.display_name AS course_name
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     LEFT JOIN courses c ON c.id = $2 AND c.tenant_id = $3::uuid
     WHERE t.id = $1::uuid
       AND og.tenant_id = $3::uuid`,
    [teamId, courseId, tenantId],
  );
  const result = await revokeTeamCourseFromDb(teamId, courseId, tenantId);
  await invalidateTenantCourseCaches(tenantId);
  return {
    ...result,
    teamName: context.rows[0]?.team_name || teamId,
    courseName: context.rows[0]?.course_name || courseId,
  };
}

async function revokeTeamCourseFromDb(teamId: string, courseId: string, tenantId: string) {
  const r = await query(
    `DELETE FROM team_courses tc
     USING teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE tc.team_id = t.id
       AND tc.team_id = $1::uuid
       AND tc.course_id = $2
       AND og.tenant_id = $3::uuid
     RETURNING tc.course_id`,
    [teamId, courseId, tenantId],
  );
  if (r.rowCount === 0) throw new AppError('Khóa học không thuộc team', 404);
  return { success: true };
}

// ═══ Team Document Categories ═══

export async function assignTeamDocCategories(
  teamId: string,
  categoryIds: string[],
  tenantId: string,
  auditEntry?: (result: { teamName: string; assigned: number }) => TransactionalAuditEntry | null,
) {
  const normalizedCategoryIds = Array.from(new Set(
    categoryIds
      .filter((cid): cid is string => typeof cid === 'string')
      .map((cid) => cid.trim())
      .filter(Boolean),
  ));
  await assertTeamInTenant(teamId, tenantId);

  const client = await getClient();
  let assigned = 0, skipped = 0;
  let teamName = teamId;
  try {
    await client.query('BEGIN');

    const teamResult = await client.query<{ name: string }>('SELECT name FROM teams WHERE id = $1::uuid', [teamId]);
    teamName = teamResult.rows[0]?.name || teamId;

    for (const cid of normalizedCategoryIds) {
      const r = await client.query(
        `INSERT INTO team_doc_categories (team_id, category_id)
         SELECT $1::uuid, dc.id
         FROM document_categories dc
         WHERE dc.id = $2::uuid
           AND dc.tenant_id = $3::uuid
           AND COALESCE(dc.is_public, false) = false
         ON CONFLICT DO NOTHING`,
        [teamId, cid, tenantId],
      );
      if (r.rowCount! > 0) assigned++; else skipped++;
    }

    if (assigned > 0 && auditEntry) {
      const entry = auditEntry({ teamName, assigned });
      if (entry) await appendAuditLog(client, entry);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  await invalidateTenantLibraryCaches(tenantId);
  return { success: true, assigned, skipped, teamName };
}
export async function revokeTeamDocCategory(teamId: string, categoryId: string, tenantId: string) {
  await assertTeamInTenant(teamId, tenantId);
  const context = await query<{ team_name: string; category_name: string | null }>(
    `SELECT t.name AS team_name, dc.name AS category_name
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     LEFT JOIN document_categories dc ON dc.id = $2::uuid AND dc.tenant_id = $3::uuid
     WHERE t.id = $1::uuid
       AND og.tenant_id = $3::uuid`,
    [teamId, categoryId, tenantId],
  );
  const result = await revokeTeamDocCategoryFromDb(teamId, categoryId, tenantId);
  await invalidateTenantLibraryCaches(tenantId);
  return {
    ...result,
    teamName: context.rows[0]?.team_name || teamId,
    categoryName: context.rows[0]?.category_name || categoryId,
  };
}

async function revokeTeamDocCategoryFromDb(teamId: string, categoryId: string, tenantId: string) {
  const r = await query(
    `DELETE FROM team_doc_categories tdc
     USING teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     JOIN document_categories dc ON dc.id = tdc.category_id
     WHERE tdc.team_id = t.id
       AND tdc.team_id = $1::uuid
       AND tdc.category_id = $2::uuid
       AND og.tenant_id = $3::uuid
       AND dc.tenant_id = $3::uuid
     RETURNING tdc.category_id`,
    [teamId, categoryId, tenantId],
  );
  if (r.rowCount === 0) throw new AppError('Danh mục tài liệu không thuộc team', 404);
  return { success: true };
}

// ═══ Team Course Categories ═══

export async function assignTeamCourseCategories(teamId: string, categoryIds: string[], tenantId: string) {
  await assertTeamInTenant(teamId, tenantId);
  const teamResult = await query<{ name: string }>(
    `SELECT t.name
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE t.id = $1::uuid AND og.tenant_id = $2::uuid`,
    [teamId, tenantId],
  );
  const teamName = teamResult.rows[0]?.name || teamId;
  let assigned = 0, skipped = 0;
  for (const cid of categoryIds) {
    const r = await query(
      `INSERT INTO team_course_categories (team_id, category_id)
       SELECT $1::uuid, cc.id
       FROM course_categories cc
       WHERE cc.id = $2::uuid
         AND cc.tenant_id = $3::uuid
         AND COALESCE(cc.is_public, false) = false
       ON CONFLICT DO NOTHING`,
      [teamId, cid, tenantId],
    );
    if (r.rowCount! > 0) assigned++; else skipped++;
  }
  if (tenantId) await invalidateTenantCourseCaches(tenantId);
  return { success: true, assigned, skipped, teamName };
}

export async function revokeTeamCourseCategory(teamId: string, categoryId: string, tenantId: string) {
  await assertTeamInTenant(teamId, tenantId);
  const context = await query<{ team_name: string; category_name: string | null }>(
    `SELECT t.name AS team_name, cc.name AS category_name
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     LEFT JOIN course_categories cc ON cc.id = $2::uuid AND cc.tenant_id = $3::uuid
     WHERE t.id = $1::uuid
       AND og.tenant_id = $3::uuid`,
    [teamId, categoryId, tenantId],
  );
  const result = await revokeTeamCourseCategoryFromDb(teamId, categoryId, tenantId);
  await invalidateTenantCourseCaches(tenantId);
  return {
    ...result,
    teamName: context.rows[0]?.team_name || teamId,
    categoryName: context.rows[0]?.category_name || categoryId,
  };
}

async function revokeTeamCourseCategoryFromDb(teamId: string, categoryId: string, tenantId: string) {
  const r = await query(
    `DELETE FROM team_course_categories tcc
     USING teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     JOIN course_categories cc ON cc.id = tcc.category_id
     WHERE tcc.team_id = t.id
       AND tcc.team_id = $1::uuid
       AND tcc.category_id = $2::uuid
       AND og.tenant_id = $3::uuid
       AND cc.tenant_id = $3::uuid
     RETURNING tcc.category_id`,
    [teamId, categoryId, tenantId],
  );
  if (r.rowCount === 0) throw new AppError('Danh mục khóa học không thuộc team', 404);
  return { success: true };
}

// ═══ Group Audit Logs ═══

export async function getGroupAuditLogs(
  tenantId: string | null,
  viewerRole: UserRole,
  queryParams: Record<string, unknown>,
) {
  if (!tenantId) throw new AppError('Chưa xác định được doanh nghiệp đang sử dụng', 403);

  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [];
  const conditions: string[] = [];

  // Chỉ lấy audit logs liên quan đến groups
  conditions.push(`a.entity_type IN ('org_group', 'sub_group', 'team', 'team_member', 'team_course', 'team_category', 'team_course_category')`);

  params.push(tenantId);
  conditions.push(`a.tenant_id = $${params.length}`);
  appendAuditLogViewerScopeFilter(viewerRole, params, conditions);
  if (search && search.length >= 2) { params.push(`%${search}%`); conditions.push(`(a.entity_name ILIKE $${params.length} OR a.actor_username ILIKE $${params.length})`); }
  const actionFilter = queryParams.action as string;
  if (actionFilter && actionFilter !== 'all') { params.push(actionFilter); conditions.push(`a.action = $${params.length}`); }
  const dateFrom = queryParams.date_from as string;
  if (dateFrom) { params.push(dateFrom); conditions.push(`a.created_at >= $${params.length}::timestamptz`); }
  else { conditions.push(`a.created_at >= now() - (${AUDIT_LOG_RETENTION_DAYS} * interval '1 day')`); }
  const dateTo = queryParams.date_to as string;
  if (dateTo) { params.push(dateTo); conditions.push(`a.created_at <= $${params.length}::timestamptz`); }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const [countR, dataR] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM audit_logs a ${where}`, params),
    query(
      `SELECT ${AUDIT_LOG_PUBLIC_SELECT_COLUMNS}
       FROM audit_logs a ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);
  const total = parseInt(countR.rows[0].count, 10);
  return { results: dataR.rows, total, page, page_size: pageSize, total_pages: calcTotalPages(total, pageSize) };
}
