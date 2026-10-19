// ═══════════════════════════════════════════════════════════════
// Auth repository: sign-in lookups, refresh tokens, the session context
// (permissions, modules, managed tenants, member groups), the tenant of a
// sign-in origin, password and profile writes. SQL only; moved unchanged from
// auth.service.ts, which keeps the rules (refusals and their order, token
// hashing and rotation, reuse grace, demo iframe locks, caches).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';
import type { DemoIframeSessionMode } from '../demo-login/demo-iframe.service.js';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface AuthDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** A user with its tenant, as a session is issued for it. */
export interface SessionUserRow {
  id: string;
  username: string;
  email: string;
  full_name: string;
  phone: string;
  avatar_url: string | null;
  role: string;
  is_active: boolean;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_active: boolean | null;
}

export interface LoginUserRow extends SessionUserRow {
  password_hash: string | null;
}

/** A refresh token row (locked), with its user, tenant and the user's session revocation. */
export interface RefreshTokenLockRow extends SessionUserRow {
  rt_id: string;
  user_id: string;
  revoked: boolean;
  expires_at: Date;
  revoked_at: Date | null;
  session_id: string | null;
  session_mode: string;
  session_revoked_at: Date | null;
}

export interface MeUserRow {
  id: string;
  username: string;
  email: string;
  full_name: string;
  phone: string;
  avatar_url: string | null;
  role: string;
  tenant_id: string | null;
  bio: string | null;
  gender: string | null;
  country: string | null;
  language: string | null;
  level_of_education: string | null;
  year_of_birth: number | null;
  tenant_name: string | null;
}

