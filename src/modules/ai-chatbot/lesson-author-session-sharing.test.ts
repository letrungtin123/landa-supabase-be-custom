import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import {
  LESSON_AUTHOR_SESSION_ERRORS,
  LessonAuthorSessionError,
  canManageLessonAuthorSession,
  lessonAuthorRequestLocale,
  lessonAuthorSessionOwnerName,
  lessonAuthorSessionPermissions,
  parseLessonAuthorSessionScope,
} from './lesson-author-session-access.logic.js';
import {
  createLessonAuthorActiveRunsHandler,
  createLessonAuthorCourseEditorGuard,
  createLessonAuthorSessionOwnerGuard,
} from './lesson-author-session-access.controller.js';

// Shared AI course design sessions (owner decision 2026-10-09). No network or
// real database: the session service runs against an in-memory pg double.

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CREATOR = 'a0000000-0000-4000-8000-000000000001';
const EDITOR = 'a0000000-0000-4000-8000-000000000002';
const SUPERUSER = 'a0000000-0000-4000-8000-000000000003';
const SUPERADMIN = 'a0000000-0000-4000-8000-000000000004';
const NO_COURSE_EDIT = 'a0000000-0000-4000-8000-000000000005';
const OTHER_TENANT_EDITOR = 'a0000000-0000-4000-8000-000000000006';
const CONV_CREATOR = 'c0000000-0000-4000-8000-000000000001';
const CONV_EDITOR = 'c0000000-0000-4000-8000-000000000002';
const CONV_OTHER_TENANT = 'c0000000-0000-4000-8000-000000000003';
const JOB = 'd0000000-0000-4000-8000-000000000001';
const COURSE = 'course-v1:Nesso+SHARE+2026';

type Role = AuthUser['role'];
const user = (id: string, role: Role, tenantId: string): AuthUser => ({ id, role, tenantId, username: id.slice(-4), sessionMode: 'normal' });
const ACTORS = {
  creator: user(CREATOR, 'staff', TENANT_A),
  editor: user(EDITOR, 'staff', TENANT_A),
  superuser: user(SUPERUSER, 'superuser', TENANT_A),
  // tenantContext has already put the selected tenant on a superadmin.
  superadmin: user(SUPERADMIN, 'superadmin', TENANT_A),
  noCourseEdit: user(NO_COURSE_EDIT, 'staff', TENANT_A),
  otherTenant: user(OTHER_TENANT_EDITOR, 'staff', TENANT_B),
};
const CAN_EDIT_COURSES = new Set([CREATOR, EDITOR, SUPERUSER, SUPERADMIN, OTHER_TENANT_EDITOR]);

interface Conversation { id: string; tenant_id: string; course_id: string; user_id: string; title: string; updated_at: string }
const NAMES: Record<string, { full_name: string | null; username: string }> = {
  [CREATOR]: { full_name: 'Nguyễn Văn Tạo', username: 'tao' },
  [EDITOR]: { full_name: null, username: 'bien.tap' },
  [OTHER_TENANT_EDITOR]: { full_name: 'Other Tenant', username: 'other' },
};

function conversations(): Conversation[] {
  return [
    { id: CONV_CREATOR, tenant_id: TENANT_A, course_id: COURSE, user_id: CREATOR, title: 'Phiên của người tạo', updated_at: '2026-10-09 02:00:00.000001+00' },
    { id: CONV_EDITOR, tenant_id: TENANT_A, course_id: COURSE, user_id: EDITOR, title: 'Phiên biên tập', updated_at: '2026-10-09 01:00:00.000001+00' },
    { id: CONV_OTHER_TENANT, tenant_id: TENANT_B, course_id: COURSE, user_id: OTHER_TENANT_EDITOR, title: 'Other tenant', updated_at: '2026-10-09 03:00:00.000001+00' },
  ];
}

interface FakeDb { conversations: Conversation[]; calls: Array<{ sql: string; params: unknown[] }>; claimedBy?: string }

