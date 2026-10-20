import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AppError } from '../../../../../middleware/error-handler.js';
import type { AuthUser } from '../../../../../types/express.js';
import type { LessonAuthorLaunchBrief } from '../../contracts/lesson-author-launch-brief.logic.js';
import { createWorkspaceV2LaunchService } from './lesson-author-workspace-v2-launch.service.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (value: string) => value.repeat(64).slice(0, 64);
const user: AuthUser = { id: uuid(1), tenantId: uuid(2), role: 'superadmin', username: 'owner', sessionMode: 'normal' };
const designBrief: LessonAuthorLaunchBrief = { design_mode: 'instructional_design',
  learner_audience: 'Nhân viên mới', course_purpose: 'Giúp nhân viên mới hiểu công ty trong tuần đầu.' };
const input = { courseId: 'course-v1:test+1+2026', conversationId: uuid(3), operationId: uuid(4),
  sourceDocumentIds: [uuid(5)], locale: 'vi' as const, brief: designBrief };
/** Stand-in for chat.service's request identity: the launch brief is part of it (QLT-6). */
const requestHashOf = (brief: unknown) => createHash('sha256').update(JSON.stringify(brief ?? null)).digest('hex');

/** `idm`: whether the tenant is admitted to the IDM pipeline (QLT-6 keep-as-is needs it); `absent` omits the dependency. */
function fixture(options: { failAdmission?: boolean; legacyWorkspace?: boolean; idm?: boolean | 'absent' } = {}) {
  let workspace: any = options.legacyWorkspace ? { id: uuid(8), conversation_id: input.conversationId, correlation_id: uuid(9),
    content_locale: input.locale, status: 'designing', request_hash: hash('a'), source_document_ids: input.sourceDocumentIds,
    launch_brief: null } : null;
  let runId: string | null = null;
  let events = 0;
  const state = { filters: 0, accepted: 0, admissions: 0, prepares: 0, replayContexts: [] as unknown[], sql: [] as string[],
    inserts: [] as unknown[][], briefs: [] as unknown[], idm: options.idm !== false, lockAccess: [] as unknown[] };
  const prepared = (brief: unknown) => ({
    identity: { tenantId: user.tenantId!, userId: user.id, conversationId: input.conversationId,
      courseId: input.courseId, botId: uuid(6), kbId: uuid(7), requestHash: requestHashOf(brief),
      sourceSnapshotHash: hash('b'), courseOutlineHash: hash('c'), runtimeConfigHash: hash('d'),
      locale: input.locale, model: 'model', sourceDocumentIds: input.sourceDocumentIds, editorContext: null },
    embeddingModel: 'embedding',
    async filterInput() { state.filters++; },
    markAccepted() { state.accepted++; },
  });
  const rows = (sql: string, params: unknown[] = []) => {
    state.sql.push(sql);
    if (sql.includes('FROM courses')) return [{ id: input.courseId }];
    if (sql.includes('FROM users u JOIN tenants')) return [{ role: 'superadmin', tenant_id: null, is_active: true, tenant_active: true }];
    if (sql.includes('FROM lesson_author_session_deletion_jobs')) return [];
    if (sql.includes("status IN ('queued','designing','drafting')")) return [];
    if (sql.includes('FROM lesson_author_workspaces') && sql.includes('idempotency_key')) return workspace ? [workspace] : [];
    if (sql.includes('INSERT INTO lesson_author_workspaces')) {
      state.inserts.push(params);
      workspace = { id: uuid(8), conversation_id: input.conversationId, correlation_id: uuid(9),
        content_locale: input.locale, status: 'queued', request_hash: params[10], source_document_ids: input.sourceDocumentIds,
        launch_brief: JSON.parse(String(params[13])) };
      return [workspace];
    }
    if (sql.includes("UPDATE lesson_author_workspaces SET status='designing'")) {
      if (!workspace || workspace.status !== 'queued') return [];
      workspace = { ...workspace, status: 'designing' };
      return [workspace];
    }
    if (sql.includes('INSERT INTO lesson_author_workspace_events')) { events++; return [{ sequence: events }]; }
    if (sql.includes('FROM lesson_author_workspace_v2_runs')) return runId ? [{ id: runId }] : [];
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  };
  const tx = { query: async (sql: string, params?: unknown[]) => ({ rows: rows(sql, params), rowCount: 1 }) };
  const launch = createWorkspaceV2LaunchService({
    query: async (sql, params) => ({ rows: rows(sql, params) }),
    db: { async transaction(work) {
      const before = { workspace: structuredClone(workspace), runId, events };
      try { return await work(tx as any); } catch (error) {
        workspace = before.workspace; runId = before.runId; events = before.events; throw error;
      }
    } },
    AppError,
    prepareDurableBlueprint: (async (_conversation: string, _actor: string, _tenant: string, _content: string,
      options: { launchBrief?: unknown }, replay?: { source_document_ids: string[]; user_message_id?: string | null }) => {
      state.prepares++; state.briefs.push(options.launchBrief);
      state.replayContexts.push(replay); return prepared(options.launchBrief) as any;
    }) as any,
    withLessonAuthorConversationLock: async (_conversation, work, access) => { state.lockAccess.push(access); return work(); },
    admit: async () => {
      state.admissions++;
      if (options.failAdmission) throw Object.assign(new Error('ADMISSION_FAILED'), { code: 'ORCHESTRATION_V2_ADMISSION_CONFLICT' });
      runId = uuid(10);
      return { created: true, run_id: runId, snapshot_id: uuid(11), task_id: uuid(12), outbox_id: uuid(13),
        bootstrap_hash: hash('e'), source_snapshot_hash: hash('b') };
    },
    id: (() => { const ids = [uuid(9), uuid(8)]; return () => ids.shift() ?? uuid(99); })(),
    ...(options.idm === 'absent' ? {} : { idmPipelineFor: (tenantId: string) => {
      assert.equal(tenantId, user.tenantId); return state.idm;
    } }),
  });
  return { launch, state, inspect: () => ({ workspace, runId, events }) };
}

