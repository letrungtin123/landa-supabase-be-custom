import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  CLUSTER_BUS_CHANNEL,
  CLUSTER_BUS_DEGRADED_CACHE_TTL_MS,
  createClusterBus,
  type ClusterBusListenClient,
} from './cluster-bus.js';

// Invalidations between processes over LISTEN/NOTIFY. A stand-in for
// PostgreSQL delivers every NOTIFY to every listening connection; no database.

class FakePostgres {
  readonly listeners = new Set<FakeListenClient>();
  notifies: Array<{ channel: string; payload: string }> = [];
  notify(channel: string, payload: string): void {
    this.notifies.push({ channel, payload });
    for (const client of this.listeners) {
      if (client.channels.has(channel)) client.emit('notification', { channel, payload });
    }
  }
}

class FakeListenClient extends EventEmitter implements ClusterBusListenClient {
  readonly channels = new Set<string>();
  released: Array<Error | null> = [];
  probeFails = false;
  constructor(private readonly postgres: FakePostgres) { super(); }
  async query(text: string): Promise<unknown> {
    const [command, channel] = text.split(' ');
    if (command === 'LISTEN') { this.channels.add(channel); this.postgres.listeners.add(this); }
    if (command === 'UNLISTEN') this.channels.delete(channel);
    if (text === 'SELECT 1' && this.probeFails) throw new Error('connection terminated');
    return {};
  }
  release(error?: Error): void {
    this.released.push(error ?? null);
    this.postgres.listeners.delete(this);
  }
}

interface Timers { pending: Array<() => void>; repeats: Array<() => void> }

