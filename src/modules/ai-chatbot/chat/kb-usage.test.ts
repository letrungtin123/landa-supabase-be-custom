import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';

// Exclusive knowledge bases (owner rule D1): the admin page bot, the learner page bot and AI ID use
// pairwise different knowledge bases; every write that could create a clash takes the tenant's
// transaction advisory lock first and is refused with 409 AI_CHATBOT_KB_ALREADY_USED.
//
// A pg double plays the database: one client per transaction, writes visible to the others only at
// COMMIT, and pg_advisory_xact_lock held until COMMIT/ROLLBACK, so two concurrent writes of one tenant
// really interleave (the usage read waits a little) unless the lock serializes them.

process.env.REDIS_URL = 'redis://127.0.0.1:1';
const redis = await import('../../../config/redis.js');
redis.installRedisClient(null);
const pg = await import('pg');
const logic = await import('./kb-usage.logic.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-0000000000c9';
const BOT_A = 'b0000000-0000-4000-8000-00000000000a';
const BOT_B = 'b0000000-0000-4000-8000-00000000000b';
const BOT_C = 'b0000000-0000-4000-8000-00000000000c';
const KB_1 = 'c0000000-0000-4000-8000-000000000001';
const KB_2 = 'c0000000-0000-4000-8000-000000000002';
const KB_3 = 'c0000000-0000-4000-8000-000000000003';
const KB_CONTEXT = 'c0000000-0000-4000-8000-0000000000cc';
const LOCK_KEY = `ai-chatbot:kb-usage:${TENANT}`;

interface State {
  pages: Map<'admin' | 'learner' | 'lesson_author', string>;
  aiIdKb: string | null;
  contextKb: string | null;
  bots: Map<string, string | null>;
}

function state(input: Partial<{ admin: string; learner: string; lesson_author: string; aiIdKb: string;
  bots: Record<string, string | null> }> = {}): State {
  const pages = new Map<'admin' | 'learner' | 'lesson_author', string>();
  if (input.admin) pages.set('admin', input.admin);
  if (input.learner) pages.set('learner', input.learner);
  if (input.lesson_author) pages.set('lesson_author', input.lesson_author);
  return { pages, aiIdKb: input.aiIdKb ?? null, contextKb: KB_CONTEXT,
    bots: new Map(Object.entries(input.bots ?? { [BOT_A]: KB_1, [BOT_B]: KB_2, [BOT_C]: KB_3 })) };
}

const normal = (text: unknown) => String(typeof text === 'object' && text && 'text' in text
  ? (text as { text: string }).text : text).replace(/\s+/g, ' ').trim();

/** A database with real transaction visibility and advisory locks; `lockless` ignores the lock (control). */
function database(t: TestContext, db: State, options: { lockless?: boolean } = {}) {
  const statements: Array<{ client: number; sql: string; params: unknown[] }> = [];
  const held = new Map<string, Promise<void>>();
  let clients = 0;

  async function acquire(key: string): Promise<() => void> {
    while (held.has(key)) await held.get(key);
    let release!: () => void;
    held.set(key, new Promise<void>(resolve => { release = () => { held.delete(key); resolve(); }; }));
    return release;
  }

  function client(id: number) {
    const pending: Array<(target: State) => void> = [];
    const releases: Array<() => void> = [];
    const end = (commit: boolean) => {
      if (commit) for (const apply of pending) apply(db);
      pending.length = 0;
      for (const release of releases.splice(0)) release();
    };
    const visible = (): State => {
      const view: State = { pages: new Map(db.pages), aiIdKb: db.aiIdKb, contextKb: db.contextKb, bots: new Map(db.bots) };
      for (const apply of pending) apply(view);
      return view;
    };
    return async (text: unknown, params: unknown[] = []) => {
      const sql = normal(text);
      statements.push({ client: id, sql, params });
      const rows = (value: unknown[]) => ({ rows: value, rowCount: value.length });
      if (sql === 'BEGIN') return rows([]);
      if (sql === 'COMMIT') { end(true); return rows([]); }
      if (sql === 'ROLLBACK') { end(false); return rows([]); }
      if (/^SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)$/.test(sql)) {
        if (!options.lockless) releases.push(await acquire(String(params[0])));
        return rows([{}]);
      }
      const view = visible();
      if (/^SELECT tba\.target::text AS slot/.test(sql)) {
        await delay(5); // a slow read: without the lock the other transaction reads the same state
        const usage = [...view.pages].filter(([slot]) => slot !== 'lesson_author')
          .map(([slot, bot]) => ({ slot, bot_id: bot, kb_id: view.bots.get(bot) ?? null, kb_name: `KB ${view.bots.get(bot)}` }));
        if (view.aiIdKb) usage.push({ slot: 'ai_id' as never, bot_id: null as never, kb_id: view.aiIdKb, kb_name: 'KB AI ID' });
        if (view.contextKb) usage.push({ slot: 'ai_id_context' as never, bot_id: null as never, kb_id: view.contextKb, kb_name: 'KB context' });
        return rows(usage);
      }
      if (/^SELECT kb_id::text AS kb_id FROM chatbots/.test(sql)) {
        const bot = String(params[0]);
        return rows(view.bots.has(bot) ? [{ kb_id: view.bots.get(bot) }] : []);
      }
      if (/^SELECT id FROM chatbots WHERE id = \$1 AND tenant_id = \$2/.test(sql)) {
        return rows(view.bots.has(String(params[0])) ? [{ id: params[0] }] : []);
      }
      if (/^SELECT c\.\*, kb\.name AS kb_name FROM chatbots c/.test(sql)) {
        const bot = String(params[0]);
        return rows(view.bots.has(bot) ? [{ id: bot, tenant_id: TENANT, kb_id: view.bots.get(bot), name: 'Bot', config: {} }] : []);
      }
      if (/^SELECT kb\.id FROM knowledgebases kb WHERE kb\.id = \$1/.test(sql)) {
        return rows(params[0] === view.contextKb ? [] : [{ id: params[0] }]);
      }
      if (/FROM tenant_ai_settings s/.test(sql)) {
        return rows([{ tenant_id: TENANT, active_engine: 'self_built_rag', provider: 'google_ai_studio', token_timezone: 'Asia/Saigon',
          chat_model: 'm', lesson_author_model: 'm', embedding_model: 'gemini-embedding-001', embedding_dimensions: 768,
          transition_state: 'idle', active_transition_job_id: null, encrypted_api_key: null, api_key_fingerprint: null }]);
      }
      if (/^INSERT INTO tenant_bot_assignments/.test(sql)) {
        const [, target, bot] = params as [string, 'admin' | 'learner' | 'lesson_author', string];
        pending.push(target_ => { target_.pages.set(target, bot); });
        return rows([]);
      }
      if (/^INSERT INTO tenant_kb_assignments/.test(sql)) {
        const kb = String(params[2]);
        pending.push(target_ => { target_.aiIdKb = kb; });
        return rows([]);
      }
      if (/^UPDATE chatbots SET/.test(sql)) {
        const kbParam = /kb_id = \$(\d+)/.exec(sql);
        const bot = String(params.at(-2));
        if (kbParam) {
          const kb = params[Number(kbParam[1]) - 1] as string | null;
          pending.push(target_ => { target_.bots.set(bot, kb); });
        }
        return rows([{ id: bot, tenant_id: TENANT, kb_id: kbParam ? params[Number(kbParam[1]) - 1] : view.bots.get(bot), name: 'Bot' }]);
      }
      return rows([]);
    };
  }

  const outside = client(0);
  t.mock.method(pg.default.Pool.prototype, 'query', (text: unknown, params?: unknown[]) => outside(text, params));
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => {
    const id = ++clients;
    return { query: client(id), release: () => undefined, on: () => undefined, off: () => undefined };
  });
  for (const method of ['log', 'info', 'warn', 'error'] as const) t.mock.method(console, method, () => undefined);
  return { statements };
}

