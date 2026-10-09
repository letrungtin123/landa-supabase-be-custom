import { randomUUID } from 'crypto';
import { query } from '../../config/database.js';
import { env } from '../../config/env.js';
import { disableRedisForProcess, getRedisClient } from '../../config/redis.js';
import { parseExpiresIn } from '../../utils/jwt.js';

const REVOCATION_KEY_PREFIX = 'auth:revoked:';
/** Full revocation (account deletion): every token of the user is refused. */
const PERMANENT_DELETION_REASON = 'permanent_user_deletion';
const FULL_REVOCATION_VALUE = '1';

/**
 * Why every session of a user ended at one instant. Unlike deletion, these
 * only refuse access tokens issued BEFORE that instant (JWT `iat`), so the
 * user can sign in again (or keep the fresh session issued on a self-service
 * password change).
 */
export type SessionRevocationReason =
  | 'password_changed'
  | 'password_reset_by_admin'
  | 'account_deactivated'
  | 'role_changed';

function revocationKey(userId: string): string {
  return `${REVOCATION_KEY_PREFIX}${userId}`;
}

/**
 * A successful PING only proves that Redis accepted a connection. Production
 * deployments that require Redis for revocation must also prove the exact
 * keyspace commands used by the fast path before accepting traffic.
 */
export async function assertAuthRevocationRedisReady(): Promise<void> {
  const client = getRedisClient();
  if (!client) throw new Error('Redis is unavailable for access-token revocation');

  const probeKey = `${REVOCATION_KEY_PREFIX}__capability_probe__:${randomUUID()}`;
  try {
    await client.set(probeKey, '1', { EX: 15 });
    const value = await client.get(probeKey);
    if (value !== '1') throw new Error('Redis revocation capability probe returned an unexpected value');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    disableRedisForProcess(`Redis access-token revocation capability check failed: ${reason}`);
    throw new Error('Redis must permit GET and SET on auth:revoked:* when production revocation enforcement is enabled');
  } finally {
    await client.del(probeKey).catch(() => undefined);
  }
}

/**
 * Ends every session of a user inside the caller's transaction:
 *   - all refresh tokens are revoked with revoked_at = the revocation instant;
 *   - auth_revocations records that instant, so access tokens issued before
 *     it are refused (see isAccessTokenRevoked).
 * The row lives as long as a refresh token issued before it could, so a late
 * reuse of one of those tokens is recognised as "session ended" and does not
 * trigger the reuse-detection revoke of newer sessions. A pending permanent
 * deletion is never downgraded. Call syncUserAccessRevocationCache() after
 * COMMIT.
 */
export async function recordUserSessionRevocation(userId: string, reason: SessionRevocationReason): Promise<Date> {
  const revokedAt = new Date();
  const expiresAt = new Date(revokedAt.getTime() + parseExpiresIn(env.JWT_REFRESH_EXPIRES_IN) + 60_000);
  await query(
    `INSERT INTO auth_revocations (user_id, revoked_at, expires_at, reason)
     VALUES ($1::uuid, $2::timestamptz, $3::timestamptz, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET revoked_at = GREATEST(auth_revocations.revoked_at, EXCLUDED.revoked_at),
           expires_at = GREATEST(auth_revocations.expires_at, EXCLUDED.expires_at),
           reason = EXCLUDED.reason
       WHERE auth_revocations.reason <> $5`,
    [userId, revokedAt, expiresAt, reason, PERMANENT_DELETION_REASON],
  );
  await query(
    `UPDATE refresh_tokens
     SET revoked = true, revoked_at = $2::timestamptz
     WHERE user_id = $1::uuid AND revoked = false`,
    [userId, revokedAt],
  );
  return revokedAt;
}

/**
 * Mirrors the durable row into the Redis fast path after COMMIT: `1` for a
 * permanent deletion, otherwise the revocation instant in ms. Reading the row
 * (not a value from the request) keeps the cache equal to what committed.
 */
export async function syncUserAccessRevocationCache(userId: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  const result = await query<{ reason: string; revoked_at: Date; expires_at: Date }>(
    `SELECT reason, revoked_at, expires_at
     FROM auth_revocations
     WHERE user_id = $1::uuid AND expires_at > now()`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return;
  const ttlSeconds = Math.max(1, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 1000));
  const value = row.reason === PERMANENT_DELETION_REASON ? FULL_REVOCATION_VALUE : String(new Date(row.revoked_at).getTime());
  try {
    await client.set(revocationKey(userId), value, { EX: ttlSeconds });
  } catch (error) {
    disableRedisForProcess(`Could not cache access revocation: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Pure decision shared by the Redis and database paths. */
export function isRevokedForIssuedAt(revocation: { full: boolean; revokedAtMs: number } | null, issuedAtSeconds: number | undefined): boolean {
  if (!revocation) return false;
  if (revocation.full) return true;
  // JWT iat has second precision; a token issued in the revocation's second
  // (e.g. the fresh session after a password change) stays valid.
  const issuedAt = typeof issuedAtSeconds === 'number' && Number.isFinite(issuedAtSeconds) ? issuedAtSeconds : 0;
  return issuedAt < Math.floor(revocation.revokedAtMs / 1000);
}

/**
 * Whether an access token (user + iat) was revoked: by a permanent deletion
 * (always) or by a session revocation after it was issued. Redis is the fast
 * path; without Redis the durable row decides.
 */
export async function isAccessTokenRevoked(userId: string, issuedAtSeconds: number | undefined): Promise<boolean> {
  const client = getRedisClient();
  if (client) {
    try {
      const value = await client.get(revocationKey(userId));
      if (value === null) return false;
      if (value === FULL_REVOCATION_VALUE) return true;
      const revokedAtMs = Number(value);
      // An unreadable value fails closed.
      if (!Number.isFinite(revokedAtMs)) return true;
      return isRevokedForIssuedAt({ full: false, revokedAtMs }, issuedAtSeconds);
    } catch (error) {
      disableRedisForProcess(`Could not read access revocation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const result = await query<{ reason: string; revoked_at: Date }>(
    `SELECT reason, revoked_at
     FROM auth_revocations
     WHERE user_id = $1::uuid AND expires_at > now()`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return false;
  return isRevokedForIssuedAt(
    { full: row.reason === PERMANENT_DELETION_REASON, revokedAtMs: new Date(row.revoked_at).getTime() },
    issuedAtSeconds,
  );
}

/** Cache a durable database revocation after the transaction commits. */
export async function cacheUserAccessRevocation(userId: string, expiresAt: Date): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  const ttlSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  try {
    await client.set(revocationKey(userId), '1', { EX: ttlSeconds });
  } catch (error) {
    disableRedisForProcess(`Could not cache access revocation: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Bounded retention cleanup; never scan/delete an unbounded production table. */
export async function cleanupExpiredAuthRevocations(limit = 10_000): Promise<number> {
  const result = await query(
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
}
