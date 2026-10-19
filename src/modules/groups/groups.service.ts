// ═══════════════════════════════════════════════════════════════
// Groups Service — Org → SubGroup → Team hierarchy + assignments
// Tenant-scoped, optimized for millions of users
// ═══════════════════════════════════════════════════════════════

import { query, getClient, withDatabaseTransaction } from '../../config/database.js';
import {
  invalidateTenantCourseCaches,
  invalidateTenantLibraryCaches,
  invalidateTenantNotificationCaches,
  invalidateUserMembershipCaches,
} from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
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
import { createGroupsRepository, type GroupsDb } from './groups.repository.js';
import { createGroupAssignmentsRepository } from './group-assignments.repository.js';
import { createGroupAuditLogsRepository } from './group-audit-logs.repository.js';

// query() joins the caller's current transaction (withDatabaseTransaction) when there is one.
const poolDb: GroupsDb = { query };
const groupsRepository = createGroupsRepository(poolDb);
const assignmentsRepository = createGroupAssignmentsRepository(poolDb);
const auditLogsRepository = createGroupAuditLogsRepository(poolDb);

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
  return groupsRepository.selectTeamTenantId(teamId);
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
  const filter = { tenantId, search };
  const [countR, rows] = await Promise.all([
    groupsRepository.countOrgGroups(filter),
    groupsRepository.selectOrgGroupPage(filter, pageSize, offset),
  ]);
  const total = parseInt(countR.count, 10);
  return { groups: rows, total, page, page_size: pageSize };
}

export async function createOrgGroup(tenantId: string, input: { name: string; description?: string }) {
  return groupsRepository.insertOrgGroup(tenantId, input.name, input.description || '');
}

export async function updateOrgGroup(id: string, tenantId: string, input: { name?: string; description?: string }) {
  const before = await groupsRepository.lockOrgGroupName(id, tenantId);
  if (!before) throw new AppError('Nhóm không tồn tại', 404);
  if (input.name === undefined && input.description === undefined) throw new AppError('Không có dữ liệu', 400);
  const updated = await groupsRepository.updateOrgGroupFields(id, tenantId, input);
  if (!updated) throw new AppError('Nhóm không tồn tại', 404);
  return { ...updated, previousName: before.name };
}

export async function deleteOrgGroup(id: string, tenantId: string) {
  const deleted = await groupsRepository.deleteOrgGroup(id, tenantId);
  if (!deleted) throw new AppError('Nhóm không tồn tại', 404);
  return deleted;
}

// ═══ Sub Groups (level 2) ═══

export async function listSubGroups(orgGroupId: string, tenantId: string, queryParams: Record<string, unknown>) {
  const search = queryParams.search as string;

  // A group of another tenant yields an empty list, never its subgroups.
  const result = await groupsRepository.selectSubGroups(orgGroupId, tenantId, search);
  return { subgroups: result.rows, total: result.rowCount };
}

export async function createSubGroup(orgGroupId: string, tenantId: string, input: { name: string }) {
  const created = await groupsRepository.insertSubGroup(orgGroupId, tenantId, input.name);
  if (!created) throw new AppError('Nhóm không tồn tại hoặc không thuộc tenant hiện tại', 404);
  return created;
}

export async function getSubGroupDetail(sgId: string, tenantId: string) {
  // Tenant check first: nothing below is read for another tenant's subgroup.
  const subGroup = await groupsRepository.selectSubGroup(sgId, tenantId);
  if (!subGroup) throw new AppError('Phân nhóm không tồn tại', 404);

  const [teamsR, membersR, coursesR, categoriesR, courseCatsR] = await Promise.all([
    groupsRepository.selectSubGroupTeams(sgId),
    groupsRepository.selectSubGroupMembers(sgId),
    groupsRepository.selectSubGroupCourses(sgId),
    groupsRepository.selectSubGroupDocCategories(sgId),
    groupsRepository.selectSubGroupCourseCategories(sgId),
  ]);

  return {
    ...subGroup,
    team_count: teamsR.rowCount,
    teams: teamsR.rows,
    member_count: membersR.rowCount,
    members: membersR.rows,
    course_count: coursesR.rowCount,
    courses: coursesR.rows,
    category_count: categoriesR.rowCount,
    categories: categoriesR.rows,
    course_category_count: courseCatsR.rowCount,
    course_categories: courseCatsR.rows,
  };
}

export async function updateSubGroup(id: string, tenantId: string, input: { name: string }) {
  const before = await groupsRepository.lockSubGroupName(id, tenantId);
  if (!before) throw new AppError('Phân nhóm không tồn tại', 404);
  const updated = await groupsRepository.updateSubGroupName(id, tenantId, input.name);
  if (!updated) throw new AppError('Phân nhóm không tồn tại', 404);
  return { ...updated, previousName: before.name };
}