function call(body: unknown, params: Record<string, string> = {}, locale?: 'en') {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const res = { status(code: number) { out.status = code; return this; },
    json(value: Record<string, unknown>) { out.body = value; return this; }, setHeader: () => undefined } as unknown as Response;
  const headers: Record<string, string> = locale ? { 'x-ui-locale': locale } : {};
  const req = { params, query: {}, body, headers, get: (name: string) => headers[name.toLowerCase()], ip: '127.0.0.1', socket: {},
    user: { id: USER, tenantId: TENANT, role: 'superuser', username: 'u', sessionMode: 'normal' } } as unknown as Request;
  return { req, res, out };
}

const writes = (statements: Array<{ sql: string }>) =>
  statements.filter(({ sql }) => /^(INSERT INTO tenant_bot_assignments|INSERT INTO tenant_kb_assignments|UPDATE chatbots)/.test(sql));

// ── Pure rule ──

test('a write clashes only with the usages it does not touch; null never clashes', () => {
  const usages = [
    { slot: 'admin' as const, bot_id: BOT_A, kb_id: KB_1, kb_name: 'One' },
    { slot: 'learner' as const, bot_id: BOT_B, kb_id: KB_2, kb_name: 'Two' },
    { slot: 'ai_id' as const, bot_id: null, kb_id: KB_3, kb_name: 'Three' },
    { slot: 'ai_id_context' as const, bot_id: null, kb_id: KB_CONTEXT, kb_name: 'Context' },
  ];
  assert.deepEqual(logic.findKbUsageClash(usages, { slots: ['admin'], kbId: KB_3 }), { used_by: ['ai_id'], same_bot_on_both_pages: false });
  assert.deepEqual(logic.findKbUsageClash(usages, { slots: ['learner'], kbId: KB_1 }), { used_by: ['admin'], same_bot_on_both_pages: false });
  assert.deepEqual(logic.findKbUsageClash(usages, { slots: ['ai_id'], kbId: KB_2 }), { used_by: ['learner'], same_bot_on_both_pages: false });
  // The page being written keeps nothing of its old knowledge base; the hidden context one is AI ID's.
  assert.equal(logic.findKbUsageClash(usages, { slots: ['admin'], kbId: KB_1 }), null);
  assert.deepEqual(logic.findKbUsageClash(usages, { slots: ['admin'], kbId: KB_CONTEXT }), { used_by: ['ai_id'], same_bot_on_both_pages: false });
  assert.equal(logic.findKbUsageClash(usages, { slots: ['admin'], kbId: null }), null);
  assert.equal(logic.findKbUsageClash(usages, { slots: ['admin'], kbId: 'c0000000-0000-4000-8000-000000000099' }), null);
  // One bot on both pages: they would share its knowledge base.
  assert.deepEqual(logic.findKbUsageClash(usages, { slots: ['admin', 'learner'], kbId: 'c0000000-0000-4000-8000-000000000099' }),
    { used_by: [], same_bot_on_both_pages: true });
  assert.deepEqual(logic.findKbUsageClash(usages, { slots: ['admin', 'learner'], kbId: KB_3 }), { used_by: ['ai_id'], same_bot_on_both_pages: true });
});

