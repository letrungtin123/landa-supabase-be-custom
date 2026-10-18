import assert from 'node:assert/strict';
import test from 'node:test';
import { createConcurrencyGate } from './ai-chat-admission.logic.js';
import {
  countActiveSlots,
  createChatAnswerGate,
  createSharedConcurrencyGate,
  type AdmissionRedisClient,
} from './ai-chat-admission.service.js';

// H10 with several API processes: the per-tenant and total AI chat limits
// hold for the whole cluster. Two gates stand for two API processes sharing
// one in-memory sorted-set Redis; no network.

class FakeSortedSets implements AdmissionRedisClient {
  readonly sets = new Map<string, Map<string, number>>();
  down = false;
  commands = 0;
  private set(key: string) {
    const existing = this.sets.get(key);
    if (existing) return existing;
    const created = new Map<string, number>();
    this.sets.set(key, created);
    return created;
  }
  private check() { this.commands += 1; if (this.down) throw new Error('ECONNRESET'); }
  async zRemRangeByScore(key: string, _min: number | string, max: number | string) {
    this.check();
    let removed = 0;
    for (const [member, score] of this.set(key)) if (score <= Number(max)) { this.set(key).delete(member); removed += 1; }
    return removed;
  }
  async zAdd(key: string, member: { score: number; value: string }, options?: { condition?: 'XX'; CH?: boolean }) {
    this.check();
    const members = this.set(key);
    if (options?.condition === 'XX' && !members.has(member.value)) return 0;
    const changed = members.get(member.value) !== member.score;
    members.set(member.value, member.score);
    return options?.CH ? Number(changed) : 1;
  }
  async zCard(key: string) { this.check(); return this.set(key).size; }
  async zRem(key: string, member: string) { this.check(); return Number(this.set(key).delete(member)); }
  async pExpire() { this.check(); return 1; }
}

function apiProcess(redis: FakeSortedSets, limits: { perKey: number; total: number }, clock: { now: number }, fallbackShare = { perKey: 1, total: 2 }) {
  const renewals: Array<() => void> = [];
  const logs: Record<string, unknown>[] = [];
  let tokens = 0;
  const gate = createSharedConcurrencyGate({
    name: 'ai-chat-test',
    limits,
    fallback: createConcurrencyGate(fallbackShare),
    getClient: () => redis,
    deadline: (_label, work) => work,
    now: () => clock.now,
    newToken: () => `lease-${(tokens += 1)}-${Math.random()}`,
    setRepeat: (callback) => { renewals.push(callback); return {}; },
    clearRepeat: () => {},
    log: (event) => logs.push(event),
  });
  return { gate, renewals, logs };
}

test('the per-tenant limit holds across two API processes; another tenant is not affected', async () => {
  const redis = new FakeSortedSets();
  const clock = { now: 1_000_000 };
  const a = apiProcess(redis, { perKey: 2, total: 10 }, clock);
  const b = apiProcess(redis, { perKey: 2, total: 10 }, clock);
  const first = await a.gate.tryAcquire('tenant-1');
  const second = await b.gate.tryAcquire('tenant-1');
  assert.ok(first && second);
  assert.equal(await a.gate.tryAcquire('tenant-1'), null, 'a third answer of the tenant is refused on process A');
  assert.equal(await b.gate.tryAcquire('tenant-1'), null, 'and on process B');
  assert.ok(await b.gate.tryAcquire('tenant-2'), 'another tenant still gets a slot');

  first();
  first();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(await b.gate.tryAcquire('tenant-1'), 'a finished answer frees its slot for every process');
});

test('the total limit holds across processes', async () => {
  const redis = new FakeSortedSets();
  const clock = { now: 2_000_000 };
  const a = apiProcess(redis, { perKey: 5, total: 3 }, clock);
  const b = apiProcess(redis, { perKey: 5, total: 3 }, clock);
  assert.ok(await a.gate.tryAcquire('t-1'));
  assert.ok(await b.gate.tryAcquire('t-2'));
  assert.ok(await a.gate.tryAcquire('t-3'));
  assert.equal(await b.gate.tryAcquire('t-4'), null);
  // Refused turns leave no lease behind.
  assert.equal([...redis.sets.values()].reduce((sum, set) => sum + set.size, 0), 6, '3 tenant leases + 3 total leases');
});

