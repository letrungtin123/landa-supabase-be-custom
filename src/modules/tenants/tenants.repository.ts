// ═══════════════════════════════════════════════════════════════
// Tenants repository: tenants, their modules, user-tenant assignments,
// user/course counts and the course component settings. SQL only, moved
// unchanged from tenants.service.ts and tenant-course-components.service.ts,
// which keep the rules (messages, transactions, audit entries, caches).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import type { UpdateTenantInput } from './tenants.validator.js';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface TenantsDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** Builds the tenant's database bytes expression (tenant-data-quota-ledger.logic.ts). */
export type DatabaseBytesSql = (usageAlias: string, tenantIdSql: string) => string;

/** The tenant columns an audit entry and a create or update answer show. */
export type TenantSnapshotRow = {
  id: string;
  name: string;
  slug: string;
  domain_learner: string | null;
  domain_admin: string | null;
  max_users: number | null;
  max_courses: number | null;
  data_limit_bytes: string | null;
  is_active: boolean;
};

/** A tenant with its data quota and AI usage, as the tenant list and detail answer it. */
export type TenantDetailRow = TenantSnapshotRow & {
  settings: unknown;
  created_at: string;
  updated_at: string;
  database_used_bytes: string;
  storage_used_bytes: string;
  storage_reserved_bytes: string;
  data_quota_state: string;
  data_quota_last_verified_at: string | null;
  ai_active_engine: string;
  ai_monthly_token_limit: null;
  ai_token_total_used: string;
  ai_token_reserved: string;
  ai_transition_state: string;
  ai_pending_engine: string | null;
};

export type TenantPageRow = TenantDetailRow & { full_count: string };

export type TenantModuleRow = {
  module_id: string;
  code: string;
  name: string;
  icon: string | null;
  sort_order: number;
  is_enabled: boolean;
};

export type TenantNameRow = { id: string; name: string };

export type UserTenantRow = { tenant_id: string; tenant_name: string };

export type TenantCountsRow = {
  max_users: number | null;
  max_courses: number | null;
  current_users: string;
  current_courses: string;
};

export type TenantQuotaCountRow = { quota: number | null; current_count: string };

const TENANT_SNAPSHOT_COLUMNS = 'id, name, slug, domain_learner, domain_admin, max_users, max_courses, data_limit_bytes, is_active';

/** Select list and joins shared by the tenant list and detail (data quota and AI usage). */
function tenantDetailColumns(databaseBytes: DatabaseBytesSql): string {
  return `SELECT t.id, t.name, t.slug, t.domain_learner, t.domain_admin, t.is_active, t.settings,
            t.max_users, t.max_courses, t.data_limit_bytes, t.created_at, t.updated_at,
            ${databaseBytes('quota', 't.id')}::bigint::text AS database_used_bytes,
            COALESCE(quota.storage_used_bytes, 0)::bigint::text AS storage_used_bytes,
            COALESCE(quota.storage_reserved_bytes, 0)::bigint::text AS storage_reserved_bytes,
            COALESCE(quota.state, 'initializing') AS data_quota_state,
            quota.last_verified_at AS data_quota_last_verified_at,
            COALESCE(ai_settings.active_engine, 'gemini_file_search') AS ai_active_engine,
            NULL::text AS ai_monthly_token_limit, -- retired token limit (AI limits are points); kept for older dashboards
            COALESCE(ai_usage.total_tokens, 0)::bigint::text AS ai_token_total_used,
            COALESCE(ai_usage.reserved_tokens, 0)::bigint::text AS ai_token_reserved,
            COALESCE(ai_settings.transition_state, 'idle') AS ai_transition_state,
            ai_transition.to_engine AS ai_pending_engine`;
}

const TENANT_DETAIL_JOINS = `FROM tenants t
     LEFT JOIN tenant_data_quota_usage quota ON quota.tenant_id = t.id
     LEFT JOIN tenant_ai_settings ai_settings ON ai_settings.tenant_id = t.id
     LEFT JOIN ai_token_monthly_usage ai_usage
       ON ai_usage.tenant_id = t.id
      AND ai_usage.period_start = date_trunc('month', now() AT TIME ZONE COALESCE(ai_settings.token_timezone, 'Asia/Saigon'))::date
     LEFT JOIN ai_engine_transition_jobs ai_transition
       ON ai_transition.id = ai_settings.active_transition_job_id`;

/**
 * One page of tenants, newest first, optionally filtered by name, slug or
 * domain. Run with readWithPendingDatabaseBytes(statement.sql, statement.params).
 */