test('existing conflicts: every knowledge base in two or more places, used_by in a fixed order, nothing else', () => {
  assert.deepEqual(logic.kbUsageConflicts([
    { slot: 'ai_id', bot_id: null, kb_id: KB_1, kb_name: 'Sổ tay' },
    { slot: 'learner', bot_id: BOT_A, kb_id: KB_1, kb_name: 'Sổ tay' },
    { slot: 'admin', bot_id: BOT_A, kb_id: KB_1, kb_name: 'Sổ tay' },
    { slot: 'ai_id_context', bot_id: null, kb_id: KB_CONTEXT, kb_name: 'Context' },
  ]), [{ kb_id: KB_1, kb_name: 'Sổ tay', used_by: ['admin', 'learner', 'ai_id'] }]);
  assert.deepEqual(logic.kbUsageConflicts([
    { slot: 'admin', bot_id: BOT_A, kb_id: KB_CONTEXT, kb_name: null },
    { slot: 'ai_id_context', bot_id: null, kb_id: KB_CONTEXT, kb_name: 'Context' },
    { slot: 'learner', bot_id: BOT_B, kb_id: null, kb_name: null },
    { slot: 'ai_id', bot_id: null, kb_id: KB_2, kb_name: 'Two' },
  ]), [{ kb_id: KB_CONTEXT, kb_name: 'Context', used_by: ['admin', 'ai_id'] }]);
  assert.deepEqual(logic.kbUsageConflicts([]), []);
});

