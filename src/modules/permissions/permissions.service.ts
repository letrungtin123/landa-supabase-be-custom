// ═══════════════════════════════════════════════════════════════
// Permissions Service — CRUD permission groups + ma trận tick
// Tenant-scoped: mỗi tenant có bộ permission groups riêng
// ═══════════════════════════════════════════════════════════════

import { query, getClient } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import type { CreatePermGroupInput, UpdatePermGroupInput } from './permissions.validator.js';
import {
  assertUserNotActiveDemoIframeAccount,
  getActiveDemoIframeUserIds,
} from '../demo-login/demo-iframe.service.js';

/**
 * Danh sách permission groups của tenant — phân trang + search.
 */
export async function listPermGroups(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);

  const params: unknown[] = [];
  const conditions: string[] = [];

  if (tenantId) {
    params.push(tenantId);
    conditions.push(`pg.tenant_id = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(pg.name ILIKE $${params.length} OR pg.description ILIKE $${params.length})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [countResult, dataResult] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM permission_groups pg ${where}`, params),
    query(
      `SELECT pg.id, pg.name, pg.description, pg.tenant_id, pg.created_at, pg.updated_at,
              t.name AS tenant_name,
              (SELECT COUNT(*) FROM user_permission_groups upg WHERE upg.permission_group_id = pg.id) AS member_count
       FROM permission_groups pg
       LEFT JOIN tenants t ON t.id = pg.tenant_id
       ${where}
       ORDER BY pg.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);

  const total = parseInt(countResult.rows[0].count, 10);

  return {
    data: dataResult.rows,
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

/**
 * Chi tiết permission group + ma trận permissions hiện tại.
 */
export async function getPermGroupById(groupId: string, tenantId: string) {
  const [groupResult, permResult, membersResult] = await Promise.all([
    query(
      `SELECT pg.id, pg.name, pg.description, pg.tenant_id, pg.created_at, pg.updated_at,
              t.name AS tenant_name
       FROM permission_groups pg
       LEFT JOIN tenants t ON t.id = pg.tenant_id
       WHERE pg.id = $1 AND pg.tenant_id = $2::uuid`,
      [groupId, tenantId],
    ),
    // Ma trận: chỉ modules ĐƯỢC BẬT cho tenant + giá trị permission hiện tại
    query(
      `SELECT m.id AS module_id, m.code, m.name, m.icon, m.sort_order,
              COALESCE(pgm.can_view, false) AS can_view,
              COALESCE(pgm.can_add, false) AS can_add,
              COALESCE(pgm.can_edit, false) AS can_edit,
              COALESCE(pgm.can_delete, false) AS can_delete
       FROM modules m
       JOIN tenant_modules tm ON tm.module_id = m.id
         AND tm.tenant_id = (SELECT tenant_id FROM permission_groups WHERE id = $1 AND tenant_id = $2::uuid)
         AND tm.is_enabled = true
       LEFT JOIN permission_group_modules pgm ON pgm.module_id = m.id AND pgm.permission_group_id = $1
       WHERE m.is_active = true
       ORDER BY m.sort_order`,
      [groupId, tenantId],
    ),
    // Members
    query(
      `SELECT u.id, u.username, u.email, u.full_name, u.avatar_url
       FROM user_permission_groups upg
       JOIN users u ON u.id = upg.user_id
       WHERE upg.permission_group_id = $1 AND u.tenant_id = $2::uuid
       ORDER BY u.username`,
      [groupId, tenantId],
    ),
  ]);

  if (groupResult.rowCount === 0) throw new AppError('Nhóm quyền không tồn tại', 404);

  return {
    ...groupResult.rows[0],
    permissions: permResult.rows,
    members: membersResult.rows,
  };
}

/**
 * Tạo permission group mới.
 */
export async function createPermGroup(tenantId: string, input: CreatePermGroupInput) {
  // Kiểm tra tên trùng trong tenant
  const existing = await query(
    'SELECT id FROM permission_groups WHERE tenant_id = $1 AND name = $2',
    [tenantId, input.name],
  );
  if (existing.rowCount! > 0) throw new AppError('Tên nhóm quyền đã tồn tại trong tenant này', 409);

  const result = await query(
    `INSERT INTO permission_groups (tenant_id, name, description)
     VALUES ($1, $2, $3)
     RETURNING id, name, description, tenant_id`,
    [tenantId, input.name, input.description || ''],
  );

  return result.rows[0];
}

/**
 * Cập nhật permission group.
 */
export async function updatePermGroup(groupId: string, tenantId: string, input: UpdatePermGroupInput) {
  const before = await query<{ name: string }>(
    'SELECT name FROM permission_groups WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE',
    [groupId, tenantId],
  );
  if (before.rowCount === 0) throw new AppError('Nhóm quyền không tồn tại', 404);
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
  if (input.description !== undefined) { sets.push(`description = $${idx++}`); params.push(input.description); }

  if (sets.length === 0) throw new AppError('Không có dữ liệu cần cập nhật', 400);

  params.push(groupId, tenantId);
  const result = await query(
    `UPDATE permission_groups SET ${sets.join(', ')}
     WHERE id = $${idx} AND tenant_id = $${idx + 1}::uuid
     RETURNING id, name, description`,
    params,
  );

  if (result.rowCount === 0) throw new AppError('Nhóm quyền không tồn tại', 404);
  return { ...result.rows[0], previousName: before.rows[0].name };
}

/**
 * Xóa permission group.
 */
export async function deletePermGroup(groupId: string, tenantId: string) {
  const result = await query<{ id: string; name: string }>(
    'DELETE FROM permission_groups WHERE id = $1 AND tenant_id = $2::uuid RETURNING id, name',
    [groupId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Nhóm quyền không tồn tại', 404);
  return result.rows[0];
}

/**
 * Cập nhật ma trận permissions (bulk upsert).
 * Input: array { module_code, can_view, can_add, can_edit, can_delete }
 */
export async function updatePermissionsMatrix(
  groupId: string,
  tenantId: string,
  permissions: { module_code: string; can_view: boolean; can_add: boolean; can_edit: boolean; can_delete: boolean }[],
  auditEntry?: (result: { groupName: string; affectedCount: number }) => TransactionalAuditEntry | null,
) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const group = await client.query<{ name: string }>(
      'SELECT name FROM permission_groups WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE',
      [groupId, tenantId],
    );
    if (group.rowCount === 0) throw new AppError('Nhóm quyền không tồn tại', 404);

    let updatedCount = 0;
    for (const perm of permissions) {
      // Tìm module_id từ code
      const modResult = await client.query<{ id: string }>(
        'SELECT id FROM modules WHERE code = $1',
        [perm.module_code],
      );

      if (modResult.rowCount === 0) continue; // Skip module không tồn tại

      const moduleId = modResult.rows[0].id;

      await client.query(
        `INSERT INTO permission_group_modules (permission_group_id, module_id, can_view, can_add, can_edit, can_delete)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (permission_group_id, module_id) DO UPDATE SET
           can_view = $3, can_add = $4, can_edit = $5, can_delete = $6`,
        [groupId, moduleId, perm.can_view, perm.can_add, perm.can_edit, perm.can_delete],
      );
      updatedCount++;
    }

    if (auditEntry) {
      const entry = auditEntry({ groupName: group.rows[0].name, affectedCount: updatedCount });
      if (entry) await appendAuditLog(client, entry);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Thêm users vào permission group (bulk).
 * Skip user đã có trong group (ON CONFLICT DO NOTHING).
 */
export async function addMembersToGroup(
  groupId: string,
  tenantId: string,
  userIds: string[],
  auditEntry?: (result: { groupName: string; added: number }) => TransactionalAuditEntry | null,
) {
  const lockedDemoUsers = await getActiveDemoIframeUserIds(userIds);
  if (lockedDemoUsers.size > 0) {
    throw new AppError('Không thể cập nhật permission group cho learner demo iframe đang hoạt động', 403);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const groupCheck = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM permission_groups WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE',
      [groupId, tenantId],
    );
    if (groupCheck.rowCount === 0) throw new AppError('Nhóm quyền không tồn tại', 404);

    const normalizedUserIds = Array.from(new Set(userIds));
    const eligibleUsers = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid',
      [normalizedUserIds, tenantId],
    );
    if (eligibleUsers.rowCount !== normalizedUserIds.length) {
      throw new AppError('Có thành viên không thuộc tenant hiện tại', 404);
    }

    let addedCount = 0;
    for (const userId of normalizedUserIds) {
      // Enforce 1 group per user: xóa assignment cũ trước khi gán group mới
      await client.query(
        `DELETE FROM user_permission_groups upg
         USING users u
         WHERE upg.user_id = u.id AND upg.user_id = $1 AND u.tenant_id = $2::uuid`,
        [userId, tenantId],
      );

      const result = await client.query(
        `INSERT INTO user_permission_groups (user_id, permission_group_id)
         VALUES ($1, $2)`,
        [userId, groupId],
      );
      if (result.rowCount! > 0) addedCount++;
    }

    if (addedCount > 0 && auditEntry) {
      const entry = auditEntry({ groupName: groupCheck.rows[0].name, added: addedCount });
      if (entry) await appendAuditLog(client, entry);
    }
    await client.query('COMMIT');
    return { added: addedCount, total: normalizedUserIds.length, groupName: groupCheck.rows[0].name };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Xóa user khỏi permission group.
 */
export async function removeMemberFromGroup(groupId: string, userId: string, tenantId: string) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Không thể cập nhật permission group cho learner demo iframe đang hoạt động');

  const context = await query<{ group_name: string; username: string }>(
    `SELECT pg.name AS group_name, u.username
     FROM permission_groups pg
     JOIN users u ON u.id = $2
     WHERE pg.id = $1 AND pg.tenant_id = $3::uuid AND u.tenant_id = $3::uuid`,
    [groupId, userId, tenantId],
  );
  const result = await query(
    `DELETE FROM user_permission_groups upg
     USING permission_groups pg, users u
     WHERE upg.permission_group_id = pg.id
       AND upg.user_id = u.id
       AND upg.permission_group_id = $1 AND upg.user_id = $2
       AND pg.tenant_id = $3::uuid AND u.tenant_id = $3::uuid
     RETURNING upg.user_id`,
    [groupId, userId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('User không thuộc nhóm quyền này', 404);
  return {
    groupName: context.rows[0]?.group_name || groupId,
    username: context.rows[0]?.username || userId,
  };
}
