// ═══════════════════════════════════════════════════════════════
// Learner notifications and popups repository: the user's notifications,
// their read state, the course popups (welcome / confirm / complete) and the
// section popups with what the user has seen. SQL only; moved unchanged
// from learner.service.ts, which keeps the demo account rule, caching and
// cache invalidation.
// ═══════════════════════════════════════════════════════════════

import type { LearnerDb } from './learner-courses.repository.js';

/** One notification of the user, with the totals of all the user's notifications on every row. */
export interface LearnerNotificationRow {
  id: string;
  title: string;
  message: string;
  course_id: string | null;
  type: string;
  metadata: unknown;
  created_at: string;
  is_read: boolean;
  read_at: string | null;
  sent_by_name: string | null;
  full_count: string;
  unread_full_count: string;
}

export interface CourseModalConfigRow {
  welcome_enabled: boolean;
  welcome_title: string;
  welcome_description: string;
  confirm_enabled: boolean;
  confirm_title: string;
  confirm_description: string;
  confirm_checkbox_text: string;
  completion_enabled: boolean;
  completion_title: string;
  completion_description: string;
  completion_social_type: string | null;
  completion_social_link: string | null;
}

/** A row of course_modal_states (every column). */
export interface CourseModalStateRow extends Record<string, unknown> {
  course_id: string;
  welcome_shown: boolean;
  confirm_shown: boolean;
  complete_shown: boolean;
}

export interface SectionModalConfigRow {
  section_id: string;
  title: string;
  description: string;
}

export interface CourseModalStateUpdates {
  welcome_shown?: boolean;
  confirm_shown?: boolean;
  complete_shown?: boolean;
}

export function createLearnerNotificationsRepository(db: LearnerDb) {
  return {
    /** One page of the user's notifications of the tenant, newest first. */
    async selectNotifications(userId: string, tenantId: string, limit: number, offset: number): Promise<LearnerNotificationRow[]> {
      const result = await db.query<LearnerNotificationRow>(
        `SELECT n.id, n.title, n.message, n.course_id, n.type, n.metadata, n.created_at,
            nr.is_read, nr.read_at,
            u.full_name AS sent_by_name,
            COUNT(*) OVER() AS full_count,
            COUNT(*) FILTER (WHERE nr.is_read = false) OVER() AS unread_full_count
     FROM notification_recipients nr
     JOIN notifications n ON n.id = nr.notification_id
     LEFT JOIN users u ON u.id = n.sent_by
     WHERE nr.user_id = $1 AND n.tenant_id = $2
     ORDER BY n.created_at DESC
     LIMIT $3 OFFSET $4`,
        [userId, tenantId, limit, offset],
      );
      return result.rows;
    },

    async countUnread(userId: string, tenantId: string): Promise<number> {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM notification_recipients nr
         JOIN notifications n ON n.id = nr.notification_id
         WHERE nr.user_id = $1 AND n.tenant_id = $2 AND nr.is_read = false`,
        [userId, tenantId],
      );
      return parseInt(result.rows[0].count);
    },

    async markRead(userId: string, notificationId: string): Promise<void> {
      await db.query<Record<string, unknown>>(
        `UPDATE notification_recipients SET is_read = true, read_at = now()
     WHERE user_id = $1 AND notification_id = $2`,
        [userId, notificationId],
      );
    },

    async markAllRead(userId: string, tenantId: string): Promise<void> {
      await db.query<Record<string, unknown>>(
        `UPDATE notification_recipients nr SET is_read = true, read_at = now()
     FROM notifications n
     WHERE nr.notification_id = n.id AND nr.user_id = $1 AND n.tenant_id = $2 AND nr.is_read = false`,
        [userId, tenantId],
      );
    },

    /** The course's popup config, or undefined when the admin has not set one up. */
    async selectCourseModalConfig(courseId: string): Promise<CourseModalConfigRow | undefined> {
      const result = await db.query<CourseModalConfigRow>(
        `SELECT welcome_enabled, welcome_title, welcome_description,
            confirm_enabled, confirm_title, confirm_description, confirm_checkbox_text,
            completion_enabled, completion_title, completion_description,
            completion_social_type, completion_social_link
     FROM course_modal_configs WHERE course_id = $1`,
        [courseId],
      );
      return result.rowCount === 0 ? undefined : result.rows[0];
    },

    /** Creates the user's popup state of the course; the new row, or undefined when it existed. */
    async createCourseModalState(userId: string, courseId: string): Promise<CourseModalStateRow | undefined> {
      const result = await db.query<CourseModalStateRow>(
        `INSERT INTO course_modal_states (user_id, course_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, course_id) DO NOTHING
     RETURNING *`,
        [userId, courseId],
      );
      return result.rowCount && result.rowCount > 0 ? result.rows[0] : undefined;
    },

    async selectCourseModalState(userId: string, courseId: string): Promise<CourseModalStateRow | undefined> {
      const existing = await db.query<CourseModalStateRow>(
        `SELECT * FROM course_modal_states WHERE user_id = $1 AND course_id = $2`,
        [userId, courseId],
      );
      return existing.rows[0];
    },

    /**
     * Sets the given popup flags (creating the row first); false, with no
     * statement, when no flag is given.
     */
    async updateCourseModalState(userId: string, courseId: string, updates: CourseModalStateUpdates): Promise<boolean> {
      const sets: string[] = [];
      const params: unknown[] = [userId, courseId];
      let idx = 3;

      if (updates.welcome_shown !== undefined) { sets.push(`welcome_shown = $${idx++}`); params.push(updates.welcome_shown); }
      if (updates.confirm_shown !== undefined) { sets.push(`confirm_shown = $${idx++}`); params.push(updates.confirm_shown); }
      if (updates.complete_shown !== undefined) { sets.push(`complete_shown = $${idx++}`); params.push(updates.complete_shown); }

      if (sets.length === 0) return false;

      sets.push('updated_at = NOW()');

      // Upsert: nếu chưa có row thì tạo mới
      await db.query<Record<string, unknown>>(
        `INSERT INTO course_modal_states (user_id, course_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, course_id) DO NOTHING`,
        [userId, courseId],
      );

      await db.query<Record<string, unknown>>(
        `UPDATE course_modal_states SET ${sets.join(', ')} WHERE user_id = $1 AND course_id = $2`,
        params,
      );
      return true;
    },

    /** The course's enabled section popups. */
    async selectSectionModalConfigs(courseId: string): Promise<SectionModalConfigRow[]> {
      const result = await db.query<SectionModalConfigRow>(
        `SELECT section_id, title, description
     FROM section_modal_configs
     WHERE course_id = $1 AND enabled = true`,
        [courseId],
      );
      return result.rows;
    },

    /** The sections of the course whose popup the user has seen. */
    async selectShownSectionIds(userId: string, courseId: string): Promise<string[]> {
      const result = await db.query<{ section_id: string }>(
        `SELECT section_id FROM section_modal_shown
     WHERE user_id = $1 AND course_id = $2`,
        [userId, courseId],
      );
      return result.rows.map(r => r.section_id);
    },

    async markSectionShown(userId: string, courseId: string, sectionId: string): Promise<void> {
      await db.query<Record<string, unknown>>(
        `INSERT INTO section_modal_shown (user_id, course_id, section_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, course_id, section_id) DO NOTHING`,
        [userId, courseId, sectionId],
      );
    },
  };
}

export type LearnerNotificationsRepository = ReturnType<typeof createLearnerNotificationsRepository>;
