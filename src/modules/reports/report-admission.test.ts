import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';

// H2: report aggregates run in a bounded number of slots per tenant and in
// total; one over the limit waits briefly, then gets a plain 429. Exports are
// limited per user, per tenant and in total, refused at once.

const logic = await import('./report-admission.logic.js');
const { createReportAdmission } = await import('./report-admission.service.js');
const { handleReportsBusyError } = await import('./reports.controller.js');
const { pool } = await import('../../config/database.js');

test.after(async () => {
  await pool.end();
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the gate keeps per-tenant and total limits and hands a freed slot to the oldest waiter that fits', async () => {
  const gate = logic.createWaitingConcurrencyGate({ perKey: 2, total: 3 });
  const a1 = await gate.acquire('a', 1_000);
  const a2 = await gate.acquire('a', 1_000);
  assert.ok(a1 && a2);
  const order: string[] = [];
  const a3 = gate.acquire('a', 1_000).then((release) => { order.push('a3'); return release; });
  const b1 = await gate.acquire('b', 1_000);
  assert.ok(b1, 'another tenant still fits the total');
  const b2 = gate.acquire('b', 1_000).then((release) => { order.push('b2'); return release; });
  assert.equal(gate.active(), 3);
  assert.equal(gate.waiting(), 2);

  a1!();
  a1!(); // releasing twice is harmless
  const a3Release = await a3;
  assert.ok(a3Release);
  assert.deepEqual(order, ['a3']);
  assert.equal(gate.active('a'), 2);

  b1!();
  const b2Release = await b2;
  assert.ok(b2Release);
  assert.deepEqual(order, ['a3', 'b2']);
  assert.equal(gate.waiting(), 0);
  for (const release of [a2!, a3Release!, b2Release!]) release();
  assert.equal(gate.active(), 0);
});

test('a waiter that gets no slot in time is refused; with no wait it is refused at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = logic.createWaitingConcurrencyGate({ perKey: 1, total: 10 });
  const held = await gate.acquire('a', 0);
  assert.ok(held);
  assert.equal(await gate.acquire('a', 0), null);

  const waiting = gate.acquire('a', 2_000);
  t.mock.timers.tick(1_999);
  await tick();
  assert.equal(gate.waiting(), 1);
  t.mock.timers.tick(1);
  assert.equal(await waiting, null);
  assert.equal(gate.waiting(), 0);
  held!();
  assert.equal(gate.active(), 0);
});

test('a report chat turn takes one slot; the aggregates it starts take none', async () => {
  const admission = createReportAdmission({
    tenantAggregates: 1, totalAggregates: 4, aggregateWaitMs: 0, userExports: 1, tenantExports: 2, totalExports: 2,
  });
  const inner = await admission.runReportAggregate('tenant-a', () => Promise.all([
    admission.runReportAggregate('tenant-a', async () => 'summary'),
    admission.runReportAggregate('tenant-a', async () => 'chart'),
  ]));
  assert.deepEqual(inner, ['summary', 'chart']);
});

test('an aggregate over the tenant limit is refused with REPORTS_BUSY, other tenants are not', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const admission = createReportAdmission({
    tenantAggregates: 1, totalAggregates: 4, aggregateWaitMs: 0, userExports: 1, tenantExports: 2, totalExports: 2,
  });
  let finish: (() => void) | undefined;
  const running = admission.runReportAggregate('tenant-a', () => new Promise<void>((resolve) => { finish = resolve; }));
  await assert.rejects(admission.runReportAggregate('tenant-a', async () => 'second'), (error: unknown) => {
    assert.ok(logic.isReportsBusyError(error));
    assert.equal((error as InstanceType<typeof logic.ReportsBusyError>).code, 'REPORTS_BUSY');
    return true;
  });
  assert.equal(await admission.runReportAggregate('tenant-b', async () => 'other tenant'), 'other tenant');
  finish!();
  await running;
  assert.equal(await admission.runReportAggregate('tenant-a', async () => 'after'), 'after');
});

test('exports: one per user, then per tenant and in total; a finished export frees its slot', () => {
  const admission = createReportAdmission({
    tenantAggregates: 2, totalAggregates: 8, aggregateWaitMs: 0, userExports: 1, tenantExports: 2, totalExports: 3,
  });
  const first = admission.tryAcquireReportExportSlot({ tenantId: 'a', userId: 'u1' });
  assert.ok('release' in first);
  assert.deepEqual(admission.tryAcquireReportExportSlot({ tenantId: 'a', userId: 'u1' }), { refused: 'user' });
  const second = admission.tryAcquireReportExportSlot({ tenantId: 'a', userId: 'u2' });
  assert.ok('release' in second);
  assert.deepEqual(admission.tryAcquireReportExportSlot({ tenantId: 'a', userId: 'u3' }), { refused: 'busy' });
  const third = admission.tryAcquireReportExportSlot({ tenantId: 'b', userId: 'u4' });
  assert.ok('release' in third);
  assert.deepEqual(admission.tryAcquireReportExportSlot({ tenantId: 'c', userId: 'u5' }), { refused: 'busy' }, 'total limit');
  // u3 was refused by the tenant limit: its user slot is not left taken.
  first.release();
  const retried = admission.tryAcquireReportExportSlot({ tenantId: 'a', userId: 'u3' });
  assert.ok('release' in retried);
  assert.deepEqual(admission.tryAcquireReportExportSlot({ tenantId: 'a', userId: 'u1' }), { refused: 'busy' });
});

function fakeResponse() {
  const out: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const res = {
    headersSent: false,
    setHeader(name: string, value: string) { out.headers[name] = value; return this; },
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body; return this; },
  } as unknown as Response;
  return { res, out };
}

test('a busy report answers 429 REPORTS_BUSY in the UI language; other errors pass on', () => {
  for (const [locale, message] of [
    ['vi', 'Báo cáo đang được nhiều người xem cùng lúc, vui lòng thử lại sau ít giây.'],
    ['en', 'Many people are viewing reports right now. Please try again in a few seconds.'],
  ] as const) {
    const { res, out } = fakeResponse();
    const req = { get: (name: string) => (name === 'X-UI-Locale' ? locale : undefined) } as unknown as Request;
    let nextCalled = false;
    handleReportsBusyError(new logic.ReportsBusyError(), req, res, (() => { nextCalled = true; }) as NextFunction);
    assert.equal(nextCalled, false);
    assert.equal(out.status, 429);
    assert.equal(out.headers['Retry-After'], String(logic.REPORTS_BUSY_RETRY_AFTER_SECONDS));
    assert.deepEqual(out.body, { success: false, code: 'REPORTS_BUSY', message });
  }
  const { res, out } = fakeResponse();
  const other = new Error('boom');
  let forwarded: unknown;
  handleReportsBusyError(other, { get: () => undefined } as unknown as Request, res, ((error: unknown) => { forwarded = error; }) as NextFunction);
  assert.equal(forwarded, other);
  assert.equal(out.status, undefined);
});
