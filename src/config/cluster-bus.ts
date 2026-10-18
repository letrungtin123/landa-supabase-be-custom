// ═══════════════════════════════════════════════════════════════
// Cluster bus — cache invalidations between the processes of one deployment
//
// PostgreSQL LISTEN/NOTIFY on one channel. The database is already the source
// of truth, every process can reach it, and the production Redis ACL allows
// neither PUBLISH/SUBSCRIBE nor Lua, so Redis pub/sub is not an option.
// - publish() sends after the surrounding transaction commits (dropped on
//   rollback) and never fails the caller; the sender applies its own change
//   directly, so its own messages are ignored when they come back.
// - Each process holds one listening connection from its pool. While it is
//   down, in-process caches keep values at most CLUSTER_BUS_DEGRADED_CACHE_TTL_MS
//   (cacheTtlMs) and isHealthy() is false; when it is lost and again when it
//   is back, onReset() handlers drop what may have missed an invalidation.
// - Disabled (a single 'all' process): publish is a no-op, isHealthy() is
//   true and caches keep their normal lifetime.
// ═══════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';
import { afterCommit, getSessionClient, pool } from './database.js';
import { processRolePlan } from './process-role.js';
import { listenRetryDelayMs } from '../modules/ai-chatbot/lesson-author-listen-retry.logic.js';

export const CLUSTER_BUS_CHANNEL = 'landa_cluster_bus';
/** PostgreSQL refuses NOTIFY payloads of 8000 bytes or more. */
export const CLUSTER_BUS_MAX_PAYLOAD_BYTES = 7_900;
/** While the listener is down, in-process caches keep values at most this long. */
export const CLUSTER_BUS_DEGRADED_CACHE_TTL_MS = 5_000;
/** How often the listening connection proves it is still alive. */
export const CLUSTER_BUS_PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

export type ClusterBusPayload = Record<string, unknown>;
type Handler = (payload: ClusterBusPayload) => void | Promise<void>;

interface Timer { unref?: () => unknown }

