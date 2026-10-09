import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import { createLessonAuthorAuthorGuard } from './lesson-author-session-access.controller.js';
import { LESSON_AUTHOR_SESSION_ERRORS } from './lesson-author-session-access.logic.js';

// S2 T8: the legacy job Apply and the source document upload keep the same
// role + normal-session rule as every other AI course design handler.

const TENANT = '11111111-1111-4111-8111-111111111111';

async function run(user: Partial<AuthUser> | undefined, canEdit = true) {
  const guard = createLessonAuthorAuthorGuard({ canEditCourses: async () => canEdit });
  const out: { status?: number; body?: { code?: string; message?: string }; next: boolean } = { next: false };
  const res = {
    setHeader() { return this; },
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body as typeof out.body; return this; },
  } as unknown as Response;
  const req = { user, query: {}, get: () => 'en' } as unknown as Request;
  await guard(req, res, () => { out.next = true; });
  return out;
}

const user = (role: string, sessionMode = 'normal'): Partial<AuthUser> => ({
  id: 'a0000000-0000-4000-8000-0000000000aa', tenantId: TENANT, role: role as AuthUser['role'], username: 'u', sessionMode: sessionMode as AuthUser['sessionMode'],
});

test('learner_plus with courses.can_edit, demo sessions and editors without the right are refused', async () => {
  for (const candidate of [user('learner_plus'), user('learner'), user('staff', 'demo_iframe'), undefined]) {
    const result = await run(candidate);
    assert.equal(result.status, 403);
    assert.equal(result.body?.code, 'LESSON_AUTHOR_SESSION_COURSE_EDIT_REQUIRED');
    assert.equal(result.body?.message, LESSON_AUTHOR_SESSION_ERRORS.COURSE_EDIT_REQUIRED[2]);
    assert.equal(result.next, false);
  }
  assert.equal((await run(user('staff'), false)).status, 403);
});

test('staff, superuser and superadmin with course editing pass', async () => {
  for (const role of ['staff', 'superuser', 'superadmin']) assert.equal((await run(user(role))).next, true);
});

test('both routes install the guard before the handler and before the upload parser', () => {
  const routes = readFileSync(new URL('./ai-chatbot.routes.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const line = (method: string, path: string) => {
    const start = routes.indexOf(`router.${method}('${path}'`);
    assert.ok(start >= 0, path);
    return routes.slice(start, routes.indexOf(';\n', start));
  };
  assert.match(line('post', '/lesson-author/jobs/:jobId/apply'), /checkPermission\('courses', 'can_edit'\), lessonAuthorAuthor, chatCtrl\.applyLessonAuthorJob/);
  assert.match(line('post', '/chat/lesson-author/source-documents'), /checkPermission\('courses', 'can_edit'\), lessonAuthorAuthor, parseLessonAuthorSourceUpload/);
});