export function tenantPageStatement(
  search: string | undefined,
  pageSize: number,
  offset: number,
): { sql: (databaseBytes: DatabaseBytesSql) => string; params: unknown[] } {
  const params: unknown[] = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = `WHERE t.name ILIKE $${params.length} OR t.slug ILIKE $${params.length} OR t.domain_learner ILIKE $${params.length} OR t.domain_admin ILIKE $${params.length}`;
  }
  params.push(pageSize, offset);
  return {
    sql: (databaseBytes) => `${tenantDetailColumns(databaseBytes)},
            COUNT(*) OVER() AS full_count
     ${TENANT_DETAIL_JOINS}
     ${where}
     ORDER BY t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  };
}

/** One tenant by id ($1). Run with readWithPendingDatabaseBytes(tenantDetailSql, [id]). */
export function tenantDetailSql(databaseBytes: DatabaseBytesSql): string {
  return `${tenantDetailColumns(databaseBytes)}
     ${TENANT_DETAIL_JOINS}
     WHERE t.id = $1`;
}

/** SET assignments and their parameters for the fields present in `input` (none when nothing changes). */
export function tenantUpdateAssignments(input: UpdateTenantInput): { sets: string[]; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.name !== undefined) { sets.push(`name = $${idx++}`); params.push(input.name); }
  if (input.slug !== undefined) { sets.push(`slug = $${idx++}`); params.push(input.slug); }
  if (input.domain_learner !== undefined) { sets.push(`domain_learner = $${idx++}`); params.push(input.domain_learner); }
  if (input.domain_admin !== undefined) { sets.push(`domain_admin = $${idx++}`); params.push(input.domain_admin); }
  if (input.max_users !== undefined) { sets.push(`max_users = $${idx++}`); params.push(input.max_users); }
  if (input.max_courses !== undefined) { sets.push(`max_courses = $${idx++}`); params.push(input.max_courses); }
  if (input.data_limit_bytes !== undefined) { sets.push(`data_limit_bytes = $${idx++}::bigint`); params.push(input.data_limit_bytes); }
  if (input.is_active !== undefined) { sets.push(`is_active = $${idx++}`); params.push(input.is_active); }
  if (input.settings !== undefined) { sets.push(`settings = $${idx++}`); params.push(JSON.stringify(input.settings)); }

  return { sets, params };
}

export function createTenantsRepository(db: TenantsDb) {
  return {
    async selectPublicDomains(tenantId: string): Promise<{ domain_admin: string | null; domain_learner: string | null } | undefined> {
      const result = await db.query<{ domain_admin: string | null; domain_learner: string | null }>(
        'SELECT domain_admin, domain_learner FROM tenants WHERE id = $1',
        [tenantId],
      );
      return result.rows[0];
    },

    async slugExists(slug: string): Promise<boolean> {
      const result = await db.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1', [slug]);
      return result.rowCount! > 0;
    },

    async insertTenant(values: {
      name: string;
      slug: string;
      domainLearner: string | null;
      domainAdmin: string | null;
      maxUsers: number | null;
      maxCourses: number | null;
      dataLimitBytes: string | null;
      settings: string;
    }): Promise<TenantSnapshotRow> {
      const result = await db.query<TenantSnapshotRow>(
        `INSERT INTO tenants (name, slug, domain_learner, domain_admin, max_users, max_courses, data_limit_bytes, settings)
         VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8)
         RETURNING id, name, slug, domain_learner, domain_admin, max_users, max_courses, data_limit_bytes, is_active`,
        [values.name, values.slug, values.domainLearner, values.domainAdmin, values.maxUsers, values.maxCourses, values.dataLimitBytes, values.settings],
      );
      return result.rows[0];
    },

    async insertAiSettings(tenantId: string, chatModel: string, lessonAuthorModel: string): Promise<void> {
      await db.query(
        `INSERT INTO tenant_ai_settings (tenant_id, chat_model, lesson_author_model)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId, chatModel, lessonAuthorModel],
      );
    },

    /** Turns on every active module except tenant management, badge management and news. */
    async enableDefaultModules(tenantId: string): Promise<void> {
      await db.query(
        `INSERT INTO tenant_modules (tenant_id, module_id, is_enabled)
         SELECT $1, id, true
         FROM modules
         WHERE code NOT IN ('tenant_management', 'badge_management', 'news') AND is_active = true`,
        [tenantId],
      );
    },

    async selectSettings(tenantId: string): Promise<QueryResult<{ settings: unknown }>> {
      return db.query<{ settings: unknown }>('SELECT settings FROM tenants WHERE id = $1', [tenantId]);
    },

    async lockSnapshot(tenantId: string): Promise<QueryResult<TenantSnapshotRow>> {
      return db.query<TenantSnapshotRow>(
        `SELECT ${TENANT_SNAPSHOT_COLUMNS}
         FROM tenants
        WHERE id = $1
        FOR UPDATE`,
        [tenantId],
      );
    },

    /** `assignments` from tenantUpdateAssignments (at least one). */
    async updateTenant(tenantId: string, assignments: { sets: string[]; params: unknown[] }): Promise<QueryResult<TenantSnapshotRow>> {
      return db.query<TenantSnapshotRow>(
        `UPDATE tenants SET ${assignments.sets.join(', ')} WHERE id = $${assignments.params.length + 1} RETURNING ${TENANT_SNAPSHOT_COLUMNS}`,
        [...assignments.params, tenantId],
      );
    },

    async deleteTenant(tenantId: string): Promise<TenantNameRow | undefined> {
      const result = await db.query<TenantNameRow>('DELETE FROM tenants WHERE id = $1 RETURNING id, name', [tenantId]);
      return result.rows[0];
    },

    async selectModules(tenantId: string): Promise<TenantModuleRow[]> {
      const result = await db.query<TenantModuleRow>(
        `SELECT m.id AS module_id, m.code, m.name, m.icon, m.sort_order,
                COALESCE(tm.is_enabled, false) AS is_enabled
         FROM modules m
         LEFT JOIN tenant_modules tm ON tm.module_id = m.id AND tm.tenant_id = $1
         WHERE m.is_active = true
         ORDER BY m.sort_order`,
        [tenantId],
      );
      return result.rows;
    },

    async upsertModule(tenantId: string, moduleId: string, isEnabled: boolean): Promise<void> {
      await db.query(
        `INSERT INTO tenant_modules (tenant_id, module_id, is_enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, module_id) DO UPDATE SET is_enabled = $3`,
        [tenantId, moduleId, isEnabled],
      );
    },

    async selectActiveTenants(): Promise<TenantNameRow[]> {
      const result = await db.query<TenantNameRow>('SELECT id, name FROM tenants WHERE is_active = true ORDER BY name ASC');
      return result.rows;
    },

    /** Active tenants assigned to the user through user_tenants. */
    async selectActiveTenantsOfUser(userId: string): Promise<TenantNameRow[]> {
      const result = await db.query<TenantNameRow>(
        `SELECT t.id, t.name
         FROM user_tenants ut
         JOIN tenants t ON t.id = ut.tenant_id
         WHERE ut.user_id = $1 AND t.is_active = true
         ORDER BY t.name ASC`,
        [userId],
      );
      return result.rows;
    },

    async selectUserTenants(userId: string): Promise<UserTenantRow[]> {
      const result = await db.query<UserTenantRow>(
        `SELECT ut.tenant_id, t.name AS tenant_name
         FROM user_tenants ut
         JOIN tenants t ON t.id = ut.tenant_id
         WHERE ut.user_id = $1
         ORDER BY t.name ASC`,
        [userId],
      );
      return result.rows;
    },

    async lockUsername(userId: string): Promise<{ username: string } | undefined> {
      const result = await db.query<{ username: string }>('SELECT username FROM users WHERE id = $1 FOR UPDATE', [userId]);
      return result.rows[0];
    },

    async deleteUserTenants(userId: string): Promise<void> {
      await db.query('DELETE FROM user_tenants WHERE user_id = $1', [userId]);
    },

    async insertUserTenant(userId: string, tenantId: string): Promise<void> {
      await db.query('INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, tenantId]);
    },

    async selectCounts(tenantId: string): Promise<QueryResult<TenantCountsRow>> {
      return db.query<TenantCountsRow>(
        `SELECT t.max_users, t.max_courses,
                (SELECT COUNT(*)::text FROM users WHERE tenant_id = $1) AS current_users,
                (SELECT COUNT(*)::text FROM courses WHERE tenant_id = $1) AS current_courses
         FROM tenants t WHERE t.id = $1`,
        [tenantId],
      );
    },

    /** The user or course limit and count; `lock` locks the tenant row (FOR UPDATE). */
    async selectQuotaCount(resource: 'users' | 'courses', lock: boolean, tenantId: string): Promise<TenantQuotaCountRow[]> {
      const col = resource === 'users' ? 'max_users' : 'max_courses';
      const table = resource === 'users' ? 'users' : 'courses';
      const result = await db.query<TenantQuotaCountRow>(
        `SELECT ${col} AS quota,
                (SELECT COUNT(*) FROM ${table} WHERE tenant_id = $1) AS current_count
         FROM tenants
         WHERE id = $1
         ${lock ? 'FOR UPDATE' : ''}`,
        [tenantId],
      );
      return result.rows;
    },

    /** Sets settings.course_authoring.allowed_component_types (JSON text). */
    async updateAllowedComponentTypes(tenantId: string, typesJson: string): Promise<number | null> {
      const result = await db.query<{ id: string }>(
        `UPDATE tenants
         SET settings = jsonb_set(
               CASE
                 WHEN jsonb_typeof(COALESCE(settings, '{}'::jsonb) -> 'course_authoring') = 'object'
                   THEN COALESCE(settings, '{}'::jsonb)
                 ELSE jsonb_set(COALESCE(settings, '{}'::jsonb), '{course_authoring}', '{}'::jsonb, true)
               END,
               '{course_authoring,allowed_component_types}',
               $1::jsonb,
               true
             ),
             updated_at = now()
         WHERE id = $2
         RETURNING id`,
        [typesJson, tenantId],
      );
      return result.rowCount;
    },
  };
}

export type TenantsRepository = ReturnType<typeof createTenantsRepository>;