/** Answers exactly the statements of lesson-author-session.service.ts. */
async function installFakeDb(t: TestContext, db: FakeDb): Promise<void> {
  const pg = await import('pg');
  const empty = { rows: [] as unknown[], rowCount: 0 };
  const rows = (list: unknown[]) => ({ rows: list, rowCount: list.length });
  const find = (id: unknown, tenant: unknown, course: unknown) => db.conversations
    .find(c => c.id === id && c.tenant_id === tenant && c.course_id === course);
  const handle = async (text: string | { text: string }, params: unknown[] = []) => {
    const sql = typeof text === 'string' ? text : text.text;
    db.calls.push({ sql, params });
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return empty;
    if (sql.includes('SELECT c.user_id::text AS owner_id') && sql.includes('JOIN courses course')) {
      const c = find(params[0], params[1], params[2]);
      return c ? rows([{ owner_id: c.user_id }]) : empty;
    }
    if (sql.includes('LEFT JOIN LATERAL') && sql.includes('FROM chat_conversations c')) {
      const [tenant, actor, course, , , limit, mine] = params;
      const list = db.conversations.filter(c => c.tenant_id === tenant && c.course_id === course && (!mine || c.user_id === actor))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, Number(limit))
        .map(c => ({ conversation_id: c.id, title: c.title, created_at: '2026-10-09T00:00:00.000Z', updated_at: c.updated_at,
          owner_id: c.user_id, owner_full_name: NAMES[c.user_id]?.full_name ?? null, owner_username: NAMES[c.user_id]?.username ?? null,
          workspace_id: c.id === CONV_CREATOR ? 'e0000000-0000-4000-8000-000000000001' : null,
          correlation_id: c.id === CONV_CREATOR ? 'f0000000-0000-4000-8000-000000000001' : null,
          content_locale: c.id === CONV_CREATOR ? 'vi' : null, workspace_status: c.id === CONV_CREATOR ? 'ready' : null }));
      return rows(list);
    }
    if (/^\s*UPDATE chat_conversations c/.test(sql)) {
      const c = find(params[2], params[0], params[1]);
      if (!c) return empty;
      c.title = String(params[3]);
      return rows([{ id: c.id, title: c.title, updated_at: '2026-10-09 04:00:00.000001+00' }]);
    }
    if (sql.includes('COUNT(DISTINCT n.id)::int AS total_nodes')) {
      return find(params[2], params[0], params[1]) ? rows([{ total_nodes: 5, applied_nodes: 2, active: false }]) : empty;
    }
    if (sql.includes('FROM lesson_author_session_deletion_jobs') && sql.includes('ORDER BY requested_at,id LIMIT 1 FOR UPDATE')) return empty;
    if (sql.includes('EXISTS (SELECT 1 FROM lesson_author_workspaces w')) return rows([{ active: false }]);
    if (/^\s*INSERT INTO lesson_author_session_deletion_jobs/.test(sql.trim()) || sql.includes('INSERT INTO lesson_author_session_deletion_jobs')) return rows([{ id: JOB }]);
    if (sql.includes('UPDATE lesson_author_session_deletion_jobs SET status=\'running\'')) {
      return rows([{ id: JOB, tenant_id: TENANT_A, course_id: COURSE, conversation_id: CONV_CREATOR, requested_by: db.claimedBy ?? SUPERUSER,
        status: 'running', attempts: 1, is_terminal: false }]);
    }
    if (sql.includes('SELECT c.user_id::text AS creator_id FROM chat_conversations c')) {
      const c = find(params[0], params[1], params[2]);
      return c ? rows([{ creator_id: c.user_id }]) : empty;
    }
    if (sql.includes('COUNT(DISTINCT w.id)::int AS workspaces')) return rows([{ blueprints: 1, workspaces: 1, nodes: 4, course_blocks: 2 }]);
    if (sql.includes('DELETE FROM chat_conversations')) return { rows: [], rowCount: 1 };
    return empty;
  };
  t.mock.method(pg.default.Pool.prototype, 'query', handle);
  t.mock.method(pg.default.Pool.prototype, 'connect', async () => ({ query: handle, release: () => undefined }));
}