export interface PermissionRow {
  code: string;
  can_view: boolean;
  can_add: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

export interface IdNameRow {
  id: string;
  name: string;
}

export interface NewRefreshToken {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  sessionMode: DemoIframeSessionMode;
  sessionId: string | null;
}

/** The profile row a self-service update answers. */
export interface ProfileRow {
  id: string;
  username: string;
  email: string;
  full_name: string;
  phone: string;
  bio: string | null;
  avatar_url: string | null;
  gender: string | null;
  country: string | null;
  language: string | null;
  level_of_education: string | null;
  year_of_birth: number | null;
}

const LOGIN_USER_SELECT = `
  SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
         u.role, u.is_active, u.tenant_id,
         u.password_hash,
         t.name AS tenant_name, t.is_active AS tenant_active
  FROM users u
  LEFT JOIN tenants t ON t.id = u.tenant_id
`;

export function createAuthRepository(db: AuthDb) {
  return {
    // ── Sign-in ──

    /** The account whose trimmed, lower-cased email is `normalizedEmail`. */
    async selectLoginUserByEmail(normalizedEmail: string): Promise<QueryResult<LoginUserRow>> {
      return db.query<LoginUserRow>(
        `${LOGIN_USER_SELECT}
       WHERE btrim(u.email) <> ''
         AND lower(btrim(u.email)) = $1
       LIMIT 1`,
        [normalizedEmail],
      );
    },

    async selectLoginUserByUsername(identifier: string): Promise<QueryResult<LoginUserRow>> {
      return db.query<LoginUserRow>(
        `${LOGIN_USER_SELECT}
     WHERE u.username = $1
     LIMIT 1`,
        [identifier],
      );
    },

    /** How many permission groups the user belongs to (any tenant). */
    async countUserPermissionGroups(userId: string): Promise<QueryResult<{ count: string }>> {
      return db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM user_permission_groups WHERE user_id = $1`,
        [userId],
      );
    },

    /** How many active tenants the user manages through user_tenants. */
    async countActiveManagedTenants(userId: string): Promise<QueryResult<{ count: string }>> {
      return db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM user_tenants ut
       JOIN tenants t ON t.id = ut.tenant_id
       WHERE ut.user_id = $1 AND t.is_active = true`,
        [userId],
      );
    },

    /** last_login_at = now(), unless it was written less than a minute ago. */
    async touchLastLogin(userId: string): Promise<void> {
      await db.query(
        `UPDATE users SET last_login_at = now()
     WHERE id = $1 AND (last_login_at IS NULL OR last_login_at < now() - interval '1 minute')`,
        [userId],
      );
    },

    /** The active tenant whose learner or admin domain is `normalizedOrigin` (slashes and spaces ignored). */
    async selectActiveTenantIdByOrigin(normalizedOrigin: string): Promise<{ id: string } | null> {
      const result = await db.query<{ id: string }>(
        `SELECT id FROM tenants
     WHERE (
       REPLACE(REPLACE(domain_learner, '/', ''), ' ', '') = REPLACE(REPLACE($1, '/', ''), ' ', '')
       OR REPLACE(REPLACE(domain_admin, '/', ''), ' ', '') = REPLACE(REPLACE($1, '/', ''), ' ', '')
     ) AND is_active = true
     LIMIT 1`,
        [normalizedOrigin],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    // ── Users ──

    /** The user with its tenant; null when there is none. */
    async selectSessionUser(userId: string): Promise<SessionUserRow | null> {
      const result = await db.query<SessionUserRow>(
        `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
            u.role, u.is_active, u.tenant_id,
            t.name AS tenant_name, t.is_active AS tenant_active
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
        [userId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    async selectMeUser(userId: string): Promise<MeUserRow | null> {
      const result = await db.query<MeUserRow>(
        `SELECT u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
            u.role, u.tenant_id, u.bio, u.gender, u.country, u.language,
            u.level_of_education, u.year_of_birth,
            t.name AS tenant_name
     FROM users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1`,
        [userId],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    async selectPasswordHash(userId: string): Promise<{ password_hash: string } | null> {
      const result = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [
        userId,
      ]);
      return result.rowCount === 0 ? null : result.rows[0];
    },

    async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    },

    /**
     * Sets the given profile columns (names from the caller's fixed allowlist,
     * in order); null when the user does not exist.
     */
    async updateProfile(userId: string, columns: ReadonlyArray<readonly [string, unknown]>): Promise<ProfileRow | null> {
      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      for (const [column, value] of columns) {
        sets.push(`${column} = $${idx++}`);
        params.push(value);
      }
      params.push(userId);
      const result = await db.query<ProfileRow>(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, username, email, full_name, phone, bio, avatar_url, gender, country, language, level_of_education, year_of_birth`,
        params,
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    // ── Refresh tokens ──

    async insertRefreshToken(token: NewRefreshToken): Promise<void> {
      await db.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, session_mode, session_id)
     VALUES ($1, $2, $3, $4, $5)`,
        [token.userId, token.tokenHash, token.expiresAt, token.sessionMode, token.sessionId],
      );
    },

    /** Locks a refresh token row (FOR UPDATE OF rt) with its user, tenant and session revocation; null when unknown. */
    async lockRefreshTokenRow(tokenHash: string): Promise<RefreshTokenLockRow | null> {
      const result = await db.query<RefreshTokenLockRow>(
        `SELECT rt.id AS rt_id, rt.user_id, rt.revoked, rt.expires_at, rt.revoked_at,
            rt.session_id,
            COALESCE(rt.session_mode, 'normal') AS session_mode,
            u.id, u.username, u.email, u.full_name, u.phone, u.avatar_url,
            u.role, u.is_active, u.tenant_id,
            t.name AS tenant_name, t.is_active AS tenant_active,
            ar.revoked_at AS session_revoked_at
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     LEFT JOIN tenants t ON t.id = u.tenant_id
     LEFT JOIN auth_revocations ar ON ar.user_id = rt.user_id AND ar.expires_at > now()
     WHERE rt.token_hash = $1
     LIMIT 1
     FOR UPDATE OF rt`,
        [tokenHash],
      );
      return result.rowCount === 0 ? null : result.rows[0];
    },

    /** Revokes the live tokens of one superadmin session family (keeps an earlier revoked_at). */
    async revokeSessionFamily(userId: string, sessionId: string): Promise<void> {
      await db.query(
        `UPDATE refresh_tokens
           SET revoked = true, revoked_at = COALESCE(revoked_at, now())
           WHERE user_id = $1 AND session_id = $2 AND revoked = false`,
        [userId, sessionId],
      );
    },

    /** Revokes every live token of the user (keeps an earlier revoked_at). */
    async revokeAllUserRefreshTokens(userId: string): Promise<void> {
      await db.query(
        'UPDATE refresh_tokens SET revoked = true, revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND revoked = false',
        [userId],
      );
    },

    /** Revokes one token row, keeping an earlier revoked_at. */
    async revokeRefreshTokenKeepingTime(refreshTokenId: string): Promise<void> {
      await db.query(
        'UPDATE refresh_tokens SET revoked = true, revoked_at = COALESCE(revoked_at, now()) WHERE id = $1',
        [refreshTokenId],
      );
    },

    /** Revokes one token row at now() (the rotation's grace period starts here). */
    async revokeRefreshTokenNow(refreshTokenId: string): Promise<void> {
      await db.query('UPDATE refresh_tokens SET revoked = true, revoked_at = now() WHERE id = $1', [refreshTokenId]);
    },

    async revokeRefreshTokenByHash(tokenHash: string): Promise<void> {
      await db.query('UPDATE refresh_tokens SET revoked = true, revoked_at = now() WHERE token_hash = $1', [tokenHash]);
    },

    /** Deletes expired tokens and tokens revoked more than a day ago; answers how many. */
    async deleteExpiredRefreshTokens(): Promise<number> {
      const result = await db.query(
        `DELETE FROM refresh_tokens
     WHERE expires_at < now()
        OR (revoked = true AND revoked_at < now() - interval '1 day')`,
      );
      return result.rowCount ?? 0;
    },

    // ── Session context ──

    /** Codes of the active modules, in menu order. */
    async selectActiveModuleCodes(): Promise<{ code: string }[]> {
      const result = await db.query<{ code: string }>('SELECT code FROM modules WHERE is_active = true ORDER BY sort_order');
      return result.rows;
    },

    /** The user's module rights in the tenant: OR over its permission groups of that tenant. */
    async selectPermissionRows(userId: string, tenantId: string | null): Promise<PermissionRow[]> {
      const result = await db.query<PermissionRow>(
        `SELECT m.code,
            bool_or(pgm.can_view) AS can_view,
            bool_or(pgm.can_add) AS can_add,
            bool_or(pgm.can_edit) AS can_edit,
            bool_or(pgm.can_delete) AS can_delete
     FROM user_permission_groups upg
     JOIN permission_group_modules pgm
       ON pgm.permission_group_id = upg.permission_group_id
      AND pgm.tenant_id = upg.tenant_id
     JOIN modules m ON m.id = pgm.module_id
     JOIN permission_groups pg ON pg.id = upg.permission_group_id
     WHERE upg.user_id = $1
       AND upg.tenant_id = $2
       AND pg.tenant_id = $2
     GROUP BY m.code`,
        [userId, tenantId],
      );
      return result.rows;
    },

    /** Codes of the active modules enabled for the tenant, in menu order. */
    async selectTenantModuleCodes(tenantId: string): Promise<{ code: string }[]> {
      const result = await db.query<{ code: string }>(
        `SELECT m.code
     FROM tenant_modules tm
     JOIN modules m ON m.id = tm.module_id
     WHERE tm.tenant_id = $1 AND tm.is_enabled = true AND m.is_active = true
     ORDER BY m.sort_order`,
        [tenantId],
      );
      return result.rows;
    },

    async selectAllActiveTenants(): Promise<IdNameRow[]> {
      const result = await db.query<IdNameRow>('SELECT id, name FROM tenants WHERE is_active = true ORDER BY name ASC');
      return result.rows;
    },

    async selectActiveTenant(tenantId: string): Promise<IdNameRow[]> {
      const result = await db.query<IdNameRow>('SELECT id, name FROM tenants WHERE id = $1 AND is_active = true', [
        tenantId,
      ]);
      return result.rows;
    },

    /** The org groups the user belongs to through team_members → teams → sub_groups → org_groups. */
    async selectMemberGroups(userId: string): Promise<IdNameRow[]> {
      const result = await db.query<IdNameRow>(
        `SELECT DISTINCT og.id, og.name
     FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     JOIN sub_groups sg ON sg.id = t.sub_group_id
     JOIN org_groups og ON og.id = sg.org_group_id
     WHERE tm.user_id = $1
     ORDER BY og.name`,
        [userId],
      );
      return result.rows;
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
