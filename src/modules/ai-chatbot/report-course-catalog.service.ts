// Tenant-scoped course-name catalog for chat reports (id + display name only),
// used to find the course a question names without the words "khóa học".
//
// Cached in Redis per tenant with a short TTL, like the org-unit catalog. The
// key carries the tenant's course cache version, which course writes already
// bump (invalidateTenantCourseCaches), so a rename shows up at once; the 60 s
// TTL bounds staleness for any write path that does not bump it.

import { cacheJson, getCacheVersion } from '../../config/cache.js';
import { cacheKeys, cacheVersions } from '../../config/cache-keys.js';
import { loadReportCourseNameRows } from './report-chat.repository.js';
import type { ReportCourseCatalog } from './report-course-mention.logic.js';

export const REPORT_COURSE_CATALOG_TTL_SECONDS = 60;
/** Upper bound of names scanned per question; far above today's largest tenant (57 courses). */
export const REPORT_COURSE_CATALOG_MAX_COURSES = 5000;
const CATALOG_RESOURCE = 'report-course-catalog';

export async function loadReportCourseCatalog(tenantId: string): Promise<ReportCourseCatalog> {
  const version = await getCacheVersion(...cacheVersions.tenantCourses(tenantId));
  return cacheJson(
    cacheKeys.tenantResource(tenantId, CATALOG_RESOURCE, version),
    REPORT_COURSE_CATALOG_TTL_SECONDS,
    async () => {
      const rows = await loadReportCourseNameRows(tenantId, REPORT_COURSE_CATALOG_MAX_COURSES);
      const truncated = rows.length > REPORT_COURSE_CATALOG_MAX_COURSES;
      if (truncated) {
        console.warn(JSON.stringify({ event: 'report_course_catalog_truncated', tenant_id: tenantId, max_courses: REPORT_COURSE_CATALOG_MAX_COURSES }));
      }
      return { courses: rows.slice(0, REPORT_COURSE_CATALOG_MAX_COURSES), truncated };
    },
  );
}