test('the refusal names where the knowledge base is used, in plain Vietnamese and English', () => {
  assert.match(logic.kbUsageClashMessage({ used_by: ['ai_id'], same_bot_on_both_pages: false }, 'vi'),
    /^Kho tri thức này đang được dùng cho AI ID\. /);
  assert.match(logic.kbUsageClashMessage({ used_by: ['admin', 'learner'], same_bot_on_both_pages: false }, 'vi'),
    /^Kho tri thức này đang được dùng cho trợ lý trang quản trị và trợ lý trang học viên\. /);
  assert.match(logic.kbUsageClashMessage({ used_by: ['admin', 'learner', 'ai_id'], same_bot_on_both_pages: false }, 'en'),
    /^This knowledge base is already used by the admin page assistant, the learner page assistant and AI ID\. /);
  assert.match(logic.kbUsageClashMessage({ used_by: [], same_bot_on_both_pages: true }, 'vi'),
    /^Trợ lý này đang được gán cho cả trang quản trị và trang học viên/);
  assert.equal(logic.kbUsageLockKey(TENANT), LOCK_KEY);
});

// ── Each write path ──

test('PUT /bots/assignments: a bot whose knowledge base AI ID or the other page uses is refused, nothing written', async t => {
  const chat = await import('./chat.service.js');
  const aiId = database(t, state({ admin: BOT_A, aiIdKb: KB_3 }));
  await assert.rejects(chat.assignBot(TENANT, 'learner', BOT_C), { statusCode: 409, code: 'AI_CHATBOT_KB_ALREADY_USED',
    message: /đang được dùng cho AI ID/ });
  assert.deepEqual(writes(aiId.statements), []);
  // The lock is the first statement of the transaction after the bot check, before the usage read.
  const sqls = aiId.statements.filter(({ client }) => client === 1).map(({ sql }) => sql);
  assert.equal(sqls[0], 'BEGIN');
  assert.match(sqls[1], /^SELECT id FROM chatbots/);
  assert.match(sqls[2], /pg_advisory_xact_lock/);
  assert.equal(aiId.statements.find(({ sql }) => /pg_advisory_xact_lock/.test(sql))?.params[0], LOCK_KEY);
  assert.match(sqls[3], /^SELECT tba\.target::text AS slot/);
  assert.equal(sqls.at(-1), 'ROLLBACK');

  const samePage = database(t, state({ admin: BOT_A }));
  await assert.rejects(chat.assignBot(TENANT, 'learner', BOT_A), { statusCode: 409, message: /đang được dùng cho trợ lý trang quản trị/ });
  assert.deepEqual(writes(samePage.statements), []);
});

test('PUT /bots/assignments: a free knowledge base, the same bot again and a bot without one pass', async t => {
  const chat = await import('./chat.service.js');
  const db = state({ admin: BOT_A, aiIdKb: KB_3, bots: { [BOT_A]: KB_1, [BOT_B]: KB_2, [BOT_C]: null } });
  const free = database(t, db);
  await chat.assignBot(TENANT, 'learner', BOT_B);
  assert.equal(db.pages.get('learner'), BOT_B);
  await chat.assignBot(TENANT, 'learner', BOT_C);
  assert.equal(db.pages.get('learner'), BOT_C);
  assert.equal(writes(free.statements).length, 2);

  // Re-assigning the bot a page already has creates no clash, even where one already exists.
  const existing = state({ admin: BOT_A, learner: BOT_A, aiIdKb: KB_1 });
  database(t, existing);
  await chat.assignBot(TENANT, 'admin', BOT_A);
  assert.equal(existing.pages.get('admin'), BOT_A);
});

test('PUT /bots/assignments: target lesson_author does not count (AI ID never reads its bot knowledge base)', async t => {
  const chat = await import('./chat.service.js');
  const db = state({ admin: BOT_A, aiIdKb: KB_1 });
  const run = database(t, db);
  await chat.assignBot(TENANT, 'lesson_author', BOT_A);
  assert.equal(db.pages.get('lesson_author'), BOT_A);
  assert.equal(run.statements.some(({ sql }) => /pg_advisory_xact_lock|AS slot/.test(sql)), false);
});

