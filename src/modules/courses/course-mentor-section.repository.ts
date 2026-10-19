// ═══════════════════════════════════════════════════════════════
// Course mentor section repository: the description and the light and
// dark logo paths shown with the course mentor. SQL only; moved unchanged
// from courses.service.ts, which keeps the rules (course in tenant,
// Storage writes and cleanup, transactions, audit, cache invalidation).
// ═══════════════════════════════════════════════════════════════

import type { CoursesDb } from './courses.repository.js';

/** Timestamps are typed as the answer types them: pg's Date reaches the client as ISO text. */
export interface CourseMentorSectionRow {
  course_id: string;
  description: string | null;
  logo_light_path: string | null;
  logo_dark_path: string | null;
  updated_at: string | null;
}

export type MentorSectionLogoColumn = 'logo_light_path' | 'logo_dark_path';

export function createCourseMentorSectionRepository(db: CoursesDb) {
  return {
    /** Creates the section with the tenant's header logos; undefined when it already exists. */
    async insertSectionDefaults(courseId: string, tenantId: string, userId: string | null): Promise<CourseMentorSectionRow | undefined> {
      const result = await db.query<CourseMentorSectionRow>(
        `INSERT INTO course_mentor_sections (tenant_id, course_id, logo_light_path, logo_dark_path, updated_by)
     SELECT t.id,
            $2,
            NULLIF(t.settings #>> '{branding,header_logo}', ''),
            NULLIF(t.settings #>> '{branding,header_logo_dark}', ''),
            $3
     FROM tenants t
     WHERE t.id = $1
     ON CONFLICT (tenant_id, course_id) DO NOTHING
     RETURNING course_id, description, logo_light_path, logo_dark_path, updated_at`,
        [tenantId, courseId, userId],
      );
      return result.rows[0];
    },

    async selectSection(courseId: string, tenantId: string): Promise<CourseMentorSectionRow | undefined> {
      const result = await db.query<CourseMentorSectionRow>(
        `SELECT course_id, description, logo_light_path, logo_dark_path, updated_at
     FROM course_mentor_sections
     WHERE course_id = $1 AND tenant_id = $2`,
        [courseId, tenantId],
      );
      return result.rows[0];
    },

    async upsertDescription(courseId: string, tenantId: string, description: string | null, userId: string): Promise<CourseMentorSectionRow> {
      const result = await db.query<CourseMentorSectionRow>(
        `INSERT INTO course_mentor_sections (tenant_id, course_id, description, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, course_id)
     DO UPDATE SET
       description = EXCLUDED.description,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING course_id, description, logo_light_path, logo_dark_path, updated_at`,
        [tenantId, courseId, description, userId],
      );
      return result.rows[0];
    },

    async selectLogoPaths(courseId: string, tenantId: string): Promise<Pick<CourseMentorSectionRow, 'logo_light_path' | 'logo_dark_path'> | undefined> {
      const current = await db.query<Pick<CourseMentorSectionRow, 'logo_light_path' | 'logo_dark_path'>>(
        `SELECT logo_light_path, logo_dark_path
     FROM course_mentor_sections
     WHERE course_id = $1 AND tenant_id = $2`,
        [courseId, tenantId],
      );
      return current.rows[0];
    },

    /** Sets one logo path, creating the section when there is none. */
    async upsertLogoPath(courseId: string, tenantId: string, logoColumn: MentorSectionLogoColumn, storagePath: string, userId: string): Promise<CourseMentorSectionRow> {
      const result = await db.query<CourseMentorSectionRow>(
        `INSERT INTO course_mentor_sections (tenant_id, course_id, ${logoColumn}, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, course_id)
       DO UPDATE SET
         ${logoColumn} = EXCLUDED.${logoColumn},
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING course_id, description, logo_light_path, logo_dark_path, updated_at`,
        [tenantId, courseId, storagePath, userId],
      );
      return result.rows[0];
    },

    /** Locks the section row and reads one logo path; null when there is no section. */
    async lockLogoPath(courseId: string, tenantId: string, logoColumn: MentorSectionLogoColumn): Promise<{ logo_path: string | null } | null> {
      const current = await db.query<{ logo_path: string | null }>(
        `SELECT ${logoColumn} AS logo_path
       FROM course_mentor_sections
       WHERE course_id = $1 AND tenant_id = $2
       FOR UPDATE`,
        [courseId, tenantId],
      );
      return current.rowCount === 0 ? null : current.rows[0];
    },

    async clearLogoPath(courseId: string, tenantId: string, logoColumn: MentorSectionLogoColumn, userId: string): Promise<CourseMentorSectionRow | undefined> {
      const result = await db.query<CourseMentorSectionRow>(
        `UPDATE course_mentor_sections
       SET ${logoColumn} = NULL, updated_by = $3, updated_at = NOW()
       WHERE course_id = $1 AND tenant_id = $2
       RETURNING course_id, description, logo_light_path, logo_dark_path, updated_at`,
        [courseId, tenantId, userId],
      );
      return result.rows[0];
    },
  };
}
