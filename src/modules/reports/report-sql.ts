// ═══════════════════════════════════════════════════════════════
// Report SQL fragments: the shared CTEs and scope filters of the report
// statements (Reports page, report chat, Excel exports). Text only, no I/O:
// every report repository builds its statements from these, so the metrics
// of the cards, lists, charts and files cannot drift apart.
// ═══════════════════════════════════════════════════════════════

export function buildGroupFilter(groupId?: string, subgroupId?: string, teamId?: string): { joins: string; conditions: string[]; params: string[] } {
  const joins: string[] = [];
  const conditions: string[] = [];
  const params: string[] = [];

  if (teamId) {
    joins.push('JOIN team_members tm ON tm.user_id = e.user_id');
    conditions.push(`tm.team_id = $PARAM`);
    params.push(teamId);
  } else if (subgroupId) {
    joins.push('JOIN team_members tm ON tm.user_id = e.user_id');
    joins.push('JOIN teams t ON t.id = tm.team_id');
    conditions.push(`t.sub_group_id = $PARAM`);
    params.push(subgroupId);
  } else if (groupId) {
    joins.push('JOIN team_members tm ON tm.user_id = e.user_id');
    joins.push('JOIN teams t ON t.id = tm.team_id');
    joins.push('JOIN sub_groups sg ON sg.id = t.sub_group_id');
    conditions.push(`sg.org_group_id = $PARAM`);
    params.push(groupId);
  }

  return { joins: joins.join(' '), conditions, params };
}

export function buildUserGroupFilter(groupId?: string, subgroupId?: string, teamId?: string): { joins: string; conditions: string[]; params: string[] } {
  const joins: string[] = [];
  const conditions: string[] = [];
  const params: string[] = [];

  if (teamId) {
    joins.push('JOIN team_members tm ON tm.user_id = u.id');
    conditions.push(`tm.team_id = $PARAM`);
    params.push(teamId);
  } else if (subgroupId) {
    joins.push('JOIN team_members tm ON tm.user_id = u.id');
    joins.push('JOIN teams t ON t.id = tm.team_id');
    conditions.push(`t.sub_group_id = $PARAM`);
    params.push(subgroupId);
  } else if (groupId) {
    joins.push('JOIN team_members tm ON tm.user_id = u.id');
    joins.push('JOIN teams t ON t.id = tm.team_id');
    joins.push('JOIN sub_groups sg ON sg.id = t.sub_group_id');
    conditions.push(`sg.org_group_id = $PARAM`);
    params.push(groupId);
  }

  return { joins: joins.join(' '), conditions, params };
}

export function buildLearnerScopeExists(
  userIdSql: string,
  groupId: string | undefined,
  subgroupId: string | undefined,
  teamId: string | undefined,
  startParamIndex: number,
): { sql: string; params: string[] } {
  if (teamId) {
    return {
      sql: `AND EXISTS (
        SELECT 1 FROM team_members tm_scope
        WHERE tm_scope.user_id = ${userIdSql}
          AND tm_scope.team_id = $${startParamIndex}
      )`,
      params: [teamId],
    };
  }

  if (subgroupId) {
    return {
      sql: `AND EXISTS (
        SELECT 1
        FROM team_members tm_scope
        JOIN teams t_scope ON t_scope.id = tm_scope.team_id
        WHERE tm_scope.user_id = ${userIdSql}
          AND t_scope.sub_group_id = $${startParamIndex}
      )`,
      params: [subgroupId],
    };
  }

  if (groupId) {
    return {
      sql: `AND EXISTS (
        SELECT 1
        FROM team_members tm_scope
        JOIN teams t_scope ON t_scope.id = tm_scope.team_id
        JOIN sub_groups sg_scope ON sg_scope.id = t_scope.sub_group_id
        WHERE tm_scope.user_id = ${userIdSql}
          AND sg_scope.org_group_id = $${startParamIndex}
      )`,
      params: [groupId],
    };
  }

  return { sql: '', params: [] };
}

/**
 * Returns completed-learning events in the selected range.
 * Keep this CTE shared by UI charts and Excel so the metric cannot silently drift.
 */
export function buildActiveLearnerEventsCte(options: {
  tenantParam: string;
  rangeStartParam: string;
  rangeEndParam: string;
  cteName?: string;
}): string {
  const { tenantParam, rangeStartParam, rangeEndParam, cteName = 'active_learner_events' } = options;

  return `${cteName} AS (
    SELECT e.user_id, (bc.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS activity_date
    FROM block_completions bc
    JOIN enrollments e ON e.id = bc.enrollment_id
    WHERE e.tenant_id = ${tenantParam}
      AND bc.completed_at >= ${rangeStartParam}
      AND bc.completed_at <= ${rangeEndParam}
  )`;
}
/**
 * Returns the immutable report cohort: active learner enrollments created in the selected period.
 * Every course-completion metric must use this CTE so cards, lists, rankings, charts, and Excel reconcile.
 */
