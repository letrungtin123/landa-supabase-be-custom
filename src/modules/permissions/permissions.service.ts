// ═══════════════════════════════════════════════════════════════
// Permission Groups — tenant-scoped groups, matrix and own history.
// ═══════════════════════════════════════════════════════════════

import type { PoolClient } from 'pg';
import { query, withDatabaseTransaction } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
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
import {
  createPermissionsRepository,
  type MemberSnapshotRow,
  type PermissionGroupRow,
  type PermissionsDb,
} from './permissions.repository.js';

const PROTECTED_MODULE_CODE = 'permission_groups';

type MatrixInput = {
  module_code: string;
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
  can_delete: boolean;
};

type LockedGroup = PermissionGroupRow;

type MemberSnapshot = MemberSnapshotRow;

const permissionsRepository = createPermissionsRepository({ query } satisfies PermissionsDb);

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
  const result = await createPermissionsRepository(client).lockGroup(groupId, tenantId);
  if (result.rowCount === 0) throw new AppError('Nhóm quyền không tồn tại', 404);
  return result.rows[0];
}

async function getMatrixSnapshot(client: PoolClient, groupId: string, tenantId: string): Promise<PermissionGroupStateSnapshot['matrix']> {
  return createPermissionsRepository(client).selectMatrixSnapshot(groupId, tenantId, PROTECTED_MODULE_CODE);
}

async function getMembersSnapshot(client: PoolClient, groupId: string, tenantId: string): Promise<MemberSnapshot[]> {
  return createPermissionsRepository(client).selectMembersSnapshot(groupId, tenantId);
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

  const availableCodes = new Set(await createPermissionsRepository(client).selectEditableModuleCodes(tenantId, PROTECTED_MODULE_CODE));
  if (availableCodes.size !== uniqueCodes.size || Array.from(uniqueCodes).some((code) => !availableCodes.has(code))) {
    throw new AppError('Ma trận phải bao gồm chính xác các tính năng đang bật của doanh nghiệp', 400);
  }
}

async function applyMatrix(client: PoolClient, groupId: string, tenantId: string, permissions: MatrixInput[]): Promise<void> {
  await createPermissionsRepository(client).upsertMatrix(groupId, tenantId, JSON.stringify(permissions));
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
  await createPermissionsRepository(client).lockMembershipUsers(ids);
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

  const repository = createPermissionsRepository(client);
  const participants: PermissionGroupHistoryParticipant[] = [];
  if (removeIds.length > 0) {
    const membersToRemove = await repository.lockGroupMembers(group.id, tenantId, removeIds);
    if (membersToRemove.rowCount !== removeIds.length) {
      throw new AppError('Có thành viên không thuộc nhóm quyền này', 404);
    }
    await repository.deleteGroupMembers(group.id, tenantId, removeIds);
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
    const eligibleUsers = await repository.lockEligibleUsers(addIds, tenantId);
    if (eligibleUsers.rowCount !== addIds.length) {
      throw new AppError('Có thành viên không hợp lệ hoặc không thuộc doanh nghiệp hiện tại', 404);
    }
    const usersToAssign = eligibleUsers.rows.filter((member) => member.previous_group_id !== group.id);
    if (usersToAssign.length > 0) {
      const idsToAssign = usersToAssign.map((member) => member.id);
      await repository.deleteMemberships(idsToAssign, tenantId);
      await repository.insertMemberships(idsToAssign, group.id, tenantId);
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
  const filter = { tenantId, search };
  const [count, data] = await Promise.all([
    permissionsRepository.countGroups(filter),
    permissionsRepository.selectGroupPage(filter, pageSize, offset),
  ]);
  const total = Number.parseInt(count, 10);
  return { data, total, page, pageSize, totalPages: calcTotalPages(total, pageSize) };
}

/** Chi tiết nhóm + ma trận current, tuyệt đối không trả module Nhóm quyền. */
export async function getPermGroupById(groupId: string, tenantId: string) {
  const groupResult = await permissionsRepository.selectGroup(groupId, tenantId);
  if (groupResult.rowCount === 0) throw new AppError('Nhóm quyền không tồn tại', 404);
  const [permissions, members] = await Promise.all([
    permissionsRepository.selectGroupPermissions(groupId, tenantId, PROTECTED_MODULE_CODE),
    permissionsRepository.selectGroupMembers(groupId, tenantId),
  ]);
  return { ...groupResult.rows[0], permissions, members };
}

export async function createPermGroup(tenantId: string, input: CreatePermGroupInput, actor: PermissionGroupHistoryActor) {
  return withDatabaseTransaction(async (client) => {
    const repository = createPermissionsRepository(client);
    const existing = await repository.nameTaken(tenantId, input.name);
    if (existing && existing > 0) throw new AppError('Tên nhóm quyền đã tồn tại trong doanh nghiệp này', 409);
    const created = await repository.insertGroup(tenantId, input.name, input.description || '');
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
      const duplicate = await createPermissionsRepository(client).nameTakenByOther(tenantId, name, groupId);
      if (duplicate && duplicate > 0) throw new AppError('Tên nhóm quyền đã tồn tại trong doanh nghiệp này', 409);
    }
    const afterGroup = await createPermissionsRepository(client).updateGroup(groupId, tenantId, name, description);
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
    await createPermissionsRepository(client).deleteGroup(groupId, tenantId);
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
    const repository = createPermissionsRepository(client);

    const userResult = await repository.lockTenantUser(userId, tenantId);
    if (userResult.rowCount === 0) {
      throw new AppError('Thành viên không tồn tại trong doanh nghiệp hiện tại', 404);
    }
    const user = userResult.rows[0];
    if (targetGroupId && user.role !== 'staff' && user.role !== 'learner_plus') {
      throw new AppError('Chỉ có thể gán nhóm quyền cho staff hoặc learner nâng cao', 400);
    }
    await assertUserNotActiveDemoIframeAccount(userId, 'Không thể cập nhật nhóm quyền cho học viên demo đang hoạt động');

    const currentResult = await repository.lockCurrentGroups(userId, tenantId);
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
      await repository.deleteMembership(userId, currentGroup.id, tenantId);
    }
    if (targetGroup) {
      await repository.insertMembership(userId, targetGroup.id, tenantId);
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
