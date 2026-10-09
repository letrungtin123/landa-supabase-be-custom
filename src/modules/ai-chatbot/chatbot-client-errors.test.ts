import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';

// S2 T9: AI chatbot controllers never send database/storage text to the
// browser, and malformed ids or cursors are refused before any query.

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a0000000-0000-4000-8000-0000000000c9';

function call(params: Record<string, string>, query: Record<string, unknown> = {}, body: unknown = {}) {
  const out: { status?: number; body?: { message?: string; code?: string } } = {};
  const res = {
    status(code: number) { out.status = code; return this; },
    json(value: unknown) { out.body = value as typeof out.body; return this; },
  } as unknown as Response;
  const req = {
    params, query, body, headers: {},
    user: { id: USER, tenantId: TENANT, role: 'staff', username: 'u', sessionMode: 'normal' },
    get: () => undefined,
  } as unknown as Request;
  return { req, res, out };
}

test('malformed bot, knowledge base and document ids are not found, without a query', async (t) => {
  const pg = await import('pg');
  const queries = t.mock.method(pg.default.Pool.prototype, 'query', async () => { throw new Error('must not query'); });
  const bot = await import('./bot.controller.js');
  const kb = await import('./kb.controller.js');
  for (const [handler, params] of [
    [bot.getBot, { id: "1' OR 1=1" }],
    [bot.updatePersona, { id: '2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008', personaId: 'abc' }],
    [kb.getKb, { id: 'not-a-uuid' }],
    [kb.deleteDocument, { kbId: '2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008', docId: 'x' }],
  ] as const) {
    const { req, res, out } = call(params as Record<string, string>);
    await (handler as (req: Request, res: Response) => Promise<void>)(req, res);
    assert.equal(out.status, 404);
  }
  assert.equal(queries.mock.callCount(), 0);
});

test('a database failure while creating a bot is answered with a plain message', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const pg = await import('pg');
  const failure = Object.assign(new Error('duplicate key value violates unique constraint "chatbots_tenant_name_key"'), { code: '23505' });
  t.mock.method(pg.default.Pool.prototype, 'query', async () => { throw failure; });
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: async () => { throw failure; }, release: () => undefined }));
  const bot = await import('./bot.controller.js');
  const { req, res, out } = call({}, {}, { name: 'Trợ lý', description: 'x' });
  await bot.createBot(req, res);
  assert.equal(out.status, 500);
  assert.equal(out.body?.code, 'REQUEST_FAILED');
  assert.doesNotMatch(String(out.body?.message), /duplicate|constraint|chatbots/);
});

test('a chat history cursor must be an ISO timestamp', async (t) => {
  const pg = await import('pg');
  const queries = t.mock.method(pg.default.Pool.prototype, 'query', async () => ({ rows: [], rowCount: 0 }));
  const chat = await import('./chat.controller.js');
  for (const cursor of ["2026-10-09'; DROP TABLE x; --", ['2026-10-09T00:00:00Z', 'b'], 'yesterday']) {
    const { req, res, out } = call({ id: '2a1f4063-3d34-4e1a-a7f3-11ee0ac0a008' }, { cursor });
    await chat.getMessages(req, res);
    assert.equal(out.status, 400);
  }
  assert.equal(queries.mock.callCount(), 0);
});