const ownerScope = (actor: AuthUser) => ({ tenantId: actor.tenantId!, userId: actor.id, role: actor.role, courseId: COURSE });

async function rejectsWith(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LessonAuthorSessionError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.statusCode, status);
    return true;
  });
}

// ── Policy ────────────────────────────────────────────────────────────────

test('permission matrix: creator continues; superuser/superadmin manage; every course editor may Apply', () => {
  const cases: Array<[AuthUser, { is_owner: boolean; can_continue: boolean; can_rename: boolean; can_delete: boolean; can_apply: boolean }]> = [
    [ACTORS.creator, { is_owner: true, can_continue: true, can_rename: true, can_delete: true, can_apply: true }],
    [ACTORS.editor, { is_owner: false, can_continue: false, can_rename: false, can_delete: false, can_apply: true }],
    [ACTORS.superuser, { is_owner: false, can_continue: false, can_rename: true, can_delete: true, can_apply: true }],
    [ACTORS.superadmin, { is_owner: false, can_continue: false, can_rename: true, can_delete: true, can_apply: true }],
  ];
  for (const [actor, expected] of cases) assert.deepEqual(lessonAuthorSessionPermissions(actor, CREATOR), expected, actor.role);
  assert.equal(canManageLessonAuthorSession({ id: EDITOR, role: 'staff' }, CREATOR), false);
  assert.equal(canManageLessonAuthorSession({ id: 'x', role: 'learner_plus' }, CREATOR), false);
  assert.equal(parseLessonAuthorSessionScope(undefined), 'all');
  assert.equal(parseLessonAuthorSessionScope('mine'), 'mine');
  assert.equal(parseLessonAuthorSessionScope('everyone'), null);
  assert.equal(lessonAuthorSessionOwnerName('  Nguyễn   Văn  A ', 'a'), 'Nguyễn Văn A');
  assert.equal(lessonAuthorSessionOwnerName(null, 'bien.tap'), 'bien.tap');
  assert.equal(lessonAuthorRequestLocale('en', undefined), 'en');
  assert.equal(lessonAuthorRequestLocale(undefined, 'EN'), 'en');
  assert.equal(lessonAuthorRequestLocale(undefined, undefined), 'vi');
});

test('session refusals are plain VI/EN text: no status numbers, codes or tech words in the message', () => {
  for (const [code, [status, vi, en]] of Object.entries(LESSON_AUTHOR_SESSION_ERRORS)) {
    assert.ok([400, 403, 404, 409].includes(status), code);
    for (const message of [vi, en]) {
      assert.ok(message.length > 10, code);
      assert.doesNotMatch(message, /\b[1-5]\d\d\b/, `${code}: bare status code`);
      assert.doesNotMatch(message, /[A-Z][A-Z0-9]*_[A-Z0-9_]+/, `${code}: error-code token`);
      assert.doesNotMatch(message, /\b(AI ID|KB|lock|workspace|revision|hash|snapshot|receipt|session id)\b/i, `${code}: jargon`);
    }
    assert.doesNotMatch(vi, /\b(session|course|draft|apply)\b/i, `${code}: English word inside Vietnamese text`);
    const error = new LessonAuthorSessionError(code as keyof typeof LESSON_AUTHOR_SESSION_ERRORS);
    assert.equal(error.code, `LESSON_AUTHOR_SESSION_${code}`);
    assert.equal(error.localizedMessage('en'), en);
    assert.equal(error.localizedMessage('vi'), vi);
  }
});

// ── Write guard: only the creator continues a session ─────────────────────

