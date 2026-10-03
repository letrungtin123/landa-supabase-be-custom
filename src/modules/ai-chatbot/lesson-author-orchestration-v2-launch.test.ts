import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AppError } from '../../middleware/error-handler.js';
import type { AuthUser } from '../../types/express.js';
import { createWorkspaceV2LaunchService } from './lesson-author-workspace-v2-launch.service.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (value: string) => value.repeat(64).slice(0, 64);
const user: AuthUser = { id: uuid(1), tenantId: uuid(2), role: 'superadmin', username: 'owner', sessionMode: 'normal' };
const input = { courseId: 'course-v1:test+1+2026', conversationId: uuid(3), operationId: uuid(4),
  sourceDocumentIds: [uuid(5)], locale: 'vi' as const };

function fixture(options: { failAdmission?: boolean; legacyWorkspace?: boolean } = {}) {
  let workspace: any = options.legacyWorkspace ? { id: uuid(8), conversation_id: input.conversationId, correlation_id: uuid(9),
    content_locale: input.locale, status: 'designing', request_hash: hash('a'), source_document_ids: input.sourceDocumentIds } : null;
  let runId: string | null = null;
  let events = 0;
  const state = { filters: 0, accepted: 0, admissions: 0, replayContexts: [] as unknown[], sql: [] as string[] };
  const prepared = {
    identity: { tenantId: user.tenantId!, userId: user.id, conversationId: input.conversationId,
      courseId: input.courseId, botId: uuid(6), kbId: uuid(7), requestHash: hash('a'),
      sourceSnapshotHash: hash('b'), courseOutlineHash: hash('c'), runtimeConfigHash: hash('d'),
      locale: input.locale, model: 'model', sourceDocumentIds: input.sourceDocumentIds, editorContext: null },
    embeddingModel: 'embedding',
    async filterInput() { state.filters++; },
    markAccepted() { state.accepted++; },
  };
  const rows = (sql: string) => {
    state.sql.push(sql);
    if (sql.includes('FROM courses')) return [{ id: input.courseId }];
    if (sql.includes('FROM users u JOIN tenants')) return [{ role: 'superadmin', tenant_id: null, is_active: true, tenant_active: true }];
    if (sql.includes('FROM lesson_author_session_deletion_jobs')) return [];
    if (sql.includes("status IN ('queued','designing','drafting')")) return [];
    if (sql.includes('FROM lesson_author_workspaces') && sql.includes('idempotency_key')) return workspace ? [workspace] : [];
    if (sql.includes('INSERT INTO lesson_author_workspaces')) {
      workspace = { id: uuid(8), conversation_id: input.conversationId, correlation_id: uuid(9),
        content_locale: input.locale, status: 'queued', request_hash: hash('a'), source_document_ids: input.sourceDocumentIds };
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
  const tx = { query: async (sql: string) => ({ rows: rows(sql), rowCount: 1 }) };
  const launch = createWorkspaceV2LaunchService({
    query: async sql => ({ rows: rows(sql) }),
    db: { async transaction(work) {
      const before = { workspace: structuredClone(workspace), runId, events };
      try { return await work(tx as any); } catch (error) {
        workspace = before.workspace; runId = before.runId; events = before.events; throw error;
      }
    } },
    AppError,
    prepareDurableBlueprint: (async (_conversation: string, _actor: string, _tenant: string, _content: string,
      _options: unknown, replay?: { source_document_ids: string[]; user_message_id?: string | null }) => {
      state.replayContexts.push(replay); return prepared as any;
    }) as any,
    withLessonAuthorConversationLock: async (_conversation, work) => work(),
    admit: async () => {
      state.admissions++;
      if (options.failAdmission) throw Object.assign(new Error('ADMISSION_FAILED'), { code: 'ORCHESTRATION_V2_ADMISSION_CONFLICT' });
      runId = uuid(10);
      return { created: true, run_id: runId, snapshot_id: uuid(11), task_id: uuid(12), outbox_id: uuid(13),
        bootstrap_hash: hash('e'), source_snapshot_hash: hash('b') };
    },
    id: (() => { const ids = [uuid(9), uuid(8)]; return () => ids.shift() ?? uuid(99); })(),
  });
  return { launch, state, inspect: () => ({ workspace, runId, events }) };
}

test('one public Create atomically creates a workspace shell and exactly one V2 admission, then replays', async () => {
  const f = fixture();
  const created = await f.launch(user, input);
  assert.deepEqual(created, { workspace_id: uuid(8), conversation_id: input.conversationId,
    correlation_id: uuid(9), content_locale: 'vi', status: 'designing', replayed: false });
  assert.deepEqual({ filters: f.state.filters, accepted: f.state.accepted, admissions: f.state.admissions },
    { filters: 1, accepted: 1, admissions: 1 });
  const inserted = f.state.sql.findIndex(sql => sql.includes('INSERT INTO lesson_author_workspaces'));
  const designing = f.state.sql.findIndex(sql => sql.includes("UPDATE lesson_author_workspaces SET status='designing'"));
  const started = f.state.sql.findIndex(sql => sql.includes("'architecture_started'"));
  assert.ok(inserted >= 0 && designing > inserted && started > designing);
  assert.match(f.state.sql[inserted]!, /'queued'/);
  assert.doesNotMatch(f.state.sql[inserted]!, /'designing'/);
  const replayed = await f.launch(user, input);
  assert.equal(replayed.replayed, true);
  assert.deepEqual({ filters: f.state.filters, accepted: f.state.accepted, admissions: f.state.admissions },
    { filters: 1, accepted: 1, admissions: 1 });
  assert.deepEqual(f.state.replayContexts[1], { source_document_ids: input.sourceDocumentIds, user_message_id: null });
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
  const source = readFileSync(new URL('./ai-chatbot.routes.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/router\.post\('\/chat\/lesson-author\/courses\/:courseId\/conversations\/:conversationId\/workspaces'/g) ?? []).length, 1);
  assert.doesNotMatch(source, /router\.post\(`\$\{workspaceReadPath\}\/orchestration-v2\/runs`/);
  assert.match(source, /env\.LESSON_AUTHOR_ORCHESTRATION_V2_ADMISSION_ENABLED\s*\?\s*workspaceV2Launch/);
});
