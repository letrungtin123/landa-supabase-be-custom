import { env } from './env.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizedTenantSet(values: readonly string[], label: string): ReadonlySet<string> {
  const result = new Set<string>();
  for (const raw of values) {
    const value = raw.trim().toLowerCase();
    if (!UUID.test(value)) throw new Error(`[ENV] ${label} contains an invalid tenant UUID`);
    result.add(value);
  }
  return result;
}

export type RuntimeTenantSql = { clause: string; params: unknown[] };

export function createRuntimeTenantFence(allowedValues: readonly string[], deniedValues: readonly string[]) {
  const allowedTenants = normalizedTenantSet(allowedValues, 'RUNTIME_TENANT_ALLOWLIST');
  const deniedTenants = normalizedTenantSet(deniedValues, 'RUNTIME_TENANT_DENYLIST');

  for (const tenantId of allowedTenants) {
    if (deniedTenants.has(tenantId)) {
      throw new Error('[ENV] Runtime tenant allowlist and denylist must not overlap');
    }
  }

  return {
    isAllowed(tenantId: string | null | undefined): boolean {
      if (!tenantId) return allowedTenants.size === 0;
      const normalized = tenantId.trim().toLowerCase();
      if (!UUID.test(normalized)) return false;
      if (deniedTenants.has(normalized)) return false;
      return allowedTenants.size === 0 || allowedTenants.has(normalized);
    },
    allowlist(): readonly string[] {
      return [...allowedTenants];
    },
    sql(column: string, firstParameter: number): RuntimeTenantSql {
      if (!/^[a-z_][a-z0-9_.]*$/i.test(column)) throw new Error('Invalid runtime tenant SQL column');
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (allowedTenants.size > 0) {
        clauses.push(`${column} = ANY($${firstParameter + params.length}::uuid[])`);
        params.push([...allowedTenants]);
      }
      if (deniedTenants.size > 0) {
        clauses.push(`NOT (${column} = ANY($${firstParameter + params.length}::uuid[]))`);
        params.push([...deniedTenants]);
      }
      return { clause: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', params };
    },
    counts(): { allowed: number; denied: number } {
      return { allowed: allowedTenants.size, denied: deniedTenants.size };
    },
  };
}

const runtimeFence = createRuntimeTenantFence(env.RUNTIME_TENANT_ALLOWLIST, env.RUNTIME_TENANT_DENYLIST);

export function isRuntimeTenantAllowed(tenantId: string | null | undefined): boolean {
  return runtimeFence.isAllowed(tenantId);
}

export function runtimeTenantAllowlist(): readonly string[] {
  return runtimeFence.allowlist();
}

/** Build a parameterized tenant predicate for durable-worker claim queries. */
export function runtimeTenantSql(column: string, firstParameter: number): RuntimeTenantSql {
  return runtimeFence.sql(column, firstParameter);
}

export function runtimeTenantDiagnostics(): Record<string, unknown> {
  const counts = runtimeFence.counts();
  return {
    runtime_lane: env.RUNTIME_LANE,
    tenant_allowlist_count: counts.allowed,
    tenant_denylist_count: counts.denied,
  };
}