function fakeRes() {
  const res = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; } };
  return res;
}
function fakeReq(actor: AuthUser | undefined, params: Record<string, string>, query: Record<string, string> = {}, header?: string) {
  return { user: actor, params, query, body: {}, get: (name: string) => name.toLowerCase() === 'x-ui-locale' ? header : undefined } as unknown as Request;
}
function guardDeps() {
  const calls: unknown[][] = [];
  return { calls, deps: {
    db: { query: async (_sql: string, params: unknown[] = []) => {
      calls.push(params);
      const c = conversations().find(item => item.id === params[0] && item.tenant_id === params[1] && (params[2] === null || item.course_id === params[2]));
      return { rows: c ? [{ owner_id: c.user_id, course_id: c.course_id }] : [], rowCount: c ? 1 : 0 };
    } } as never,
    canEditCourses: async (actor: AuthUser) => CAN_EDIT_COURSES.has(actor.id),
  } };
}
async function runGuard(guard: ReturnType<ReturnType<typeof createLessonAuthorSessionOwnerGuard>>, req: Request) {
  const res = fakeRes(); let nextCalled = false, nextError: unknown;
  await guard(req, res as unknown as Response, (error?: unknown) => { nextCalled = true; nextError = error; });
  return { res, nextCalled, nextError };
}

test('chat, launch, edits and transcriptions on someone else\'s session are refused with a localized 403', async () => {
  const { deps, calls } = guardDeps();
  const guard = createLessonAuthorSessionOwnerGuard(deps)('conversationId', { courseParam: 'courseId' });
  const params = { conversationId: CONV_CREATOR, courseId: COURSE };
  // The creator passes.
  assert.equal((await runGuard(guard, fakeReq(ACTORS.creator, params))).nextCalled, true);
  // Every other course editor is refused, including tenant and system admins.
  for (const actor of [ACTORS.editor, ACTORS.superuser, ACTORS.superadmin]) {
    const { res, nextCalled } = await runGuard(guard, fakeReq(actor, params, { ui_locale: 'en' }));
    assert.equal(nextCalled, false, actor.role);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { success: false, code: 'LESSON_AUTHOR_SESSION_NOT_OWNER', message: LESSON_AUTHOR_SESSION_ERRORS.NOT_OWNER[2] });
  }
  const vi = await runGuard(guard, fakeReq(ACTORS.editor, params, {}, 'vi'));
  assert.equal((vi.res.body as { message: string }).message, LESSON_AUTHOR_SESSION_ERRORS.NOT_OWNER[1]);
  // Never revealed to callers who cannot see the session: they keep the route's own not-found path.
  for (const actor of [ACTORS.noCourseEdit, ACTORS.otherTenant]) {
    const { nextCalled, res } = await runGuard(guard, fakeReq(actor, params));
    assert.equal(nextCalled, true, actor.id); assert.equal(res.statusCode, 200);
  }
  // Tenant isolation: the lookup is bound to the caller's tenant and course.
  assert.deepEqual(calls.at(-1), [CONV_CREATOR, TENANT_B, COURSE]);
  // Learner/demo sessions and malformed ids never reach the database.
  const before = calls.length;
  await runGuard(guard, fakeReq({ ...ACTORS.editor, role: 'learner' }, params));
  await runGuard(guard, fakeReq(ACTORS.editor, { conversationId: 'not-a-uuid', courseId: COURSE }));
  assert.equal(calls.length, before);
});

test('lesson-author runtime needs courses.can_edit, never the chatbot configuration module', async () => {
  const guard = createLessonAuthorCourseEditorGuard({ canEditCourses: async actor => CAN_EDIT_COURSES.has(actor.id) },
    req => String((req.query as Record<string, string>).target ?? 'admin'));
  const allowed = await runGuard(guard as never, fakeReq(ACTORS.editor, {}, { target: 'lesson_author' }));
  assert.equal(allowed.nextCalled, true);
  const refused = await runGuard(guard as never, fakeReq(ACTORS.noCourseEdit, {}, { target: 'lesson_author', ui_locale: 'en' }));
  assert.equal(refused.res.statusCode, 403);
  assert.deepEqual(refused.res.body, { success: false, code: 'LESSON_AUTHOR_SESSION_COURSE_EDIT_REQUIRED',
    message: LESSON_AUTHOR_SESSION_ERRORS.COURSE_EDIT_REQUIRED[2] });
  // Admin/learner chat keep their deployment-only rules.
  assert.equal((await runGuard(guard as never, fakeReq(ACTORS.noCourseEdit, {}, { target: 'admin' }))).nextCalled, true);
});

