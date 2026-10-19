import { query } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import {
  COURSE_COMPONENT_TYPES,
  isCourseComponentType,
  normalizeCourseComponentTypes,
  type CourseComponentType,
} from './tenant-course-components.constants.js';
import { createTenantsRepository, type TenantsDb } from './tenants.repository.js';

type QueryExecutor = TenantsDb;

const tenantsRepository = createTenantsRepository({ query } satisfies TenantsDb);

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
  const result = await tenantsRepository.selectSettings(tenantId);
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

  const updated = await tenantsRepository.updateAllowedComponentTypes(tenantId, JSON.stringify(normalized));
  if (updated === 0) throw new AppError('Tenant không tồn tại', 404);

  return { allowed_component_types: normalized };
}

export async function getTenantAllowedCourseComponentTypeSet(
  tenantId: string,
  client?: QueryExecutor,
): Promise<Set<CourseComponentType>> {
  const result = await createTenantsRepository(client ?? { query }).selectSettings(tenantId);
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
