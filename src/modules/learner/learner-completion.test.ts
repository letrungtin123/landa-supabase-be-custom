import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';
import { MAX_COMPLETE_BLOCK_IDS, planBlockCompletion } from './learner-completion.logic.js';

// H7: POST /api/learner/complete-blocks writes only what is not completed yet.
// Re-sending blocks a learner already completed (every unit view of older
// learner apps) costs reads only: no insert, no progress recalculation, no
// cache bump. `marked` keeps the value it always had.

const USER = 'a0000000-0000-4000-8000-0000000000c1';
const COURSE = 'course-v1:A+perf+2026';
const ENROLLMENT = 'e0000000-0000-4000-8000-0000000000c1';
const B1 = 'b0000000-0000-4000-8000-000000000001';
const B2 = 'b0000000-0000-4000-8000-000000000002';
const B3 = 'b0000000-0000-4000-8000-000000000003';

type Call = { sql: string; params: unknown[] };
type Fixture = {
  active: Array<{ id: string; completed: boolean }>;
  insertedIds?: string[];
  leafTotals?: { total: number; completed: number };
  wasCompleted?: boolean | null;
  enrolled?: boolean;
};

async function installFakeDb(t: TestContext, fixture: Fixture): Promise<Call[]> {
  const calls: Call[] = [];
  const pg = await import('pg');
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    calls.push({ sql: text, params });
    if (text.includes('tenant_demo_iframe_settings')) return { rows: [{ exists: false }], rowCount: 1 };
    if (text.includes('FROM enrollments e') && text.includes('JOIN courses c')) {
      return fixture.enrolled === false ? { rows: [], rowCount: 0 } : { rows: [{ id: ENROLLMENT }], rowCount: 1 };
    }
    if (text.includes('WITH RECURSIVE ancestors') && text.includes('block_completions bc')) {
      const requested = new Set(params[1] as string[]);
      const rows = fixture.active.filter((row) => requested.has(row.id));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('INSERT INTO block_completions')) {
      const ids = fixture.insertedIds ?? (params[1] as string[]);
      return { rows: ids.map((block_id) => ({ block_id })), rowCount: ids.length };
    }
    if (text.includes('leaf_blocks lb')) {
      const totals = fixture.leafTotals ?? { total: 3, completed: 3 };
      return { rows: [{ total: String(totals.total), completed: String(totals.completed) }], rowCount: 1 };
    }
    if (text.includes('UPDATE course_progress')) {
      return { rows: [{ was_completed: fixture.wasCompleted ?? false }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return calls;
}

const writes = (calls: Call[]) => calls.filter((call) => /INSERT INTO block_completions|UPDATE course_progress|leaf_blocks lb/.test(call.sql));

test('the plan keeps marked as the number of distinct active blocks and lists the missing ones', () => {
  assert.deepEqual(planBlockCompletion([]), { marked: 0, missing: [] });
  assert.deepEqual(
    planBlockCompletion([{ id: B1, completed: true }, { id: B2, completed: false }, { id: B2, completed: false }]),
    { marked: 2, missing: [B2] },
  );
  assert.deepEqual(planBlockCompletion([{ id: B1, completed: true }, { id: B2, completed: true }]), { marked: 2, missing: [] });
});

test('blocks already completed are answered without any write or recalculation', async (t) => {
  const calls = await installFakeDb(t, { active: [{ id: B1, completed: true }, { id: B2, completed: true }] });
  const svc = await import('./learner.service.js');
  const result = await svc.markBlocksComplete(USER, COURSE, [B1, B2, B1]);
  assert.deepEqual(result, { marked: 2, newly_completed: 0 });
  assert.deepEqual(writes(calls), [], 'no insert, no progress query, no progress update');
});

test('ids that are not active leaf blocks are answered with marked 0 and no write', async (t) => {
  const calls = await installFakeDb(t, { active: [] });
  const svc = await import('./learner.service.js');
  assert.deepEqual(await svc.markBlocksComplete(USER, COURSE, [B3]), { marked: 0, newly_completed: 0 });
  assert.deepEqual(writes(calls), []);
});

test('only the missing blocks are inserted, then progress is recalculated once', async (t) => {
  const calls = await installFakeDb(t, {
    active: [{ id: B1, completed: true }, { id: B2, completed: false }, { id: B3, completed: false }],
    leafTotals: { total: 4, completed: 3 },
  });
  const svc = await import('./learner.service.js');
  const result = await svc.markBlocksComplete(USER, COURSE, [B1, B2, B3]);
  assert.deepEqual(result, { marked: 3, newly_completed: 2, progress: 75, is_completed: false, completion_changed: false });

  const insert = calls.find((call) => call.sql.includes('INSERT INTO block_completions'));
  assert.ok(insert);
  assert.deepEqual(insert.params, [ENROLLMENT, [B2, B3]]);
  assert.match(insert.sql, /ON CONFLICT DO NOTHING\s+RETURNING block_id/);
  assert.equal(calls.filter((call) => call.sql.includes('UPDATE course_progress')).length, 1);
  const update = calls.find((call) => call.sql.includes('UPDATE course_progress'));
  assert.deepEqual(update?.params, [75, false, ENROLLMENT], 'same values as before: progress, is_completed, enrollment');
});

test('the request that completes the course reports the change', async (t) => {
  await installFakeDb(t, {
    active: [{ id: B1, completed: false }],
    leafTotals: { total: 3, completed: 3 },
    wasCompleted: false,
  });
  const svc = await import('./learner.service.js');
  assert.deepEqual(await svc.markBlocksComplete(USER, COURSE, [B1]), {
    marked: 1, newly_completed: 1, progress: 100, is_completed: true, completion_changed: true,
  });
});

test('when a concurrent request inserted the rows first, this one does not recalculate', async (t) => {
  const calls = await installFakeDb(t, { active: [{ id: B1, completed: false }], insertedIds: [] });
  const svc = await import('./learner.service.js');
  assert.deepEqual(await svc.markBlocksComplete(USER, COURSE, [B1]), { marked: 1, newly_completed: 0 });
  assert.equal(calls.some((call) => /leaf_blocks lb|UPDATE course_progress/.test(call.sql)), false);
});

test('a learner who is not enrolled still gets the same 400', async (t) => {
  await installFakeDb(t, { active: [], enrolled: false });
  const svc = await import('./learner.service.js');
  await assert.rejects(svc.markBlocksComplete(USER, COURSE, [B1]), (err: { statusCode?: number }) => err.statusCode === 400);
});

function callComplete(body: unknown, locale?: string) {
  const out: { status?: number; body?: { success?: boolean; message?: string }; error?: unknown } = {};
  const res = {
    status(code: number) { out.status = code; return this; },
    json(value: unknown) { out.body = value as typeof out.body; return this; },
  } as unknown as Response;
  const req = {
    body,
    get: (name: string) => (name.toLowerCase() === 'x-ui-locale' ? locale : undefined),
    user: { id: USER, tenantId: '11111111-1111-4111-8111-111111111111', role: 'learner', username: 'l', sessionMode: 'normal' },
  } as unknown as Request;
  return import('./learner.controller.js')
    .then((ctrl) => ctrl.completeBlocks(req, res, (err?: unknown) => { out.error = err; }))
    .then(() => out);
}

test(`more than ${MAX_COMPLETE_BLOCK_IDS} block ids are refused with a plain message before any query`, async (t) => {
  const calls = await installFakeDb(t, { active: [] });
  const tooMany = Array.from({ length: MAX_COMPLETE_BLOCK_IDS + 1 }, (_, i) => `b0000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

  const vi = await callComplete({ course_id: COURSE, block_ids: tooMany });
  assert.equal(vi.status, 400);
  assert.equal(vi.body?.success, false);
  assert.match(vi.body?.message ?? '', /tối đa 200 nội dung/);

  const en = await callComplete({ course_id: COURSE, block_ids: tooMany }, 'en');
  assert.equal(en.status, 400);
  assert.match(en.body?.message ?? '', /At most 200 items/);
  assert.equal(calls.length, 0, 'nothing reached the database');

  const atLimit = await callComplete({ course_id: COURSE, block_ids: tooMany.slice(0, MAX_COMPLETE_BLOCK_IDS) });
  assert.equal(atLimit.status, 200, 'exactly the limit is accepted');
});
