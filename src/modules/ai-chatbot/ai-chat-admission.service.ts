// ═══════════════════════════════════════════════════════════════
// AI chat admission across several API processes
//
// The per-tenant and total limits hold for the whole cluster: each streamed
// answer holds a lease in two Redis sorted sets (the tenant's and the total),
// scored by the lease expiry. Admission adds the lease, then counts: over a
// limit, the lease is removed and the turn refused. Two turns racing for the
// last slot may both be refused, never both admitted. A lease is renewed
// while the answer streams and removed when it ends; a crashed process's
// leases expire after AI_CHAT_ADMISSION_LEASE_MS.
//
// Only plain sorted-set commands are used (the production Redis ACL has no
// MULTI or Lua). When Redis is unavailable, failing or slow, this process
// falls back to its own gate with its share of the limits (limit / API
// processes, rounded up), so the cluster stays near the limits.
// With one API process, chat.controller.ts keeps the in-process gate.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { cacheKey } from '../../config/cache.js';
import { perInstanceShare, type ProcessRolePlan } from '../../config/process-role.js';
import { getRedisClient, withRedisDeadline } from '../../config/redis.js';
import { createConcurrencyGate, type ConcurrencyGate } from './ai-chat-admission.logic.js';

export const AI_CHAT_ADMISSION_LEASE_MS = 60_000;
export const AI_CHAT_ADMISSION_RENEW_MS = 20_000;

/** The sorted-set commands the shared gate uses (injectable for tests). */
export interface AdmissionRedisClient {
  zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number>;
  zAdd(key: string, member: { score: number; value: string }, options?: { condition?: 'XX'; CH?: boolean }): Promise<number>;
  zCard(key: string): Promise<number>;
  zRem(key: string, member: string): Promise<number>;
  pExpire(key: string, milliseconds: number): Promise<unknown>;
}

/** A gate whose admission may need a network round trip. */
export interface AsyncConcurrencyGate {
  /** A release function when a slot was free, else null. Releasing twice is harmless. */
  tryAcquire(key: string): Promise<(() => void) | null>;
}

export interface SharedConcurrencyGateOptions {
  /** Part of the Redis keys. */
  name: string;
  limits: { perKey: number; total: number };
  /** Used while Redis is unavailable (this process's share of the limits). */
  fallback: ConcurrencyGate;
  getClient?: () => AdmissionRedisClient | null;
  /** Runs one Redis command within the command deadline (opens the Redis breaker on failure). */
  deadline?: <T>(label: string, work: Promise<T>) => Promise<T>;
  leaseMs?: number;
  renewMs?: number;
  now?: () => number;
  newToken?: () => string;
  setRepeat?: (callback: () => void, ms: number) => { unref?: () => unknown };
  clearRepeat?: (timer: { unref?: () => unknown }) => void;
  log?: (event: Record<string, unknown>) => void;
}

/** Wraps the in-process gate in the asynchronous interface. */
export function asAsyncGate(gate: ConcurrencyGate): AsyncConcurrencyGate {
  return { tryAcquire: async (key) => gate.tryAcquire(key) };
}

export interface CountedConcurrencyGate extends AsyncConcurrencyGate {
  /** Slots this process holds now, whichever gate admitted them (GET /internal/metrics). */
  active(): number;
}

/** Counts the slots this process holds through `gate` (refusals are not counted). */
export function countActiveSlots(gate: AsyncConcurrencyGate): CountedConcurrencyGate {
  let active = 0;
  return {
    async tryAcquire(key) {
      const release = await gate.tryAcquire(key);
      if (!release) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
        release();
      };
    },
    active: () => active,
  };
}

