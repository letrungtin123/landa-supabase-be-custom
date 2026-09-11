// ═══════════════════════════════════════════════════════════════
// Permission Groups — tenant-scoped groups, matrix and own history.
// ═══════════════════════════════════════════════════════════════

import type { PoolClient } from 'pg';
import { query, withDatabaseTransaction } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { parsePagination, calcOffset, calcTotalPages } from '../../utils/query-helpers.js';
import type {
  CreatePermGroupInput,
  SavePermGroupConfigurationInput,
  UpdatePermGroupInput,
} from './permissions.validator.js';
import {
  appendPermissionGroupHistory,
  type PermissionGroupHistoryActor,
  type PermissionGroupHistoryParticipant,
  type PermissionGroupStateSnapshot,
} from './permission-group-history.service.js';
import {
  assertUserNotActiveDemoIframeAccount,
  getActiveDemoIframeUserIds,
} from '../demo-login/demo-iframe.service.js';

const PROTECTED_MODULE_CODE = 'permission_groups';

type MatrixInput = {
  module_code: string;
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
  can_delete: boolean;
};

interface LockedGroup {
  id: string;
  name: string;
  description: string | null;
}

interface MemberSnapshot {
  id: string;
  username: string;
  full_name: string | null;
  email: string | null;
  role: string | null;
}

