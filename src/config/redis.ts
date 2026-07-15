import { createClient, type RedisClientType } from '@redis/client';
import { env } from './env.js';

let redisClient: RedisClientType | null = null;
let redisDisabledForProcess = false;

function maskRedisUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<invalid redis url>';
  }
}

export async function connectRedis(): Promise<void> {
  redisDisabledForProcess = false;
  if (!env.REDIS_URL) {
    console.log('[Redis] Disabled: REDIS_URL is not configured');
    return;
  }

  const client = createClient({
    url: env.REDIS_URL,
    socket: {
      connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy(retries) {
        if (retries > 5) return false;
        return Math.min(retries * 200, 2_000);
      },
    },
  });

  client.on('error', (err) => {
    console.warn('[Redis] Runtime error:', err instanceof Error ? err.message : String(err));
  });

  try {
    await client.connect();
    await client.ping();
    redisClient = client as RedisClientType;
    console.log(`[Redis] Connected: ${maskRedisUrl(env.REDIS_URL)}`);
  } catch (err) {
    redisClient = null;
    try {
      await client.destroy();
    } catch {
      // ignore cleanup error
    }
    console.warn('[Redis] Connect failed; backend will continue with DB fallback:', err instanceof Error ? err.message : String(err));
  }
}

export function getRedisClient(): RedisClientType | null {
  if (redisDisabledForProcess) return null;
  if (!redisClient || !redisClient.isOpen || !redisClient.isReady) return null;
  return redisClient;
}

export function disableRedisForProcess(reason: string): void {
  if (redisDisabledForProcess) return;
  redisDisabledForProcess = true;
  const client = redisClient;
  redisClient = null;
  console.warn(`[Redis] Disabled for current process; using DB fallback. Reason: ${reason}`);
  if (client?.isOpen) {
    try {
      client.destroy();
    } catch {
      // ignore cleanup error
    }
  }
}

export async function closeRedis(): Promise<void> {
  if (!redisClient) return;
  const client = redisClient;
  redisClient = null;
  if (!client.isOpen) return;
  try {
    await client.quit();
  } catch {
    client.destroy();
  }
}
