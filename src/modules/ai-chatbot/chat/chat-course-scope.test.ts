import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';

// S1 C10: a runtime chat may only use a course of the caller's tenant (and,
// for learners, one they may open). In-memory pg double; no AI/network call.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const COURSE_A = 'course-v1:A+open';
const COURSE_A_LOCKED = 'course-v1:A+locked';
const COURSE_B = 'course-v1:B+secret';
const STAFF_A = 'a0000000-0000-4000-8000-000000000001';
const LEARNER_A = 'a0000000-0000-4000-8000-000000000002';
const BOT = 'b0000000-0000-4000-8000-000000000001';
const PERSONA = 'b0000000-0000-4000-8000-000000000002';
const CONVERSATION = 'c0000000-0000-4000-8000-000000000001';

const courses = new Map([[COURSE_A, TENANT_A], [COURSE_A_LOCKED, TENANT_A], [COURSE_B, TENANT_B]]);
const learnerCanOpen = new Set([`${LEARNER_A}:${COURSE_A}`]);

interface FakeDb { calls: string[]; storedCourseId: string | null }

async function installFakeDb(t: TestContext, db: FakeDb): Promise<void> {
  const pg = await import('pg');
  const handle = async (text: string | { text: string }, params: unknown[] = []) => {
    const sql = typeof text === 'string' ? text : text.text;
    db.calls.push(sql);
    const empty = { rows: [] as unknown[], rowCount: 0 };
    const one = (row: unknown) => ({ rows: [row], rowCount: 1 });
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) || sql.includes('pg_advisory_xact_lock')) return empty;
    if (/SELECT c\.id\s+FROM courses c/.test(sql)) {
      const inTenant = courses.get(String(params[0])) === params[1];
      const learnerRule = sql.includes('visible_to_staff_only');
      const allowed = inTenant && (!learnerRule || learnerCanOpen.has(`${params[2]}:${params[0]}`));
      return allowed ? one({ id: params[0] }) : empty;
    }
    if (sql.includes('FROM tenant_bot_assignments tba') && sql.includes('bot_name')) {
      return one({ tenant_id: params[0], target: params[1], bot_id: BOT, bot_name: 'Bot' });
    }
    if (sql.includes('WITH counts AS')) return one({ conv_count: 0, persona_valid: true, assignment_valid: true });
    if (/^\s*INSERT INTO chat_conversations/.test(sql)) return one({ id: CONVERSATION, course_id: params[5] });
    if (sql.includes('WITH conv AS')) {
      return one({
        id: CONVERSATION, tenant_id: params[2], bot_id: BOT, target: 'admin', course_id: db.storedCourseId,
        bot_kb_id: null, custom_prompt: null, template_prompt: 'prompt', bot_config: {}, msg_count: 0,
      });
    }
    return empty;
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release: () => undefined }));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no network in tests'); });
}

function response() {
  const out: { status?: number; body?: Record<string, unknown>; streamed?: boolean } = {};
  const res = {
    status(code: number) { out.status = code; return this; },
    json(body: Record<string, unknown>) { out.body = body; return this; },
    writeHead() { out.streamed = true; return this; },
  } as unknown as Response;
  return { out, res };
}

const user = (id: string, role: string) => ({ id, role, tenantId: TENANT_A, username: role, sessionMode: 'normal' });

test('createConversation refuses another tenant\'s course and a course the learner cannot open', async (t) => {
  const db: FakeDb = { calls: [], storedCourseId: null };
  await installFakeDb(t, db);
  const { createConversation } = await import('./chat.controller.js');

  for (const [actor, courseId, target] of [
    [user(STAFF_A, 'staff'), COURSE_B, 'admin'],
    [user(LEARNER_A, 'learner'), COURSE_B, 'learner'],
    [user(LEARNER_A, 'learner'), COURSE_A_LOCKED, 'learner'],
  ] as const) {
    const { out, res } = response();
    await createConversation({
      user: actor, query: {}, body: { persona_id: PERSONA, courseId, target },
      get: (name: string) => (name.toLowerCase() === 'x-ui-locale' ? 'en' : undefined),
    } as unknown as Request, res);
    assert.equal(out.status, 404, `${actor.role} ${courseId}`);
    assert.equal(out.body?.code, 'CHAT_COURSE_NOT_AVAILABLE');
    assert.match(String(out.body?.message), /do not have access/);
  }
  assert.equal(db.calls.some((sql) => /INSERT INTO chat_conversations/.test(sql)), false);
});

test('same-tenant chat keeps working: staff and an enrolled learner create course conversations', async (t) => {
  const db: FakeDb = { calls: [], storedCourseId: null };
  await installFakeDb(t, db);
  const { createConversation } = await import('./chat.controller.js');

  for (const [actor, target] of [[user(STAFF_A, 'staff'), 'admin'], [user(LEARNER_A, 'learner'), 'learner']] as const) {
    const { out, res } = response();
    await createConversation({
      user: actor, query: {}, body: { persona_id: PERSONA, courseId: COURSE_A, target }, get: () => undefined,
    } as unknown as Request, res);
    assert.equal(out.status, 200, actor.role);
  }
  assert.equal(db.calls.filter((sql) => /INSERT INTO chat_conversations/.test(sql)).length, 2);
});

test('a message cannot pull another tenant\'s outline or lessons, whether the course comes from the client or the stored row', async (t) => {
  const { sendMessage } = await import('./chat.controller.js');
  const chatService = await import('./chat.service.js');

  // Client courseId on a conversation without a stored course: refused before streaming.
  {
    const db: FakeDb = { calls: [], storedCourseId: null };
    await installFakeDb(t, db);
    const { out, res } = response();
    await sendMessage({
      user: user(STAFF_A, 'staff'), params: { id: CONVERSATION }, query: {},
      body: { content: 'Tóm tắt bài 1', courseId: COURSE_B, target: 'admin' },
      get: () => undefined, header: () => undefined,
    } as unknown as Request, res);
    assert.equal(out.status, 404);
    assert.equal(out.body?.code, 'CHAT_COURSE_NOT_AVAILABLE');
    assert.equal(out.streamed, undefined);
    assert.equal(db.calls.some((sql) => sql.includes('FROM course_blocks')), false);
    t.mock.restoreAll();
  }
  // A stored course of another tenant (row written before this fix).
  {
    const db: FakeDb = { calls: [], storedCourseId: COURSE_B };
    await installFakeDb(t, db);
    let failure: (Error & { code?: string }) | undefined;
    await chatService.sendMessageStream(
      CONVERSATION, STAFF_A, TENANT_A, 'Tóm tắt bài 1',
      { target: 'admin', mode: 'chat', reportActorRole: 'staff' },
      () => undefined, () => undefined, (err) => { failure = err; },
    );
    assert.equal(failure?.code, 'CHAT_COURSE_NOT_AVAILABLE');
    assert.equal(db.calls.some((sql) => sql.includes('FROM course_blocks')), false);
  }
});