test('one public Create atomically creates a workspace shell and exactly one V2 admission, then replays', async () => {
  const f = fixture();
  const created = await f.launch(user, input);
  assert.deepEqual(created, { workspace_id: uuid(8), conversation_id: input.conversationId,
    correlation_id: uuid(9), content_locale: 'vi', status: 'designing', launch_brief: designBrief, replayed: false });
  assert.deepEqual({ filters: f.state.filters, accepted: f.state.accepted, admissions: f.state.admissions },
    { filters: 1, accepted: 1, admissions: 1 });
  // The lock first checks that the conversation is the caller's own (404 like a missing one, busy or not).
  assert.deepEqual(f.state.lockAccess, [{ userId: user.id, tenantId: user.tenantId }]);
  const inserted = f.state.sql.findIndex(sql => sql.includes('INSERT INTO lesson_author_workspaces'));
  const designing = f.state.sql.findIndex(sql => sql.includes("UPDATE lesson_author_workspaces SET status='designing'"));
  const started = f.state.sql.findIndex(sql => sql.includes("'architecture_started'"));
  assert.ok(inserted >= 0 && designing > inserted && started > designing);
  assert.match(f.state.sql[inserted]!, /'queued'/);
  assert.doesNotMatch(f.state.sql[inserted]!, /'designing'/);
  const replayed = await f.launch(user, input);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.launch_brief, designBrief);
  assert.deepEqual({ filters: f.state.filters, accepted: f.state.accepted, admissions: f.state.admissions },
    { filters: 1, accepted: 1, admissions: 1 });
  assert.deepEqual(f.state.replayContexts[1], { source_document_ids: input.sourceDocumentIds, user_message_id: null });
});

test('QLT-6: the launch brief is written once with the shell and is part of the request identity', async () => {
  const f = fixture();
  await f.launch(user, input);
  assert.match(f.state.sql.find(sql => sql.includes('INSERT INTO lesson_author_workspaces'))!, /launch_brief\)[\s\S]*\$14::jsonb/);
  assert.deepEqual(JSON.parse(String(f.state.inserts[0]![13])), { ...designBrief, version: 1 });
  // The request hash the shell stores is the one prepared with the brief.
  assert.deepEqual(f.state.briefs, [designBrief]);
  assert.equal(f.state.inserts[0]![10], requestHashOf(designBrief));

  const preserve = fixture();
  const brief: LessonAuthorLaunchBrief = { design_mode: 'preserve_source', learner_audience: null, course_purpose: null };
  const created = await preserve.launch(user, { ...input, brief });
  assert.deepEqual(created.launch_brief, brief);
  assert.deepEqual(JSON.parse(String(preserve.state.inserts[0]![13])),
    { design_mode: 'preserve_source', learner_audience: null, course_purpose: null, version: 1 });
});