export function createSharedConcurrencyGate(options: SharedConcurrencyGateOptions): AsyncConcurrencyGate {
  const getClient = options.getClient ?? (() => getRedisClient() as unknown as AdmissionRedisClient | null);
  const deadline = options.deadline ?? (<T>(label: string, work: Promise<T>) => withRedisDeadline(label, work));
  const leaseMs = options.leaseMs ?? AI_CHAT_ADMISSION_LEASE_MS;
  const renewMs = options.renewMs ?? AI_CHAT_ADMISSION_RENEW_MS;
  const now = options.now ?? (() => Date.now());
  const newToken = options.newToken ?? (() => randomUUID());
  const setRepeat = options.setRepeat ?? ((callback, ms) => setInterval(callback, ms));
  const clearRepeat = options.clearRepeat ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const log = options.log ?? ((event) => console.warn(`[AiChatAdmission] ${JSON.stringify(event)}`));
  const totalKey = cacheKey('admission', options.name, 'total');
  const keyFor = (key: string) => cacheKey('admission', options.name, 'key', key);

  const both = <T>(label: string, work: (setKey: string) => Promise<T>, setKeys: readonly string[]) =>
    Promise.all(setKeys.map((setKey) => deadline(label, work(setKey))));

  async function removeLease(client: AdmissionRedisClient, setKeys: readonly string[], token: string): Promise<void> {
    await both('ai chat admission release', (setKey) => client.zRem(setKey, token), setKeys);
  }

  return {
    async tryAcquire(key) {
      const client = getClient();
      if (!client) return options.fallback.tryAcquire(key);
      const setKeys = [keyFor(key), totalKey] as const;
      const token = newToken();
      try {
        const at = now();
        await both('ai chat admission sweep', (setKey) => client.zRemRangeByScore(setKey, '-inf', at), setKeys);
        await both('ai chat admission add', (setKey) => client.zAdd(setKey, { score: at + leaseMs, value: token }), setKeys);
        const [keyCount, totalCount] = await both('ai chat admission count', (setKey) => client.zCard(setKey), setKeys);
        // An idle set disappears on its own.
        await both('ai chat admission expiry', (setKey) => client.pExpire(setKey, leaseMs * 2), setKeys);
        if (keyCount > options.limits.perKey || totalCount > options.limits.total) {
          await removeLease(client, setKeys, token);
          return null;
        }
      } catch (error) {
        // Best effort: a lease left behind expires with its lease time.
        await removeLease(client, setKeys, token).catch(() => undefined);
        log({ event: 'ai_chat_admission_fallback', reason: error instanceof Error ? error.message : String(error) });
        return options.fallback.tryAcquire(key);
      }

      let released = false;
      let lostLogged = false;
      const renew = setRepeat(() => {
        const expiry = now() + leaseMs;
        void Promise.all(setKeys.map(async (setKey) => {
          const changed = await deadline('ai chat admission renew',
            client.zAdd(setKey, { score: expiry, value: token }, { condition: 'XX', CH: true }));
          await deadline('ai chat admission expiry', client.pExpire(setKey, leaseMs * 2));
          if (changed === 0 && !released && !lostLogged) {
            lostLogged = true;
            log({ event: 'ai_chat_admission_lease_lost' });
          }
        })).catch(() => {
          // The lease stays until its expiry; the next renewal tries again.
        });
      }, renewMs);
      renew.unref?.();
      return () => {
        if (released) return;
        released = true;
        clearRepeat(renew);
        void removeLease(client, setKeys, token).catch(() => {
          // Not removed now: it expires with its lease time.
        });
      };
    },
  };
}

/**
 * The chat answer gate of this process: the in-process gate with the full
 * limits when it is the only API process (as before), else the shared gate
 * with this process's share of the limits as its fallback.
 */
export function createChatAnswerGate(
  plan: Pick<ProcessRolePlan, 'severalApiInstances' | 'apiInstances'>,
  limits: { perKey: number; total: number },
  options: Partial<Omit<SharedConcurrencyGateOptions, 'name' | 'limits' | 'fallback'>> = {},
): AsyncConcurrencyGate {
  if (!plan.severalApiInstances) return asAsyncGate(createConcurrencyGate(limits));
  return createSharedConcurrencyGate({
    ...options,
    name: 'ai-chat',
    limits,
    fallback: createConcurrencyGate({
      perKey: perInstanceShare(limits.perKey, plan.apiInstances),
      total: perInstanceShare(limits.total, plan.apiInstances),
    }),
  });
}
