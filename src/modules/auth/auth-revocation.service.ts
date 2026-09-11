import { randomUUID } from 'crypto';
import { query } from '../../config/database.js';
import { disableRedisForProcess, getRedisClient } from '../../config/redis.js';

const REVOCATION_KEY_PREFIX = 'auth:revoked:';

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

/**
 * Redis is only a fast path. If it is unavailable, the durable revocation row
 * is checked so a deleted user can never regain access because of a cache miss.
 */
export async function isUserAccessRevoked(userId: string): Promise<boolean> {
  const client = getRedisClient();
  if (client) {
    try {
      return (await client.get(revocationKey(userId))) === '1';
    } catch (error) {
      disableRedisForProcess(`Could not read access revocation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const result = await query<{ revoked: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM auth_revocations
       WHERE user_id = $1::uuid AND expires_at > now()
     ) AS revoked`,
    [userId],
  );
  return Boolean(result.rows[0]?.revoked);
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
