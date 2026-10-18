// ═══════════════════════════════════════════════════════════════
// Course access repository — "does this course belong to the tenant?"
// ═══════════════════════════════════════════════════════════════
//
// The one lookup behind every "course belongs to tenant" check: a course that
// is not soft-deleted and whose tenant_id is the caller's tenant. A course of
// another tenant is answered exactly like a missing one, so callers return
// 404 (never 403) and reveal nothing. Callers keep their own error message.
//
// No imports: the AI ID workspace repositories use it with their transaction
// client and must not open a pool or read config when they are imported.

/** The pool query() (joins the current transaction) or a transaction client. */
export interface CourseAccessDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export function createCourseAccessRepository(db: CourseAccessDb) {
  return {
    /** True when the course exists, is not deleted and belongs to the tenant. */
    async courseBelongsToTenant(courseId: string, tenantId: string): Promise<boolean> {
      const result = await db.query(
        `SELECT id FROM courses WHERE id = $1 AND tenant_id = $2::uuid AND deleted_at IS NULL`,
        [courseId, tenantId],
      );
      return result.rows.length > 0;
    },

    /**
     * The same check inside a transaction, holding the course row (FOR UPDATE)
     * until it ends, so the course cannot be deleted meanwhile. Call it where
     * the caller's lock order puts the course lock.
     */
    async lockCourseOfTenant(courseId: string, tenantId: string): Promise<boolean> {
      const result = await db.query(
        `SELECT id FROM courses WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [courseId, tenantId],
      );
      return result.rows.length === 1;
    },
  };
}