export function buildReportEnrollmentCte(options: {
  tenantParam: string;
  rangeStartParam: string;
  rangeEndParam: string;
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
  scopeParamStart: number;
  cteName?: string;
}): { sql: string; params: string[] } {
  const {
    tenantParam,
    rangeStartParam,
    rangeEndParam,
    groupId,
    subgroupId,
    teamId,
    scopeParamStart,
    cteName = 'report_enrollments',
  } = options;
  const scope = buildLearnerScopeExists('e.user_id', groupId, subgroupId, teamId, scopeParamStart);

  return {
    params: scope.params,
    sql: `${cteName} AS (
      SELECT
        e.id AS enrollment_id,
        e.user_id,
        e.course_id,
        e.enrolled_at,
        COALESCE(c.display_name, 'Khóa học không còn hiển thị') AS course_name,
        CASE
          WHEN cp.completed_at IS NOT NULL AND cp.completed_at <= ${rangeEndParam} THEN 100
          ELSE LEAST(GREATEST(COALESCE(cp.progress, 0), 0), 99.99)
        END AS progress,
        CASE
          WHEN cp.completed_at IS NOT NULL AND cp.completed_at <= ${rangeEndParam} THEN cp.completed_at
          ELSE NULL
        END AS completed_at,
        CASE
          WHEN cp.completed_at IS NOT NULL AND cp.completed_at <= ${rangeEndParam} THEN true
          ELSE false
        END AS is_completed,
        CASE
          WHEN COALESCE(cp.progress, 0) > 0 OR cp.completed_at IS NOT NULL THEN true
          ELSE false
        END AS has_started
      FROM enrollments e
      JOIN users u ON u.id = e.user_id
        AND u.tenant_id = ${tenantParam}
        AND u.is_active = true
        AND u.role IN ('learner', 'learner_plus')
      LEFT JOIN courses c ON c.id = e.course_id
      LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
      WHERE e.tenant_id = ${tenantParam}
        AND e.is_active = true
        AND e.enrolled_at >= ${rangeStartParam}
        AND e.enrolled_at <= ${rangeEndParam}
        ${scope.sql}
    )`,
  };
}
export function buildReportLearnerRosterCte(options: {
  tenantParam: string;
  groupId?: string;
  subgroupId?: string;
  teamId?: string;
  scopeParamStart: number;
  cteName?: string;
}): { sql: string; params: string[] } {
  const {
    tenantParam,
    groupId,
    subgroupId,
    teamId,
    scopeParamStart,
    cteName = 'report_learners',
  } = options;
  const scope = buildLearnerScopeExists('u.id', groupId, subgroupId, teamId, scopeParamStart);

  return {
    params: scope.params,
    sql: `${cteName} AS (
      SELECT
        u.id AS user_id,
        u.username,
        u.email,
        u.full_name,
        u.avatar_url
      FROM users u
      WHERE u.tenant_id = ${tenantParam}
        AND u.is_active = true
        AND u.role IN ('learner', 'learner_plus')
        ${scope.sql}
    )`,
  };
}
export function buildVisibleCourseUsersCte(options: {
  tenantParam: string;
  snapshotParam: string;
  extraFilterSql?: string;
}): string {
  const { tenantParam, snapshotParam, extraFilterSql = '' } = options;
  const learnerWhere = `
    u.tenant_id = ${tenantParam}
    AND u.is_active = true
    AND u.role IN ('learner', 'learner_plus')
    AND u.created_at <= ${snapshotParam}
  `;
  const courseWhere = `
    c.tenant_id = ${tenantParam}
    AND c.deleted_at IS NULL
    AND c.visible_to_staff_only = false
    AND c.created_at <= ${snapshotParam}
    ${extraFilterSql}
  `;
  const assignedWhere = `
    ${learnerWhere}
    AND og.tenant_id = ${tenantParam}
    AND ${courseWhere}
  `;
  const publicWhere = `
    ${learnerWhere}
    AND ${courseWhere}
    AND EXISTS (
      SELECT 1
      FROM course_category_courses ccc_public
      JOIN course_categories cc_public ON cc_public.id = ccc_public.category_id
      WHERE ccc_public.course_id = c.id
        AND cc_public.tenant_id = c.tenant_id
        AND COALESCE(cc_public.is_public, false) = true
    )
  `;

  return `
    visible_course_users AS (
      SELECT u.id AS user_id, c.id AS course_id, c.display_name AS name
      FROM users u
      JOIN team_members tm ON tm.user_id = u.id
      JOIN teams t ON t.id = tm.team_id
      JOIN sub_groups sg ON sg.id = t.sub_group_id
      JOIN org_groups og ON og.id = sg.org_group_id
      JOIN team_courses tc ON tc.team_id = t.id
      JOIN courses c ON c.id = tc.course_id
      WHERE ${assignedWhere}

      UNION

      SELECT u.id AS user_id, c.id AS course_id, c.display_name AS name
      FROM users u
      JOIN team_members tm ON tm.user_id = u.id
      JOIN teams t ON t.id = tm.team_id
      JOIN sub_groups sg ON sg.id = t.sub_group_id
      JOIN org_groups og ON og.id = sg.org_group_id
      JOIN team_course_categories tcc ON tcc.team_id = t.id
      JOIN course_category_courses ccc ON ccc.category_id = tcc.category_id
      JOIN courses c ON c.id = ccc.course_id
      WHERE ${assignedWhere}

      UNION

      SELECT u.id AS user_id, c.id AS course_id, c.display_name AS name
      FROM users u
      LEFT JOIN team_members tm ON tm.user_id = u.id
      LEFT JOIN teams t ON t.id = tm.team_id
      LEFT JOIN sub_groups sg ON sg.id = t.sub_group_id
      LEFT JOIN org_groups og ON og.id = sg.org_group_id
      JOIN courses c ON c.tenant_id = ${tenantParam}
      WHERE ${publicWhere}
    )
  `;
}
