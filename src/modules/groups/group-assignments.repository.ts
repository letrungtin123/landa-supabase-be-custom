// ═══════════════════════════════════════════════════════════════
// Group assignments repository: team members (with the "added to team"
// notification), team courses, document categories and course categories.
// SQL only; moved unchanged from groups.service.ts, which keeps the rules
// (demo accounts, eligibility messages, transactions, audit, email, caches).
// ═══════════════════════════════════════════════════════════════

import type { GroupsDb } from './groups.repository.js';

export interface TeamWithParentsRow {
  id: string;
  team_name: string;
  subgroup_name: string;
  org_group_name: string;
}

export interface TeamCourseCategorySummaryRow {
  name: string;
  /** COUNT(...)::int arrives as a number; typed as the code has always read it. */
  course_count: string;
}

export interface TeamMemberNotificationValues {
  tenantId: string;
  teamId: string;
  teamName: string;
  subgroupName: string;
  orgGroupName: string;
  sendEmail: boolean;
  /** JSON text of the course category summaries. */
  courseCategoriesJson: string;
  title: string;
  message: string;
  actorUserId: string;
  recipientCount: number;
  /** JSON text of the tenant's group labels. */
  groupLabelsJson: string;
}

export function createGroupAssignmentsRepository(db: GroupsDb) {
  return {
    // ── Team members ──

    /** The team of the tenant with its subgroup and group names, share-locked; undefined when not in the tenant. */
    async lockTeamWithParents(teamId: string, tenantId: string): Promise<TeamWithParentsRow | undefined> {
      const teamResult = await db.query<TeamWithParentsRow>(
        `SELECT t.id,
              t.name AS team_name,
              sg.name AS subgroup_name,
              og.name AS org_group_name
       FROM teams t
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE t.id = $1::uuid
         AND og.tenant_id = $2::uuid
       FOR SHARE`,
        [teamId, tenantId],
      );
      return teamResult.rows[0];
    },

    /** Adds the active learners of the tenant among `userIds`; answers the ids actually added. */
    async insertEligibleTeamMembers(teamId: string, userIds: string[], tenantId: string): Promise<string[]> {
      const insertResult = await db.query<{ user_id: string }>(
        `WITH input_users AS (
         SELECT DISTINCT unnest($2::uuid[]) AS user_id
       ),
       eligible_users AS (
         SELECT iu.user_id
         FROM input_users iu
         JOIN users u
           ON u.id = iu.user_id
          AND u.tenant_id = $3::uuid
         WHERE u.role IN ('learner', 'learner_plus')
           AND u.is_active = true
       )
       INSERT INTO team_members (team_id, user_id)
       SELECT $1::uuid, user_id
       FROM eligible_users
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
        [teamId, userIds, tenantId],
      );
      return insertResult.rows.map(row => row.user_id);
    },

    /** The team's course categories with their count of learner-visible courses of the tenant, by name. */
    async selectTeamCourseCategorySummaries(teamId: string, tenantId: string): Promise<TeamCourseCategorySummaryRow[]> {
      const categoryResult = await db.query<TeamCourseCategorySummaryRow>(
        `SELECT cc.name,
                COUNT(DISTINCT c.id)::int AS course_count
         FROM team_course_categories tcc
         JOIN course_categories cc
           ON cc.id = tcc.category_id
         LEFT JOIN course_category_courses ccc
           ON ccc.category_id = tcc.category_id
         LEFT JOIN courses c
           ON c.id = ccc.course_id
          AND c.tenant_id = $2::uuid
          AND c.deleted_at IS NULL
          AND c.visible_to_staff_only = false
         WHERE tcc.team_id = $1::uuid
         GROUP BY cc.id, cc.name
         ORDER BY cc.name`,
        [teamId, tenantId],
      );
      return categoryResult.rows;
    },

    /** Inserts the "added to team" notification; answers its id. */
    async insertTeamMemberNotification(values: TeamMemberNotificationValues): Promise<string> {
      const notification = await db.query<{ id: string }>(
        `INSERT INTO notifications (tenant_id, course_id, type, metadata, title, message, sent_by, recipient_count)
         VALUES (
           $1::uuid,
           NULL,
           'team_member_added',
           jsonb_build_object(
             'send_email', $6::boolean,
             'recipient_rule', 'team_members_added',
             'team_id', $2::uuid,
             'team_name', $3::text,
             'subgroup_name', $4::text,
             'org_group_name', $5::text,
             'group_labels', $12::jsonb,
             'course_categories', $7::jsonb
           ),
           $8::varchar,
           $9::text,
           $10::uuid,
           $11::int
         )
         RETURNING id`,
        [
          values.tenantId,
          values.teamId,
          values.teamName,
          values.subgroupName,
          values.orgGroupName,
          values.sendEmail,
          values.courseCategoriesJson,
          values.title,
          values.message,
          values.actorUserId,
          values.recipientCount,
          values.groupLabelsJson,
        ],
      );
      return notification.rows[0].id;
    },

    async insertNotificationRecipients(notificationId: string, userIds: string[]): Promise<void> {
      await db.query(
        `INSERT INTO notification_recipients (notification_id, user_id)
         SELECT $1::uuid, unnest($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [notificationId, userIds],
      );
    },

    /** Team name (team in the tenant) and username, for the audit entry of a removal. */
    async selectTeamMemberContext(teamId: string, userId: string, tenantId: string): Promise<{ team_name: string; username: string } | undefined> {
      const context = await db.query<{ team_name: string; username: string }>(
        `SELECT t.name AS team_name, u.username
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     JOIN users u ON u.id = $2
     WHERE t.id = $1 AND og.tenant_id = $3::uuid`,
        [teamId, userId, tenantId],
      );
      return context.rows[0];
    },

    /** Removes the member from the team of the tenant; answers how many rows went. */
    async deleteTeamMember(teamId: string, userId: string, tenantId: string): Promise<number | null> {
      const r = await db.query(
        `DELETE FROM team_members tm
     USING teams t, sub_groups sg, org_groups og
     WHERE tm.team_id = t.id
       AND t.sub_group_id = sg.id
       AND sg.org_group_id = og.id
       AND tm.team_id = $1 AND tm.user_id = $2 AND og.tenant_id = $3::uuid
     RETURNING tm.user_id`,
        [teamId, userId, tenantId],
      );
      return r.rowCount;
    },

    // ── Team courses ──

    async selectTeamCourseContext(teamId: string, courseId: string, tenantId: string): Promise<{ team_name: string; course_name: string | null } | undefined> {
      const context = await db.query<{ team_name: string; course_name: string | null }>(
        `SELECT t.name AS team_name, c.display_name AS course_name
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     LEFT JOIN courses c ON c.id = $2 AND c.tenant_id = $3::uuid
     WHERE t.id = $1::uuid
       AND og.tenant_id = $3::uuid`,
        [teamId, courseId, tenantId],
      );
      return context.rows[0];
    },

    async deleteTeamCourse(teamId: string, courseId: string, tenantId: string): Promise<number | null> {
      const r = await db.query(
        `DELETE FROM team_courses tc
     USING teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE tc.team_id = t.id
       AND tc.team_id = $1::uuid
       AND tc.course_id = $2
       AND og.tenant_id = $3::uuid
     RETURNING tc.course_id`,
        [teamId, courseId, tenantId],
      );
      return r.rowCount;
    },

    // ── Team document categories ──

    /** The team's name by id alone: the caller has already checked the team's tenant. */
    async selectTeamName(teamId: string): Promise<{ name: string } | undefined> {
      const teamResult = await db.query<{ name: string }>('SELECT name FROM teams WHERE id = $1::uuid', [teamId]);
      return teamResult.rows[0];
    },

    /** Assigns a private document category of the tenant; answers the rowCount as pg sends it. */
    async insertTeamDocCategory(teamId: string, categoryId: string, tenantId: string): Promise<number | null> {
      const r = await db.query(
        `INSERT INTO team_doc_categories (team_id, category_id)
         SELECT $1::uuid, dc.id
         FROM document_categories dc
         WHERE dc.id = $2::uuid
           AND dc.tenant_id = $3::uuid
           AND COALESCE(dc.is_public, false) = false
         ON CONFLICT DO NOTHING`,
        [teamId, categoryId, tenantId],
      );
      return r.rowCount;
    },

    async selectTeamDocCategoryContext(teamId: string, categoryId: string, tenantId: string): Promise<{ team_name: string; category_name: string | null } | undefined> {
      const context = await db.query<{ team_name: string; category_name: string | null }>(
        `SELECT t.name AS team_name, dc.name AS category_name
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     LEFT JOIN document_categories dc ON dc.id = $2::uuid AND dc.tenant_id = $3::uuid
     WHERE t.id = $1::uuid
       AND og.tenant_id = $3::uuid`,
        [teamId, categoryId, tenantId],
      );
      return context.rows[0];
    },

    async deleteTeamDocCategory(teamId: string, categoryId: string, tenantId: string): Promise<number | null> {
      const r = await db.query(
        `DELETE FROM team_doc_categories tdc
     USING teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     JOIN document_categories dc ON dc.id = tdc.category_id
     WHERE tdc.team_id = t.id
       AND tdc.team_id = $1::uuid
       AND tdc.category_id = $2::uuid
       AND og.tenant_id = $3::uuid
       AND dc.tenant_id = $3::uuid
     RETURNING tdc.category_id`,
        [teamId, categoryId, tenantId],
      );
      return r.rowCount;
    },

    // ── Team course categories ──

    async selectTenantTeamName(teamId: string, tenantId: string): Promise<{ name: string } | undefined> {
      const teamResult = await db.query<{ name: string }>(
        `SELECT t.name
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE t.id = $1::uuid AND og.tenant_id = $2::uuid`,
        [teamId, tenantId],
      );
      return teamResult.rows[0];
    },

    /** Assigns a private course category of the tenant; answers the rowCount as pg sends it. */
    async insertTeamCourseCategory(teamId: string, categoryId: string, tenantId: string): Promise<number | null> {
      const r = await db.query(
        `INSERT INTO team_course_categories (team_id, category_id)
       SELECT $1::uuid, cc.id
       FROM course_categories cc
       WHERE cc.id = $2::uuid
         AND cc.tenant_id = $3::uuid
         AND COALESCE(cc.is_public, false) = false
       ON CONFLICT DO NOTHING`,
        [teamId, categoryId, tenantId],
      );
      return r.rowCount;
    },

    async selectTeamCourseCategoryContext(teamId: string, categoryId: string, tenantId: string): Promise<{ team_name: string; category_name: string | null } | undefined> {
      const context = await db.query<{ team_name: string; category_name: string | null }>(
        `SELECT t.name AS team_name, cc.name AS category_name
     FROM teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     LEFT JOIN course_categories cc ON cc.id = $2::uuid AND cc.tenant_id = $3::uuid
     WHERE t.id = $1::uuid
       AND og.tenant_id = $3::uuid`,
        [teamId, categoryId, tenantId],
      );
      return context.rows[0];
    },

    async deleteTeamCourseCategory(teamId: string, categoryId: string, tenantId: string): Promise<number | null> {
      const r = await db.query(
        `DELETE FROM team_course_categories tcc
     USING teams t
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     JOIN course_categories cc ON cc.id = tcc.category_id
     WHERE tcc.team_id = t.id
       AND tcc.team_id = $1::uuid
       AND tcc.category_id = $2::uuid
       AND og.tenant_id = $3::uuid
       AND cc.tenant_id = $3::uuid
     RETURNING tcc.category_id`,
        [teamId, categoryId, tenantId],
      );
      return r.rowCount;
    },
  };
}
