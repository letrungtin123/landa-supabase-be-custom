// ═══════════════════════════════════════════════════════════════
// AI chat admission — how many chat answers this process streams at once
//
// Per tenant and in total. A turn that does not fit is refused at once with
// 429 AI_BUSY (no queue: a waiting browser holds a connection and the
// provider is usually the reason it is busy). The limits are per API
// process; with several processes the totals add up.
// ═══════════════════════════════════════════════════════════════

export const AI_BUSY_CODE = 'AI_BUSY';
/** Seconds the client is asked to wait before trying again (Retry-After). */
export const AI_BUSY_RETRY_AFTER_SECONDS = 30;

/** [HTTP status, Vietnamese, English]. */
export const AI_BUSY_ERROR = [
  429,
  'Trợ lý AI đang bận, vui lòng thử lại sau ít phút.',
  'The AI assistant is busy. Please try again in a few minutes.',
] as const;

export interface ConcurrencyGate {
  /** A release function when a slot was free, else null. Releasing twice is harmless. */
  tryAcquire(key: string): (() => void) | null;
  active(key?: string): number;
}

export function createConcurrencyGate(limits: { perKey: number; total: number }): ConcurrencyGate {
  const perKey = new Map<string, number>();
  let total = 0;
  return {
    tryAcquire(key) {
      const current = perKey.get(key) ?? 0;
      if (total >= limits.total || current >= limits.perKey) return null;
      perKey.set(key, current + 1);
      total += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total -= 1;
        const left = (perKey.get(key) ?? 1) - 1;
        if (left > 0) perKey.set(key, left); else perKey.delete(key);
      };
    },
    active(key) {
      return key === undefined ? total : perKey.get(key) ?? 0;
    },
  };
}
