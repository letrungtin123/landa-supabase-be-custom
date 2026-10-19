import { getClient, query } from '../../config/database.js';
import { appendAuditLog, type TransactionalAuditEntry } from '../../middleware/audit-log.js';
import { invalidateTenantBadgeCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../utils/errors.js';
import { calcOffset, calcTotalPages, parsePagination } from '../../utils/query-helpers.js';
import {
  criteriaRequiresCourses,
  describeBadgeCriteria,
  minimumMappedCourses,
  parseBadgeCriteria,
} from '../badges/badge-criteria.js';
import { isBadgeManagementModuleEnabled } from '../badges/badge-evaluation.service.js';
import type { UpdateTenantBadgeRuleInput } from './tenant-badges.validator.js';
import { createTenantBadgesRepository, type TenantBadgesDb } from './tenant-badges.repository.js';

// query() joins the caller's current transaction when there is one; the
// transaction block below uses the repository over its own client.
const poolDb: TenantBadgesDb = { query };
const tenantBadgesRepository = createTenantBadgesRepository(poolDb);

type CourseMapping = {
  course_id: string | null;
  display_name: string;
  is_deleted: boolean;
};

function uniqueCourseIds(courseIds: string[]): string[] {
  return Array.from(new Set(courseIds));
}

function uniqueCourseMappings(courses: CourseMapping[]): CourseMapping[] {
  const seen = new Set<string>();
  return courses.filter((course) => {
    if (!course.course_id) return true;
    if (seen.has(course.course_id)) return false;
    seen.add(course.course_id);
    return true;
  });
}

async function assertModuleEnabled(tenantId: string, allowWhenDisabled = false): Promise<boolean> {
  const moduleEnabled = await isBadgeManagementModuleEnabled(tenantId);
  if (!moduleEnabled && !allowWhenDisabled) {
    throw new AppError('Tính năng Quản lý huy hiệu chưa được bật cho tenant', 403);
  }
  return moduleEnabled;
}

export async function listTenantBadges(tenantId: string, allowWhenDisabled = false) {
  const moduleEnabled = await assertModuleEnabled(tenantId, allowWhenDisabled);

  const rows = await tenantBadgesRepository.selectTenantBadgeRules(tenantId);

  return rows.map((row) => {
    const criteria = parseBadgeCriteria(row.criteria);
    const courses = uniqueCourseMappings((Array.isArray(row.courses) ? row.courses : []) as CourseMapping[]);
    const validCourseCount = courses.filter((course) => course.course_id && !course.is_deleted).length;
    const requiresCourses = criteria ? criteriaRequiresCourses(criteria) : false;
    const minimumRequiredCourses = criteria ? minimumMappedCourses(criteria) : 0;
    const isConfigValid = Boolean(criteria)
      && (!requiresCourses || validCourseCount === minimumRequiredCourses);

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      image_key: row.image_key,
      card_image_url: row.card_image_url,
      icon_image_url: row.icon_image_url,
      mobile_card_image_url: row.mobile_card_image_url,
      sort_order: Number(row.sort_order) || 0,
      is_enabled: row.is_enabled === true,
      effective_enabled: moduleEnabled && row.is_enabled === true && isConfigValid,
      module_enabled: moduleEnabled,
      requires_courses: requiresCourses,
      minimum_required_courses: minimumRequiredCourses,
      is_config_valid: isConfigValid,
      rule_summary: criteria ? describeBadgeCriteria(criteria) : 'Rule chưa được hệ thống hỗ trợ',
      courses,
      updated_at: row.updated_at,
    };
  });
}

export async function listSelectableCourses(
  tenantId: string,
  queryParams: Record<string, unknown>,
  allowWhenDisabled = false,
) {
  await assertModuleEnabled(tenantId, allowWhenDisabled);

  const { page, pageSize, search } = parsePagination(queryParams);
  const offset = calcOffset(page, pageSize);
  const { countRow, rows } = await tenantBadgesRepository.selectSelectableCoursePage(tenantId, search, pageSize, offset);
  const total = Number(countRow?.count || 0);

  return {
    data: rows,
    total,
    page,
    page_size: pageSize,
    total_pages: calcTotalPages(total, pageSize),
  };
}