// ── Session list / rename / delete matrix (service + in-memory pg) ─────────

test('every course editor of the tenant sees every session of the course with its creator', async (t) => {
  const db: FakeDb = { conversations: conversations(), calls: [] };
  await installFakeDb(t, db);
  const { listLessonAuthorSessions } = await import('./lesson-author-session.service.js');

  for (const actor of [ACTORS.creator, ACTORS.editor, ACTORS.superuser, ACTORS.superadmin]) {
    const { items } = await listLessonAuthorSessions(ownerScope(actor));
    assert.deepEqual(items.map(item => item.conversation_id), [CONV_CREATOR, CONV_EDITOR], actor.role);
    const creatorSession = items[0]!;
    assert.deepEqual(creatorSession.owner, { user_id: CREATOR, display_name: 'Nguyễn Văn Tạo' });
    assert.equal(creatorSession.is_mine, actor.id === CREATOR);
    assert.equal(creatorSession.workspace?.can_edit, actor.id === CREATOR, 'only the creator edits the workspace');
    assert.equal(creatorSession.permissions.can_apply, true);
    assert.equal(creatorSession.permissions.can_delete, actor.id === CREATOR || actor.role !== 'staff');
    assert.equal(items[1]!.owner.display_name, 'bien.tap');
  }
  const list = db.calls.filter(call => call.sql.includes('LEFT JOIN LATERAL'));
  assert.ok(list.every(call => call.params[0] === TENANT_A), 'tenant filter on every list');
  assert.doesNotMatch(list[0]!.sql, /c\.user_id=\$2::uuid AND c\.course_id/);

  // "Mine" filter.
  const mine = await listLessonAuthorSessions(ownerScope(ACTORS.editor), { scope: 'mine' });
  assert.deepEqual(mine.items.map(item => item.conversation_id), [CONV_EDITOR]);
  // Other tenant never sees tenant A's sessions of the same course id.
  const other = await listLessonAuthorSessions(ownerScope(ACTORS.otherTenant));
  assert.deepEqual(other.items.map(item => item.conversation_id), [CONV_OTHER_TENANT]);
});

test('rename/delete: creator, superuser of the tenant or superadmin; other editors 403; other tenant 404', async (t) => {
  const db: FakeDb = { conversations: conversations(), calls: [] };
  await installFakeDb(t, db);
  const { renameLessonAuthorSession, getLessonAuthorSessionDeleteImpact, requestLessonAuthorSessionDeletion } = await import('./lesson-author-session.service.js');

  await rejectsWith(renameLessonAuthorSession(ownerScope(ACTORS.editor), CONV_CREATOR, 'Đổi tên'), 'LESSON_AUTHOR_SESSION_MANAGE_FORBIDDEN', 403);
  await rejectsWith(getLessonAuthorSessionDeleteImpact(ownerScope(ACTORS.editor), CONV_CREATOR), 'LESSON_AUTHOR_SESSION_MANAGE_FORBIDDEN', 403);
  await rejectsWith(requestLessonAuthorSessionDeletion(ownerScope(ACTORS.editor), CONV_CREATOR), 'LESSON_AUTHOR_SESSION_MANAGE_FORBIDDEN', 403);
  await rejectsWith(renameLessonAuthorSession(ownerScope(ACTORS.otherTenant), CONV_CREATOR, 'X'), 'LESSON_AUTHOR_SESSION_NOT_FOUND', 404);
  await rejectsWith(requestLessonAuthorSessionDeletion(ownerScope(ACTORS.otherTenant), CONV_CREATOR), 'LESSON_AUTHOR_SESSION_NOT_FOUND', 404);
  assert.equal(db.calls.some(call => /^\s*UPDATE chat_conversations c/.test(call.sql)), false);
  assert.equal(db.calls.some(call => call.sql.includes('INSERT INTO lesson_author_session_deletion_jobs')), false);

  assert.equal((await renameLessonAuthorSession(ownerScope(ACTORS.creator), CONV_CREATOR, 'Của tôi')).title, 'Của tôi');
  assert.equal((await renameLessonAuthorSession(ownerScope(ACTORS.superuser), CONV_CREATOR, 'Quản trị đổi')).title, 'Quản trị đổi');
  assert.equal((await renameLessonAuthorSession(ownerScope(ACTORS.superadmin), CONV_CREATOR, 'Hệ thống đổi')).title, 'Hệ thống đổi');
  assert.equal((await getLessonAuthorSessionDeleteImpact(ownerScope(ACTORS.superuser), CONV_CREATOR)).unapplied_nodes, 3);

  const deletion = await requestLessonAuthorSessionDeletion(ownerScope(ACTORS.superuser), CONV_CREATOR);
  assert.deepEqual(deletion, { job_id: JOB, replayed: false, creator_id: CREATOR });
  const insert = db.calls.find(call => call.sql.includes('INSERT INTO lesson_author_session_deletion_jobs'))!;
  assert.deepEqual(insert.params, [TENANT_A, COURSE, CONV_CREATOR, SUPERUSER], 'the job records who asked');
  const active = db.calls.find(call => call.sql.includes('EXISTS (SELECT 1 FROM lesson_author_workspaces w'))!;
  assert.equal(active.params[1], CREATOR, 'the running check looks at the creator\'s runs');
  const existing = db.calls.find(call => call.sql.includes('ORDER BY requested_at,id LIMIT 1 FOR UPDATE'))!;
  assert.doesNotMatch(existing.sql, /requested_by/, 'one active deletion per session, whoever asked');
});

