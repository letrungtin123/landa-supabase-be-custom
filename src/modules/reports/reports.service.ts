// ═══════════════════════════════════════════════════════════════
// Reports Service — Analytics & Dashboard data
// Optimized for millions of rows:
//   - Chart: single batch SQL per metric (not N×12 queries)
//   - Composite indexes for all hot paths
//   - No N+1 subqueries
// ═══════════════════════════════════════════════════════════════

import { query } from '../../config/database.js';

// ── Types ──

export interface ReportSummary {
  meta: {
    month: number;
    year: number;
    month_label: string;
    is_current_month: boolean;
  };
  overview: {
    total_learners: number;
    active_learners: number;
    completion_rate: number;
    total_enrollments: number;
  };
}

export interface ReportChartPoint {
  month: string;
  month_label: string;
  value?: number;
  [key: string]: unknown;
}

export interface ReportTopCourse {
  course_id: string;
  name: string;
  enrollments: number;
}

export interface ReportLearner {
  username: string;
  email: string;
  avatar: string | null;
  last_completion_at: string | null;
  progress: number;
  course_name: string;
  status: 'not_started' | 'learning' | 'completed';
  enrolled_courses: number;
}

export interface LearnerDetailResult {
  course_id: string;
  course_name: string;
  enrolled_at: string | null;
  progress: number;
  is_completed: boolean;
}

export interface LearnerDetailResponse {
  username: string;
  groups: Array<{ group_name: string; subgroup_name: string }>;
  results: LearnerDetailResult[];
  total_count: number;
  total_pages: number;
  current_page: number;
}

// ── Helpers ──

const MONTH_LABELS = [
  '', 'Tháng 1', 'Tháng 2', 'Tháng 3', 'Tháng 4', 'Tháng 5', 'Tháng 6',
  'Tháng 7', 'Tháng 8', 'Tháng 9', 'Tháng 10', 'Tháng 11', 'Tháng 12',
];

function getMonthRange(year: number, month: number): { startDate: Date; endDate: Date } {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59, 999);
  return { startDate, endDate };
}

