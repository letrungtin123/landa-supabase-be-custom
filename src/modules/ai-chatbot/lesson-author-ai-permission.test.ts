import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Request, Response } from 'express';
import type { AuthUser } from '../../types/express.js';
import { checkPermission } from '../../middleware/authorize.js';
import { LESSON_AUTHOR_SOURCE_UPLOAD_ERRORS, uploadLessonAuthorSourceDocument } from './lesson-author-source-upload.controller.js';

// AI permission rule (owner decision 2026-10-09): using AI never needs the
// ai_chatbot module (chatbot configuration pages only); it needs the DATA
// permission it touches. One table documents and pins every AI runtime path.

const routes = readFileSync(new URL('./ai-chatbot.routes.ts', import.meta.url), 'utf8');
const routeLine = (method: string, path: string): string => {
  const marker = `router.${method}('${path}'`;
  const start = routes.indexOf(marker);
  assert.ok(start >= 0, `route ${method.toUpperCase()} ${path} exists`);
  return routes.slice(start, routes.indexOf(';\n', start));
};

const AI_RUNTIME_PATHS: Array<{ method: string; path: string; requires: RegExp[]; never?: RegExp }> = [
  // Admin/learner chat: deployment (bot assignment) only; lesson-author target needs course editing.
  { method: 'post', path: '/chat/conversations/:id/messages', requires: [/allowRuntimeChatTarget/, /lessonAuthorCourseEditor/, /lessonAuthorSessionOwnerOnly\('id'\)/] },
  { method: 'get', path: '/chat/conversations', requires: [/allowRuntimeChatTarget/, /lessonAuthorCourseEditor/] },
  { method: 'post', path: '/chat/conversations', requires: [/allowRuntimeChatTarget/, /lessonAuthorCourseEditor/] },
  { method: 'get', path: '/chat/conversations/:id/messages', requires: [/allowRuntimeChatTarget/, /lessonAuthorCourseEditor/] },
  // AI course design.
  { method: 'get', path: '/chat/lesson-author/settings', requires: [/checkPermission\('courses', 'can_edit'\)/] },
  { method: 'get', path: '/chat/lesson-author/source-documents', requires: [/checkPermission\('courses', 'can_edit'\)/] },
  { method: 'post', path: '/chat/lesson-author/source-documents', requires: [/checkPermission\('courses', 'can_edit'\)/, /parseLessonAuthorSourceUpload/] },
  { method: 'get', path: '/chat/lesson-author/source-documents/:documentId/stream', requires: [/canRead: user => hasPermission\(user, 'courses', 'can_edit'\)/] },
  { method: 'post', path: '/chat/lesson-author/conversations/:conversationId/transcriptions', requires: [/checkPermission\('courses', 'can_edit'\), lessonAuthorSessionOwnerOnly\('conversationId'\), parseLessonAuthorVideoUpload/] },
  { method: 'post', path: '/chat/lesson-author/conversations/:conversationId/transcriptions/:jobId/commit', requires: [/checkPermission\('courses', 'can_edit'\), lessonAuthorSessionOwnerOnly\('conversationId'\)/] },
  { method: 'get', path: '/chat/lesson-author/courses/:courseId/sessions', requires: [/checkPermission\('courses', 'can_edit'\)/] },
  { method: 'get', path: '/chat/lesson-author/courses/:courseId/sessions/active-runs', requires: [/checkPermission\('courses', 'can_edit'\)/] },
  { method: 'post', path: '/chat/lesson-author/courses/:courseId/conversations/:conversationId/workspaces', requires: [/lessonAuthorSessionOwnerOnly\('conversationId', \{ courseParam: 'courseId' \}\)/] },
  { method: 'post', path: '/lesson-author/jobs/:jobId/apply', requires: [/checkPermission\('courses', 'can_edit'\)/] },
  // AI Report keeps the report data permission.
  { method: 'post', path: '/chat/conversations/:id/report-pdf', requires: [/checkPermission\('report_summary', 'can_view'\)/] },
  { method: 'post', path: '/chat/conversations/:id/report-pdf/jobs', requires: [/checkPermission\('report_summary', 'can_view'\)/] },
];