export async function deleteSubGroup(id: string, tenantId: string) {
  const deleted = await groupsRepository.deleteSubGroup(id, tenantId);
  if (!deleted) throw new AppError('Phân nhóm không tồn tại', 404);
  return deleted;
}

// ═══ Teams (level 3) ═══

export async function listTeams(subgroupId: string, tenantId: string, queryParams: Record<string, unknown>) {
  const search = queryParams.search as string;

  const result = await groupsRepository.selectTeams(subgroupId, tenantId, search);
  return { teams: result.rows, total: result.rowCount };
}

export async function createTeam(subgroupId: string, tenantId: string, input: { name: string }) {
  const created = await groupsRepository.insertTeam(subgroupId, tenantId, input.name);
  if (!created) throw new AppError('Phân nhóm không tồn tại hoặc không thuộc tenant hiện tại', 404);
  return created;
}

export async function getTeamDetail(teamId: string, tenantId: string) {
  const team = await groupsRepository.selectTeamDetail(teamId, tenantId);
  if (!team) throw new AppError('Team không tồn tại', 404);

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
  tenantId: string,
  queryParams: Record<string, unknown>,
) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const filter = { teamId, tenantId, search };
  const [total, rows] = await Promise.all([
    groupsRepository.countTeamMembers(filter),
    groupsRepository.selectTeamMemberPage(filter, pageSize, offset),
  ]);

  return {
    data: rows,
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function listTeamDocCategories(
  teamId: string,
  tenantId: string,
  queryParams: Record<string, unknown>,
) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const filter = { teamId, tenantId, search };
  const [total, rows] = await Promise.all([
    groupsRepository.countTeamDocCategories(filter),
    groupsRepository.selectTeamDocCategoryPage(filter, pageSize, offset),
  ]);

  return {
    data: rows,
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function listTeamCourseCategories(
  teamId: string,
  tenantId: string,
  queryParams: Record<string, unknown>,
) {
  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const filter = { teamId, tenantId, search };
  const [total, rows] = await Promise.all([
    groupsRepository.countTeamCourseCategories(filter),
    groupsRepository.selectTeamCourseCategoryPage(filter, pageSize, offset),
  ]);

  return {
    data: rows,
    total,
    page,
    pageSize,
    totalPages: calcTotalPages(total, pageSize),
  };
}

export async function updateTeam(id: string, tenantId: string, input: { name: string }) {
  const before = await groupsRepository.lockTeamName(id, tenantId);
  if (!before) throw new AppError('Team không tồn tại', 404);
  const updated = await groupsRepository.updateTeamName(id, tenantId, input.name);
  if (!updated) throw new AppError('Team không tồn tại', 404);
  return { ...updated, previousName: before.name };
}

export async function deleteTeam(id: string, tenantId: string) {
  const deleted = await groupsRepository.deleteTeam(id, tenantId);
  if (!deleted) throw new AppError('Team không tồn tại', 404);
  return deleted;
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

  const { notificationId, added, emailQueued, teamName } = await withDatabaseTransaction(async (client) => {
    let notificationId: string | null = null;
    let emailQueued = 0;
    const repository = createGroupAssignmentsRepository(client);

    const team = await repository.lockTeamWithParents(teamId, options.tenantId);
    if (!team) {
      throw new AppError(`${labels.team} không tồn tại hoặc không thuộc tenant hiện tại.`, 404);
    }
    const teamName = team.team_name;

    const insertedUserIds = await repository.insertEligibleTeamMembers(teamId, normalizedUserIds, options.tenantId);
    const added = insertedUserIds.length;

    if (added > 0) {
      const categoryRows = await repository.selectTeamCourseCategorySummaries(teamId, options.tenantId);
      const courseCategories: CourseCategorySummary[] = categoryRows.map(row => ({
        name: row.name,
        courseCount: Number(row.course_count || 0),
      }));
      const title = `Bạn đã được thêm vào ${teamLabelLower} ${team.team_name}`;
      const message = `Bạn vừa được thêm vào ${teamLabelLower} ${team.team_name} thuộc ${subgroupLabelLower} ${team.subgroup_name} - ${groupLabelLower} ${team.org_group_name}.`;

      notificationId = await repository.insertTeamMemberNotification({
        tenantId: options.tenantId,
        teamId,
        teamName: team.team_name,
        subgroupName: team.subgroup_name,
        orgGroupName: team.org_group_name,
        sendEmail,
        courseCategoriesJson: JSON.stringify(courseCategories),
        title,
        message,
        actorUserId: options.actorUserId,
        recipientCount: added,
        groupLabelsJson: JSON.stringify(labels),
      });

      await repository.insertNotificationRecipients(notificationId, insertedUserIds);

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

    return { notificationId, added, emailQueued, teamName };
  });

  if (emailQueued > 0) {
    wakeEmailOutboxWorker('team-member-added');
  }
  await invalidateUserMembershipCaches(normalizedUserIds);
  if (notificationId) await invalidateTenantNotificationCaches(options.tenantId);

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
  const context = await assignmentsRepository.selectTeamMemberContext(teamId, userId, tenantId);
  const result = await removeTeamMemberFromDb(teamId, userId, tenantId);
  await invalidateUserMembershipCaches([userId]);
  return {
    ...result,
    teamName: context?.team_name || teamId,
    username: context?.username || userId,
  };
}

async function removeTeamMemberFromDb(teamId: string, userId: string, tenantId: string) {
  const removed = await assignmentsRepository.deleteTeamMember(teamId, userId, tenantId);
  if (removed === 0) throw new AppError('Thành viên không thuộc team', 404);
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
  const context = await assignmentsRepository.selectTeamCourseContext(teamId, courseId, tenantId);
  const result = await revokeTeamCourseFromDb(teamId, courseId, tenantId);
  await invalidateTenantCourseCaches(tenantId);
  return {
    ...result,
    teamName: context?.team_name || teamId,
    courseName: context?.course_name || courseId,
  };
}

async function revokeTeamCourseFromDb(teamId: string, courseId: string, tenantId: string) {
  const removed = await assignmentsRepository.deleteTeamCourse(teamId, courseId, tenantId);
  if (removed === 0) throw new AppError('Khóa học không thuộc team', 404);
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
    const repository = createGroupAssignmentsRepository(client);

    const team = await repository.selectTeamName(teamId);
    teamName = team?.name || teamId;

    for (const cid of normalizedCategoryIds) {
      const inserted = await repository.insertTeamDocCategory(teamId, cid, tenantId);
      if (inserted! > 0) assigned++; else skipped++;
    }

    if (assigned > 0 && auditEntry) {
      const entry = auditEntry({ teamName, assigned });
      if (entry) await appendAuditLog(client, entry);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); // fails only on a broken connection, which pg-pool discards
    throw err;
  } finally {
    client.release();
  }

  await invalidateTenantLibraryCaches(tenantId);
  return { success: true, assigned, skipped, teamName };
}
export async function revokeTeamDocCategory(teamId: string, categoryId: string, tenantId: string) {
  await assertTeamInTenant(teamId, tenantId);
  const context = await assignmentsRepository.selectTeamDocCategoryContext(teamId, categoryId, tenantId);
  const result = await revokeTeamDocCategoryFromDb(teamId, categoryId, tenantId);
  await invalidateTenantLibraryCaches(tenantId);
  return {
    ...result,
    teamName: context?.team_name || teamId,
    categoryName: context?.category_name || categoryId,
  };
}

async function revokeTeamDocCategoryFromDb(teamId: string, categoryId: string, tenantId: string) {
  const removed = await assignmentsRepository.deleteTeamDocCategory(teamId, categoryId, tenantId);
  if (removed === 0) throw new AppError('Danh mục tài liệu không thuộc team', 404);
  return { success: true };
}

// ═══ Team Course Categories ═══

export async function assignTeamCourseCategories(teamId: string, categoryIds: string[], tenantId: string) {
  await assertTeamInTenant(teamId, tenantId);
  const team = await assignmentsRepository.selectTenantTeamName(teamId, tenantId);
  const teamName = team?.name || teamId;
  let assigned = 0, skipped = 0;
  for (const cid of categoryIds) {
    const inserted = await assignmentsRepository.insertTeamCourseCategory(teamId, cid, tenantId);
    if (inserted! > 0) assigned++; else skipped++;
  }
  if (tenantId) await invalidateTenantCourseCaches(tenantId);
  return { success: true, assigned, skipped, teamName };
}

export async function revokeTeamCourseCategory(teamId: string, categoryId: string, tenantId: string) {
  await assertTeamInTenant(teamId, tenantId);
  const context = await assignmentsRepository.selectTeamCourseCategoryContext(teamId, categoryId, tenantId);
  const result = await revokeTeamCourseCategoryFromDb(teamId, categoryId, tenantId);
  await invalidateTenantCourseCaches(tenantId);
  return {
    ...result,
    teamName: context?.team_name || teamId,
    categoryName: context?.category_name || categoryId,
  };
}

async function revokeTeamCourseCategoryFromDb(teamId: string, categoryId: string, tenantId: string) {
  const removed = await assignmentsRepository.deleteTeamCourseCategory(teamId, categoryId, tenantId);
  if (removed === 0) throw new AppError('Danh mục khóa học không thuộc team', 404);
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
  const filter = {
    tenantId,
    viewerRole,
    search,
    action: queryParams.action as string,
    dateFrom: queryParams.date_from as string,
    dateTo: queryParams.date_to as string,
  };
  const [countR, rows] = await Promise.all([
    auditLogsRepository.countGroupAuditLogs(filter),
    auditLogsRepository.selectGroupAuditLogPage(filter, pageSize, offset),
  ]);
  const total = parseInt(countR.count, 10);
  return { results: rows, total, page, page_size: pageSize, total_pages: calcTotalPages(total, pageSize) };
}
