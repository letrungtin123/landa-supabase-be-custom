// ═══════════════════════════════════════════════════════════════
// Tenant of a sign-in origin: per-process cache
//
// Login refuses an account of another tenant on a tenant's own domain; the
// tenant of the origin is looked up in `tenants`. The origin is chosen by the
// client (body or Origin header), so the cache in front of that lookup:
// - holds at most `maxEntries` origins, the least recently used dropped first;
// - keeps a tenant for `hitTtlMs`, and "no tenant" only for `missTtlMs`, so a
//   domain set on a tenant later applies without a restart;
// - never keeps an origin longer than MAX_CACHED_ORIGIN_LENGTH or that is not
//   exactly a URL origin (scheme://host[:port]): those are looked up each time.
// It only saves repeated lookups: the answer is always the lookup's.
// ═══════════════════════════════════════════════════════════════

export const MAX_CACHED_ORIGIN_LENGTH = 255;

export interface OriginTenant {
  id: string;
}

export interface OriginTenantCacheOptions {
  maxEntries: number;
  hitTtlMs: number;
  missTtlMs: number;
  now?: () => number;
}

export interface OriginTenantCache {
  /** The cached answer (null: no tenant); undefined when the origin is not cached or expired. */
  get(origin: string): OriginTenant | null | undefined;
  /** Keeps the lookup's answer when the origin may be cached. */
  set(origin: string, tenant: OriginTenant | null): void;
  readonly size: number;
}

/** Whether `origin` may be a cache key: at most MAX_CACHED_ORIGIN_LENGTH characters and exactly a URL origin. */
export function isCacheableOrigin(origin: string): boolean {
  if (!origin || origin.length > MAX_CACHED_ORIGIN_LENGTH) return false;
  try {
    return new URL(origin).origin === origin;
  } catch {
    return false;
  }
}

export function createOriginTenantCache(options: OriginTenantCacheOptions): OriginTenantCache {
  const now = options.now ?? (() => Date.now());
  // A Map iterates in insertion order: a read re-inserts its entry, so the first key is the least recently used.
  const entries = new Map<string, { tenant: OriginTenant | null; expires: number }>();

  return {
    get(origin) {
      const entry = entries.get(origin);
      if (!entry) return undefined;
      entries.delete(origin);
      if (entry.expires <= now()) return undefined;
      entries.set(origin, entry);
      return entry.tenant;
    },
    set(origin, tenant) {
      if (!isCacheableOrigin(origin)) return;
      entries.delete(origin);
      entries.set(origin, {
        tenant: tenant ? { id: tenant.id } : null,
        expires: now() + (tenant ? options.hitTtlMs : options.missTtlMs),
      });
      while (entries.size > options.maxEntries) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
