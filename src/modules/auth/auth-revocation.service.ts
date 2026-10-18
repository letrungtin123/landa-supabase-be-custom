import { randomUUID } from 'crypto';
import { query } from '../../config/database.js';
import { env } from '../../config/env.js';
import { getRedisClient, isRedisConfigured, markRedisUnhealthy, redisConnectionEpoch, withRedisDeadline } from '../../config/redis.js';
import { parseExpiresIn } from '../../utils/jwt.js';
import { clusterBus } from '../../config/cluster-bus.js';

const REVOCATION_KEY_PREFIX = 'auth:revoked:';
/** Clock-skew margin on top of the access-token lifetime when copying recent revocations. */
const MIRROR_WINDOW_MARGIN_MS = 120_000;
const MIRROR_RESYNC_MIN_INTERVAL_MS = 2_000;
const MIRROR_RESYNC_BATCH_SIZE = 100;
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

// ── Trust in the Redis copy ──
// Redis answers "not revoked" only for revocations it holds. The copy is
// trusted only after this process has copied, from the database, every
// revocation that can still refuse an access token (those younger than the
// access-token lifetime), and only while no later copy has failed or been
// skipped. Otherwise (and while Redis is unhealthy) the durable row decides,
// so a revoked session is never accepted because Redis missed it.
let trustedEpoch: number | null = null;
let mirrorGeneration = 0;
let mirrorCopiesStarted = 0;
let mirrorCopiesInFlight = 0;
let resyncInFlight: Promise<boolean> | null = null;
let lastResyncAttemptAt = 0;

/** A revocation could not be copied to Redis: stop trusting the copy until a full resync. */
function markRevocationMirrorStale(): void {
  if (!isRedisConfigured()) return;
  trustedEpoch = null;
  mirrorGeneration += 1;
}

// ── Several processes ──
// Each process copies the revocations it records. Another process may fail
// that copy (its Redis breaker open), so every recorded revocation is also
// announced on the cluster bus and every process copies it from the
// database; a process whose own copy fails stops trusting Redis. While this
// process's bus listener is down it could miss an announcement, so the copy
// is not trusted then, and is resynced once the listener is back.
const REVOCATION_EVENT = 'auth.revocation';
clusterBus.onReset(() => markRevocationMirrorStale());
clusterBus.on(REVOCATION_EVENT, async (payload) => {
  if (typeof payload.user_id === 'string') await copyDatabaseRevocationToRedis(payload.user_id);
});

/** Whether isAccessTokenRevoked may currently answer from Redis (diagnostics and tests). */
export function isAccessRevocationMirrorTrusted(): boolean {
  return trustedEpoch !== null && trustedEpoch === redisConnectionEpoch() && clusterBus.isHealthy();
}

function revocationValue(row: { reason: string; revoked_at: Date }): string {
  return row.reason === PERMANENT_DELETION_REASON ? FULL_REVOCATION_VALUE : String(new Date(row.revoked_at).getTime());
}

