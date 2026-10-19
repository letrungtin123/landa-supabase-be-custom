// ═══════════════════════════════════════════════════════════════
// Auth revocation repository: the durable per-user revocation row
// (auth_revocations) and the refresh tokens it ends. SQL only; moved
// unchanged from auth-revocation.service.ts, which keeps the rules (what a
// row refuses, the Redis mirror and when it is trusted, the cluster bus).
// ═══════════════════════════════════════════════════════════════

import type { QueryResult, QueryResultRow } from 'pg';

/** The pool query() (joins the current transaction) or a transaction client. */
export interface AuthRevocationDb {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface RevocationRow {
  reason: string;
  revoked_at: Date;
}

export interface LiveRevocationRow extends RevocationRow {
  expires_at: Date;
}

export interface RecentRevocationRow extends LiveRevocationRow {
  user_id: string;
}

export interface SessionRevocationValues {
  userId: string;
  revokedAt: Date;
  expiresAt: Date;
  reason: string;
  /** A row with this reason (a pending permanent deletion) is never overwritten. */
  protectedReason: string;
}

export function createAuthRevocationRepository(db: AuthRevocationDb) {
  return {
    /** Live revocations recorded within the last `windowMs` milliseconds. */
    async selectRecentRevocations(windowMs: number): Promise<RecentRevocationRow[]> {
      const result = await db.query<RecentRevocationRow>(
        `SELECT user_id::text AS user_id, reason, revoked_at, expires_at
       FROM auth_revocations
       WHERE expires_at > now()
         AND revoked_at > now() - ($1::bigint * interval '1 millisecond')`,
        [windowMs],
      );
      return result.rows;
    },

    /** Records (or moves later) the user's revocation instant, unless the row has the protected reason. */
    async upsertSessionRevocation(values: SessionRevocationValues): Promise<void> {
      await db.query(
        `INSERT INTO auth_revocations (user_id, revoked_at, expires_at, reason)
     VALUES ($1::uuid, $2::timestamptz, $3::timestamptz, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET revoked_at = GREATEST(auth_revocations.revoked_at, EXCLUDED.revoked_at),
           expires_at = GREATEST(auth_revocations.expires_at, EXCLUDED.expires_at),
           reason = EXCLUDED.reason
       WHERE auth_revocations.reason <> $5`,
        [values.userId, values.revokedAt, values.expiresAt, values.reason, values.protectedReason],
      );
    },

    /** Revokes every live refresh token of the user with revoked_at = `revokedAt`. */
    async revokeUserRefreshTokensAt(userId: string, revokedAt: Date): Promise<void> {
      await db.query(
        `UPDATE refresh_tokens
     SET revoked = true, revoked_at = $2::timestamptz
     WHERE user_id = $1::uuid AND revoked = false`,
        [userId, revokedAt],
      );
    },

    /** The user's live revocation with its expiry, for the Redis copy; undefined when there is none. */
    async selectLiveRevocation(userId: string): Promise<LiveRevocationRow | undefined> {
      const result = await db.query<LiveRevocationRow>(
        `SELECT reason, revoked_at, expires_at
       FROM auth_revocations
       WHERE user_id = $1::uuid AND expires_at > now()`,
        [userId],
      );
      return result.rows[0];
    },

    /** The user's live revocation, as an access-token check reads it; undefined when there is none. */
    async selectLiveRevocationForCheck(userId: string): Promise<RevocationRow | undefined> {
      const result = await db.query<RevocationRow>(
        `SELECT reason, revoked_at
     FROM auth_revocations
     WHERE user_id = $1::uuid AND expires_at > now()`,
        [userId],
      );
      return result.rows[0];
    },

    /** Deletes at most `limit` expired rows, oldest expiry first; answers how many. */
    async deleteExpiredRevocations(limit: number): Promise<number> {
      const result = await db.query(
        `WITH doomed AS (
       SELECT user_id
       FROM auth_revocations
       WHERE expires_at <= now()
       ORDER BY expires_at ASC
       LIMIT $1::int
     )
     DELETE FROM auth_revocations revocation
     USING doomed
     WHERE revocation.user_id = doomed.user_id`,
        [limit],
      );
      return result.rowCount || 0;
    },
  };
}