function buildGroupFilter(groupId?: string, subgroupId?: string): { joins: string; conditions: string[]; params: any[] } {
  const joins: string[] = [];
  const conditions: string[] = [];
  const params: any[] = [];

  if (subgroupId) {
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

function buildUserGroupFilter(groupId?: string, subgroupId?: string): { joins: string; conditions: string[]; params: any[] } {
  const joins: string[] = [];
  const conditions: string[] = [];
  const params: any[] = [];

  if (subgroupId) {
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

// ═══════════════════════════════════════════════════════════════
// Report Summary — 4 queries total (optimized)
// ═══════════════════════════════════════════════════════════════

export async function getReportSummary(
  tenantId: string,
  month?: number,
  year?: number,
  groupId?: string,
  subgroupId?: string,
): Promise<ReportSummary> {
  const now = new Date();
  const targetMonth = month ?? (now.getMonth() + 1);
  const targetYear = year ?? now.getFullYear();
  const isCurrentMonth = targetMonth === now.getMonth() + 1 && targetYear === now.getFullYear();
  const { startDate, endDate } = getMonthRange(targetYear, targetMonth);

  const ugf = buildUserGroupFilter(groupId, subgroupId);
  const egf = buildGroupFilter(groupId, subgroupId);

  // ── Single query: total_learners + active_learners ──
  let uParamIdx = 2;
  const uConds = ugf.conditions.map(c => c.replace('$PARAM', `$${uParamIdx++}`));
  const userResult = await query<{ total: string; active: string }>(
    `SELECT
       COUNT(DISTINCT u.id) AS total,
       COUNT(DISTINCT CASE WHEN u.last_login_at >= $${uParamIdx} AND u.last_login_at <= $${uParamIdx + 1} THEN u.id END) AS active
     FROM users u ${ugf.joins}
     WHERE u.tenant_id = $1 AND u.is_active = true AND u.role = 'learner'
       AND u.created_at <= $${uParamIdx + 2}
       ${uConds.length ? 'AND ' + uConds.join(' AND ') : ''}`,
    [tenantId, ...ugf.params, startDate, endDate, endDate],
  );

  // ── Single query: completion_rate + total_enrollments ──
  let eParamIdx = 2;
  const eConds = egf.conditions.map(c => c.replace('$PARAM', `$${eParamIdx++}`));
  const enrollResult = await query<{ avg_progress: string; month_enrollments: string }>(
    `SELECT
       COALESCE(AVG(cp.progress), 0) AS avg_progress,
       COUNT(DISTINCT CASE WHEN e.enrolled_at >= $${eParamIdx} AND e.enrolled_at <= $${eParamIdx + 1} THEN e.id END) AS month_enrollments
     FROM enrollments e
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     ${egf.joins}
     WHERE e.tenant_id = $1 AND e.is_active = true AND e.enrolled_at <= $${eParamIdx + 2}
       ${eConds.length ? 'AND ' + eConds.join(' AND ') : ''}`,
    [tenantId, ...egf.params, startDate, endDate, endDate],
  );

  return {
    meta: {
      month: targetMonth,
      year: targetYear,
      month_label: MONTH_LABELS[targetMonth],
      is_current_month: isCurrentMonth,
    },
    overview: {
      total_learners: parseInt(userResult.rows[0]?.total ?? '0'),
      active_learners: parseInt(userResult.rows[0]?.active ?? '0'),
      completion_rate: Math.round(parseFloat(enrollResult.rows[0]?.avg_progress ?? '0') * 10) / 10,
      total_enrollments: parseInt(enrollResult.rows[0]?.month_enrollments ?? '0'),
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Report Chart — BATCH queries (1 SQL per metric, not N×12)
// ═══════════════════════════════════════════════════════════════

export async function getReportChart(
  tenantId: string,
  year: number,
  metric: string,
  groupId?: string,
  subgroupId?: string,
  groupByOrg = false,
  grouped = true,
): Promise<{ year: number; metric: string; data: ReportChartPoint[]; is_grouped: boolean }> {
  const now = new Date();
  const maxMonth = year > now.getFullYear() ? 0
    : year === now.getFullYear() ? now.getMonth() + 1
    : 12;

  if (groupByOrg) {
    return chartGroupedByOrg(tenantId, year, metric, maxMonth, groupId);
  }
  if (subgroupId && grouped) {
    return chartGroupedByTeam(tenantId, year, metric, maxMonth, subgroupId);
  }
  if (groupId && grouped) {
    return chartGroupedBySubGroup(tenantId, year, metric, maxMonth, groupId);
  }

  return chartSimple(tenantId, year, metric, maxMonth, groupId, subgroupId);
}

/**
 * Simple chart — 1 SQL query for ALL 12 months (batch).
 * Uses GROUP BY EXTRACT(MONTH FROM ...) instead of 12 separate queries.
 */
async function chartSimple(
  tenantId: string, year: number, metric: string, maxMonth: number,
  groupId?: string, subgroupId?: string,
): Promise<{ year: number; metric: string; data: ReportChartPoint[]; is_grouped: boolean }> {
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

  const monthValues = await batchMetricByMonth(tenantId, metric, yearStart, yearEnd, year, groupId, subgroupId);

  const data: ReportChartPoint[] = [];
  for (let m = 1; m <= 12; m++) {
    data.push({
      month: `T${m}`,
      month_label: MONTH_LABELS[m],
      value: m > maxMonth ? 0 : (monthValues.get(m) ?? 0),
    });
  }

  return { year, metric, data, is_grouped: false };
}

/**
 * Grouped by OrgGroup — 1 SQL query per OrgGroup (instead of N×12)
 */
async function chartGroupedByOrg(
  tenantId: string, year: number, metric: string, maxMonth: number,
  groupId?: string,
): Promise<{ year: number; metric: string; data: ReportChartPoint[]; is_grouped: boolean }> {
  const gFilter = groupId ? 'AND og.id = $2' : '';
  const gParams = groupId ? [tenantId, groupId] : [tenantId];
  const orgs = await query<{ id: string; name: string }>(
    `SELECT id, name FROM org_groups WHERE tenant_id = $1 ${gFilter} ORDER BY name`,
    gParams,
  );

  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

  // 1 batch query per org (not 12!)
  const orgMonthData = new Map<string, Map<number, number>>();
  for (const og of orgs.rows) {
    const mv = await batchMetricByMonth(tenantId, metric, yearStart, yearEnd, year, og.id, undefined);
    orgMonthData.set(og.name, mv);
  }

  const data: ReportChartPoint[] = [];
  for (let m = 1; m <= 12; m++) {
    const point: ReportChartPoint = { month: `T${m}`, month_label: MONTH_LABELS[m] };
    for (const og of orgs.rows) {
      point[og.name] = m > maxMonth ? 0 : (orgMonthData.get(og.name)?.get(m) ?? 0);
    }
    data.push(point);
  }

  return { year, metric, data, is_grouped: true };
}

/**
 * Grouped by SubGroup — 1 SQL query per SubGroup (not 12!)
 */
async function chartGroupedBySubGroup(
  tenantId: string, year: number, metric: string, maxMonth: number,
  groupId: string,
): Promise<{ year: number; metric: string; data: ReportChartPoint[]; is_grouped: boolean }> {
  const sgs = await query<{ id: string; name: string }>(
    `SELECT id, name FROM sub_groups WHERE org_group_id = $1 ORDER BY name`,
    [groupId],
  );

  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

  const sgMonthData = new Map<string, Map<number, number>>();
  for (const sg of sgs.rows) {
    const mv = await batchMetricByMonth(tenantId, metric, yearStart, yearEnd, year, undefined, sg.id);
    sgMonthData.set(sg.name, mv);
  }

  const data: ReportChartPoint[] = [];
  for (let m = 1; m <= 12; m++) {
    const point: ReportChartPoint = { month: `T${m}`, month_label: MONTH_LABELS[m] };
    for (const sg of sgs.rows) {
      point[sg.name] = m > maxMonth ? 0 : (sgMonthData.get(sg.name)?.get(m) ?? 0);
    }
    data.push(point);
  }

  return { year, metric, data, is_grouped: true };
}

/**
 * Grouped by Team — 1 SQL query per Team (not 12!)
 */
async function chartGroupedByTeam(
  tenantId: string, year: number, metric: string, maxMonth: number,
  subgroupId: string,
): Promise<{ year: number; metric: string; data: ReportChartPoint[]; is_grouped: boolean }> {
  const teams = await query<{ id: string; name: string }>(
    `SELECT id, name FROM teams WHERE sub_group_id = $1 ORDER BY name`,
    [subgroupId],
  );

  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

  const teamMonthData = new Map<string, Map<number, number>>();
  for (const tm of teams.rows) {
    const mv = await batchMetricByMonthTeam(tenantId, metric, yearStart, yearEnd, year, tm.id);
    teamMonthData.set(tm.name, mv);
  }

  const data: ReportChartPoint[] = [];
  for (let m = 1; m <= 12; m++) {
    const point: ReportChartPoint = { month: `T${m}`, month_label: MONTH_LABELS[m] };
    for (const tm of teams.rows) {
      point[tm.name] = m > maxMonth ? 0 : (teamMonthData.get(tm.name)?.get(m) ?? 0);
    }
    data.push(point);
  }

  return { year, metric, data, is_grouped: true };
}

/**
 * BATCH: Calculate metric for all 12 months in 1 SQL query.
 * Returns Map<month_number, value>.
 */
async function batchMetricByMonth(
  tenantId: string, metric: string,
  yearStart: Date, yearEnd: Date, year: number,
  groupId?: string, subgroupId?: string,
): Promise<Map<number, number>> {
  const result = new Map<number, number>();

  switch (metric) {
    case 'total_learners': {
      // Cumulative: count users created before end of each month
      const ugf = buildUserGroupFilter(groupId, subgroupId);
      let idx = 2;
      const conds = ugf.conditions.map(c => c.replace('$PARAM', `$${idx++}`));
      const r = await query<{ m: number; cnt: string }>(
        `SELECT gs.m,
                COUNT(DISTINCT u.id) AS cnt
         FROM generate_series(1, 12) AS gs(m)
         LEFT JOIN users u ON u.tenant_id = $1
           AND u.is_active = true AND u.role = 'learner'
           AND u.created_at <= (make_date($${idx}, gs.m::INT, 1) + INTERVAL '1 month' - INTERVAL '1 second')
           ${ugf.joins ? ugf.joins.replace(/\bu\b/g, 'u') : ''}
           ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
         GROUP BY gs.m ORDER BY gs.m`,
        [tenantId, ...ugf.params, year],
      );
      for (const row of r.rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
    case 'active_learners': {
      const ugf = buildUserGroupFilter(groupId, subgroupId);
      let idx = 2;
      const conds = ugf.conditions.map(c => c.replace('$PARAM', `$${idx++}`));
      const r = await query<{ m: number; cnt: string }>(
        `SELECT EXTRACT(MONTH FROM u.last_login_at)::INT AS m,
                COUNT(DISTINCT u.id) AS cnt
         FROM users u ${ugf.joins}
         WHERE u.tenant_id = $1 AND u.is_active = true AND u.role = 'learner'
           AND u.last_login_at >= $${idx} AND u.last_login_at <= $${idx + 1}
           ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
         GROUP BY EXTRACT(MONTH FROM u.last_login_at)`,
        [tenantId, ...ugf.params, yearStart, yearEnd],
      );
      for (const row of r.rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
    case 'completion_rate': {
      // AVG progress per month — uses enrolled_at month as bucket
      const egf = buildGroupFilter(groupId, subgroupId);
      let idx = 2;
      const conds = egf.conditions.map(c => c.replace('$PARAM', `$${idx++}`));
      const r = await query<{ m: number; avg_p: string }>(
        `SELECT EXTRACT(MONTH FROM e.enrolled_at)::INT AS m,
                COALESCE(AVG(cp.progress), 0) AS avg_p
         FROM enrollments e
         LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
         ${egf.joins}
         WHERE e.tenant_id = $1 AND e.is_active = true
           AND e.enrolled_at >= $${idx} AND e.enrolled_at <= $${idx + 1}
           ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
         GROUP BY EXTRACT(MONTH FROM e.enrolled_at)`,
        [tenantId, ...egf.params, yearStart, yearEnd],
      );
      for (const row of r.rows) result.set(row.m, Math.round(parseFloat(row.avg_p) * 10) / 10);
      break;
    }
    case 'total_enrollments': {
      const egf = buildGroupFilter(groupId, subgroupId);
      let idx = 2;
      const conds = egf.conditions.map(c => c.replace('$PARAM', `$${idx++}`));
      const r = await query<{ m: number; cnt: string }>(
        `SELECT EXTRACT(MONTH FROM e.enrolled_at)::INT AS m,
                COUNT(DISTINCT e.id) AS cnt
         FROM enrollments e ${egf.joins}
         WHERE e.tenant_id = $1 AND e.is_active = true
           AND e.enrolled_at >= $${idx} AND e.enrolled_at <= $${idx + 1}
           ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
         GROUP BY EXTRACT(MONTH FROM e.enrolled_at)`,
        [tenantId, ...egf.params, yearStart, yearEnd],
      );
      for (const row of r.rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
  }

  return result;
}

/**
 * BATCH by Team: single SQL for all months, filtered by team_id.
 */
async function batchMetricByMonthTeam(
  tenantId: string, metric: string,
  yearStart: Date, yearEnd: Date, year: number,
  teamId: string,
): Promise<Map<number, number>> {
  const result = new Map<number, number>();

  switch (metric) {
    case 'total_learners': {
      const r = await query<{ m: number; cnt: string }>(
        `SELECT gs.m,
                COUNT(DISTINCT u.id) AS cnt
         FROM generate_series(1, 12) AS gs(m)
         LEFT JOIN users u ON u.tenant_id = $1
           AND u.is_active = true AND u.role = 'learner'
           AND u.created_at <= (make_date($2, gs.m::INT, 1) + INTERVAL '1 month' - INTERVAL '1 second')
         LEFT JOIN team_members tm ON tm.user_id = u.id AND tm.team_id = $3
         WHERE (u.id IS NULL OR tm.user_id IS NOT NULL)
         GROUP BY gs.m ORDER BY gs.m`,
        [tenantId, year, teamId],
      );
      for (const row of r.rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
    case 'active_learners': {
      const r = await query<{ m: number; cnt: string }>(
        `SELECT EXTRACT(MONTH FROM u.last_login_at)::INT AS m,
                COUNT(DISTINCT u.id) AS cnt
         FROM users u
         JOIN team_members tm ON tm.user_id = u.id
         WHERE u.tenant_id = $1 AND u.is_active = true AND u.role = 'learner'
           AND tm.team_id = $2
           AND u.last_login_at >= $3 AND u.last_login_at <= $4
         GROUP BY EXTRACT(MONTH FROM u.last_login_at)`,
        [tenantId, teamId, yearStart, yearEnd],
      );
      for (const row of r.rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
    case 'completion_rate': {
      const r = await query<{ m: number; avg_p: string }>(
        `SELECT EXTRACT(MONTH FROM e.enrolled_at)::INT AS m,
                COALESCE(AVG(cp.progress), 0) AS avg_p
         FROM enrollments e
         LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
         JOIN team_members tm ON tm.user_id = e.user_id
         WHERE e.tenant_id = $1 AND e.is_active = true AND tm.team_id = $2
           AND e.enrolled_at >= $3 AND e.enrolled_at <= $4
         GROUP BY EXTRACT(MONTH FROM e.enrolled_at)`,
        [tenantId, teamId, yearStart, yearEnd],
      );
      for (const row of r.rows) result.set(row.m, Math.round(parseFloat(row.avg_p) * 10) / 10);
      break;
    }
    case 'total_enrollments': {
      const r = await query<{ m: number; cnt: string }>(
        `SELECT EXTRACT(MONTH FROM e.enrolled_at)::INT AS m,
                COUNT(e.id) AS cnt
         FROM enrollments e
         JOIN team_members tm ON tm.user_id = e.user_id
         WHERE e.tenant_id = $1 AND e.is_active = true AND tm.team_id = $2
           AND e.enrolled_at >= $3 AND e.enrolled_at <= $4
         GROUP BY EXTRACT(MONTH FROM e.enrolled_at)`,
        [tenantId, teamId, yearStart, yearEnd],
      );
      for (const row of r.rows) result.set(row.m, parseInt(row.cnt));
      break;
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// Top Courses
// ═══════════════════════════════════════════════════════════════

export async function getReportTopCourses(
  tenantId: string,
  page = 1,
  pageSize = 10,
  month?: number,
  year?: number,
  groupId?: string,
  subgroupId?: string,
): Promise<{ count: number; total_pages: number; current_page: number; results: ReportTopCourse[] }> {
  const offset = (page - 1) * pageSize;
  const conditions: string[] = ['e.tenant_id = $1', 'e.is_active = true'];
  const params: any[] = [tenantId];
  let paramIdx = 2;

  if (month && year) {
    const { startDate, endDate } = getMonthRange(year, month);
    conditions.push(`e.enrolled_at >= $${paramIdx} AND e.enrolled_at <= $${paramIdx + 1}`);
    params.push(startDate, endDate);
    paramIdx += 2;
  } else if (year) {
    conditions.push(`EXTRACT(YEAR FROM e.enrolled_at) = $${paramIdx}`);
    params.push(year);
    paramIdx++;
  }

  const gf = buildGroupFilter(groupId, subgroupId);
  const gfConditions = gf.conditions.map(c => c.replace('$PARAM', `$${paramIdx++}`));
  params.push(...gf.params);

  const whereClause = [...conditions, ...gfConditions].join(' AND ');

  // Single query: count + data using window function
  params.push(pageSize, offset);
  const result = await query<ReportTopCourse & { full_count: string }>(
    `SELECT e.course_id, c.display_name AS name,
            COUNT(DISTINCT e.id) AS enrollments,
            COUNT(*) OVER() AS full_count
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     ${gf.joins}
     WHERE ${whereClause}
     GROUP BY e.course_id, c.display_name
     ORDER BY enrollments DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    params,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');

  return {
    count: total,
    total_pages: Math.ceil(total / pageSize),
    current_page: page,
    results: result.rows.map(r => ({ course_id: r.course_id, name: r.name, enrollments: Number(r.enrollments) })),
  };
}

// ═══════════════════════════════════════════════════════════════
// Report Learners — optimized with no N+1 subqueries
// ═══════════════════════════════════════════════════════════════

export async function getReportLearners(
  tenantId: string,
  page = 1,
  pageSize = 20,
  search?: string,
  month?: number,
  year?: number,
  groupId?: string,
  subgroupId?: string,
  status?: 'all' | 'not_started' | 'learning' | 'completed',
): Promise<{ count: number; total_pages: number; current_page: number; results: ReportLearner[] }> {
  const offset = (page - 1) * pageSize;
  const conditions: string[] = ["u.tenant_id = $1", "u.is_active = true", "u.role = 'learner'"];
  const params: any[] = [tenantId];
  let paramIdx = 2;

  if (search) {
    conditions.push(`(u.username ILIKE '%' || $${paramIdx} || '%' OR u.email ILIKE '%' || $${paramIdx} || '%')`);
    params.push(search);
    paramIdx++;
  }

  const ugf = buildUserGroupFilter(groupId, subgroupId);
  const ugfConditions = ugf.conditions.map(c => c.replace('$PARAM', `$${paramIdx++}`));
  params.push(...ugf.params);

  const whereClause = [...conditions, ...ugfConditions].join(' AND ');

  let enrollmentDateFilter = '';
  if (month && year) {
    const { startDate, endDate } = getMonthRange(year, month);
    enrollmentDateFilter = ` AND e.enrolled_at >= $${paramIdx} AND e.enrolled_at <= $${paramIdx + 1}`;
    params.push(startDate, endDate);
    paramIdx += 2;
  }

  // Base query: aggregate per user
  const baseQuery = `
    SELECT u.id AS user_id, u.username, u.email, u.avatar_url AS avatar,
           MAX(cp.completed_at) AS last_completion_at,
           COALESCE(AVG(cp.progress), 0) AS progress,
           MIN(c.display_name) FILTER (WHERE c.display_name IS NOT NULL) AS course_name,
           CASE
             WHEN COALESCE(AVG(cp.progress), 0) >= 100 AND COUNT(e.id) > 0 THEN 'completed'
             WHEN COALESCE(AVG(cp.progress), 0) > 0 THEN 'learning'
             ELSE 'not_started'
           END AS status,
           COUNT(DISTINCT e.id) AS enrolled_courses
    FROM users u
    ${ugf.joins}
    LEFT JOIN enrollments e ON e.user_id = u.id AND e.is_active = true${enrollmentDateFilter}
    LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
    LEFT JOIN courses c ON c.id = e.course_id
    WHERE ${whereClause}
    GROUP BY u.id, u.username, u.email, u.avatar_url`;

  let statusFilter = '';
  if (status && status !== 'all') {
    statusFilter = `WHERE sub.status = '${status}'`;
  }

  // Single query with window function for count
  params.push(pageSize, offset);
  const result = await query<any>(
    `SELECT sub.*, COUNT(*) OVER() AS full_count
     FROM (${baseQuery}) sub ${statusFilter}
     ORDER BY sub.last_completion_at DESC NULLS LAST, sub.username ASC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    params,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');

  return {
    count: total,
    total_pages: Math.ceil(total / pageSize),
    current_page: page,
    results: result.rows.map((r: any) => ({
      username: r.username,
      email: r.email,
      avatar: r.avatar,
      last_completion_at: r.last_completion_at,
      progress: parseFloat(r.progress) || 0,
      course_name: r.course_name || '',
      status: r.status,
      enrolled_courses: parseInt(r.enrolled_courses) || 0,
    })),
  };
}

// ═══════════════════════════════════════════════════════════════
// Learner Detail
// ═══════════════════════════════════════════════════════════════

export async function getLearnerDetail(
  tenantId: string,
  username: string,
  page = 1,
  pageSize = 10,
  search = '',
): Promise<LearnerDetailResponse> {
  const userResult = await query<{ id: string }>(
    `SELECT id FROM users WHERE username = $1 AND tenant_id = $2`,
    [username, tenantId],
  );
  if (userResult.rowCount === 0) {
    return { username, groups: [], results: [], total_count: 0, total_pages: 0, current_page: page };
  }
  const userId = userResult.rows[0].id;

  // Groups
  const groupsResult = await query<{ group_name: string; subgroup_name: string }>(
    `SELECT og.name AS group_name, sg.name AS subgroup_name
     FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE tm.user_id = $1`,
    [userId],
  );

  // Single query: count + data with window function
  const searchFilter = search ? `AND c.display_name ILIKE '%' || $3 || '%'` : '';
  const offset = (page - 1) * pageSize;
  const dataParams: any[] = [userId, tenantId];
  if (search) dataParams.push(search);
  dataParams.push(pageSize, offset);

  const paramOff = search ? 4 : 3;
  const result = await query<LearnerDetailResult & { full_count: string }>(
    `SELECT e.course_id, c.display_name AS course_name,
            e.enrolled_at,
            COALESCE(cp.progress, 0) AS progress,
            COALESCE(cp.is_completed, false) AS is_completed,
            COUNT(*) OVER() AS full_count
     FROM enrollments e
     JOIN courses c ON c.id = e.course_id
     LEFT JOIN course_progress cp ON cp.enrollment_id = e.id
     WHERE e.user_id = $1 AND e.tenant_id = $2 AND e.is_active = true ${searchFilter}
     ORDER BY e.enrolled_at DESC
     LIMIT $${paramOff} OFFSET $${paramOff + 1}`,
    dataParams,
  );

  const total = parseInt(result.rows[0]?.full_count ?? '0');

  return {
    username,
    groups: groupsResult.rows,
    results: result.rows.map(r => ({
      course_id: r.course_id,
      course_name: r.course_name,
      enrolled_at: r.enrolled_at,
      progress: parseFloat(r.progress as any) || 0,
      is_completed: r.is_completed,
    })),
    total_count: total,
    total_pages: Math.ceil(total / pageSize),
    current_page: page,
  };
}

// ═══════════════════════════════════════════════════════════════
// User Badges
// ═══════════════════════════════════════════════════════════════

export async function getUserBadges(
  username: string,
  tenantId: string,
): Promise<{ username: string; badges: Array<{ badge_id: string; earned_at: string }> }> {
  const result = await query<{ badge_id: string; earned_at: string }>(
    `SELECT ub.badge_id, ub.earned_at
     FROM user_badges ub
     JOIN users u ON u.id = ub.user_id
     WHERE u.username = $1 AND u.tenant_id = $2
     ORDER BY ub.earned_at DESC`,
    [username, tenantId],
  );

  return { username, badges: result.rows };
}

// ═══════════════════════════════════════════════════════════════
// User Study Time
// ═══════════════════════════════════════════════════════════════

export async function getUserStudyTime(
  username: string,
  tenantId: string,
): Promise<{ username: string; entries: Array<{ date: string; minutes: number }> }> {
  const result = await query<{ date: string; minutes: string }>(
    `SELECT ss.started_at::DATE AS date,
            SUM(ss.duration_minutes) AS minutes
     FROM study_sessions ss
     JOIN users u ON u.id = ss.user_id
     WHERE u.username = $1 AND u.tenant_id = $2
       AND ss.started_at >= now() - INTERVAL '7 days'
     GROUP BY ss.started_at::DATE
     ORDER BY date`,
    [username, tenantId],
  );

  return {
    username,
    entries: result.rows.map(r => ({ date: r.date, minutes: parseInt(r.minutes) })),
  };
}

// ═══════════════════════════════════════════════════════════════
// Refresh Materialized View
// ═══════════════════════════════════════════════════════════════

export async function refreshReportSummary(): Promise<void> {
  try {
    await query('SELECT refresh_report_summary()', []);
  } catch {
    // Function may not exist yet
  }
}
