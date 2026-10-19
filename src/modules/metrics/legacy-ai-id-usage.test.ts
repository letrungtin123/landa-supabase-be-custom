import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createJsonLogger } from '../../utils/json-logger.js';
import { formatPrometheus } from './metrics.logic.js';
import { collectMetricsText } from './metrics.service.js';
import { createLegacyAiIdRecorder, legacyAiId, mountLegacyAiIdCounters } from './legacy-ai-id-usage.js';
import {
  createLegacyAiIdUsage,
  LEGACY_AI_ID_ENTRIES,
  LEGACY_AI_ID_ENTRY_NAMES,
  legacyAiIdMetricFamilies,
  legacyLessonAuthorMessageEntry,
  type LegacyAiIdEntry,
} from './legacy-ai-id-usage.logic.js';

function recorder() {
  const lines: string[] = [];
  const logger = createJsonLogger({ tag: 'LegacyAiId', write: (_level, line) => lines.push(line), now: () => new Date(0) });
  return { lines, recorder: createLegacyAiIdRecorder({ logger }) };
}

function fakeRequest(headers: Record<string, string>, body: unknown): Request {
  return { body, get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

function runMiddleware(handler: (req: Request, res: Response, next: NextFunction) => void, req: Request): number {
  let nextCalls = 0;
  handler(req, {} as Response, ((error?: unknown) => {
    assert.equal(error, undefined, 'next() without an error');
    nextCalls += 1;
  }) as NextFunction);
  return nextCalls;
}

const count = (lines: string[], entry: LegacyAiIdEntry) => lines.filter((line) => line.includes(`"entry":"${entry}"`)).length;

test('the lesson-author chat message entry follows the request shape the controller dispatches on', () => {
  const entry = (target: string | undefined, jobKeyHeader: string | undefined, chapterResume: unknown) =>
    legacyLessonAuthorMessageEntry({ target, jobKeyHeader, chapterResume });
  assert.equal(entry('lesson_author', undefined, undefined), 'lesson_author_message');
  assert.equal(entry('lesson_author', 'b6b9c4c4-9a61-4bb5-9d1f-1d1d9a0f3c11', undefined), 'durable_blueprint_enqueue');
  assert.equal(entry('lesson_author', 'b6b9c4c4-9a61-4bb5-9d1f-1d1d9a0f3c11', { draft_id: 'x' }), 'chapter_checkpoint_resume');
  assert.equal(entry('lesson_author', undefined, null), 'chapter_checkpoint_resume');
  for (const target of ['learner', 'admin', undefined, 'LESSON_AUTHOR']) assert.equal(entry(target, 'key', undefined), null);
});

test('the counter is bounded: one sample per known entry, 0 until called', () => {
  const usage = createLegacyAiIdUsage();
  assert.deepEqual(
    usage.snapshot().map(({ entry, value }) => [entry, value]),
    LEGACY_AI_ID_ENTRY_NAMES.map((entry) => [entry, 0]),
  );
  usage.record('proposal_job_apply');
  usage.record('proposal_job_apply');
  usage.record('workspace_v1_launch');
  const text = formatPrometheus(legacyAiIdMetricFamilies(usage), { instance: '1' });
  assert.match(text, /^# TYPE landa_legacy_ai_id_calls_total counter$/m);
  assert.match(
    text,
    /^landa_legacy_ai_id_calls_total\{instance="1",route="POST \/api\/ai-chatbot\/lesson-author\/jobs\/:jobId\/apply",entry="proposal_job_apply"\} 2$/m,
  );
  assert.match(text, /entry="workspace_v1_launch"\} 1$/m);
  assert.match(text, /entry="chapter_checkpoint_status"\} 0$/m);
  assert.equal(text.split('\n').filter((line) => line.startsWith('landa_legacy_ai_id_calls_total{')).length, LEGACY_AI_ID_ENTRY_NAMES.length);
  assert.throws(() => usage.record('not-an-entry' as LegacyAiIdEntry), /unknown entry/);
});

test('every route label is a method and a route template, never a concrete id', () => {
  for (const route of Object.values(LEGACY_AI_ID_ENTRIES)) {
    assert.match(route, /^(GET|POST) \/api\/ai-chatbot\/[a-z0-9/:_-]+$/i);
    assert.doesNotMatch(route, /[0-9a-f]{8}-[0-9a-f]{4}/i);
  }
});

test('route middleware: counts, writes one line with the route and entry only, and calls next once', () => {
  const { lines, recorder: legacy } = recorder();
  assert.equal(runMiddleware(legacy.count('chapter_checkpoint_status'), fakeRequest({}, undefined)), 1);
  assert.deepEqual(lines, [
    '[LegacyAiId] {"event":"legacy_ai_id_call","level":"info","ts":"1970-01-01T00:00:00.000Z","route":"GET /api/ai-chatbot/chat/lesson-author/conversations/:conversationId/chapter-checkpoint","entry":"chapter_checkpoint_status"}',
  ]);
  assert.equal(legacy.usage.snapshot().find((sample) => sample.entry === 'chapter_checkpoint_status')?.value, 1);
});

test('chat message middleware: counts lesson-author turns by entry, ignores every other chat', () => {
  const { lines, recorder: legacy } = recorder();
  const handler = legacy.countLessonAuthorMessage((req) => (req.body as { target?: string } | undefined)?.target);
  const key = { 'x-lesson-author-job-key': 'b6b9c4c4-9a61-4bb5-9d1f-1d1d9a0f3c11' };
  assert.equal(runMiddleware(handler, fakeRequest({}, { target: 'lesson_author', content: 'x' })), 1);
  assert.equal(runMiddleware(handler, fakeRequest(key, { target: 'lesson_author', content: 'x' })), 1);
  assert.equal(runMiddleware(handler, fakeRequest(key, { target: 'lesson_author', chapter_resume: {} })), 1);
  assert.equal(runMiddleware(handler, fakeRequest(key, { target: 'learner', content: 'x' })), 1);
  assert.equal(runMiddleware(handler, fakeRequest({}, undefined)), 1);
  assert.equal(count(lines, 'lesson_author_message'), 1);
  assert.equal(count(lines, 'durable_blueprint_enqueue'), 1);
  assert.equal(count(lines, 'chapter_checkpoint_resume'), 1);
  assert.equal(lines.length, 3);
  for (const line of lines) assert.doesNotMatch(line, /content|b6b9c4c4|target/);
});

test('withCount: the wrapped function gets the same arguments and returns its result', async () => {
  const { lines, recorder: legacy } = recorder();
  const launched = legacy.withCount('workspace_v1_launch', async (user: { id: string }, input: { n: number }) => ({ user: user.id, n: input.n }));
  assert.deepEqual(await launched({ id: 'u' }, { n: 2 }), { user: 'u', n: 2 });
  assert.equal(count(lines, 'workspace_v1_launch'), 1);
});

test('GET /internal/metrics text carries the counter of this process', () => {
  legacyAiId.usage.record('generation_job_status');
  const text = collectMetricsText();
  assert.match(text, /^landa_legacy_ai_id_calls_total\{instance="[^"]+",route="GET [^"]+generation-jobs\/:jobId",entry="generation_job_status"\} [1-9]\d*$/m);
});

test('mounted counters: each V1 route is counted once, the real route still answers, other routes are not counted', async () => {
  const { lines, recorder: legacy } = recorder();
  const app = express();
  app.use(express.json());
  const router = express.Router();
  mountLegacyAiIdCounters(router, legacy, (req) => (req.body as { target?: string } | undefined)?.target);
  const answer = (name: string) => (_req: Request, res: Response) => {
    res.status(200).json({ route: name });
  };
  router.post('/lesson-author/jobs/:jobId/apply', answer('apply'));
  router.get('/chat/lesson-author/conversations/:conversationId/chapter-checkpoint', answer('checkpoint'));
  router.get('/chat/lesson-author/conversations/:conversationId/generation-jobs/:jobId', answer('job'));
  router.post('/chat/conversations/:id/messages', answer('message'));
  router.get('/chat/conversations/:id/messages', answer('history'));
  router.get('/lesson-author/settings', answer('settings'));
  app.use('/api/ai-chatbot', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai-chatbot${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as { route: string } };
  };
  try {
    const id = 'b6b9c4c4-9a61-4bb5-9d1f-1d1d9a0f3c11';
    assert.deepEqual(await call('POST', `/lesson-author/jobs/${id}/apply`, {}), { status: 200, body: { route: 'apply' } });
    assert.deepEqual(await call('GET', `/chat/lesson-author/conversations/${id}/chapter-checkpoint`), { status: 200, body: { route: 'checkpoint' } });
    assert.deepEqual(await call('GET', `/chat/lesson-author/conversations/${id}/generation-jobs/${id}`), { status: 200, body: { route: 'job' } });
    assert.deepEqual(await call('POST', `/chat/conversations/${id}/messages`, { target: 'lesson_author', content: 'x' }), { status: 200, body: { route: 'message' } });
    assert.deepEqual(await call('POST', `/chat/conversations/${id}/messages`, { target: 'lesson_author' }, { 'X-Lesson-Author-Job-Key': id }), { status: 200, body: { route: 'message' } });
    assert.deepEqual(await call('POST', `/chat/conversations/${id}/messages`, { target: 'learner', content: 'x' }), { status: 200, body: { route: 'message' } });
    assert.deepEqual(await call('GET', `/chat/conversations/${id}/messages`), { status: 200, body: { route: 'history' } });
    assert.deepEqual(await call('GET', '/lesson-author/settings'), { status: 200, body: { route: 'settings' } });
  } finally {
    server.close();
  }
  const counts = Object.fromEntries(legacy.usage.snapshot().map(({ entry, value }) => [entry, value]));
  assert.deepEqual(counts, {
    lesson_author_message: 1,
    durable_blueprint_enqueue: 1,
    chapter_checkpoint_resume: 0,
    chapter_checkpoint_status: 1,
    generation_job_status: 1,
    proposal_job_apply: 1,
    workspace_v1_launch: 0,
  });
  assert.equal(lines.length, 5, 'one log line per counted call');
  for (const line of lines) assert.doesNotMatch(line, /b6b9c4c4/, 'route templates only, never ids');
});

test('wiring: ai-chatbot.routes.ts mounts the counters after sign-in and before every V1 route, and counts the V1 runtime launch', () => {
  const routes = readFileSync(new URL('../ai-chatbot/ai-chatbot.routes.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const mounted = routes.indexOf('mountLegacyAiIdCounters(router, legacyAiId, getRuntimeChatTarget);');
  assert.ok(mounted > routes.indexOf('router.use(tenantContext);') && routes.indexOf('router.use(tenantContext);') > routes.indexOf('router.use(authenticate);'));
  for (const route of [
    "router.post('/lesson-author/jobs/:jobId/apply'",
    "router.get('/chat/lesson-author/conversations/:conversationId/chapter-checkpoint'",
    "router.get('/chat/lesson-author/conversations/:conversationId/generation-jobs/:jobId'",
    "router.post('/chat/conversations/:id/messages'",
  ]) {
    const at = routes.indexOf(route);
    assert.ok(at > mounted, `${route} is registered after the counters`);
  }
  assert.ok(routes.includes("const createV1Workspace = legacyAiId.withCount('workspace_v1_launch', createLessonAuthorWorkspace);"));
  assert.match(routes, /\? workspaceV2Launch\(user,input\) : createV1Workspace\(user,input\),/);
  assert.doesNotMatch(routes, /: createLessonAuthorWorkspace\(user,input\)/, 'no uncounted V1 launch');
});