async function getCurrentCourseIds(tenantId: string, badgeId: string): Promise<string[]> {
  return uniqueCourseIds(await tenantBadgesRepository.selectRuleCourseIds(tenantId, badgeId));
}

async function getCurrentRuleState(tenantId: string, badgeId: string) {
  return tenantBadgesRepository.selectRuleEnabled(tenantId, badgeId);
}

export async function updateTenantBadgeRule(
  tenantId: string,
  badgeId: string,
  actorId: string,
  input: UpdateTenantBadgeRuleInput,
  allowWhenDisabled = false,
  createAuditEntry?: (context: { badgeName: string; previousEnabled: boolean; nextEnabled: boolean; courseCount: number }) => TransactionalAuditEntry,
) {
  await assertModuleEnabled(tenantId, allowWhenDisabled);

  const badge = await tenantBadgesRepository.selectActiveBadge(tenantId, badgeId);
  if (!badge) throw new AppError('Huy hiệu không tồn tại hoặc đã bị superadmin tắt', 404);

  const criteria = parseBadgeCriteria(badge.criteria);
  if (!criteria) throw new AppError('Rule huy hiệu chưa được hệ thống hỗ trợ', 409);

  const requiresCourses = criteriaRequiresCourses(criteria);
  const minimumRequiredCourses = minimumMappedCourses(criteria);
  const [previousCourseIds, previousEnabled] = await Promise.all([
    getCurrentCourseIds(tenantId, badgeId),
    getCurrentRuleState(tenantId, badgeId),
  ]);
  const nextCourseIds = uniqueCourseIds(input.course_ids ?? previousCourseIds);

  if (!requiresCourses && nextCourseIds.length > 0) {
    throw new AppError('Huy hiệu này không cho phép cấu hình khóa học', 400);
  }
  if (requiresCourses && (input.course_ids !== undefined || input.is_enabled) && nextCourseIds.length > minimumRequiredCourses) {
    throw new AppError(`Chỉ được chọn đúng ${minimumRequiredCourses} khóa học cho huy hiệu này`, 400);
  }
  if (requiresCourses && input.is_enabled && nextCourseIds.length !== minimumRequiredCourses) {
    throw new AppError(`Cần chọn đúng ${minimumRequiredCourses} khóa học trước khi bật huy hiệu`, 400);
  }

  let courses: Array<{ id: string; display_name: string }> = [];
  if (nextCourseIds.length > 0) {
    courses = await tenantBadgesRepository.selectTenantCourses(tenantId, nextCourseIds);
    if (courses.length !== nextCourseIds.length) {
      throw new AppError('Có khóa học không tồn tại, đã bị xóa hoặc không thuộc tenant', 400);
    }
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const tx = createTenantBadgesRepository(client);
    await tx.upsertRule(tenantId, badgeId, input.is_enabled, actorId);

    if (input.course_ids !== undefined) {
      await tx.deleteRuleCourses(tenantId, badgeId);

      const courseById = new Map(courses.map((course) => [course.id, course]));
      for (const courseId of nextCourseIds) {
        const course = courseById.get(courseId)!;
        await tx.insertRuleCourse(tenantId, badgeId, course, actorId);
      }
    }

    const auditEntry = createAuditEntry?.({
      badgeName: badge.name,
      previousEnabled,
      nextEnabled: input.is_enabled,
      courseCount: nextCourseIds.length,
    });
    if (auditEntry) await appendAuditLog(client, auditEntry);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await invalidateTenantBadgeCaches(tenantId);
  const badges = await listTenantBadges(tenantId, allowWhenDisabled);
  const updated = badges.find((badge) => badge.id === badgeId);
  if (!updated) throw new AppError('Không thể tải lại cấu hình huy hiệu', 500);

  return {
    badge: updated,
    audit: {
      badge_id: badgeId,
      badge_name: badge.name,
      previous: { is_enabled: previousEnabled, course_ids: previousCourseIds },
      next: { is_enabled: input.is_enabled, course_ids: nextCourseIds },
    },
  };
}
