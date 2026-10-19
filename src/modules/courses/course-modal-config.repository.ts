// ═══════════════════════════════════════════════════════════════
// Course modal config repository: the welcome, confirm and completion
// popups of a course and the popup of each section. SQL only; moved
// unchanged from courses.service.ts, which keeps the rules (course in
// tenant for writes, defaults, cache invalidation).
// ═══════════════════════════════════════════════════════════════

import type { CoursesDb } from './courses.repository.js';

/** A whole course_modal_configs row (`SELECT *`). */
export interface CourseModalConfigRow {
  course_id: string;
  [column: string]: unknown;
}

/** A whole section_modal_configs row (`SELECT *`). */
export interface SectionModalConfigRow {
  course_id: string;
  section_id: string;
  [column: string]: unknown;
}

export interface SectionModalConfigValues {
  sectionId: string;
  enabled: boolean;
  title: string;
  description: string;
}

export function createCourseModalConfigRepository(db: CoursesDb) {
  return {
    async selectCourseModalConfig(courseId: string): Promise<CourseModalConfigRow | null> {
      const result = await db.query<CourseModalConfigRow>('SELECT * FROM course_modal_configs WHERE course_id = $1', [courseId]);
      return result.rowCount === 0 ? null : result.rows[0];
    },

    async insertCourseModalConfigIfMissing(courseId: string): Promise<void> {
      await db.query(
        `INSERT INTO course_modal_configs (course_id) VALUES ($1) ON CONFLICT (course_id) DO NOTHING`,
        [courseId],
      );
    },

    /**
     * Sets the given fields, in the order of `fields`, then updated_at.
     * `fields` comes from the service's fixed list of column names.
     */
    async updateCourseModalConfig(courseId: string, fields: readonly string[], input: Record<string, unknown>): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [courseId];
      let idx = 2;
      for (const f of fields) {
        sets.push(`${f} = $${idx++}`); params.push(input[f]);
      }
      sets.push('updated_at = NOW()');
      await db.query(`UPDATE course_modal_configs SET ${sets.join(', ')} WHERE course_id = $1`, params);
    },

    async selectSectionModalConfig(courseId: string, sectionId: string): Promise<SectionModalConfigRow | null> {
      const result = await db.query<SectionModalConfigRow>('SELECT * FROM section_modal_configs WHERE course_id = $1 AND section_id = $2', [courseId, sectionId]);
      return result.rowCount === 0 ? null : result.rows[0];
    },

    async upsertSectionModalConfig(courseId: string, values: SectionModalConfigValues): Promise<void> {
      await db.query(
        `INSERT INTO section_modal_configs (course_id, section_id, enabled, title, description)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (course_id, section_id) DO UPDATE SET
       enabled = COALESCE($3, section_modal_configs.enabled),
       title = COALESCE($4, section_modal_configs.title),
       description = COALESCE($5, section_modal_configs.description),
       updated_at = NOW()`,
        [courseId, values.sectionId, values.enabled, values.title, values.description],
      );
    },
  };
}