test('QLT-6: the same operation with a different brief is a conflict; nothing is prepared, written or admitted', async () => {
  const f = fixture();
  await f.launch(user, input);
  const before = structuredClone(f.inspect());
  for (const brief of [
    { ...designBrief, course_purpose: 'Một mục đích khác cho cùng thao tác này.' },
    { ...designBrief, learner_audience: 'Quản lý cấp trung' },
    { design_mode: 'preserve_source', learner_audience: null, course_purpose: null },
  ] as LessonAuthorLaunchBrief[]) {
    await assert.rejects(f.launch(user, { ...input, brief }), { code: 'WORKSPACE_CREATE_CONFLICT', statusCode: 409 });
  }
  assert.deepEqual(f.inspect(), before);
  assert.deepEqual({ prepares: f.state.prepares, admissions: f.state.admissions, inserts: f.state.inserts.length },
    { prepares: 1, admissions: 1, inserts: 1 });
  // An identical replay still succeeds afterwards.
  assert.equal((await f.launch(user, input)).replayed, true);
});

test('QLT-6: a brief the controller did not clean never reaches preparation or the database', async () => {
  for (const brief of [
    { design_mode: 'verbatim', learner_audience: null, course_purpose: null },
    { design_mode: 'instructional_design', learner_audience: '  Nhân viên  ', course_purpose: 'Mục đích hợp lệ.' },
    { design_mode: 'instructional_design', learner_audience: null, course_purpose: 'Mục đích hợp lệ.' },
    { design_mode: 'preserve_source', learner_audience: '', course_purpose: null },
    { ...designBrief, version: 1 },
  ]) {
    const f = fixture();
    await assert.rejects(f.launch(user, { ...input, brief: brief as never }),
      { code: 'WORKSPACE_CREATE_INPUT_INVALID', statusCode: 400 });
    assert.deepEqual({ prepares: f.state.prepares, sql: f.state.sql.length }, { prepares: 0, sql: 0 });
  }
});

test('QLT-6: keeping a document needs the IDM pipeline: refused before anything is prepared, written or admitted',
  async () => {
    const kept: LessonAuthorLaunchBrief = { design_mode: 'preserve_source', learner_audience: null, course_purpose: null };
    for (const idm of [false, 'absent'] as const) {
      const f = fixture({ idm });
      await assert.rejects(f.launch(user, { ...input, brief: kept }), { code: 'LESSON_AUTHOR_LAUNCH_MODE_UNAVAILABLE' });
      assert.deepEqual({ prepares: f.state.prepares, admissions: f.state.admissions, inserts: f.state.inserts.length,
        filters: f.state.filters }, { prepares: 0, admissions: 0, inserts: 0, filters: 0 });
      assert.ok(f.state.sql.every(sql => /^\s*SELECT/.test(sql)), 'only the replay lookup ran');
      // The design mode is unaffected on the legacy pipeline.
      assert.equal((await f.launch(user, input)).replayed, false);
    }
    // An admitted kept workspace still replays after the rollout flag is turned off.
    const f = fixture();
    assert.equal((await f.launch(user, { ...input, brief: kept })).replayed, false);
    f.state.idm = false;
    assert.equal((await f.launch(user, { ...input, brief: kept })).replayed, true);
    assert.equal(f.state.admissions, 1);
  });

test('failed V2 admission rolls back the workspace shell and event', async () => {
  const f = fixture({ failAdmission: true });
  await assert.rejects(f.launch(user, input), /ADMISSION_FAILED/);
  assert.deepEqual(f.inspect(), { workspace: null, runId: null, events: 0 });
  assert.equal(f.state.accepted, 0);
});

test('V2 mode never takes over a pre-existing V1 workspace without atomic V2 run evidence', async () => {
  const f = fixture({ legacyWorkspace: true });
  await assert.rejects(f.launch(user, input), { code: 'WORKSPACE_CREATE_CONFLICT' });
  assert.equal(f.state.admissions, 0);
  assert.equal(f.state.filters, 0);
});

test('router exposes one workspace launch mutation and never exposes browser V2 admission', () => {
  const source = readFileSync(new URL('../../../ai-chatbot.routes.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/router\.post\('\/chat\/lesson-author\/courses\/:courseId\/conversations\/:conversationId\/workspaces'/g) ?? []).length, 1);
  assert.doesNotMatch(source, /router\.post\(`\$\{workspaceReadPath\}\/orchestration-v2\/runs`/);
  assert.match(source, /env\.LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED\s*\?\s*workspaceV2Launch/);
});