/** The subset of a pg PoolClient the listener needs (injectable for tests). */
export interface ClusterBusListenClient {
  query(text: string): Promise<unknown>;
  on(event: 'notification', listener: (message: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  release(error?: Error): void;
}

export interface ClusterBusOptions {
  enabled: boolean;
  acquire: () => Promise<ClusterBusListenClient>;
  notify: (channel: string, payload: string) => Promise<unknown>;
  /** Runs a publish after the surrounding transaction commits (config/database afterCommit). */
  afterCommit?: (work: () => Promise<void>) => Promise<void>;
  originId?: string;
  retryDelayMs?: (failures: number) => number;
  probeIntervalMs?: number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  setRepeat?: (callback: () => void, ms: number) => Timer;
  clearRepeat?: (timer: Timer) => void;
  log?: (event: Record<string, unknown>) => void;
  info?: (message: string) => void;
}

export interface ClusterBus {
  readonly enabled: boolean;
  /** Starts listening (first attempt awaited, later ones in the background). */
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Tells the other processes; never throws. Inside a transaction it is sent
   * after COMMIT (dropped on rollback) unless `immediate` is set.
   */
  publish(kind: string, payload: ClusterBusPayload, options?: { immediate?: boolean }): Promise<void>;
  /** Handles messages of `kind` from the other processes. Returns the unsubscribe. */
  on(kind: string, handler: Handler): () => void;
  /** Runs when the listener is lost and when it is back (invalidations may have been missed). */
  onReset(handler: () => void): () => void;
  /** False while invalidations from other processes may be missed. */
  isHealthy(): boolean;
  /** `normalTtlMs`, or the short degraded lifetime while the listener is down. */
  cacheTtlMs(normalTtlMs: number): number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`cluster bus probe took longer than ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createClusterBus(options: ClusterBusOptions): ClusterBus {
  const origin = options.originId ?? randomUUID();
  const log = options.log ?? ((event) => console.warn(`[ClusterBus] ${JSON.stringify(event)}`));
  const info = options.info ?? ((message) => console.log(`[ClusterBus] ${message}`));
  const retryDelay = options.retryDelayMs ?? ((failures: number) => listenRetryDelayMs(failures));
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  const setRepeat = options.setRepeat ?? ((callback, ms) => setInterval(callback, ms));
  const clearRepeat = options.clearRepeat ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const probeIntervalMs = options.probeIntervalMs ?? CLUSTER_BUS_PROBE_INTERVAL_MS;
  const defer = options.afterCommit ?? (async (work: () => Promise<void>) => { await work(); });
  const handlers = new Map<string, Set<Handler>>();
  const resetHandlers = new Set<() => void>();
  let connection: { client: ClusterBusListenClient; release: (error?: Error) => void } | null = null;
  let connecting: Promise<void> | null = null;
  let healthy = false;
  let started = false;
  let stopped = false;
  let failures = 0;
  let retryTimer: Timer | null = null;
  let probeTimer: Timer | null = null;

  function runResetHandlers(): void {
    for (const handler of [...resetHandlers]) {
      try { handler(); } catch (error) {
        log({ event: 'cluster_bus_reset_handler_failed', reason: errorText(error) });
      }
    }
  }

  function deliver(raw: string | undefined): void {
    let message: { o?: unknown; k?: unknown; p?: unknown };
    try { message = JSON.parse(raw ?? '') as typeof message; } catch {
      log({ event: 'cluster_bus_message_invalid' });
      return;
    }
    if (!message || message.o === origin || typeof message.k !== 'string'
      || !message.p || typeof message.p !== 'object' || Array.isArray(message.p)) return;
    const kind = message.k;
    const payload = message.p as ClusterBusPayload;
    for (const handler of handlers.get(kind) ?? []) {
      Promise.resolve().then(() => handler(payload)).catch((error: unknown) => {
        log({ event: 'cluster_bus_handler_failed', kind, reason: errorText(error) });
      });
    }
  }

  function scheduleConnect(): void {
    if (stopped || retryTimer) return;
    const timer = setTimer(() => { retryTimer = null; void connect(); }, retryDelay(failures));
    timer.unref?.();
    retryTimer = timer;
  }

  function stopProbe(): void {
    if (probeTimer) clearRepeat(probeTimer);
    probeTimer = null;
  }

  function lose(reason: string): void {
    connection = null;
    stopProbe();
    failures += 1;
    if (healthy) {
      healthy = false;
      log({ event: 'cluster_bus_unavailable', reason, degraded_cache_ttl_ms: CLUSTER_BUS_DEGRADED_CACHE_TTL_MS });
      runResetHandlers();
    }
    scheduleConnect();
  }

  function startProbe(client: ClusterBusListenClient, release: (error?: Error) => void): void {
    stopProbe();
    const timer = setRepeat(() => {
      withTimeout(client.query('SELECT 1'), PROBE_TIMEOUT_MS).catch((error: unknown) => {
        if (connection?.client !== client) return;
        // The socket may be half-open: close it, the pool discards it.
        release(error instanceof Error ? error : new Error(String(error)));
        lose(errorText(error));
      });
    }, probeIntervalMs);
    timer.unref?.();
    probeTimer = timer;
  }

  function connect(): Promise<void> {
    if (stopped || connection) return Promise.resolve();
    if (connecting) return connecting;
    connecting = (async () => {
      let client: ClusterBusListenClient;
      try { client = await options.acquire(); } catch (error) {
        lose(errorText(error));
        return;
      }
      let released = false;
      const release = (error?: Error) => {
        if (released) return;
        released = true;
        // With an error the pool closes the connection instead of reusing it.
        if (error) client.release(error); else client.release();
      };
      client.on('notification', (message) => {
        if (message.channel === CLUSTER_BUS_CHANNEL) deliver(message.payload);
      });
      client.on('error', (error: Error) => {
        const current = connection?.client === client;
        release(error);
        if (current) lose(errorText(error));
      });
      try {
        await client.query(`LISTEN ${CLUSTER_BUS_CHANNEL}`);
      } catch (error) {
        release(error instanceof Error ? error : new Error(String(error)));
        lose(errorText(error));
        return;
      }
      if (stopped) { release(); return; }
      if (released) { lose('listening connection closed'); return; }
      connection = { client, release };
      failures = 0;
      healthy = true;
      startProbe(client, release);
      info('Listening for invalidations from the other processes');
      // Anything sent while this process was not listening was missed.
      runResetHandlers();
    })().finally(() => { connecting = null; });
    return connecting;
  }

  return {
    enabled: options.enabled,
    async start() {
      if (!options.enabled || started) return;
      started = true;
      stopped = false;
      await connect();
    },
    async stop() {
      stopped = true;
      if (retryTimer) clearTimer(retryTimer);
      retryTimer = null;
      stopProbe();
      await connecting;
      const current = connection;
      connection = null;
      healthy = false;
      if (!current) return;
      try { await current.client.query(`UNLISTEN ${CLUSTER_BUS_CHANNEL}`); } catch { /* released below either way */ }
      current.release();
    },
    publish(kind, payload, publishOptions = {}) {
      if (!options.enabled) return Promise.resolve();
      const text = JSON.stringify({ o: origin, k: kind, p: payload });
      if (Buffer.byteLength(text) > CLUSTER_BUS_MAX_PAYLOAD_BYTES) {
        log({ event: 'cluster_bus_message_too_large', kind, bytes: Buffer.byteLength(text) });
        return Promise.resolve();
      }
      const send = async () => {
        try {
          await options.notify(CLUSTER_BUS_CHANNEL, text);
        } catch (error) {
          // The other processes then rely on their cache lifetime.
          log({ event: 'cluster_bus_publish_failed', kind, reason: errorText(error) });
        }
      };
      // Registered synchronously, so it joins the caller's transaction (if any).
      return publishOptions.immediate ? send() : defer(send);
    },
    on(kind, handler) {
      const set = handlers.get(kind) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(kind, set);
      return () => { set.delete(handler); };
    },
    onReset(handler) {
      resetHandlers.add(handler);
      return () => { resetHandlers.delete(handler); };
    },
    isHealthy() {
      return !options.enabled || healthy;
    },
    cacheTtlMs(normalTtlMs) {
      return !options.enabled || healthy ? normalTtlMs : Math.min(normalTtlMs, CLUSTER_BUS_DEGRADED_CACHE_TTL_MS);
    },
  };
}

/** The bus of this process: enabled whenever other processes share the caches. */
export const clusterBus: ClusterBus = createClusterBus({
  enabled: processRolePlan.sharesStateAcrossProcesses,
  // LISTEN needs its own server session (never a transaction-mode pooler).
  acquire: () => getSessionClient(),
  notify: (channel, payload) => pool.query('SELECT pg_notify($1, $2)', [channel, payload]),
  afterCommit,
});