test('PUT /bots/assignments: a bot on the hidden organization context knowledge base is refused as AI ID', async t => {
  const chat = await import('./chat.service.js');
  database(t, state({ bots: { [BOT_A]: KB_CONTEXT } }));
  await assert.rejects(chat.assignBot(TENANT, 'admin', BOT_A), { statusCode: 409, message: /đang được dùng cho AI ID/ });
});

test('PUT /lesson-author/kb-assignment: a page knowledge base is refused; the hidden context one is not found', async t => {
  const chat = await import('./chat.service.js');
  const run = database(t, state({ admin: BOT_A, learner: BOT_B }));
  await assert.rejects(chat.assignLessonAuthorKb(TENANT, KB_2), { statusCode: 409, code: 'AI_CHATBOT_KB_ALREADY_USED',
    message: /đang được dùng cho trợ lý trang học viên/ });
  await assert.rejects(chat.assignLessonAuthorKb(TENANT, KB_CONTEXT), { statusCode: 404 });
  assert.deepEqual(writes(run.statements), []);

  const db = state({ admin: BOT_A, learner: BOT_B, aiIdKb: KB_3 });
  database(t, db);
  await chat.assignLessonAuthorKb(TENANT, KB_3); // unchanged
  await chat.assignLessonAuthorKb(TENANT, 'c0000000-0000-4000-8000-000000000004');
  assert.equal(db.aiIdKb, 'c0000000-0000-4000-8000-000000000004');
});

test('PUT /bots/:id: a page bot cannot move to a used knowledge base; unassigned bots and unchanged ones pass', async t => {
  const bots = await import('./bot.service.js');
  const used = database(t, state({ admin: BOT_A, learner: BOT_B, aiIdKb: KB_3 }));
  await assert.rejects(bots.updateBot(BOT_A, TENANT, { kb_id: KB_3 }), { statusCode: 409, message: /đang được dùng cho AI ID/ });
  await assert.rejects(bots.updateBot(BOT_B, TENANT, { kb_id: KB_1 }), { statusCode: 409, message: /trợ lý trang quản trị/ });
  assert.deepEqual(writes(used.statements), []);

  // The same bot on both pages: any knowledge base would be shared by them.
  database(t, state({ admin: BOT_A, learner: BOT_A }));
  await assert.rejects(bots.updateBot(BOT_A, TENANT, { kb_id: KB_2 }), { statusCode: 409,
    message: /^Trợ lý này đang được gán cho cả trang quản trị và trang học viên/ });

  const db = state({ admin: BOT_A, learner: BOT_A, aiIdKb: KB_1 });
  database(t, db);
  await bots.updateBot(BOT_A, TENANT, { kb_id: KB_1, name: 'Bot' }); // unchanged: an existing clash is not this write's
  await bots.updateBot(BOT_C, TENANT, { kb_id: KB_1 }); // not on a page
  assert.equal(db.bots.get(BOT_C), KB_1);
  await bots.updateBot(BOT_A, TENANT, { kb_id: null }); // no knowledge base never clashes
  assert.equal(db.bots.get(BOT_A), null);
});

// ── The race, through the lock ──