function revocationTtlSeconds(expiresAt: Date): number {
  return Math.max(1, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

/**
 * Copies every revocation that can still refuse an access token from the
 * database to Redis, then trusts the copy, unless a single-user copy started
 * or failed meanwhile (that copy could carry an older value). Single-flight
 * and throttled; returns whether the copy is trusted afterwards.
 */
export function resyncAccessRevocationMirror(): Promise<boolean> {
  if (isAccessRevocationMirrorTrusted()) return Promise.resolve(true);
  if (resyncInFlight) return resyncInFlight;
  const now = Date.now();
  // A clock that moved backwards (NTP) never blocks the resync.
  if (now >= lastResyncAttemptAt && now - lastResyncAttemptAt < MIRROR_RESYNC_MIN_INTERVAL_MS) return Promise.resolve(false);
  lastResyncAttemptAt = now;
  resyncInFlight = (async () => {
    const client = getRedisClient();
    if (!client || mirrorCopiesInFlight > 0) return false;
    const epoch = redisConnectionEpoch();
    const generation = mirrorGeneration;
    const copiesStarted = mirrorCopiesStarted;
    const windowMs = parseExpiresIn(env.JWT_ACCESS_EXPIRES_IN) + MIRROR_WINDOW_MARGIN_MS;
    const result = await query<{ user_id: string; reason: string; revoked_at: Date; expires_at: Date }>(
      `SELECT user_id::text AS user_id, reason, revoked_at, expires_at
       FROM auth_revocations
       WHERE expires_at > now()
         AND revoked_at > now() - ($1::bigint * interval '1 millisecond')`,
      [windowMs],
    );
    for (let index = 0; index < result.rows.length; index += MIRROR_RESYNC_BATCH_SIZE) {
      await Promise.all(result.rows.slice(index, index + MIRROR_RESYNC_BATCH_SIZE).map((row) => withRedisDeadline(
        'access revocation resync',
        client.set(revocationKey(row.user_id), revocationValue(row), { EX: revocationTtlSeconds(row.expires_at) }),
      )));
    }
    if (epoch !== redisConnectionEpoch() || generation !== mirrorGeneration
      || copiesStarted !== mirrorCopiesStarted || mirrorCopiesInFlight > 0) return false;
    trustedEpoch = epoch;
    return true;
  })().catch(() => false).finally(() => { resyncInFlight = null; });
  return resyncInFlight;
}

/** Writes one user's revocation to Redis; any skipped or failed write makes the copy untrusted. */
async function copyRevocationToRedis(
  userId: string,
  read: () => Promise<{ value: string; ttlSeconds: number } | null>,
): Promise<void> {
  if (!isRedisConfigured()) return;
  const client = getRedisClient();
  if (!client) {
    markRevocationMirrorStale();
    return;
  }
  mirrorCopiesStarted += 1;
  mirrorCopiesInFlight += 1;
  try {
    const entry = await read();
    if (!entry) return;
    try {
      await withRedisDeadline('access revocation write', client.set(revocationKey(userId), entry.value, { EX: entry.ttlSeconds }));
    } catch {
      markRevocationMirrorStale();
    }
  } finally {
    mirrorCopiesInFlight -= 1;
  }
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
    markRedisUnhealthy(`Redis access-token revocation capability check failed: ${reason}`);
    throw new Error('Redis must permit GET and SET on auth:revoked:* when production revocation enforcement is enabled');
  } finally {
    await client.del(probeKey).catch(() => undefined); // the probe key expires after 15 s anyway
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
  await copyDatabaseRevocationToRedis(userId);
  await clusterBus.publish(REVOCATION_EVENT, { user_id: userId });
}

async function copyDatabaseRevocationToRedis(userId: string): Promise<void> {
  await copyRevocationToRedis(userId, async () => {
    const result = await query<{ reason: string; revoked_at: Date; expires_at: Date }>(
      `SELECT reason, revoked_at, expires_at
       FROM auth_revocations
       WHERE user_id = $1::uuid AND expires_at > now()`,
      [userId],
    );
    const row = result.rows[0];
    return row ? { value: revocationValue(row), ttlSeconds: revocationTtlSeconds(row.expires_at) } : null;
  });
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
  if (client && isAccessRevocationMirrorTrusted()) {
    let value: string | null | undefined;
    try {
      value = await withRedisDeadline('access revocation read', client.get(revocationKey(userId)));
    } catch {
      // The breaker is open now; the durable row below decides.
      value = undefined;
    }
    if (value === null) return false;
    if (value === FULL_REVOCATION_VALUE) return true;
    if (value !== undefined) {
      const revokedAtMs = Number(value);
      // An unreadable value fails closed.
      if (!Number.isFinite(revokedAtMs)) return true;
      return isRevokedForIssuedAt({ full: false, revokedAtMs }, issuedAtSeconds);
    }
  } else if (client && clusterBus.isHealthy()) {
    // Redis is back (or new to this process): copy the recent revocations in
    // the background; this request uses the database.
    void resyncAccessRevocationMirror();
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
  await copyRevocationToRedis(userId, async () => ({ value: FULL_REVOCATION_VALUE, ttlSeconds: revocationTtlSeconds(expiresAt) }));
  // The other processes copy the committed row (permanent deletion -> full revocation).
  await clusterBus.publish(REVOCATION_EVENT, { user_id: userId });
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
