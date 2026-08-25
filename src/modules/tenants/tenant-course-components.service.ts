import type pg from 'pg';
import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import {
  COURSE_COMPONENT_TYPES,
  isCourseComponentType,
  normalizeCourseComponentTypes,
  type CourseComponentType,
} from './tenant-course-components.constants.js';

type QueryExecutor = {
  query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
};

function getAllowedTypesFromSettings(settings: unknown): CourseComponentType[] {
  const courseAuthoring = settings && typeof settings === 'object'
    ? (settings as Record<string, unknown>).course_authoring
    : null;
  const allowedTypes = courseAuthoring && typeof courseAuthoring === 'object'
    ? (courseAuthoring as Record<string, unknown>).allowed_component_types
    : undefined;

  return normalizeCourseComponentTypes(allowedTypes);
}

export async function getTenantCourseComponentPermissions(tenantId: string) {
  const result = await query<{ settings: unknown }>(
    'SELECT settings FROM tenants WHERE id = $1',
    [tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);

  return {
    allowed_component_types: getAllowedTypesFromSettings(result.rows[0]?.settings),
  };
}

export async function updateTenantCourseComponentPermissions(
  tenantId: string,
  allowedComponentTypes: CourseComponentType[],
) {
  const selected = new Set(allowedComponentTypes);
  const normalized = COURSE_COMPONENT_TYPES.filter(type => selected.has(type));

  const result = await query<{ id: string }>(
    `UPDATE tenants
     SET settings = jsonb_set(
           CASE
             WHEN jsonb_typeof(COALESCE(settings, '{}'::jsonb) -> 'course_authoring') = 'object'
               THEN COALESCE(settings, '{}'::jsonb)
             ELSE jsonb_set(COALESCE(settings, '{}'::jsonb), '{course_authoring}', '{}'::jsonb, true)
           END,
           '{course_authoring,allowed_component_types}',
           $1::jsonb,
           true
         ),
         updated_at = now()
     WHERE id = $2
     RETURNING id`,
    [JSON.stringify(normalized), tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);

  return { allowed_component_types: normalized };
}

export async function getTenantAllowedCourseComponentTypeSet(
  tenantId: string,
  client?: QueryExecutor,
): Promise<Set<CourseComponentType>> {
  const db = client ?? { query };
  const result = await db.query<{ settings: unknown }>(
    'SELECT settings FROM tenants WHERE id = $1',
    [tenantId],
  );
  if (result.rowCount === 0) throw new AppError('Tenant không tồn tại', 404);
  return new Set(getAllowedTypesFromSettings(result.rows[0]?.settings));
}

export function assertCourseComponentTypeAllowed(
  allowedTypes: Set<CourseComponentType>,
  blockType: string,
): void {
  if (!isCourseComponentType(blockType)) return;
  if (!allowedTypes.has(blockType)) {
    throw new AppError('Loại nội dung này chưa được bật cho doanh nghiệp hiện tại', 403);
  }
}

export async function assertTenantCanAddCourseComponent(
  tenantId: string,
  blockType: string,
): Promise<void> {
  if (!isCourseComponentType(blockType)) return;
  const allowedTypes = await getTenantAllowedCourseComponentTypeSet(tenantId);
  assertCourseComponentTypeAllowed(allowedTypes, blockType);
}
