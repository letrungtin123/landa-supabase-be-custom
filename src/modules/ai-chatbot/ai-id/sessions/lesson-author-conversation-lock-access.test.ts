import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';
import pg from 'pg';

// The AI ID conversation lock checks who may use the conversation BEFORE it
// takes the lock (as the chat stream since a9eaef3): a user of the same
// tenant who knows the id of another user's conversation gets the same
// answer whether or not it is busy, never "already active". No database or
// Redis: a pg double answers the ownership reads; "busy" is this process's
// lock set.

process.env.REDIS_URL = 'redis://127.0.0.1:1';

const { withLessonAuthorConversationLock } = await import('../../chat/chat.service.js');
const { streamLocks } = await import('../../chat/chat-turn-runtime.service.js');
const { deleteLessonAuthorSessionController } = await import('./lesson-author-session.controller.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'a0000000-0000-4000-8000-000000000002';
const CONVERSATION = 'c0000000-0000-4000-8000-000000000001';
const NOT_FOUND = { statusCode: 404, message: 'Cuộc hội thoại không tồn tại' };

interface Statement { text: string; params: unknown[] }

/** Answers the conversation owner read (assertChatConversationOwner) and the session creator read. */
function installDb(t: TestContext, owner: string | null): Statement[] {
  const statements: Statement[] = [];
  const query = async (text: string, params: unknown[] = []) => {
    statements.push({ text, params });
    if (/FROM chat_conversations cc/.test(text)) {
      const rows = owner && params[1] === owner ? [{ id: CONVERSATION }] : [];
      return { rows, rowCount: rows.length };
    }
    if (/AS owner_id/.test(text)) {
      const rows = owner ? [{ owner_id: owner }] : [];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  t.mock.method(pg.Pool.prototype, 'query', query);
  t.mock.method(pg.Pool.prototype, 'connect', async () => ({ query, release() {} }));
  return statements;
}

function busy(t: TestContext) {
  streamLocks.add(CONVERSATION);
  t.after(() => streamLocks.delete(CONVERSATION));
}

const neverRuns = async () => assert.fail('the work must not run');

test('lock: another user\'s conversation answers 404 whether or not it is busy, before any lock', async t => {
  const statements = installDb(t, OWNER);
  await assert.rejects(withLessonAuthorConversationLock(CONVERSATION, neverRuns, { userId: OTHER, tenantId: TENANT }), NOT_FOUND);
  assert.equal(streamLocks.has(CONVERSATION), false);
  busy(t);
  await assert.rejects(withLessonAuthorConversationLock(CONVERSATION, neverRuns, { userId: OTHER, tenantId: TENANT }), NOT_FOUND);
  const ownerReads = statements.filter(statement => /FROM chat_conversations cc/.test(statement.text));
  assert.deepEqual(ownerReads.map(statement => statement.params), [
    [CONVERSATION, OTHER, TENANT, 'lesson_author'],
    [CONVERSATION, OTHER, TENANT, 'lesson_author'],
  ]);
});

test('lock: the owner of a busy conversation is still told it is active', async t => {
  installDb(t, OWNER);
  busy(t);
  await assert.rejects(withLessonAuthorConversationLock(CONVERSATION, neverRuns, { userId: OWNER, tenantId: TENANT }), {
    code: 'GENERATION_ALREADY_ACTIVE',
  });
});

test('lock: a custom access check runs first and its refusal is the answer', async t => {
  installDb(t, OWNER);
  busy(t);
  const refusal = new Error('refused by the check');
  await assert.rejects(withLessonAuthorConversationLock(CONVERSATION, neverRuns, { check: async () => { throw refusal; } }), refusal);
});

/** DELETE of a design session, answered by the session controller. */
async function deleteSession(user: { id: string; role: string }) {
  let resolve!: (value: { status: number; body: { code?: string } }) => void;
  const answered = new Promise<{ status: number; body: { code?: string } }>(done => { resolve = done; });
  let status = 200;
  const res = {
    setHeader() { return res; },
    status(code: number) { status = code; return res; },
    json(body: { code?: string }) { resolve({ status, body }); return res; },
  } as unknown as Response;
  const req = {
    user: { ...user, tenantId: TENANT, username: 'u', sessionMode: 'normal' },
    params: { courseId: 'course-1', conversationId: CONVERSATION },
    query: {},
    headers: {},
    get: () => undefined,
  } as unknown as Request;
  deleteLessonAuthorSessionController(req, res, error => resolve({ status: 500, body: { code: String(error) } }));
  const { status: code, body } = await answered;
  return [code, body.code];
}

test('session delete: a missing session and one the caller may not manage answer the same, busy or not', async t => {
  installDb(t, null);
  const missing = await deleteSession({ id: OTHER, role: 'staff' });
  assert.deepEqual(missing, [404, 'LESSON_AUTHOR_SESSION_NOT_FOUND']);
  busy(t);
  assert.deepEqual(await deleteSession({ id: OTHER, role: 'staff' }), missing);
  t.mock.restoreAll();

  installDb(t, OWNER);
  assert.deepEqual(await deleteSession({ id: OTHER, role: 'staff' }), [403, 'LESSON_AUTHOR_SESSION_MANAGE_FORBIDDEN']);
});

test('session delete: the creator of a busy session is still told it is active', async t => {
  installDb(t, OWNER);
  busy(t);
  assert.deepEqual(await deleteSession({ id: OWNER, role: 'staff' }), [409, 'LESSON_AUTHOR_SESSION_ACTIVE']);
});