test('every AI runtime path requires its data permission and never the ai_chatbot configuration module', () => {
  for (const route of AI_RUNTIME_PATHS) {
    const line = routeLine(route.method, route.path);
    for (const pattern of route.requires) assert.match(line, pattern, `${route.method} ${route.path}`);
    assert.doesNotMatch(line, /ai_chatbot/, `${route.method} ${route.path} must not need ai_chatbot`);
  }
  // Workspace reads/stream, Save/Reset and Apply authorize courses.can_edit in their factories.
  assert.match(routes, /const workspaceReads = createWorkspaceReadHandlers\(\{[\s\S]*?canRead: user => hasPermission\(user, 'courses', 'can_edit'\)/);
  assert.doesNotMatch(routes.slice(routes.indexOf('// ── Chat runtime'), routes.indexOf('export default router')), /'ai_chatbot'/);
});

test('chatbot configuration pages, including knowledge base uploads, keep requiring ai_chatbot', () => {
  assert.match(routeLine('post', '/kb/:kbId/documents'), /checkPermission\('ai_chatbot', 'can_add'\), upload\.array\('files', 20\)/);
  assert.match(routeLine('post', '/kb'), /checkPermission\('ai_chatbot', 'can_add'\)/);
  assert.match(routeLine('put', '/bots/assignments'), /checkPermission\('ai_chatbot', 'can_edit'\)/);
  assert.match(routeLine('get', '/lesson-author/settings'), /checkPermission\('ai_chatbot', 'can_view'\)/);
  assert.match(routeLine('put', '/lesson-author/kb-assignment'), /checkPermission\('ai_chatbot', 'can_edit'\)/);
});

test('AI course design upload never takes a knowledge base from the request', () => {
  const controller = readFileSync(new URL('./lesson-author-source-upload.controller.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(controller, /req\.(params|body|query)\.kb/i);
  assert.match(controller, /getActiveKbAssignmentFresh\(tenantId\)/);
  assert.match(controller, /getActiveBot\(tenantId, 'lesson_author'\)/);
  assert.match(controller, /code: 'knowledgebase\.document\.created'/);
});

// Behaviour of the shared permission middleware for a staff member whose
// permission group grants courses.can_edit but nothing on ai_chatbot.
test('staff with courses.can_edit and no ai_chatbot right passes AI course design and is refused KB management', async (t) => {
  const pg = await import('pg');
  const staffId = 'b0000000-0000-4000-8000-0000000000a1', tenant = '11111111-1111-4111-8111-111111111111';
  const grants: Record<string, Record<string, boolean>> = { courses: { can_view: true, can_edit: true }, ai_chatbot: {} };
  t.mock.method(pg.default.Pool.prototype, 'query', async (text: string, params: unknown[] = []) => {
    const action = /bool_or\(pgm\.(can_\w+)\)/.exec(text)?.[1] ?? '';
    return { rows: [{ allowed: grants[String(params[1])]?.[action] === true }], rowCount: 1 };
  });
  const staff: AuthUser = { id: staffId, role: 'staff', tenantId: tenant, username: 'staff', sessionMode: 'normal' };
  const run = async (module: string, action: 'can_view' | 'can_add' | 'can_edit') => {
    let passed = false, status = 200;
    const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
    await checkPermission(module, action)({ user: staff } as Request, res, () => { passed = true; });
    return { passed, status };
  };
  assert.deepEqual(await run('courses', 'can_edit'), { passed: true, status: 200 }, 'AI course design incl. upload');
  assert.deepEqual(await run('ai_chatbot', 'can_add'), { passed: false, status: 403 }, 'KB management upload');
  assert.deepEqual(await run('ai_chatbot', 'can_view'), { passed: false, status: 403 }, 'chatbot configuration pages');
});

test('upload refusals answer before touching storage, in the request language', async () => {
  const replies: Array<{ status: number; body: { code: string; message: string } }> = [];
  const send = (file: unknown, locale: string) => {
    const reply = { status: 200, body: { code: '', message: '' } };
    const res = { setHeader() {}, status(code: number) { reply.status = code; return this; },
      json(body: { code: string; message: string }) { reply.body = body; replies.push(reply); return this; } } as unknown as Response;
    const req = { user: { id: 'u', tenantId: 't', role: 'staff' }, file, query: { ui_locale: locale }, get: () => undefined } as unknown as Request;
    return uploadLessonAuthorSourceDocument(req, res);
  };
  await send(undefined, 'vi');
  await send({ originalname: 'virus.exe', size: 10 }, 'en');
  assert.deepEqual(replies.map(reply => [reply.status, reply.body.code]), [
    [400, 'LESSON_AUTHOR_SOURCE_UPLOAD_FILE_REQUIRED'], [400, 'LESSON_AUTHOR_SOURCE_UPLOAD_FILE_TYPE_UNSUPPORTED']]);
  assert.equal(replies[0]!.body.message, LESSON_AUTHOR_SOURCE_UPLOAD_ERRORS.FILE_REQUIRED[1]);
  assert.equal(replies[1]!.body.message, LESSON_AUTHOR_SOURCE_UPLOAD_ERRORS.FILE_TYPE_UNSUPPORTED[2]);
});
