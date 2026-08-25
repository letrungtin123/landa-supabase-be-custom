import { getClient, query } from '../../config/database.js';
import { invalidateTenantBadgeCaches } from '../../config/cache-invalidation.js';
import { AppError } from '../../middleware/error-handler.js';
import { calcOffset, calcTotalPages, parsePagination } from '../../utils/query-helpers.js';
import {
  criteriaRequiresCourses,
  describeBadgeCriteria,
  minimumMappedCourses,
  parseBadgeCriteria,
} from '../badges/badge-criteria.js';
import { isBadgeManagementModuleEnabled } from '../badges/badge-evaluation.service.js';
import type { UpdateTenantBadgeRuleInput } from './tenant-badges.validator.js';

type CourseMapping = {
  course_id: string | null;
  display_name: string;
  is_deleted: boolean;
};

async function assertModuleEnabled(tenantId: string, allowWhenDisabled = false): Promise<boolean> {
  const moduleEnabled = await isBadgeManagementModuleEnabled(tenantId);
  if (!moduleEnabled && !allowWhenDisabled) {
    throw new AppError('Tính năng Quản lý huy hiệu chưa được bật cho tenant', 403);
  }
  return moduleEnabled;
}

export async function listTenantBadges(tenantId: string, allowWhenDisabled = false) {
  const moduleEnabled = await assertModuleEnabled(tenantId, allowWhenDisabled);

  const result = await query<any>(
    `SELECT b.id,
            COALESCE(NULLIF(BTRIM(tbs.name_override), ''), b.name) AS name,
            COALESCE(NULLIF(BTRIM(tbs.description_override), ''), b.description) AS description,
            b.image_key,
            tbs.card_image_url,
            tbs.icon_image_url,
            tbs.mobile_card_image_url,
            b.sort_order,
            b.criteria,
            COALESCE(tbr.is_enabled, false) AS is_enabled,
            tbr.updated_at,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'course_id', CASE WHEN c.id IS NOT NULL THEN tbrc.course_id ELSE NULL END,
                  'display_name', COALESCE(c.display_name, tbrc.course_name_snapshot, 'Khóa học đã bị xóa'),
                  'is_deleted', c.id IS NULL
                ) ORDER BY tbrc.assigned_at, tbrc.id
              ) FILTER (WHERE tbrc.id IS NOT NULL),
              '[]'::jsonb
            ) AS courses
     FROM badge_definitions b
     LEFT JOIN tenant_badge_settings tbs
       ON tbs.badge_id = b.id AND tbs.tenant_id = $1
     LEFT JOIN tenant_badge_rules tbr
       ON tbr.badge_id = b.id AND tbr.tenant_id = $1
     LEFT JOIN tenant_badge_rule_courses tbrc
       ON tbrc.badge_id = b.id AND tbrc.tenant_id = $1
     LEFT JOIN courses c
       ON c.id = tbrc.course_id
      AND c.tenant_id = $1
     WHERE b.is_active = true
       AND (b.tenant_id IS NULL OR b.tenant_id = $1)
       AND COALESCE(tbs.is_active, true) = true
     GROUP BY b.id, b.name, b.description, b.image_key, b.sort_order, b.criteria,
              tbs.name_override, tbs.description_override,
              tbs.card_image_url, tbs.icon_image_url, tbs.mobile_card_image_url,
              tbr.is_enabled, tbr.updated_at
     ORDER BY b.sort_order, b.id`,
    [tenantId],
  );

  return result.rows.map((row: any) => {
    const criteria = parseBadgeCriteria(row.criteria);
    const courses = (Array.isArray(row.courses) ? row.courses : []) as CourseMapping[];
    const validCourseCount = courses.filter((course) => course.course_id && !course.is_deleted).length;
    const requiresCourses = criteria ? criteriaRequiresCourses(criteria) : false;
    const minimumRequiredCourses = criteria ? minimumMappedCourses(criteria) : 0;
    const isConfigValid = Boolean(criteria)
      && (!requiresCourses || validCourseCount >= minimumRequiredCourses);

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
  const params: unknown[] = [tenantId];
  const conditions = ['tenant_id = $1', 'deleted_at IS NULL'];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(display_name ILIKE $${params.length} OR id ILIKE $${params.length})`);
  }

  const where = conditions.join(' AND ');
  const [countResult, dataResult] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM courses WHERE ${where}`, params),
    query<{ id: string; display_name: string; visible_to_staff_only: boolean }>(
      `SELECT id, display_name, visible_to_staff_only
       FROM courses
       WHERE ${where}
       ORDER BY display_name ASC, id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    ),
  ]);
  const total = Number(countResult.rows[0]?.count || 0);

  return {
    data: dataResult.rows,
    total,
    page,
    page_size: pageSize,
    total_pages: calcTotalPages(total, pageSize),
  };
}

async function getCurrentCourseIds(tenantId: string, badgeId: string): Promise<string[]> {
  const result = await query<{ course_id: string }>(
    `SELECT course_id
     FROM tenant_badge_rule_courses
     WHERE tenant_id = $1 AND badge_id = $2 AND course_id IS NOT NULL
     ORDER BY assigned_at, id`,
    [tenantId, badgeId],
  );
  return result.rows.map((row) => row.course_id);
}

async function getCurrentRuleState(tenantId: string, badgeId: string) {
  const result = await query<{ is_enabled: boolean }>(
    `SELECT is_enabled
     FROM tenant_badge_rules
     WHERE tenant_id = $1 AND badge_id = $2`,
    [tenantId, badgeId],
  );
  return result.rows[0]?.is_enabled === true;
}

export async function updateTenantBadgeRule(
  tenantId: string,
  badgeId: string,
  actorId: string,
  input: UpdateTenantBadgeRuleInput,
  allowWhenDisabled = false,
) {
  await assertModuleEnabled(tenantId, allowWhenDisabled);

  const badgeResult = await query<{ name: string; criteria: unknown }>(
    `SELECT COALESCE(NULLIF(BTRIM(tbs.name_override), ''), b.name) AS name, b.criteria
     FROM badge_definitions b
     LEFT JOIN tenant_badge_settings tbs
       ON tbs.badge_id = b.id AND tbs.tenant_id = $1
     WHERE b.id = $2
       AND b.is_active = true
       AND (b.tenant_id IS NULL OR b.tenant_id = $1)
       AND COALESCE(tbs.is_active, true) = true`,
    [tenantId, badgeId],
  );
  if (badgeResult.rowCount === 0) throw new AppError('Huy hiệu không tồn tại hoặc đã bị superadmin tắt', 404);

  const criteria = parseBadgeCriteria(badgeResult.rows[0].criteria);
  if (!criteria) throw new AppError('Rule huy hiệu chưa được hệ thống hỗ trợ', 409);

  const requiresCourses = criteriaRequiresCourses(criteria);
  const minimumRequiredCourses = minimumMappedCourses(criteria);
  const [previousCourseIds, previousEnabled] = await Promise.all([
    getCurrentCourseIds(tenantId, badgeId),
    getCurrentRuleState(tenantId, badgeId),
  ]);
  const nextCourseIds = input.course_ids ?? previousCourseIds;

  if (!requiresCourses && nextCourseIds.length > 0) {
    throw new AppError('Huy hiệu này không cho phép cấu hình khóa học', 400);
  }
  if (requiresCourses && input.is_enabled && nextCourseIds.length < minimumRequiredCourses) {
    throw new AppError(`Cần chọn ít nhất ${minimumRequiredCourses} khóa học trước khi bật huy hiệu`, 400);
  }

  let courses: Array<{ id: string; display_name: string }> = [];
  if (nextCourseIds.length > 0) {
    const courseResult = await query<{ id: string; display_name: string }>(
      `SELECT id, display_name
       FROM courses
       WHERE tenant_id = $1 AND deleted_at IS NULL AND id = ANY($2::varchar[])`,
      [tenantId, nextCourseIds],
    );
    courses = courseResult.rows;
    if (courses.length !== nextCourseIds.length) {
      throw new AppError('Có khóa học không tồn tại, đã bị xóa hoặc không thuộc tenant', 400);
    }
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenant_badge_rules (
         tenant_id, badge_id, is_enabled, created_by, updated_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $4, now(), now())
       ON CONFLICT (tenant_id, badge_id) DO UPDATE SET
         is_enabled = EXCLUDED.is_enabled,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [tenantId, badgeId, input.is_enabled, actorId],
    );

    if (input.course_ids !== undefined) {
      await client.query(
        'DELETE FROM tenant_badge_rule_courses WHERE tenant_id = $1 AND badge_id = $2',
        [tenantId, badgeId],
      );

      const courseById = new Map(courses.map((course) => [course.id, course]));
      for (const courseId of nextCourseIds) {
        const course = courseById.get(courseId)!;
        await client.query(
          `INSERT INTO tenant_badge_rule_courses (
             tenant_id, badge_id, course_id, course_name_snapshot, created_by
           ) VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, badgeId, course.id, course.display_name, actorId],
        );
      }
    }

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
      badge_name: badgeResult.rows[0].name,
      previous: { is_enabled: previousEnabled, course_ids: previousCourseIds },
      next: { is_enabled: input.is_enabled, course_ids: nextCourseIds },
    },
  };
}