test('deletion worker removes the creator\'s private rows even when an admin asked', async (t) => {
  const db: FakeDb = { conversations: conversations(), calls: [], claimedBy: SUPERUSER };
  await installFakeDb(t, db);
  const { runLessonAuthorSessionDeletion } = await import('./lesson-author-session.service.js');
  await runLessonAuthorSessionDeletion(JOB);
  const deleted = db.calls.find(call => call.sql.includes('DELETE FROM chat_conversations'))!;
  assert.deepEqual(deleted.params, [CONV_CREATOR, TENANT_A, CREATOR, COURSE]);
  const blueprints = db.calls.find(call => call.sql.includes('DELETE FROM lesson_author_blueprints'))!;
  assert.equal(blueprints.params[2], CREATOR);
  assert.equal(db.calls.some(call => /course_blocks/.test(call.sql) && /DELETE|UPDATE|INSERT/.test(call.sql)), false);
});

test('active-runs banner data is tenant/course scoped and names the creator', async () => {
  const seen: unknown[][] = [];
  const handler = createLessonAuthorActiveRunsHandler({ db: { query: async (_sql: string, params: unknown[] = []) => {
    seen.push(params);
    return { rows: [{ conversation_id: CONV_CREATOR, title: 'Phiên A', owner_id: CREATOR, full_name: 'Nguyễn Văn Tạo',
      username: 'tao', started_at: '2026-10-09T01:00:00.000Z' }], rowCount: 1 };
  } } as never });
  const res = fakeRes();
  await handler(fakeReq(ACTORS.editor, { courseId: COURSE }), res as unknown as Response, () => undefined);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, data: { items: [{ conversation_id: CONV_CREATOR, title: 'Phiên A',
    owner: { user_id: CREATOR, display_name: 'Nguyễn Văn Tạo' }, is_mine: false, started_at: '2026-10-09T01:00:00.000Z' }] } });
  assert.deepEqual(seen[0]!.slice(0, 2), [TENANT_A, COURSE]);
  assert.deepEqual(seen[0]![2], ['planning', 'executing', 'finalizing']);
  const bad = fakeRes();
  await handler(fakeReq(ACTORS.editor, { courseId: COURSE }, { extra: '1' }), bad as unknown as Response, () => undefined);
  assert.equal(bad.statusCode, 400);
});
