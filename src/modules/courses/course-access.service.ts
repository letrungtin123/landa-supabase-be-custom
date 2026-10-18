// ═══════════════════════════════════════════════════════════════
// Course access guard — 404 unless the course belongs to the tenant
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';
import { AppError } from '../../middleware/error-handler.js';
import { createCourseAccessRepository } from './course-access.repository.js';

// query() joins the caller's current transaction (withDatabaseTransaction) when there is one.
const courseAccess = createCourseAccessRepository({ query: (text, values) => query(text, values) });

/**
 * Throws AppError(notFoundMessage, 404) unless the course exists, is not
 * deleted and belongs to the tenant. Each endpoint passes the message it has
 * always returned; the texts are not unified yet.
 */
export async function assertCourseBelongsToTenant(courseId: string, tenantId: string, notFoundMessage: string): Promise<void> {
  if (!await courseAccess.courseBelongsToTenant(courseId, tenantId)) {
    throw new AppError(notFoundMessage, 404);
  }
}