function groupState(group: LockedGroup, matrix: PermissionGroupStateSnapshot['matrix']): PermissionGroupStateSnapshot {
  return {
    group: { id: group.id, name: group.name, description: group.description || '' },
    matrix,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

async function lockGroup(client: PoolClient, groupId: string, tenantId: string): Promise<LockedGroup> {
  const result = await client.query<LockedGroup>(
    `SELECT id, name, description
     FROM permission_groups
     WHERE id = $1::uuid AND tenant_id = $2::uuid
     FOR UPDATE`,
    [groupId, tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Nhóm quyền không tồn tại', 404);
  return result.rows[0];
}

async function getMatrixSnapshot(client: PoolClient, groupId: string, tenantId: string): Promise<PermissionGroupStateSnapshot['matrix']> {
  const result = await client.query<PermissionGroupStateSnapshot['matrix'][number]>(
    `SELECT m.code AS module_code,
            m.name AS module_name,
            m.icon AS module_icon,
            COALESCE(pgm.can_view, false) AS can_view,
            COALESCE(pgm.can_add, false) AS can_add,
            COALESCE(pgm.can_edit, false) AS can_edit,
            COALESCE(pgm.can_delete, false) AS can_delete
     FROM modules m
     JOIN tenant_modules tm
       ON tm.module_id = m.id
      AND tm.tenant_id = $2::uuid
      AND tm.is_enabled = true
     LEFT JOIN permission_group_modules pgm
       ON pgm.permission_group_id = $1::uuid
      AND pgm.module_id = m.id
      AND pgm.tenant_id = $2::uuid
     WHERE m.is_active = true
       AND m.code <> $3
     ORDER BY m.sort_order ASC, m.code ASC`,
    [groupId, tenantId, PROTECTED_MODULE_CODE],
  );
  return result.rows;
}

async function getMembersSnapshot(client: PoolClient, groupId: string, tenantId: string): Promise<MemberSnapshot[]> {
  const result = await client.query<MemberSnapshot>(
    `SELECT u.id, u.username,
            NULLIF(btrim(u.full_name), '') AS full_name,
            NULLIF(lower(btrim(u.email)), '') AS email,
            u.role
     FROM user_permission_groups upg
     JOIN users u ON u.id = upg.user_id
     WHERE upg.permission_group_id = $1::uuid
       AND upg.tenant_id = $2::uuid
       AND u.tenant_id = $2::uuid
     ORDER BY u.id ASC`,
    [groupId, tenantId],
  );
  return result.rows;
}

async function getStateSnapshot(client: PoolClient, group: LockedGroup, tenantId: string): Promise<PermissionGroupStateSnapshot> {
  return groupState(group, await getMatrixSnapshot(client, group.id, tenantId));
}

async function assertCompleteEditableMatrix(client: PoolClient, tenantId: string, permissions: MatrixInput[]): Promise<void> {
  const requestedCodes = permissions.map((permission) => permission.module_code);
  const uniqueCodes = new Set(requestedCodes);
  if (uniqueCodes.size !== requestedCodes.length) {
    throw new AppError('Mỗi tính năng chỉ được xuất hiện một lần trong ma trận quyền', 400);
  }
  if (uniqueCodes.has(PROTECTED_MODULE_CODE)) {
    throw new AppError('Không thể cấu hình quyền cho tính năng Nhóm quyền', 403);
  }

  const available = await client.query<{ code: string }>(
    `SELECT m.code
     FROM modules m
     JOIN tenant_modules tm ON tm.module_id = m.id
     WHERE tm.tenant_id = $1::uuid
       AND tm.is_enabled = true
       AND m.is_active = true
       AND m.code <> $2
     ORDER BY m.code ASC`,
    [tenantId, PROTECTED_MODULE_CODE],
  );
  const availableCodes = new Set(available.rows.map((row) => row.code));
  if (availableCodes.size !== uniqueCodes.size || Array.from(uniqueCodes).some((code) => !availableCodes.has(code))) {
    throw new AppError('Ma trận phải bao gồm chính xác các tính năng đang bật của doanh nghiệp', 400);
  }
}

async function applyMatrix(client: PoolClient, groupId: string, tenantId: string, permissions: MatrixInput[]): Promise<void> {
  await client.query(
    `INSERT INTO permission_group_modules (
       permission_group_id, module_id, tenant_id,
       can_view, can_add, can_edit, can_delete
     )
     SELECT $1::uuid, m.id, $2::uuid,
            p.can_view, p.can_add, p.can_edit, p.can_delete
     FROM jsonb_to_recordset($3::jsonb) AS p(
       module_code text,
       can_view boolean,
       can_add boolean,
       can_edit boolean,
       can_delete boolean
     )
     JOIN modules m ON m.code = p.module_code
     ON CONFLICT (permission_group_id, module_id) DO UPDATE
       SET can_view = EXCLUDED.can_view,
           can_add = EXCLUDED.can_add,
           can_edit = EXCLUDED.can_edit,
           can_delete = EXCLUDED.can_delete,
           tenant_id = EXCLUDED.tenant_id`,
    [groupId, tenantId, JSON.stringify(permissions)],
  );
}

async function ensureDemoUsersAreUnlocked(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const lockedDemoUsers = await getActiveDemoIframeUserIds(userIds);
  if (lockedDemoUsers.size > 0) {
    throw new AppError('Không thể cập nhật nhóm quyền cho học viên demo đang hoạt động', 403);
  }
}

/**
 * Membership is a cross-group resource: a user can belong to only one group.
 * Take a transaction advisory lock before a group row lock in every write path
 * so two concurrent saves cannot race or deadlock while moving one user.
 */
async function lockMembershipUsers(client: PoolClient, userIds: string[]): Promise<void> {
  const ids = uniqueIds(userIds).sort();
  if (ids.length === 0) return;
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(user_id::text, 20260911))
     FROM (
       SELECT user_id
       FROM unnest($1::uuid[]) AS u(user_id)
       ORDER BY user_id
     ) ordered_users`,
    [ids],
  );
}

async function applyMemberChanges(
  client: PoolClient,
  group: LockedGroup,
  tenantId: string,
  addUserIds: string[],
  removeUserIds: string[],
): Promise<PermissionGroupHistoryParticipant[]> {
  const addIds = uniqueIds(addUserIds);
  const removeIds = uniqueIds(removeUserIds);
  if (addIds.some((id) => removeIds.includes(id))) {
    throw new AppError('Một thành viên không thể vừa được thêm vừa bị xóa trong cùng lần lưu', 400);
  }

  const participants: PermissionGroupHistoryParticipant[] = [];
  if (removeIds.length > 0) {
    const membersToRemove = await client.query<MemberSnapshot>(
      `SELECT u.id, u.username,
              NULLIF(btrim(u.full_name), '') AS full_name,
              NULLIF(lower(btrim(u.email)), '') AS email,
              u.role
       FROM user_permission_groups upg
       JOIN users u ON u.id = upg.user_id
       WHERE upg.permission_group_id = $1::uuid
         AND upg.tenant_id = $2::uuid
         AND u.tenant_id = $2::uuid
         AND u.id = ANY($3::uuid[])
       ORDER BY u.id ASC
       FOR UPDATE`,
      [group.id, tenantId, removeIds],
    );
    if (membersToRemove.rowCount !== removeIds.length) {
      throw new AppError('Có thành viên không thuộc nhóm quyền này', 404);
    }
    await client.query(
      `DELETE FROM user_permission_groups upg
       USING permission_groups pg
       WHERE upg.permission_group_id = pg.id
         AND upg.permission_group_id = $1::uuid
         AND upg.tenant_id = $2::uuid
         AND pg.tenant_id = $2::uuid
         AND upg.user_id = ANY($3::uuid[])`,
      [group.id, tenantId, removeIds],
    );
    participants.push(...membersToRemove.rows.map((member) => ({
      user_id: member.id,
      username: member.username,
      display_name: member.full_name,
      email: member.email,
      role: member.role,
      change: 'removed' as const,
      previous_group_id: group.id,
      previous_group_name: group.name,
    })));
  }

  if (addIds.length > 0) {
    const eligibleUsers = await client.query<MemberSnapshot & { previous_group_id: string | null; previous_group_name: string | null }>(
      `SELECT u.id, u.username,
              NULLIF(btrim(u.full_name), '') AS full_name,
              NULLIF(lower(btrim(u.email)), '') AS email,
              u.role,
              current_group.permission_group_id AS previous_group_id,
              current_group.name AS previous_group_name
       FROM users u
       LEFT JOIN LATERAL (
         SELECT upg.permission_group_id, pg.name
         FROM user_permission_groups upg
         JOIN permission_groups pg ON pg.id = upg.permission_group_id
         WHERE upg.user_id = u.id
           AND upg.tenant_id = $2::uuid
           AND pg.tenant_id = $2::uuid
         ORDER BY upg.created_at DESC, upg.id DESC
         LIMIT 1
       ) current_group ON true
       WHERE u.id = ANY($1::uuid[])
         AND u.tenant_id = $2::uuid
         AND u.role IN ('staff', 'learner_plus')
       ORDER BY u.id ASC
       FOR UPDATE`,
      [addIds, tenantId],
    );
    if (eligibleUsers.rowCount !== addIds.length) {
      throw new AppError('Có thành viên không hợp lệ hoặc không thuộc doanh nghiệp hiện tại', 404);
    }
    const usersToAssign = eligibleUsers.rows.filter((member) => member.previous_group_id !== group.id);
    if (usersToAssign.length > 0) {
      const idsToAssign = usersToAssign.map((member) => member.id);
      await client.query(
        `DELETE FROM user_permission_groups upg
         USING permission_groups pg
         WHERE upg.permission_group_id = pg.id
           AND upg.tenant_id = $2::uuid
           AND pg.tenant_id = $2::uuid
           AND upg.user_id = ANY($1::uuid[])`,
        [idsToAssign, tenantId],
      );
      await client.query(
        `INSERT INTO user_permission_groups (user_id, permission_group_id, tenant_id)
         SELECT user_id, $2::uuid, $3::uuid
         FROM unnest($1::uuid[]) AS user_id`,
        [idsToAssign, group.id, tenantId],
      );
      participants.push(...usersToAssign.map((member) => ({
        user_id: member.id,
        username: member.username,
        display_name: member.full_name,
        email: member.email,
        role: member.role,
        change: member.previous_group_id ? 'reassigned' as const : 'added' as const,
        previous_group_id: member.previous_group_id,
        previous_group_name: member.previous_group_name,
      })));
    }
  }
  return participants;
}

/** Danh sách permission groups của tenant — phân trang + search. */
export async function listPermGroups(tenantId: string | null, queryParams: Record<string, unknown>) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (tenantId) {
    params.push(tenantId);
    conditions.push(`pg.tenant_id = $${params.length}::uuid`);
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
              (SELECT COUNT(*) FROM user_permission_groups upg WHERE upg.permission_group_id = pg.id AND upg.tenant_id = pg.tenant_id) AS member_count
       FROM permission_groups pg
       LEFT JOIN tenants t ON t.id = pg.tenant_id
       ${where}
       ORDER BY pg.created_at DESC, pg.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);
  const total = Number.parseInt(countResult.rows[0].count, 10);
  return { data: dataResult.rows, total, page, pageSize, totalPages: calcTotalPages(total, pageSize) };
}

/** Chi tiết nhóm + ma trận current, tuyệt đối không trả module Nhóm quyền. */
export async function getPermGroupById(groupId: string, tenantId: string) {
  const groupResult = await query<LockedGroup & { tenant_id: string; tenant_name: string | null; created_at: string; updated_at: string }>(
    `SELECT pg.id, pg.name, pg.description, pg.tenant_id, t.name AS tenant_name, pg.created_at, pg.updated_at
     FROM permission_groups pg
     LEFT JOIN tenants t ON t.id = pg.tenant_id
     WHERE pg.id = $1::uuid AND pg.tenant_id = $2::uuid`,
    [groupId, tenantId],
  );
  if (groupResult.rowCount === 0) throw new AppError('Nhóm quyền không tồn tại', 404);
  const [permissions, members] = await Promise.all([
    query(
      `SELECT m.id AS module_id, m.code, m.name, m.icon, m.sort_order,
              COALESCE(pgm.can_view, false) AS can_view,
              COALESCE(pgm.can_add, false) AS can_add,
              COALESCE(pgm.can_edit, false) AS can_edit,
              COALESCE(pgm.can_delete, false) AS can_delete
       FROM modules m
       JOIN tenant_modules tm ON tm.module_id = m.id AND tm.tenant_id = $2::uuid AND tm.is_enabled = true
       LEFT JOIN permission_group_modules pgm ON pgm.module_id = m.id AND pgm.permission_group_id = $1::uuid AND pgm.tenant_id = $2::uuid
       WHERE m.is_active = true AND m.code <> $3
       ORDER BY m.sort_order ASC, m.code ASC`,
      [groupId, tenantId, PROTECTED_MODULE_CODE],
    ),
    query(
      `SELECT u.id, u.username, u.email, u.full_name, u.avatar_url
       FROM user_permission_groups upg
       JOIN users u ON u.id = upg.user_id
       WHERE upg.permission_group_id = $1::uuid AND upg.tenant_id = $2::uuid AND u.tenant_id = $2::uuid
       ORDER BY u.username ASC, u.id ASC`,
      [groupId, tenantId],
    ),
  ]);
  return { ...groupResult.rows[0], permissions: permissions.rows, members: members.rows };
}

export async function createPermGroup(tenantId: string, input: CreatePermGroupInput, actor: PermissionGroupHistoryActor) {
  return withDatabaseTransaction(async (client) => {
    const existing = await client.query('SELECT id FROM permission_groups WHERE tenant_id = $1::uuid AND name = $2', [tenantId, input.name]);
    if (existing.rowCount && existing.rowCount > 0) throw new AppError('Tên nhóm quyền đã tồn tại trong doanh nghiệp này', 409);
    const result = await client.query<LockedGroup & { tenant_id: string }>(
      `INSERT INTO permission_groups (tenant_id, name, description)
       VALUES ($1::uuid, $2, $3)
       RETURNING id, name, description, tenant_id`,
      [tenantId, input.name, input.description || ''],
    );
    const created = result.rows[0];
    await appendPermissionGroupHistory(client, { tenantId, groupId: created.id, groupName: created.name, action: 'created', actor, afterState: await getStateSnapshot(client, created, tenantId) });
    return created;
  });
}

export async function updatePermGroup(groupId: string, tenantId: string, input: UpdatePermGroupInput, actor: PermissionGroupHistoryActor) {
  return withDatabaseTransaction(async (client) => {
    const beforeGroup = await lockGroup(client, groupId, tenantId);
    const beforeState = await getStateSnapshot(client, beforeGroup, tenantId);
    const name = input.name === undefined ? beforeGroup.name : input.name;
    const description = input.description === undefined ? beforeGroup.description || '' : input.description;
    if (name === beforeGroup.name && description === (beforeGroup.description || '')) return beforeGroup;
    if (name !== beforeGroup.name) {
      const duplicate = await client.query('SELECT id FROM permission_groups WHERE tenant_id = $1::uuid AND name = $2 AND id <> $3::uuid', [tenantId, name, groupId]);
      if (duplicate.rowCount && duplicate.rowCount > 0) throw new AppError('Tên nhóm quyền đã tồn tại trong doanh nghiệp này', 409);
    }
    const updated = await client.query<LockedGroup>(
      `UPDATE permission_groups SET name = $1, description = $2
       WHERE id = $3::uuid AND tenant_id = $4::uuid
       RETURNING id, name, description`,
      [name, description, groupId, tenantId],
    );
    const afterGroup = updated.rows[0];
    await appendPermissionGroupHistory(client, {
      tenantId, groupId, groupName: afterGroup.name, action: 'updated', actor,
      beforeState, afterState: await getStateSnapshot(client, afterGroup, tenantId),
    });
    return afterGroup;
  });
}

export async function deletePermGroup(groupId: string, tenantId: string, actor: PermissionGroupHistoryActor) {
  return withDatabaseTransaction(async (client) => {
    const group = await lockGroup(client, groupId, tenantId);
    const beforeState = await getStateSnapshot(client, group, tenantId);
    await client.query('DELETE FROM permission_groups WHERE id = $1::uuid AND tenant_id = $2::uuid', [groupId, tenantId]);
    await appendPermissionGroupHistory(client, {
      tenantId, groupId, groupName: group.name, action: 'deleted', actor, beforeState,
    });
    return { id: group.id, name: group.name };
  });
}

export async function updatePermissionsMatrix(groupId: string, tenantId: string, permissions: MatrixInput[], actor: PermissionGroupHistoryActor) {
  return withDatabaseTransaction(async (client) => {
    const group = await lockGroup(client, groupId, tenantId);
    await assertCompleteEditableMatrix(client, tenantId, permissions);
    const beforeState = await getStateSnapshot(client, group, tenantId);
    const proposedMatrix = permissions.map((permission) => ({ ...permission })).sort((a, b) => a.module_code.localeCompare(b.module_code));
    const currentMatrix = beforeState.matrix.map((permission) => ({
      module_code: permission.module_code, can_view: permission.can_view, can_add: permission.can_add,
      can_edit: permission.can_edit, can_delete: permission.can_delete,
    })).sort((a, b) => a.module_code.localeCompare(b.module_code));
    const changed = !sameJson(currentMatrix, proposedMatrix);
    if (changed) await applyMatrix(client, groupId, tenantId, permissions);
    if (changed) {
      await appendPermissionGroupHistory(client, {
        tenantId, groupId, groupName: group.name, action: 'matrix_updated', actor,
        beforeState, afterState: await getStateSnapshot(client, group, tenantId),
      });
    }
    return { changed };
  });
}

export async function addMembersToGroup(groupId: string, tenantId: string, userIds: string[], actor: PermissionGroupHistoryActor) {
  const normalizedIds = uniqueIds(userIds);
  await ensureDemoUsersAreUnlocked(normalizedIds);
  return withDatabaseTransaction(async (client) => {
    await lockMembershipUsers(client, normalizedIds);
    const group = await lockGroup(client, groupId, tenantId);
    const beforeState = await getStateSnapshot(client, group, tenantId);
    const participants = await applyMemberChanges(client, group, tenantId, normalizedIds, []);
    if (participants.length > 0) {
      await appendPermissionGroupHistory(client, {
        tenantId, groupId, groupName: group.name, action: 'members_assigned', actor,
        beforeState, afterState: await getStateSnapshot(client, group, tenantId), participants,
      });
    }
    return { added: participants.length, total: normalizedIds.length, groupName: group.name, affectedUserIds: normalizedIds };
  });
}

export async function removeMemberFromGroup(groupId: string, userId: string, tenantId: string, actor: PermissionGroupHistoryActor) {
  await assertUserNotActiveDemoIframeAccount(userId, 'Không thể cập nhật nhóm quyền cho học viên demo đang hoạt động');
  return withDatabaseTransaction(async (client) => {
    await lockMembershipUsers(client, [userId]);
    const group = await lockGroup(client, groupId, tenantId);
    const beforeState = await getStateSnapshot(client, group, tenantId);
    const participants = await applyMemberChanges(client, group, tenantId, [], [userId]);
    await appendPermissionGroupHistory(client, {
      tenantId, groupId, groupName: group.name, action: 'member_removed', actor,
      beforeState, afterState: await getStateSnapshot(client, group, tenantId), participants,
    });
    return { groupName: group.name, username: participants[0].username, affectedUserIds: [userId] };
  });
}

export async function savePermGroupConfiguration(
  groupId: string,
  tenantId: string,
  input: SavePermGroupConfigurationInput,
  actor: PermissionGroupHistoryActor,
) {
  const addIds = uniqueIds(input.add_user_ids);
  const removeIds = uniqueIds(input.remove_user_ids);
  if (removeIds.includes(actor.id)) throw new AppError('Không thể xóa chính bạn khỏi nhóm quyền', 403);
  await ensureDemoUsersAreUnlocked([...addIds, ...removeIds]);
  return withDatabaseTransaction(async (client) => {
    await lockMembershipUsers(client, [...addIds, ...removeIds]);
    const group = await lockGroup(client, groupId, tenantId);
    await assertCompleteEditableMatrix(client, tenantId, input.permissions);
    const beforeState = await getStateSnapshot(client, group, tenantId);
    const proposedMatrix = input.permissions.map((permission) => ({ ...permission })).sort((a, b) => a.module_code.localeCompare(b.module_code));
    const currentMatrix = beforeState.matrix.map((permission) => ({
      module_code: permission.module_code, can_view: permission.can_view, can_add: permission.can_add,
      can_edit: permission.can_edit, can_delete: permission.can_delete,
    })).sort((a, b) => a.module_code.localeCompare(b.module_code));
    const matrixChanged = !sameJson(currentMatrix, proposedMatrix);
    if (matrixChanged) await applyMatrix(client, groupId, tenantId, input.permissions);
    const participants = await applyMemberChanges(client, group, tenantId, addIds, removeIds);
    const afterState = await getStateSnapshot(client, group, tenantId);
    const membersChanged = participants.length > 0;
    const changed = matrixChanged || membersChanged;
    if (changed) {
      await appendPermissionGroupHistory(client, {
        tenantId, groupId, groupName: group.name, action: 'configuration_updated', actor,
        beforeState, afterState, participants,
      });
    }
    return {
      changed,
      matrixChanged,
      affectedUserIds: uniqueIds([
        ...participants.map((participant) => participant.user_id),
      ]),
    };
  });
}

/**
 * Compatibility path for the User module.  The User API must never replace a
 * membership by writing user_permission_groups directly: this keeps the same
 * tenant fence, locking protocol, and independent Permission Group history as
 * the dedicated Permission Groups screen.
 */
export async function replaceUserPermissionGroup(
  userId: string,
  targetGroupId: string | null,
  tenantId: string,
  actor: PermissionGroupHistoryActor,
) {
  return withDatabaseTransaction(async (client) => {
    await lockMembershipUsers(client, [userId]);

    const userResult = await client.query<MemberSnapshot>(
      `SELECT id, username,
              NULLIF(btrim(full_name), '') AS full_name,
              NULLIF(lower(btrim(email)), '') AS email,
              role
       FROM users
       WHERE id = $1::uuid
         AND tenant_id = $2::uuid
         AND deletion_requested_at IS NULL
       FOR UPDATE`,
      [userId, tenantId],
    );
    if (userResult.rowCount === 0) {
      throw new AppError('Thành viên không tồn tại trong doanh nghiệp hiện tại', 404);
    }
    const user = userResult.rows[0];
    if (targetGroupId && user.role !== 'staff' && user.role !== 'learner_plus') {
      throw new AppError('Chỉ có thể gán nhóm quyền cho staff hoặc learner nâng cao', 400);
    }
    await assertUserNotActiveDemoIframeAccount(userId, 'Không thể cập nhật nhóm quyền cho học viên demo đang hoạt động');

    const currentResult = await client.query<LockedGroup>(
      `SELECT pg.id, pg.name, pg.description
       FROM user_permission_groups upg
       JOIN permission_groups pg ON pg.id = upg.permission_group_id
       WHERE upg.user_id = $1::uuid
         AND upg.tenant_id = $2::uuid
         AND pg.tenant_id = $2::uuid
       ORDER BY upg.created_at DESC, upg.id DESC
       FOR UPDATE`,
      [userId, tenantId],
    );
    if ((currentResult.rowCount || 0) > 1) {
      throw new AppError('Dữ liệu nhóm quyền của thành viên không hợp lệ, vui lòng liên hệ quản trị viên', 409);
    }
    const currentGroup = currentResult.rows[0] || null;

    if (!targetGroupId && !currentGroup) {
      return { changed: false, affectedUserIds: [] as string[] };
    }

    let targetGroup: LockedGroup | null = null;
    if (targetGroupId) {
      targetGroup = await lockGroup(client, targetGroupId, tenantId);
      if (currentGroup?.id === targetGroup.id) {
        return { changed: false, affectedUserIds: [] as string[] };
      }
    }

    const participantBase = {
      user_id: user.id,
      username: user.username,
      display_name: user.full_name,
      email: user.email,
      role: user.role,
    };
    const previousState = currentGroup
      ? await getStateSnapshot(client, currentGroup, tenantId)
      : null;
    const targetBeforeState = targetGroup
      ? await getStateSnapshot(client, targetGroup, tenantId)
      : null;

    if (currentGroup) {
      await client.query(
        `DELETE FROM user_permission_groups
         WHERE user_id = $1::uuid
           AND permission_group_id = $2::uuid
           AND tenant_id = $3::uuid`,
        [userId, currentGroup.id, tenantId],
      );
    }
    if (targetGroup) {
      await client.query(
        `INSERT INTO user_permission_groups (user_id, permission_group_id, tenant_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [userId, targetGroup.id, tenantId],
      );
    }

    if (currentGroup && previousState) {
      await appendPermissionGroupHistory(client, {
        tenantId,
        groupId: currentGroup.id,
        groupName: currentGroup.name,
        action: 'member_removed',
        actor,
        beforeState: previousState,
        afterState: await getStateSnapshot(client, currentGroup, tenantId),
        participants: [{
          ...participantBase,
          change: 'removed',
          previous_group_id: currentGroup.id,
          previous_group_name: currentGroup.name,
        }],
      });
    }
    if (targetGroup && targetBeforeState) {
      await appendPermissionGroupHistory(client, {
        tenantId,
        groupId: targetGroup.id,
        groupName: targetGroup.name,
        action: 'members_assigned',
        actor,
        beforeState: targetBeforeState,
        afterState: await getStateSnapshot(client, targetGroup, tenantId),
        participants: [{
          ...participantBase,
          change: currentGroup ? 'reassigned' : 'added',
          previous_group_id: currentGroup?.id || null,
          previous_group_name: currentGroup?.name || null,
        }],
      });
    }

    return { changed: true, affectedUserIds: [userId] };
  });
}
