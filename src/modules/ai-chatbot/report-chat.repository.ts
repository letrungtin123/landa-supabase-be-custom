// SQL for the admin report chat path. Every read is tenant-scoped: org units
// through org_groups.tenant_id, enrollments through enrollments.tenant_id and
// users.tenant_id, the unit breakdown through the tenant_id of every table it
// reads, conversations through the caller's already-verified conversation
// (loaded with user_id + tenant_id by the chat service).

import { query } from '../../config/database.js';
import { buildLearnerScopeExists, type ReportDateRange } from '../reports/reports.service.js';
import type { ReportScope } from '../reports/report-access.service.js';
import type { NormalizedReportChatFilter } from './report-chat.service.js';
import type { ReportOrgUnit, ReportOrgUnitLevel } from './report-org-unit.logic.js';
import {
  buildReportUnitBreakdownQuery,
  type ReportUnitBreakdownQueryInput,
  type ReportUnitBreakdownQueryRow,
} from './report-unit-breakdown.logic.js';

/** Per-unit breakdown of a report scope: one grouped statement, at most limit + 2 rows. */
export async function loadReportUnitBreakdownRows(input: ReportUnitBreakdownQueryInput): Promise<ReportUnitBreakdownQueryRow[]> {
  const { sql, params } = buildReportUnitBreakdownQuery(input);
  const result = await query<ReportUnitBreakdownQueryRow>(sql, params);
  return result.rows;
}

export async function insertReportAssistantMessage(conversationId: string, content: string, metadata: Record<string, unknown>): Promise<string> {
  const saved = await query<{ id: string }>(
    `INSERT INTO chat_messages (conversation_id, role, content, metadata)
     VALUES ($1, 'assistant', $2, $3)
     RETURNING id::text AS id`,
    [conversationId, content, metadata],
  );
  return saved.rows[0].id;
}

export async function touchReportConversation(input: {
  conversationId: string;
  tenantId: string;
  title: string;
  setTitle: boolean;
}): Promise<void> {
  await query(
    `UPDATE chat_conversations
     SET updated_at = now(), title = CASE WHEN $3::boolean THEN $2 ELSE title END
     WHERE id = $1 AND tenant_id = $4`,
    [input.conversationId, input.title, input.setTitle, input.tenantId],
  );
}

function readStoredReportFilter(value: unknown): NormalizedReportChatFilter | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const filter = value as Record<string, unknown>;
  if (typeof filter.date_from !== 'string' || typeof filter.date_to !== 'string') return null;
  return {
    date_from: filter.date_from,
    date_to: filter.date_to,
    ...(typeof filter.group_id === 'string' ? { group_id: filter.group_id } : {}),
    ...(typeof filter.subgroup_id === 'string' ? { subgroup_id: filter.subgroup_id } : {}),
    ...(typeof filter.team_id === 'string' ? { team_id: filter.team_id } : {}),
  };
}

export async function loadLatestReportAnalysisContext(conversationId: string): Promise<{
  question: string;
  filter: NormalizedReportChatFilter;
} | null> {
  const result = await query<{ metadata: unknown }>(
    `SELECT metadata
     FROM chat_messages
     WHERE conversation_id = $1
       AND role = 'assistant'
       AND metadata ->> 'kind' = 'report_analysis'
     ORDER BY created_at DESC
     LIMIT 1`,
    [conversationId],
  );
  const metadata = result.rows[0]?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const question = typeof record.report_question === 'string' ? record.report_question : '';
  const filter = readStoredReportFilter(record.report_filter);
  return question && filter ? { question, filter } : null;
}

interface OrgUnitRow {
  level: ReportOrgUnitLevel;
  id: string;
  name: string;
  group_id: string;
  group_name: string;
  subgroup_id: string | null;
  subgroup_name: string | null;
}

/** Bounded by `limit`; returns `limit + 1` rows at most so the caller can detect truncation. */
export async function loadReportOrgUnitRows(tenantId: string, limit: number): Promise<ReportOrgUnit[]> {
  const result = await query<OrgUnitRow>(
    `SELECT level, id, name, group_id, group_name, subgroup_id, subgroup_name
     FROM (
       SELECT 'group'::text AS level, og.id::text AS id, og.name::text AS name,
              og.id::text AS group_id, og.name::text AS group_name,
              NULL::text AS subgroup_id, NULL::text AS subgroup_name
       FROM org_groups og
       WHERE og.tenant_id = $1
       UNION ALL
       SELECT 'subgroup'::text, sg.id::text, sg.name::text, og.id::text, og.name::text, sg.id::text, sg.name::text
       FROM sub_groups sg
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE og.tenant_id = $1
       UNION ALL
       SELECT 'team'::text, t.id::text, t.name::text, og.id::text, og.name::text, sg.id::text, sg.name::text
       FROM teams t
       JOIN sub_groups sg ON sg.id = t.sub_group_id
       JOIN org_groups og ON og.id = sg.org_group_id
       WHERE og.tenant_id = $1
     ) units
     ORDER BY CASE level WHEN 'group' THEN 1 WHEN 'subgroup' THEN 2 ELSE 3 END, name, id
     LIMIT $2`,
    [tenantId, limit + 1],
  );
  return result.rows
    .filter((row) => row.name.trim().length > 0)
    .map((row) => ({
      id: row.id,
      level: row.level,
      name: row.name.trim(),
      group_id: row.group_id,
      group_name: row.group_name,
      subgroup_id: row.subgroup_id,
      subgroup_name: row.subgroup_name,
    }));
}

/**
 * Closest enrollment day (Asia/Ho_Chi_Minh) before and after an empty range,
 * in the same tenant and org scope as the report. Each side is one ordered
 * LIMIT 1 scan on idx_enrollments_tenant_date_active.
 */
export async function findNearestReportEnrollmentDates(input: {
  tenantId: string;
  scope: Pick<ReportScope, 'groupId' | 'subgroupId' | 'teamId'>;
  range: ReportDateRange;
}): Promise<{ before: string | null; after: string | null }> {
  const scope = buildLearnerScopeExists('e.user_id', input.scope.groupId, input.scope.subgroupId, input.scope.teamId, 4);
  const nearest = (comparison: string, order: 'ASC' | 'DESC') => `(
    SELECT to_char(e.enrolled_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')
    FROM enrollments e
    JOIN users u ON u.id = e.user_id
      AND u.tenant_id = $1
      AND u.is_active = true
      AND u.role IN ('learner', 'learner_plus')
    WHERE e.tenant_id = $1
      AND e.is_active = true
      AND ${comparison}
      ${scope.sql}
    ORDER BY e.enrolled_at ${order}
    LIMIT 1
  )`;
  const result = await query<{ before_date: string | null; after_date: string | null }>(
    `SELECT ${nearest('e.enrolled_at < $2', 'DESC')} AS before_date,
            ${nearest('e.enrolled_at > $3 AND e.enrolled_at <= now()', 'ASC')} AS after_date`,
    [input.tenantId, input.range.startDate.toISOString(), input.range.endDate.toISOString(), ...scope.params],
  );
  const row = result.rows[0];
  return { before: row?.before_date ?? null, after: row?.after_date ?? null };
}