test('two concurrent writes of one tenant: the lock serializes them and exactly one is refused', async t => {
  const chat = await import('./chat.service.js');
  const bots = await import('./bot.service.js');
  const scenarios: Array<[string, () => Promise<unknown>, () => Promise<unknown>, State]> = [
    ['AI ID assignment vs admin page assignment', () => chat.assignLessonAuthorKb(TENANT, KB_3),
      () => chat.assignBot(TENANT, 'admin', BOT_C), state()],
    ['admin vs learner page assignment of bots on one knowledge base', () => chat.assignBot(TENANT, 'admin', BOT_A),
      () => chat.assignBot(TENANT, 'learner', BOT_C), state({ bots: { [BOT_A]: KB_1, [BOT_C]: KB_1 } })],
    ['a page bot knowledge base change vs AI ID assignment', () => bots.updateBot(BOT_A, TENANT, { kb_id: KB_3 }),
      () => chat.assignLessonAuthorKb(TENANT, KB_3), state({ admin: BOT_A })],
  ];
  for (const [name, first, second, db] of scenarios) {
    const run = database(t, db);
    const outcomes = await Promise.allSettled([first(), second()]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1, name);
    const refused = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
    assert.equal(refused.reason.code, 'AI_CHATBOT_KB_ALREADY_USED', name);
    assert.deepEqual(logic.kbUsageConflicts(usagesOf(db)), [], `${name}: no clash committed`);
    assert.equal(run.statements.filter(({ sql, params }) => /pg_advisory_xact_lock/.test(sql) && params[0] === LOCK_KEY).length, 2, name);
  }
});

test('control: without the lock the same interleaving commits a clash (the test would catch a missing lock)', async t => {
  const chat = await import('./chat.service.js');
  const db = state();
  database(t, db, { lockless: true });
  const outcomes = await Promise.allSettled([chat.assignLessonAuthorKb(TENANT, KB_3), chat.assignBot(TENANT, 'admin', BOT_C)]);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(logic.kbUsageConflicts(usagesOf(db)).map(conflict => conflict.used_by), [['admin', 'ai_id']]);
});

function usagesOf(db: State) {
  const rows: Array<Parameters<typeof logic.kbUsageConflicts>[0][number]> = [...db.pages]
    .filter(([slot]) => slot !== 'lesson_author')
    .map(([slot, bot]) => ({ slot: slot as 'admin' | 'learner', bot_id: bot, kb_id: db.bots.get(bot) ?? null, kb_name: null }));
  if (db.aiIdKb) rows.push({ slot: 'ai_id', bot_id: null, kb_id: db.aiIdKb, kb_name: null });
  return rows;
}

// ── HTTP ──

test('the refusal is the sendError shape with the code, in the UI language', async t => {
  const controller = await import('./chat.controller.js');
  const botController = await import('./bot.controller.js');
  database(t, state({ admin: BOT_A, aiIdKb: KB_3 }));
  const vi = call({ target: 'learner', bot_id: BOT_C });
  await controller.assignBot(vi.req, vi.res);
  assert.equal(vi.out.status, 409);
  assert.deepEqual(Object.keys(vi.out.body ?? {}).sort(), ['code', 'error', 'message', 'success']);
  assert.equal(vi.out.body?.code, 'AI_CHATBOT_KB_ALREADY_USED');
  assert.equal(vi.out.body?.error, 'AI_CHATBOT_KB_ALREADY_USED');
  assert.match(String(vi.out.body?.message), /^Kho tri thức này đang được dùng cho AI ID\./);

  const en = call({ kb_id: KB_1 }, {}, 'en');
  await controller.assignLessonAuthorKb(en.req, en.res);
  assert.equal(en.out.status, 409);
  assert.match(String(en.out.body?.message), /^This knowledge base is already used by the admin page assistant\./);

  const update = call({ kb_id: KB_3 }, { id: BOT_A });
  await botController.updateBot(update.req, update.res);
  assert.equal(update.out.status, 409);
  assert.equal(update.out.body?.code, 'AI_CHATBOT_KB_ALREADY_USED');
});

test('GET /kb-usage-conflicts lists the existing clashes and changes nothing', async t => {
  const { getKbUsageConflicts } = await import('./kb-usage.controller.js');
  const run = database(t, state({ admin: BOT_A, learner: BOT_A, aiIdKb: KB_1 }));
  const { req, res, out } = call({});
  await getKbUsageConflicts(req, res);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { success: true, data: { conflicts: [
    { kb_id: KB_1, kb_name: `KB ${KB_1}`, used_by: ['admin', 'learner', 'ai_id'] },
  ] } });
  assert.deepEqual(writes(run.statements), []);
  assert.equal(run.statements.some(({ sql }) => /pg_advisory_xact_lock/.test(sql)), false);
  assert.ok(run.statements.every(({ sql, params }) => !/AS slot/.test(sql) || params[0] === TENANT));
});
