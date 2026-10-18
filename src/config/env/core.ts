// Env: runtime, process role, network binding and proxy trust (part of `env`, see ../env.ts).

import './load.js';
import {
  optionalBoolean,
  optionalBoundedInt,
  optionalCsv,
  optionalNonNegativeInt,
  optionalOneOf,
  optionalString,
  required,
  requiredInt,
} from './helpers.js';

export const coreEnv = {
  NODE_ENV: required('NODE_ENV'),
  PORT: requiredInt('PORT'),
  // Runtime fencing allows a localhost working tree and the always-on DEMO
  // snapshot to share one Supabase project without competing for another
  // runtime's tenant jobs. Empty lists preserve historical behaviour.
  RUNTIME_LANE: optionalString('RUNTIME_LANE', 'default'),
  RUNTIME_TENANT_ALLOWLIST: optionalCsv('RUNTIME_TENANT_ALLOWLIST'),
  RUNTIME_TENANT_DENYLIST: optionalCsv('RUNTIME_TENANT_DENYLIST'),
  RUNTIME_GLOBAL_MAINTENANCE_ENABLED: optionalBoolean('RUNTIME_GLOBAL_MAINTENANCE_ENABLED', true),
  // What this process of dist/index.js runs (config/process-role.ts):
  // 'all' = HTTP and the background work in one process (the default, as
  // before); 'api' = HTTP only (PM2 cluster instances); 'background' = queue
  // consumers, pollers, sweepers and maintenance only (one process).
  LANDA_PROCESS_ROLE: optionalOneOf('LANDA_PROCESS_ROLE', 'all', ['all', 'api', 'background'] as const),
  // Number of 'api' processes PM2 runs (ecosystem.config.cjs passes the same
  // value it uses for `instances`). Above 1, request limits and short-lived
  // request state are shared through Redis.
  LANDA_API_INSTANCES: optionalBoundedInt('LANDA_API_INSTANCES', 1, 1, 64),
  // Existing direct deployments retain the default. Behind Nginx, bind to
  // 127.0.0.1 so the API cannot bypass the gateway on a LAN/public interface.
  BIND_HOST: optionalString('BIND_HOST', '0.0.0.0'),
  TRUST_PROXY_HOPS: optionalNonNegativeInt('TRUST_PROXY_HOPS', 0),
  // Exact proxy CIDR allowlist. When configured it takes precedence over the
  // legacy hop count so a direct caller cannot spoof X-Forwarded-For.
  // Entries: IPs/CIDRs or the keywords loopback, linklocal, uniquelocal.
  // Production: loopback + the Cloudflare ranges (+ the gateway's own address).
  TRUSTED_PROXY_CIDRS: optionalCsv('TRUSTED_PROXY_CIDRS'),
} as const;