test('a crashed process frees its slots when the leases expire; a live answer renews its lease', async () => {
  const redis = new FakeSortedSets();
  const clock = { now: 3_000_000 };
  const crashed = apiProcess(redis, { perKey: 1, total: 10 }, clock);
  const live = apiProcess(redis, { perKey: 1, total: 10 }, clock);
  assert.ok(await crashed.gate.tryAcquire('t-crash'), 'held, never released (the process died)');
  assert.ok(await live.gate.tryAcquire('t-live'));
  assert.equal(await live.gate.tryAcquire('t-crash'), null);

  clock.now += 50_000;
  live.renewals[0]();
  await new Promise((resolve) => setImmediate(resolve));
  clock.now += 20_000; // 70 s after the start: past the first lease.
  assert.ok(await live.gate.tryAcquire('t-crash'), 'the dead lease expired');
  assert.equal(await crashed.gate.tryAcquire('t-live'), null, 'the renewed lease still counts');
});

test('Redis unavailable: each process falls back to its share of the limits', async () => {
  const redis = new FakeSortedSets();
  redis.down = true;
  const clock = { now: 4_000_000 };
  const a = apiProcess(redis, { perKey: 4, total: 8 }, clock, { perKey: 1, total: 2 });
  const released = await a.gate.tryAcquire('t-1');
  assert.ok(released);
  assert.equal(await a.gate.tryAcquire('t-1'), null, 'this process share: 1 per tenant');
  assert.equal(a.logs[0]?.event, 'ai_chat_admission_fallback');
  released();
  assert.ok(await a.gate.tryAcquire('t-1'));
});

test('one API process keeps the in-process gate with the full limits (no Redis)', async () => {
  const gate = createChatAnswerGate({ severalApiInstances: false, apiInstances: 1 }, { perKey: 2, total: 3 }, {
    getClient: () => { throw new Error('Redis must not be used'); },
  });
  const one = await gate.tryAcquire('t');
  const two = await gate.tryAcquire('t');
  assert.ok(one && two);
  assert.equal(await gate.tryAcquire('t'), null);
});

test('several API processes: the shared gate, its fallback is limit / instances rounded up', async () => {
  const redis = new FakeSortedSets();
  redis.down = true;
  const gate = createChatAnswerGate({ severalApiInstances: true, apiInstances: 4 }, { perKey: 8, total: 48 }, {
    getClient: () => redis, deadline: (_label, work) => work, log: () => {},
  });
  const held = [];
  for (let index = 0; index < 3; index += 1) held.push(await gate.tryAcquire('t'));
  assert.deepEqual(held.map(Boolean), [true, true, false], '8 / 4 = 2 per tenant in this process');
  assert.ok(redis.commands > 0, 'it tried Redis first');
});

test('two processes racing for the last slot: never both admitted', async () => {
  for (let round = 0; round < 20; round += 1) {
    const redis = new FakeSortedSets();
    const clock = { now: 5_000_000 };
    const a = apiProcess(redis, { perKey: 3, total: 50 }, clock);
    const b = apiProcess(redis, { perKey: 3, total: 50 }, clock);
    assert.ok(await a.gate.tryAcquire('t'));
    assert.ok(await b.gate.tryAcquire('t'));
    const raced = await Promise.all([a.gate.tryAcquire('t'), b.gate.tryAcquire('t')]);
    assert.ok(raced.filter(Boolean).length <= 1, `round ${round}: over the limit`);
  }
});

test('the metrics count: slots this process holds, shared or fallback, refusals and double releases not counted', async () => {
  const redis = new FakeSortedSets();
  const clock = { now: 7_000_000 };
  const a = apiProcess(redis, { perKey: 2, total: 10 }, clock);
  const b = apiProcess(redis, { perKey: 2, total: 10 }, clock);
  const counted = countActiveSlots(a.gate);
  const first = await counted.tryAcquire('t');
  assert.ok(first && await b.gate.tryAcquire('t'));
  assert.equal(counted.active(), 1, 'the slot held by the other process is not counted here');
  assert.equal(await counted.tryAcquire('t'), null);
  assert.equal(counted.active(), 1, 'a refused turn is not counted');
  redis.down = true;
  const fallback = await counted.tryAcquire('t-2');
  assert.ok(fallback, 'the fallback gate admits while Redis is down');
  assert.equal(counted.active(), 2);
  first();
  first();
  assert.equal(counted.active(), 1, 'releasing twice counts once');
  fallback();
  assert.equal(counted.active(), 0);

  const single = countActiveSlots(createChatAnswerGate({ severalApiInstances: false, apiInstances: 1 }, { perKey: 1, total: 1 }));
  const only = await single.tryAcquire('t');
  assert.ok(only);
  assert.equal(await single.tryAcquire('t'), null);
  assert.equal(single.active(), 1, 'one API process: the in-process gate is counted the same way');
  only();
  assert.equal(single.active(), 0);
});