function processBus(postgres: FakePostgres, options: { enabled?: boolean; originId: string; timers?: Timers; afterCommit?: (work: () => Promise<void>) => Promise<void> }) {
  const clients: FakeListenClient[] = [];
  const logs: Record<string, unknown>[] = [];
  const timers = options.timers ?? { pending: [], repeats: [] };
  const bus = createClusterBus({
    enabled: options.enabled ?? true,
    originId: options.originId,
    acquire: async () => { const client = new FakeListenClient(postgres); clients.push(client); return client; },
    notify: async (channel, payload) => { postgres.notify(channel, payload); },
    afterCommit: options.afterCommit,
    retryDelayMs: () => 1,
    setTimer: (callback) => { timers.pending.push(callback); return {}; },
    clearTimer: () => {},
    setRepeat: (callback) => { timers.repeats.push(callback); return {}; },
    clearRepeat: () => {},
    log: (event) => logs.push(event),
    info: () => {},
  });
  return { bus, clients, logs, timers };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('an invalidation published by one process reaches the others, never the sender itself', async () => {
  const postgres = new FakePostgres();
  const a = processBus(postgres, { originId: 'a' });
  const b = processBus(postgres, { originId: 'b' });
  await Promise.all([a.bus.start(), b.bus.start()]);
  assert.equal(a.bus.isHealthy(), true);
  const seenByA: unknown[] = [];
  const seenByB: unknown[] = [];
  a.bus.on('permissions', (payload) => { seenByA.push(payload); });
  b.bus.on('permissions', (payload) => { seenByB.push(payload); });
  b.bus.on('other-kind', () => { throw new Error('wrong kind delivered'); });

  await a.bus.publish('permissions', { user_id: 'u-1' });
  await flush();
  assert.deepEqual(seenByB, [{ user_id: 'u-1' }]);
  assert.deepEqual(seenByA, [], 'the sender already applied its own change');
  assert.equal(postgres.notifies[0].channel, CLUSTER_BUS_CHANNEL);
});

test('published after COMMIT: nothing is sent while the transaction is open, nothing on rollback', async () => {
  const postgres = new FakePostgres();
  const deferred: Array<() => Promise<void>> = [];
  const a = processBus(postgres, { originId: 'a', afterCommit: async (work) => { deferred.push(work); } });
  await a.bus.start();
  void a.bus.publish('tenant.status', { tenant_id: 't-1' });
  assert.equal(postgres.notifies.length, 0, 'held until commit');
  await deferred[0]();
  assert.equal(postgres.notifies.length, 1);
  // `immediate` (a relay of an already committed change) is sent at once.
  await a.bus.publish('cache.bump', { segments: [] }, { immediate: true });
  assert.equal(postgres.notifies.length, 2);
});

test('a lost listener: caches are reset, values live only a few seconds, and it reconnects', async () => {
  const postgres = new FakePostgres();
  const a = processBus(postgres, { originId: 'a' });
  const b = processBus(postgres, { originId: 'b' });
  await Promise.all([a.bus.start(), b.bus.start()]);
  let resets = 0;
  b.bus.onReset(() => { resets += 1; });
  const seen: unknown[] = [];
  b.bus.on('tenant.status', (payload) => { seen.push(payload); });
  assert.equal(b.bus.cacheTtlMs(60_000), 60_000);

  b.clients[0].emit('error', new Error('terminating connection due to administrator command'));
  assert.equal(b.bus.isHealthy(), false);
  assert.equal(resets, 1, 'entries that could miss an invalidation are dropped');
  assert.equal(b.bus.cacheTtlMs(60_000), CLUSTER_BUS_DEGRADED_CACHE_TTL_MS);
  assert.equal(b.bus.cacheTtlMs(1_000), 1_000);
  assert.ok(b.clients[0].released[0] instanceof Error, 'the broken connection is discarded by the pool');

  await a.bus.publish('tenant.status', { tenant_id: 'missed' });
  await flush();
  assert.deepEqual(seen, [], 'not listening: missed');

  b.timers.pending.shift()!();
  await flush();
  assert.equal(b.bus.isHealthy(), true);
  assert.equal(resets, 2, 'what was missed meanwhile is dropped again');
  await a.bus.publish('tenant.status', { tenant_id: 't-2' });
  await flush();
  assert.deepEqual(seen, [{ tenant_id: 't-2' }]);
});

test('a listener that stops answering the probe is replaced', async () => {
  const postgres = new FakePostgres();
  const b = processBus(postgres, { originId: 'b' });
  await b.bus.start();
  b.clients[0].probeFails = true;
  b.timers.repeats[0]();
  await flush();
  assert.equal(b.bus.isHealthy(), false);
  b.timers.pending.shift()!();
  await flush();
  assert.equal(b.bus.isHealthy(), true);
  assert.equal(b.clients.length, 2);
});

test('a first connection that fails is retried in the background; startup is not blocked', async () => {
  const postgres = new FakePostgres();
  let attempts = 0;
  const timers: Timers = { pending: [], repeats: [] };
  const bus = createClusterBus({
    enabled: true,
    originId: 'c',
    acquire: async () => { attempts += 1; if (attempts === 1) throw new Error('ECONNREFUSED'); return new FakeListenClient(postgres); },
    notify: async () => {},
    retryDelayMs: () => 1,
    setTimer: (callback) => { timers.pending.push(callback); return {}; },
    clearTimer: () => {},
    setRepeat: (callback) => { timers.repeats.push(callback); return {}; },
    clearRepeat: () => {},
    log: () => {},
    info: () => {},
  });
  await bus.start();
  assert.equal(bus.isHealthy(), false);
  timers.pending.shift()!();
  await flush();
  assert.equal(bus.isHealthy(), true);
});

test('disabled (one process): publish sends nothing and caches keep their lifetime', async () => {
  const postgres = new FakePostgres();
  const single = processBus(postgres, { originId: 'solo', enabled: false });
  await single.bus.start();
  await single.bus.publish('permissions', {});
  assert.equal(single.clients.length, 0, 'no listening connection');
  assert.equal(postgres.notifies.length, 0);
  assert.equal(single.bus.isHealthy(), true);
  assert.equal(single.bus.cacheTtlMs(300_000), 300_000);
});

test('oversized or malformed messages are dropped, stop() releases the connection', async () => {
  const postgres = new FakePostgres();
  const a = processBus(postgres, { originId: 'a' });
  const b = processBus(postgres, { originId: 'b' });
  await Promise.all([a.bus.start(), b.bus.start()]);
  await a.bus.publish('permissions', { user_id: 'x'.repeat(9_000) });
  assert.equal(postgres.notifies.length, 0);
  assert.equal(a.logs[0]?.event, 'cluster_bus_message_too_large');
  b.clients[0].emit('notification', { channel: CLUSTER_BUS_CHANNEL, payload: 'not json' });
  assert.equal(b.logs[0]?.event, 'cluster_bus_message_invalid');
  await b.bus.stop();
  assert.deepEqual(b.clients[0].released, [null]);
  assert.equal(b.clients[0].channels.size, 0);
});
